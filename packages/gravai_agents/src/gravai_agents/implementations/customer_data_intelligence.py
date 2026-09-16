"""Customer Data Intelligence Agent (P2).

Builds segments and propensity signals from behaviour the platform already
holds.

Two constraints make this different from ordinary marketing segmentation, and
both are enforced in code:

* **Consent is per purpose.** Data collected to underwrite a loan may not be
  used to market one. A borrower without a live marketing consent is excluded
  before any rule runs, not filtered out of the campaign afterwards.
* **Every segment carries a readable rule.** A segment nobody can explain cannot
  be defended to a regulator or a customer, so a score without a rule is not a
  segment here — it is a number, and this agent does not emit those.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from ..base import Agent, AgentContext, AgentResult, AgentStep
from ..guardrails import run_all
from ..schemas import AgentOutput, Flag, FlagType

#: The consent purpose a segment must be covered by. Underwriting consent is
#: not marketing consent.
MARKETING_PURPOSE = "marketing"


class CustomerSignal(BaseModel):
    """What the platform observed about one borrower."""

    model_config = ConfigDict(extra="forbid")

    customer_ref: str
    #: Purposes this customer has granted live consent for.
    consent_purposes: list[str] = Field(default_factory=list)

    months_on_book: int = 0
    outstanding_principal: Decimal = Decimal("0")
    original_principal: Decimal = Decimal("0")
    emi_amount: Decimal = Decimal("0")
    monthly_income: Decimal | None = None
    bounces_12m: int = 0
    days_past_due: int = 0
    risk_band: str | None = None
    enquiries_3m: int = 0

    @property
    def repaid_share(self) -> float:
        if self.original_principal <= 0:
            return 0.0
        repaid = self.original_principal - self.outstanding_principal
        return max(0.0, min(1.0, float(repaid / self.original_principal)))


@dataclass(frozen=True, slots=True)
class SegmentRule:
    """A named, human-readable rule. The rule *is* the segment."""

    name: str
    rule: str
    action: str

    def matches(self, signal: CustomerSignal) -> bool:  # pragma: no cover - overridden
        raise NotImplementedError


class SegmentMembership(BaseModel):
    model_config = ConfigDict(extra="forbid")

    segment: str
    rule: str
    suggested_action: str
    customers: list[str] = Field(default_factory=list)
    size: int = 0


class CdiOutput(AgentOutput):
    model_config = ConfigDict(extra="forbid")

    population: int = 0
    consented: int = 0
    excluded_no_consent: int = 0
    segments: list[SegmentMembership] = Field(default_factory=list)
    unsegmented: int = 0


def _top_up_ready(s: CustomerSignal) -> bool:
    return (
        s.months_on_book >= 12
        and s.repaid_share >= 0.4
        and s.bounces_12m == 0
        and s.days_past_due == 0
        and s.risk_band in (None, "GREEN")
    )


def _pre_delinquency_watch(s: CustomerSignal) -> bool:
    return s.days_past_due == 0 and (s.bounces_12m >= 2 or s.enquiries_3m >= 5)


def _stretched(s: CustomerSignal) -> bool:
    if not s.monthly_income or s.monthly_income <= 0:
        return False
    return float(s.emi_amount / s.monthly_income) > 0.45


def _nearly_closed(s: CustomerSignal) -> bool:
    return s.repaid_share >= 0.85 and s.days_past_due == 0


#: The catalogue. Each entry pairs a rule you can read with the action it implies.
SEGMENTS: tuple[tuple[str, str, str, Any], ...] = (
    (
        "top_up_ready",
        "On book 12 months or more, at least 40% repaid, no bounces in 12 months, "
        "not past due, and not in the RED risk band.",
        "Offer a top-up at existing terms.",
        _top_up_ready,
    ),
    (
        "pre_delinquency_watch",
        "Currently up to date, but either two or more bounces in 12 months, or five or "
        "more credit enquiries in the last three months.",
        "Pre-emptive contact before the account falls due.",
        _pre_delinquency_watch,
    ),
    (
        "repayment_stretched",
        "Instalment is more than 45% of observed monthly income.",
        "Review affordability before offering further credit.",
        _stretched,
    ),
    (
        "nearly_closed",
        "At least 85% repaid and not past due.",
        "Closure and retention conversation.",
        _nearly_closed,
    ),
)


class CustomerDataIntelligenceAgent(Agent[CdiOutput]):
    """Consent-scoped, explainable segmentation."""

    id = "customer_data_intelligence"
    name = "Customer Data Intelligence Agent"
    task = "Segment the book into explainable, consent-scoped groups."
    output_model = CdiOutput
    tools = ("ledger.query", "graviton.get_application")

    async def run(
        self,
        ctx: AgentContext,
        *,
        signals: list[CustomerSignal],
        purpose: str = MARKETING_PURPOSE,
        **_: Any,
    ) -> AgentResult[CdiOutput]:
        # Consent first. A customer without a live consent for this purpose is
        # never evaluated, so they cannot appear in an output that is later
        # exported to a campaign tool.
        consented = [s for s in signals if purpose in s.consent_purposes]
        excluded = len(signals) - len(consented)

        memberships: list[SegmentMembership] = []
        assigned: set[str] = set()

        for name, rule, action, predicate in SEGMENTS:
            members = [s.customer_ref for s in consented if predicate(s)]
            assigned.update(members)
            memberships.append(
                SegmentMembership(
                    segment=name,
                    rule=rule,
                    suggested_action=action,
                    customers=members,
                    size=len(members),
                )
            )

        flags: list[Flag] = []
        if excluded:
            flags.append(
                Flag(
                    type=FlagType.QUALITY,
                    detail=(
                        f"{excluded} customer(s) excluded for want of a live '{purpose}' "
                        f"consent. Data collected to underwrite may not be used to market."
                    ),
                    severity="low",
                )
            )

        output = CdiOutput(
            population=len(signals),
            consented=len(consented),
            excluded_no_consent=excluded,
            segments=memberships,
            unsegmented=len(consented) - len(assigned),
            flags=flags,
            escalate=False,
            reasoning_summary=(
                f"Evaluated {len(consented)} of {len(signals)} customers holding a live "
                f"'{purpose}' consent against {len(SEGMENTS)} published rules. "
                f"{len(assigned)} fell into at least one segment. No protected attribute "
                f"is used by any rule."
            ),
        )

        step = AgentStep(name="apply_segment_rules", kind="deterministic")
        report = run_all(output)
        return AgentResult(agent_id=self.id, output=output, steps=[step], validation=report)
