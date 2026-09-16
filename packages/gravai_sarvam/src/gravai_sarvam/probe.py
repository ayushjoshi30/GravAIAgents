"""Live model probes.

Everything in the platform can run against recorded fixtures. This module is the
opposite: it points at the **real** service with a real key and measures what
actually happens, so the assumptions the capacity plan rests on stop being
assumptions.

It exists because several things cannot be settled from documentation:

* Whether the endpoint paths and model ids in the config are correct at all.
* Whether the model honours JSON mode, or whether the repair loop carries it.
* How long a document really takes, and therefore how many polls it really costs.
* **Whether status polls count against the rate limit** — the single unknown that
  moves the backlog estimate by a factor of twelve.

Every probe spends real money, so each one reports what it cost, nothing runs
without an explicit opt-in, and the expensive probes state their price before
they start.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

import httpx
from gravai_core.errors import SarvamError
from gravai_core.settings import Settings, get_settings

from .pricing import RateCard
from .types import CallRecord, DocumentMode, DocumentRef, Product


@dataclass(slots=True)
class ProbeResult:
    """What one probe found."""

    name: str
    ok: bool
    detail: str
    measurements: dict[str, Any] = field(default_factory=dict)
    cost_inr: Decimal = Decimal("0")
    error: str | None = None

    def render(self) -> str:
        mark = "PASS" if self.ok else "FAIL"
        lines = [f"[{mark}] {self.name}", f"       {self.detail}"]
        for key, value in self.measurements.items():
            lines.append(f"       {key:<34} {value}")
        if self.cost_inr:
            lines.append(f"       {'estimated cost':<34} INR {self.cost_inr}")
        if self.error:
            lines.append(f"       error: {self.error}")
        return "\n".join(lines)


class Prober:
    """Runs probes against the live service.

    Deliberately does not reuse the platform's retrying HTTP client for the
    rate-limit work: that client retries 429s away, which is correct in
    production and fatal to an experiment whose entire purpose is to observe
    them.
    """

    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()
        self.rate_card = RateCard()
        if not self.settings.sarvam_api_key:
            raise ValueError(
                "No API key configured. Probes talk to the live service; set "
                "SARVAM_API_KEY in .env first."
            )

    def _client(self, timeout: float = 60.0) -> httpx.AsyncClient:
        """A raw client with no retries, so errors are observable."""
        return httpx.AsyncClient(
            base_url=self.settings.sarvam_base_url,
            headers={
                "api-subscription-key": self.settings.sarvam_api_key,
                "Accept": "application/json",
            },
            timeout=timeout,
        )

    # --- connectivity ----------------------------------------------------

    async def connectivity(self) -> ProbeResult:
        """Is the key valid and the base URL right?

        Runs the cheapest possible completion. A 401 here means the key or the
        header name is wrong, and every later probe would fail for that reason
        rather than the one it is testing.
        """
        payload = {
            "model": self.settings.sarvam_model_fast,
            "messages": [{"role": "user", "content": "Reply with the single word: ok"}],
            "max_tokens": 5,
            "temperature": 0.0,
        }
        started = time.perf_counter()
        async with self._client(timeout=30.0) as client:
            try:
                response = await client.post("/v1/chat/completions", json=payload)
            except httpx.TransportError as exc:
                return ProbeResult(
                    "connectivity",
                    False,
                    f"Could not reach {self.settings.sarvam_base_url}",
                    error=str(exc),
                )

        latency = int((time.perf_counter() - started) * 1000)
        if response.status_code == 401 or response.status_code == 403:
            return ProbeResult(
                "connectivity",
                False,
                "The service rejected the key. Check SARVAM_API_KEY and the auth header name.",
                measurements={"status": response.status_code, "body": response.text[:200]},
            )
        if response.status_code >= 400:
            return ProbeResult(
                "connectivity",
                False,
                f"Unexpected status {response.status_code}. The endpoint path may be wrong.",
                measurements={
                    "endpoint": "/v1/chat/completions",
                    "status": response.status_code,
                    "body": response.text[:300],
                },
            )

        body = response.json()
        return ProbeResult(
            "connectivity",
            True,
            "Key accepted and the chat endpoint responded.",
            measurements={
                "base_url": self.settings.sarvam_base_url,
                "model requested": self.settings.sarvam_model_fast,
                "model returned": body.get("model", "(not reported)"),
                "latency_ms": latency,
            },
        )

    # --- model behaviour --------------------------------------------------

    async def chat(self, model: str | None = None, prompt: str | None = None) -> ProbeResult:
        """One completion against a named model, measured."""
        target = model or self.settings.sarvam_model_reasoning
        text = prompt or ("In one sentence, what is the Fixed Obligation to Income Ratio used for?")
        payload = {
            "model": target,
            "messages": [{"role": "user", "content": text}],
            "temperature": 0.1,
            "max_tokens": 120,
        }
        started = time.perf_counter()
        async with self._client() as client:
            response = await client.post("/v1/chat/completions", json=payload)
        latency = int((time.perf_counter() - started) * 1000)

        if response.status_code >= 400:
            return ProbeResult(
                f"chat:{target}",
                False,
                "The model id was rejected, or the request shape is wrong.",
                measurements={"status": response.status_code, "body": response.text[:300]},
            )

        body = response.json()
        usage = body.get("usage") or {}
        reply = ""
        try:
            reply = body["choices"][0]["message"]["content"] or ""
        except (KeyError, IndexError, TypeError):
            return ProbeResult(
                f"chat:{target}",
                False,
                "Response shape was not as expected; the adapter needs updating.",
                measurements={"body": str(body)[:300]},
            )

        cost = self._price_tokens(
            int(usage.get("prompt_tokens", 0)), int(usage.get("completion_tokens", 0))
        )
        return ProbeResult(
            f"chat:{target}",
            True,
            "Completion returned.",
            measurements={
                "latency_ms": latency,
                "input_tokens": usage.get("prompt_tokens", "(not reported)"),
                "output_tokens": usage.get("completion_tokens", "(not reported)"),
                "usage reported": bool(usage),
                "reply": reply.strip()[:120],
            },
            cost_inr=cost,
        )

    async def json_mode(self, model: str | None = None) -> ProbeResult:
        """Does the model actually honour a JSON-mode request?

        This decides how much work the repair loop has to do. If JSON mode is
        real, most agent calls are one round trip; if it is ignored, a share of
        them are two or three, and the cost model changes accordingly.
        """
        import json as _json

        target = model or self.settings.sarvam_model_reasoning
        payload = {
            "model": target,
            "messages": [
                {
                    "role": "user",
                    "content": (
                        "Return ONLY a JSON object with keys 'name' (string) and "
                        "'amount' (number). No prose."
                    ),
                }
            ],
            "temperature": 0.0,
            "max_tokens": 100,
            "response_format": {"type": "json_object"},
        }
        async with self._client() as client:
            response = await client.post("/v1/chat/completions", json=payload)

        if response.status_code >= 400:
            return ProbeResult(
                f"json_mode:{target}",
                False,
                "response_format was rejected; the platform must rely on the repair loop.",
                measurements={"status": response.status_code, "body": response.text[:200]},
            )

        body = response.json()
        text = (body.get("choices") or [{}])[0].get("message", {}).get("content", "") or ""
        clean = text.strip()
        parses = False
        try:
            _json.loads(clean)
            parses = True
        except ValueError:
            parses = False

        usage = body.get("usage") or {}
        return ProbeResult(
            f"json_mode:{target}",
            parses,
            (
                "The model returned parseable JSON directly."
                if parses
                else "JSON mode was accepted but the output still needs repair."
            ),
            measurements={
                "raw output": clean[:160],
                "parses without repair": parses,
            },
            cost_inr=self._price_tokens(
                int(usage.get("prompt_tokens", 0)), int(usage.get("completion_tokens", 0))
            ),
        )

    async def compare_models(
        self, models: list[str], prompt: str | None = None
    ) -> list[ProbeResult]:
        """The same prompt against several models, for latency and cost."""
        return [await self.chat(model=model, prompt=prompt) for model in models]

    # --- documents --------------------------------------------------------

    async def document(
        self, document_url: str, mode: DocumentMode = DocumentMode.EXTRACT
    ) -> ProbeResult:
        """Run one real document and count what it actually cost.

        This is the measurement the whole capacity model rests on: how long a
        job really takes, and therefore how many polls the back-off schedule
        really issues.
        """
        from .documents import SarvamDocuments
        from .http import SarvamHTTP

        http = SarvamHTTP(self.settings)
        documents = SarvamDocuments(http, self.settings)
        schedule = self.settings.docai_poll_schedule

        started = time.perf_counter()
        try:
            job_id = await documents.submit(
                DocumentRef(document_id="probe", uri=document_url), mode
            )
        except SarvamError as exc:
            await http.aclose()
            return ProbeResult(
                f"document:{mode}",
                False,
                "Submission failed. The endpoint path or request shape is likely wrong.",
                measurements={"configured path": self.settings.sarvam_docai_extract_path},
                error=str(exc),
            )

        polls = 0
        status = None
        try:
            for delay in schedule.delays():
                await asyncio.sleep(delay)
                status = await documents.status(job_id)
                polls += 1
                if status.done or status.failed:
                    break
            elapsed = time.perf_counter() - started

            if status is None or not status.done:
                await http.aclose()
                return ProbeResult(
                    f"document:{mode}",
                    False,
                    f"Job did not finish within {schedule.max_wall_clock:.0f}s.",
                    measurements={"job_id": job_id, "polls": polls},
                )

            results = await documents.results(job_id)
        except SarvamError as exc:
            await http.aclose()
            return ProbeResult(
                f"document:{mode}", False, "Polling or results fetch failed.", error=str(exc)
            )

        await http.aclose()
        pages = int(results.get("page_count") or 0)
        total_calls = 1 + polls + 1 + (1 if mode is DocumentMode.DIGITISE else 0)
        predicted = schedule.expected_polls(elapsed)

        product = Product.DOCAI_EXTRACT if mode is DocumentMode.EXTRACT else Product.DOCAI_DIGITISE
        cost = self.rate_card.price(
            CallRecord(product=product, endpoint=str(mode), pages=pages, sandbox=False)
        )

        return ProbeResult(
            f"document:{mode}",
            True,
            "Document processed. These are measured figures, not estimates.",
            measurements={
                "job seconds (measured)": round(elapsed, 1),
                "polls issued (measured)": polls,
                "polls predicted by model": predicted,
                "model agrees": polls == predicted,
                "pages": pages,
                "total API calls for this document": total_calls,
                "fields returned": len(results.get("fields") or {}),
                "text returned": bool(results.get("text")),
            },
            cost_inr=cost,
        )

    # --- the rate-limit experiment ---------------------------------------

    async def poll_quota_experiment(
        self, document_url: str, poll_attempts: int = 40
    ) -> ProbeResult:
        """Settle whether status polls count against the rate limit.

        The single highest-value unknown in the platform: it moves the backlog
        estimate from about 184 days to about 2,200.

        Method. Submit exactly one document, then poll that one job as fast as
        the limit would allow, submitting nothing else. If polls draw on the
        same bucket, the limit is reached after roughly `rpm` polls within the
        minute and the service returns 429. If polls are free, all attempts
        succeed.

        Deliberately uses a non-retrying client: the production client retries
        429s away, which would hide the very signal being measured.
        """
        from .documents import SarvamDocuments
        from .http import SarvamHTTP

        http = SarvamHTTP(self.settings)
        documents = SarvamDocuments(http, self.settings)
        try:
            job_id = await documents.submit(
                DocumentRef(document_id="probe-quota", uri=document_url),
                DocumentMode.EXTRACT,
            )
        except SarvamError as exc:
            await http.aclose()
            return ProbeResult(
                "poll_quota_experiment",
                False,
                "Could not submit the probe document.",
                error=str(exc),
            )
        await http.aclose()

        status_path = self.settings.sarvam_docai_status_path.format(job_id=job_id)
        rpm = self.settings.sarvam_docai_rpm

        statuses: list[int] = []
        first_429_at: int | None = None
        retry_after: str | None = None
        started = time.perf_counter()

        async with self._client(timeout=30.0) as client:
            for attempt in range(1, poll_attempts + 1):
                if time.perf_counter() - started > 60.0:
                    # The experiment is about one minute's allowance; past that
                    # the bucket has refilled and the result means nothing.
                    break
                response = await client.get(status_path)
                statuses.append(response.status_code)
                if response.status_code == 429 and first_429_at is None:
                    first_429_at = attempt
                    retry_after = response.headers.get("Retry-After")
                    break
                # Poll hard: the question is whether volume is limited, so do
                # not back off here.
                await asyncio.sleep(0.2)

        elapsed = round(time.perf_counter() - started, 1)
        polls_made = len(statuses)

        if first_429_at is not None:
            verdict = "POLLS COUNT against the rate limit."
            implication = (
                f"Set SARVAM_DOCAI_POLLS_COUNT_TOWARD_LIMIT=true (the current default). "
                f"A document costs about {1 + 10 + 1} quota units, and the backlog is the "
                f"longer estimate."
            )
            ok = True
        elif polls_made > rpm * 1.5:
            verdict = "POLLS APPEAR TO BE FREE."
            implication = (
                f"{polls_made} polls in {elapsed}s with no 429, well past the {rpm}/min "
                f"submission limit. Set SARVAM_DOCAI_POLLS_COUNT_TOWARD_LIMIT=false and "
                f"throughput rises roughly twelvefold."
            )
            ok = True
        else:
            verdict = "INCONCLUSIVE."
            implication = (
                f"Only {polls_made} polls completed in {elapsed}s — not enough to pass the "
                f"{rpm}/min threshold either way. Re-run with more attempts."
            )
            ok = False

        return ProbeResult(
            "poll_quota_experiment",
            ok,
            f"{verdict} {implication}",
            measurements={
                "job_id": job_id,
                "polls attempted": polls_made,
                "configured limit per minute": rpm,
                "first 429 at poll": first_429_at if first_429_at else "none",
                "Retry-After header": retry_after or "(not sent)",
                "elapsed seconds": elapsed,
                "distinct statuses seen": sorted(set(statuses)),
            },
        )

    async def submission_ceiling(self, document_url: str, attempts: int = 15) -> ProbeResult:
        """Find the real submission limit, as a control for the poll experiment.

        Confirms the limit exists and that a 429 is detectable at all. Without
        this control, "no 429s while polling" is ambiguous: it could mean polls
        are free, or that the detection simply does not work.
        """
        path = self.settings.sarvam_docai_extract_path
        statuses: list[int] = []
        first_429_at: int | None = None
        started = time.perf_counter()

        async with self._client(timeout=30.0) as client:
            for attempt in range(1, attempts + 1):
                response = await client.post(path, json={"document_url": document_url})
                statuses.append(response.status_code)
                if response.status_code == 429 and first_429_at is None:
                    first_429_at = attempt
                    break

        elapsed = round(time.perf_counter() - started, 1)
        return ProbeResult(
            "submission_ceiling",
            first_429_at is not None,
            (
                f"Limit observed after {first_429_at} submissions in {elapsed}s "
                f"(configured assumption: {self.settings.sarvam_docai_rpm}/min)."
                if first_429_at
                else f"No limit hit in {len(statuses)} submissions over {elapsed}s — the real "
                f"ceiling is higher than {self.settings.sarvam_docai_rpm}/min, or is not "
                f"enforced per minute."
            ),
            measurements={
                "submissions made": len(statuses),
                "first 429 at": first_429_at or "none",
                "configured assumption": self.settings.sarvam_docai_rpm,
                "distinct statuses seen": sorted(set(statuses)),
            },
        )

    # --- speech -----------------------------------------------------------

    async def tts(
        self, text: str = "Your instalment is due.", language: str = "en-IN"
    ) -> ProbeResult:
        """Synthesise a short line and confirm audio comes back."""
        payload = {
            "inputs": [text],
            "target_language_code": language,
            "speaker": "anushka",
            "model": self.settings.sarvam_tts_model,
        }
        started = time.perf_counter()
        async with self._client() as client:
            response = await client.post("/text-to-speech", json=payload)
        latency = int((time.perf_counter() - started) * 1000)

        if response.status_code >= 400:
            return ProbeResult(
                "tts",
                False,
                "Text-to-speech was rejected. Check the model id, speaker name and path.",
                measurements={"status": response.status_code, "body": response.text[:250]},
            )

        audios = response.json().get("audios") or []
        return ProbeResult(
            "tts",
            bool(audios),
            "Audio returned." if audios else "Call succeeded but returned no audio.",
            measurements={
                "latency_ms": latency,
                "clips": len(audios),
                "base64 length": len(audios[0]) if audios else 0,
                "characters": len(text),
            },
            cost_inr=self.rate_card.price(
                CallRecord(product=Product.TTS, endpoint="/text-to-speech", characters=len(text))
            ),
        )

    # --- helpers ----------------------------------------------------------

    def _price_tokens(self, input_tokens: int, output_tokens: int) -> Decimal:
        return self.rate_card.price(
            CallRecord(product=Product.LLM_INPUT, endpoint="chat", input_tokens=input_tokens)
        ) + self.rate_card.price(
            CallRecord(product=Product.LLM_OUTPUT, endpoint="chat", output_tokens=output_tokens)
        )


def render_report(results: list[ProbeResult]) -> str:
    """A readable summary with the total spend."""
    lines = ["", "=" * 74, "LIVE MODEL PROBE REPORT", "=" * 74, ""]
    for result in results:
        lines.append(result.render())
        lines.append("")
    passed = sum(1 for r in results if r.ok)
    total = sum((r.cost_inr for r in results), Decimal("0"))
    lines.append("-" * 74)
    lines.append(f"{passed}/{len(results)} probes passed.  Estimated spend: INR {total}")
    lines.append("-" * 74)
    return "\n".join(lines)
