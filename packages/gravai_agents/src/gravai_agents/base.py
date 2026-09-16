"""Agent run contract.

An agent is a prompt, an output schema, a set of tools and a set of guardrails.
This module supplies the parts every agent shares: building the prompt, calling
the model with the repair loop, validating the result, pricing the call, and
recording a step the console can render and an auditor can follow.
"""

from __future__ import annotations

import hashlib
from abc import ABC, abstractmethod
from dataclasses import dataclass, field, replace
from decimal import Decimal
from typing import Any

from gravai_core.audit import canonical_json
from gravai_sarvam import (
    CallRecord,
    ChatMessage,
    ChatRequest,
    Product,
    RateCard,
    SarvamBundle,
)
from pydantic import BaseModel

from .guardrails import ValidationReport, run_all
from .prompting import PromptContext, build_system_prompt


def _digest(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode()).hexdigest()[:16]


@dataclass(slots=True)
class AgentContext:
    """Who this run is for and under what policy."""

    tenant_id: str
    tenant_name: str = "the lender"
    application_id: str | None = None
    case_id: str | None = None
    run_id: str | None = None
    language: str = "English"
    loan_product: str = ""
    policy_version: str = ""
    confidence_floor: float = 0.7
    #: Documents available to this run. Any citation outside this set is a
    #: fabricated source and is rejected by the validators.
    document_ids: tuple[str, ...] = field(default=())


@dataclass(slots=True)
class AgentStep:
    """One model or tool interaction, as the console renders it."""

    name: str
    kind: str = "llm"
    model: str | None = None
    prompt_version: str | None = None
    input_digest: str = ""
    output_digest: str = ""
    input_tokens: int = 0
    output_tokens: int = 0
    pages: int = 0
    audio_seconds: float = 0.0
    latency_ms: int = 0
    cost_inr: Decimal = Decimal("0")
    attempts: int = 1
    estimated_usage: bool = False
    validation: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "kind": self.kind,
            "model": self.model,
            "prompt_version": self.prompt_version,
            "input_digest": self.input_digest,
            "output_digest": self.output_digest,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "pages": self.pages,
            "audio_seconds": self.audio_seconds,
            "latency_ms": self.latency_ms,
            "cost_inr": str(self.cost_inr),
            "attempts": self.attempts,
            "estimated_usage": self.estimated_usage,
            "validation": self.validation,
        }


@dataclass(slots=True)
class AgentResult[OutputT: BaseModel]:
    """What an agent run produced."""

    agent_id: str
    output: OutputT
    steps: list[AgentStep] = field(default_factory=list)
    validation: ValidationReport = field(default_factory=ValidationReport)
    calls: list[CallRecord] = field(default_factory=list)

    @property
    def cost_inr(self) -> Decimal:
        return sum((step.cost_inr for step in self.steps), Decimal("0"))

    @property
    def total_calls(self) -> int:
        return len(self.calls)

    @property
    def escalated(self) -> bool:
        """Escalated by the agent's own judgement, or by a failed validator."""
        return bool(getattr(self.output, "escalate", False)) or not self.validation.ok

    @property
    def escalation_reason(self) -> str | None:
        if not self.validation.ok:
            return "; ".join(self.validation.violations[:5])
        reason = getattr(self.output, "escalation_reason", None)
        return str(reason) if reason else None

    def as_dict(self) -> dict[str, Any]:
        return {
            "agent_id": self.agent_id,
            "output": self.output.model_dump(mode="json"),
            "steps": [step.as_dict() for step in self.steps],
            "cost_inr": str(self.cost_inr),
            "escalated": self.escalated,
            "escalation_reason": self.escalation_reason,
            "validation": {
                "ok": self.validation.ok,
                "violations": self.validation.violations,
                "warnings": self.validation.warnings,
            },
        }


