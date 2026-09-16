"""Chat completions.

``complete_json`` is the workhorse: every agent has a strict output contract, and
a model returning almost-valid JSON is routine rather than exceptional. The
repair loop hands the model its own validation errors and one or two chances to
correct itself; after that the run escalates to a human rather than burning more
quota on the same mistake.

The loop lives on a shared base class so the sandbox client inherits it. That
matters: it means the test suite exercises the real repair behaviour instead of
a fake that always succeeds.
"""

from __future__ import annotations

import json
import re
import time
from typing import Any, TypeVar

from gravai_core.errors import SchemaViolation
from gravai_core.settings import Settings, get_settings
from gravai_core.telemetry import get_logger
from pydantic import BaseModel, ValidationError

from .http import SarvamHTTP
from .types import ChatMessage, ChatRequest, ChatResponse, Usage

log = get_logger("gravai.sarvam.chat")

ModelT = TypeVar("ModelT", bound=BaseModel)

CHAT_PATH = "/v1/chat/completions"

_FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL)


def extract_json_object(text: str) -> str:
    """Pull a JSON object out of a model response.

    Models wrap JSON in prose or code fences often enough that failing on it
    would mean discarding otherwise-correct answers.
    """
    if not text:
        raise SchemaViolation("Model returned an empty response")

    fenced = _FENCE.search(text)
    candidate = fenced.group(1).strip() if fenced else text.strip()

    if candidate.startswith("{") and candidate.endswith("}"):
        return candidate

    start = candidate.find("{")
    if start == -1:
        raise SchemaViolation("Model response contained no JSON object", body=text[:400])

    depth, in_string, escape = 0, False, False
    for index in range(start, len(candidate)):
        char = candidate[index]
        if in_string:
            if escape:
                escape = False
            elif char == "\\":
                escape = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return candidate[start : index + 1]

    raise SchemaViolation("Model response had an unterminated JSON object", body=text[:400])


def estimate_tokens(text: str) -> int:
    """Rough token estimate for when a provider omits usage.

    Deliberately crude; anything derived from it is flagged ``estimated_usage``
    so the cost ledger never presents a guess as a measurement.
    """
    return max(1, len(text) // 4)


class ChatClient:
    """Chat contract: a provider supplies ``complete``; the repair loop is shared."""

    async def complete(self, request: ChatRequest) -> ChatResponse:  # pragma: no cover
        raise NotImplementedError

    async def complete_json(
        self,
        request: ChatRequest,
        schema: type[ModelT],
        *,
        max_repairs: int = 2,
    ) -> tuple[ModelT, list[ChatResponse]]:
        """Complete and validate against a Pydantic model.

        Returns the parsed object and every response produced along the way, so
        the cost ledger bills the repairs too — repair attempts are real spend,
        and hiding them would understate the cost of a badly-behaved prompt.
        """
        messages = list(request.messages)
        responses: list[ChatResponse] = []
        last_error = ""

        for attempt in range(max_repairs + 1):
            attempt_request = ChatRequest(
                messages=tuple(messages),
                model=request.model,
                temperature=request.temperature,
                top_p=request.top_p,
                max_tokens=request.max_tokens,
                json_mode=True,
                stop=request.stop,
            )
            response = await self.complete(attempt_request)
            responses.append(response)

            try:
                raw = extract_json_object(response.text)
                return schema.model_validate_json(raw), responses
            except (SchemaViolation, ValidationError, json.JSONDecodeError) as exc:
                last_error = str(exc)[:1500]
                if attempt == max_repairs:
                    break
                log.warning(
                    "schema_repair",
                    attempt=attempt + 1,
                    schema=schema.__name__,
                    error=last_error[:200],
                )
                messages.append(ChatMessage(role="assistant", content=response.text))
                messages.append(
                    ChatMessage(
                        role="user",
                        content=(
                            "Your previous output failed validation:\n"
                            f"{last_error}\n\n"
                            "Return ONLY a corrected JSON object matching the schema. "
                            "No prose, no code fences. Do not invent values to satisfy "
                            "the schema: use null with a reason where a value is "
                            "genuinely unavailable."
                        ),
                    )
                )

        raise SchemaViolation(
            f"Model failed to satisfy {schema.__name__} after {max_repairs + 1} attempts",
            schema=schema.__name__,
            last_error=last_error,
        )


class SarvamChat(ChatClient):
    """Sarvam chat completions over HTTP."""

    def __init__(self, http: SarvamHTTP, settings: Settings | None = None) -> None:
        self.http = http
        self.settings = settings or get_settings()

    def _model_for(self, request: ChatRequest) -> str:
        return request.model or self.settings.sarvam_model_reasoning

    async def complete(self, request: ChatRequest) -> ChatResponse:
        """One completion."""
        model = self._model_for(request)
        payload: dict[str, Any] = {
            "model": model,
            "messages": [{"role": m.role, "content": m.content} for m in request.messages],
            "temperature": request.temperature,
            "top_p": request.top_p,
        }
        if request.max_tokens:
            payload["max_tokens"] = request.max_tokens
        if request.stop:
            payload["stop"] = list(request.stop)
        if request.json_mode:
            payload["response_format"] = {"type": "json_object"}

        started = time.perf_counter()
        response = await self.http.request("POST", CHAT_PATH, product="llm", json=payload)
        latency_ms = int((time.perf_counter() - started) * 1000)
        body = response.json()

        try:
            text = body["choices"][0]["message"]["content"] or ""
        except (KeyError, IndexError, TypeError) as exc:
            raise SchemaViolation(
                "Sarvam chat response had an unexpected shape", body=str(body)[:400]
            ) from exc

        usage_body = body.get("usage") or {}
        if usage_body:
            usage = Usage(
                input_tokens=int(usage_body.get("prompt_tokens", 0)),
                output_tokens=int(usage_body.get("completion_tokens", 0)),
            )
            estimated = False
        else:
            prompt_text = "".join(m.content for m in request.messages)
            usage = Usage(
                input_tokens=estimate_tokens(prompt_text),
                output_tokens=estimate_tokens(text),
            )
            estimated = True

        return ChatResponse(
            text=text,
            usage=usage,
            model=body.get("model", model),
            latency_ms=latency_ms,
            estimated_usage=estimated,
        )
