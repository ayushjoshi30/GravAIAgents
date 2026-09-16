"""Collections Case Allocation Agent (P1).

Ranks delinquent cases and routes the next best action.

Ranking is deterministic — exposure, urgency and recoverability are arithmetic —
and the suppression rules are absolute: a live promise, a dispute, a do-not-call
flag or an exhausted attempt budget removes a case from outreach regardless of
how much money is on it. Those are conduct rules, not optimisation inputs, so
they are enforced before scoring rather than weighted against it.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from gravai_connectors.collections_los import CollectionsCase
from gravai_core.time_utils import DEFAULT_CALL_WINDOW_END, DEFAULT_CALL_WINDOW_START
from pydantic import BaseModel, ConfigDict, Field

from ..base import Agent, AgentContext, AgentResult, AgentStep
from ..guardrails import run_all
from ..schemas import AgentOutput

#: Actions, cheapest and least intrusive first.
ACTIONS = ("suppress", "digital_nudge", "voice_agent", "human_call", "field_visit", "legal_review")

#: Attempts per case per day. A conduct limit, not a tuning parameter.
MAX_ATTEMPTS_PER_DAY = 3


class Allocation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    case_id: str
    priority: float
    next_action: str
    channel: str
    language: str
    reason: str
    suppressed: bool = False
    suppression_reason: str | None = None
    earliest_contact_local: str | None = None
    requires_human: bool = False


class CaseAllocationOutput(AgentOutput):
    model_config = ConfigDict(extra="forbid")

    allocations: list[Allocation] = Field(default_factory=list)
    total_cases: int = 0
    suppressed_cases: int = 0
    contactable_cases: int = 0
    total_overdue: Decimal = Decimal("0")


class CaseAllocationAgent(Agent[CaseAllocationOutput]):
    """Prioritises a collections portfolio."""

    id = "case_allocation"
    name = "Collections Case Allocation Agent"
    task = "Rank delinquent cases and choose the next best action for each."
    output_model = CaseAllocationOutput
    tools = ("collections.list_cases", "risk.score_dpd")

    @staticmethod
    def suppression(case: CollectionsCase) -> str | None:
        """Why this case must not be contacted, if it must not.

        Checked before any scoring. A case with a live promise that is chased
        anyway is both a conduct breach and the fastest way to turn a paying
        borrower into a complaint.
        """
        if case.in_dispute:
            return "The account is in dispute; collections outreach stops until it is resolved."
        if case.do_not_call:
            return "The borrower is on do-not-call; only non-voice channels are permitted."
        if case.live_promise is not None:
            promise = case.live_promise
            return (
                f"A promise to pay {promise.amount} by {promise.due_on:%d/%m/%Y} is live "
                f"and has not fallen due."
            )
        if case.attempts_today >= MAX_ATTEMPTS_PER_DAY:
            return (
                f"{case.attempts_today} attempts already made today (limit {MAX_ATTEMPTS_PER_DAY})."
            )
        return None

    @staticmethod
    def priority(case: CollectionsCase) -> float:
        """Exposure x urgency x recoverability, normalised to roughly 0-100.

        Recoverability falls with broken promises and bounces: chasing a case
        that has broken two promises with another automated reminder is not
        where the next rupee comes from.
        """
        exposure = float(case.overdue_amount) / 100_000.0
        urgency = min(case.dpd / 90.0, 1.5)
        recoverability = 1.0
        recoverability -= 0.15 * case.broken_promises
        recoverability -= 0.05 * min(case.bounces_6m, 6)
        if case.risk_band == "RED":
            recoverability -= 0.2
        elif case.risk_band == "GREEN":
            recoverability += 0.1
        recoverability = max(0.15, min(recoverability, 1.2))
        return round(exposure * (0.5 + urgency) * recoverability * 10, 2)

    @staticmethod
    def next_action(case: CollectionsCase) -> tuple[str, str, bool]:
        """Action, channel, and whether a human is required.

        Escalation follows delinquency and history, and hands to a human where
        judgement or settlement authority is needed — an AI agent should not be
        negotiating a settlement or discussing legal action.
        """
        if case.dpd >= 90 or case.broken_promises >= 2:
            return "human_call", "voice", True
        if case.dpd >= 60:
            return "field_visit", "field", True
        if case.dpd >= 15:
            return "voice_agent", "voice", False
        return "digital_nudge", "whatsapp", False

    async def run(
        self,
        ctx: AgentContext,
        *,
        cases: list[CollectionsCase],
        **_: Any,
    ) -> AgentResult[CaseAllocationOutput]:
        allocations: list[Allocation] = []

        for case in cases:
            blocked = self.suppression(case)
            if blocked:
                allocations.append(
                    Allocation(
                        case_id=case.case_id,
                        priority=0.0,
                        next_action="suppress",
                        channel="none",
                        language=case.language,
                        reason="Excluded from outreach.",
                        suppressed=True,
                        suppression_reason=blocked,
                    )
                )
                continue

            action, channel, human = self.next_action(case)
            allocations.append(
                Allocation(
                    case_id=case.case_id,
                    priority=self.priority(case),
                    next_action=action,
                    channel=channel,
                    language=case.language,
                    reason=(
                        f"{case.dpd} days past due, {case.overdue_amount} overdue, "
                        f"{case.broken_promises} broken promise(s), "
                        f"{case.bounces_6m} bounce(s) in six months."
                    ),
                    earliest_contact_local=(
                        f"{DEFAULT_CALL_WINDOW_START:%H:%M}-{DEFAULT_CALL_WINDOW_END:%H:%M} IST"
                        if channel in ("voice", "field")
                        else None
                    ),
                    requires_human=human,
                )
            )

        allocations.sort(key=lambda a: a.priority, reverse=True)
        suppressed = sum(1 for a in allocations if a.suppressed)

        output = CaseAllocationOutput(
            allocations=allocations,
            total_cases=len(cases),
            suppressed_cases=suppressed,
            contactable_cases=len(allocations) - suppressed,
            total_overdue=sum((c.overdue_amount for c in cases), Decimal("0")),
            escalate=any(a.requires_human for a in allocations),
            escalation_reason=(
                f"{sum(1 for a in allocations if a.requires_human)} case(s) need a human "
                "conversation rather than an automated one"
                if any(a.requires_human for a in allocations)
                else None
            ),
            reasoning_summary=(
                f"Ranked {len(cases)} cases. {suppressed} suppressed (dispute, do-not-call, "
                f"live promise or attempt limit). "
                f"{sum(1 for a in allocations if a.requires_human)} routed to a human."
            ),
        )

        step = AgentStep(name="rank_portfolio", kind="deterministic")
        report = run_all(output)
        return AgentResult(agent_id=self.id, output=output, steps=[step], validation=report)
