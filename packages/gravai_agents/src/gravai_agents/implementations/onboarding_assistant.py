"""Onboarding & Support Agent (P1).

Answers an applicant's questions about their own application: where it is, what
is still outstanding, what a requirement means.

The constraint that shapes it: this agent talks to a *customer*, so what it says
is what the lender has said. It therefore may not quote an eligibility outcome,
a rate, an approval or a rejection — only the status the LOS actually holds and
the requirements actually raised. Anything else goes to a human.
"""

from __future__ import annotations

from typing import Any

from gravai_connectors import GravitonApplication, Pendency
from pydantic import BaseModel, ConfigDict, Field

from ..base import Agent, AgentContext, AgentResult
from ..guardrails import run_all
from ..prompting import input_block
from ..schemas import AgentOutput, Flag, FlagType

#: Questions an assistant must not answer to a customer. Each is either a
#: decision the lender has not made yet, or one a human must deliver.
HANDOFF_TOPICS: tuple[tuple[str, str], ...] = (
    ("approval_decision", "whether the loan is approved, rejected or how likely it is"),
    ("interest_rate", "the interest rate or any pricing not already communicated"),
    ("eligibility_amount", "how much they are eligible for"),
    ("complaint", "a complaint or grievance"),
    ("settlement", "a settlement, waiver or restructuring"),
    ("legal", "legal consequences"),
)


class SuggestedAction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    label: str
    detail: str


class OnboardingOutput(AgentOutput):
    model_config = ConfigDict(extra="forbid")

    application_id: str
    language: str
    answer: str
    status_explained: str = ""
    outstanding_requirements: list[str] = Field(default_factory=list)
    suggested_actions: list[SuggestedAction] = Field(default_factory=list)
    handoff_required: bool = False
    handoff_topic: str | None = None


class AssistantReply(BaseModel):
    """What the model writes: an answer grounded in supplied facts."""

    model_config = ConfigDict(extra="forbid")

    answer: str = Field(description="Two to five sentences, plain language")
    status_explained: str = Field(description="What the current status means, in one sentence")
    suggested_actions: list[SuggestedAction] = Field(default_factory=list)
    requires_human: bool = Field(
        description="True if the question is about approval, pricing, eligibility, "
        "a complaint, a settlement or legal consequences"
    )
    human_topic: str | None = None


class OnboardingAssistantAgent(Agent[OnboardingOutput]):
    """Guides applicants through their application."""

    id = "onboarding_assistant"
    name = "Onboarding & Support Agent"
    task = "Answer an applicant's question about their own loan application."
    output_model = OnboardingOutput
    tools = ("graviton.get_application", "graviton.list_pendencies", "notifications.send")
    agent_rules = """
8. You are speaking to the customer. Say only what the lender's own records
   show: the current status, and the requirements actually raised. Never state
   or hint at an approval, a rejection, a likelihood, an interest rate, or an
   eligible amount — those are decisions a human communicates.
9. If the question touches approval, pricing, eligibility, a complaint, a
   settlement or legal consequences, set requires_human and say a colleague will
   call, rather than answering.
10. Never ask the customer for an OTP, a PIN, a card number, a full account
   number or a full Aadhaar. If they offer one, tell them not to share it.
11. Be brief, warm and concrete. Say what to do next.
"""

    async def run(
        self,
        ctx: AgentContext,
        *,
        application: GravitonApplication,
        question: str,
        pendencies: list[Pendency] | None = None,
        language: str = "English",
        **_: Any,
    ) -> AgentResult[OnboardingOutput]:
        outstanding = [p.requirement for p in (pendencies or []) if p.status == "open"]

        facts = input_block(
            {
                "application_reference": application.external_id,
                "product": application.product,
                "current_status": application.status,
                "outstanding_requirements": outstanding,
                "applicant_name": application.applicant_name,
                "topics_requiring_a_human": [detail for _, detail in HANDOFF_TOPICS],
            }
        )
        reply, step, calls = await self.ask(
            ctx,
            f"The applicant asks: {question!r}\n\nAnswer using only these facts.\n\n{facts}",
            AssistantReply,
            step_name="answer_query",
        )

        flags: list[Flag] = []
        if reply.requires_human:
            flags.append(
                Flag(
                    type=FlagType.QUALITY,
                    detail=f"Question needs a human: {reply.human_topic or 'unspecified'}",
                    severity="medium",
                )
            )

        output = OnboardingOutput(
            application_id=application.application_id,
            language=language,
            answer=reply.answer,
            status_explained=reply.status_explained,
            outstanding_requirements=outstanding,
            suggested_actions=reply.suggested_actions,
            handoff_required=reply.requires_human,
            handoff_topic=reply.human_topic,
            flags=flags,
            escalate=reply.requires_human,
            escalation_reason=(
                f"Applicant asked about {reply.human_topic or 'a topic requiring a human'}"
                if reply.requires_human
                else None
            ),
            reasoning_summary=(
                f"Answered a status question on {application.external_id} "
                f"(status {application.status}, {len(outstanding)} outstanding "
                f"requirement(s)). Handoff: {reply.requires_human}."
            ),
        )

        report = run_all(output, known_document_ids=ctx.document_ids)
        return AgentResult(
            agent_id=self.id, output=output, steps=[step], validation=report, calls=calls
        )