class Agent[OutputT: BaseModel](ABC):
    """Base class for every GravAI agent."""

    #: Must match an id in the agent catalog.
    id: str
    name: str
    task: str
    output_model: type[OutputT]
    prompt_version: str = "v1"
    agent_rules: str = ""
    few_shot: str = ""
    tools: tuple[str, ...] = ()
    #: Output fields permitted to contain identifiers that would otherwise be
    #: flagged as unmasked PII (e.g. a masked account number field).
    allow_pii_fields: frozenset[str] = frozenset()

    def __init__(self, sarvam: SarvamBundle, rate_card: RateCard | None = None) -> None:
        self.sarvam = sarvam
        self.rate_card = rate_card or sarvam.rate_card

    # --- prompt ---------------------------------------------------------

    def prompt_context(self, ctx: AgentContext) -> PromptContext:
        return PromptContext(
            tenant_name=ctx.tenant_name,
            agent_name=self.name,
            task=self.task,
            loan_product=ctx.loan_product,
            policy_version=ctx.policy_version,
            output_language=ctx.language,
            confidence_floor=ctx.confidence_floor,
            tools=self.tools,
        )

    def system_prompt(self, ctx: AgentContext, model: type[BaseModel] | None = None) -> str:
        """The prompt, carrying whichever schema this call must satisfy.

        Usually the agent's own output model, but an agent whose figures are
        computed in code may ask the model for a smaller shape — a narrative,
        say — while its published output type stays the full document.
        """
        return build_system_prompt(
            self.prompt_context(ctx),
            model or self.output_model,
            agent_rules=self.agent_rules,
            few_shot=self.few_shot,
        )

    # --- model ----------------------------------------------------------

    def _price_chat(self, responses: list[Any]) -> tuple[Decimal, list[CallRecord]]:
        """Price every response, including repairs.

        Repair attempts are real spend; excluding them would understate the cost
        of a prompt that needs three goes to produce valid JSON.
        """
        total = Decimal("0")
        records: list[CallRecord] = []
        for response in responses:
            # Input and output tokens are priced separately because their rates
            # differ; latency is attributed once, to the input leg, so summing
            # the ledger does not double-count time.
            legs = (
                (Product.LLM_INPUT, response.usage.input_tokens, 0, response.latency_ms),
                (Product.LLM_OUTPUT, 0, response.usage.output_tokens, 0),
            )
            for product, input_tokens, output_tokens, latency in legs:
                record = CallRecord(
                    product=product,
                    endpoint="/v1/chat/completions",
                    model=response.model,
                    input_tokens=input_tokens,
                    output_tokens=output_tokens,
                    latency_ms=latency,
                    sandbox=self.sarvam.sandbox,
                    agent_id=self.id,
                )
                cost = self.rate_card.price(record)
                total += cost
                records.append(replace(record, cost_inr=cost))
        return total, records

    async def ask[ResponseT: BaseModel](
        self,
        ctx: AgentContext,
        user_content: str,
        response_model: type[ResponseT],
        *,
        step_name: str = "reason",
        max_repairs: int = 2,
    ) -> tuple[ResponseT, AgentStep, list[CallRecord]]:
        """Run the model against a validated output contract."""
        request = ChatRequest(
            messages=(
                ChatMessage(role="system", content=self.system_prompt(ctx, response_model)),
                ChatMessage(role="user", content=user_content),
            ),
            temperature=0.1,
            json_mode=True,
        )
        output, responses = await self.sarvam.chat.complete_json(
            request, response_model, max_repairs=max_repairs
        )

        cost, records = self._price_chat(responses)
        report = run_all(
            output,
            known_document_ids=ctx.document_ids,
            allow_pii_fields=self.allow_pii_fields,
        )

        last = responses[-1]
        step = AgentStep(
            name=step_name,
            kind="llm",
            model=last.model,
            prompt_version=self.prompt_version,
            input_digest=_digest(user_content),
            output_digest=_digest(output.model_dump(mode="json")),
            input_tokens=sum(r.usage.input_tokens for r in responses),
            output_tokens=sum(r.usage.output_tokens for r in responses),
            latency_ms=sum(r.latency_ms for r in responses),
            cost_inr=cost,
            attempts=len(responses),
            estimated_usage=any(r.estimated_usage for r in responses),
            validation=report.violations,
        )
        return output, step, records

    # --- contract -------------------------------------------------------

    @abstractmethod
    async def run(self, *args: Any, **kwargs: Any) -> AgentResult[OutputT]:
        """Execute the agent.

        Deliberately untyped in the base: each agent requires different inputs —
        documents, transactions, an application — and forcing them through one
        signature would either lose that typing or make every call site pass a
        bag of optionals. Subclasses declare what they actually need.
        """
        raise NotImplementedError
