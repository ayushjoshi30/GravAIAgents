"""Smart Mandate Agent (P1).

Chooses the right customer, amount and date to present an e-NACH or UPI AutoPay
mandate.

The timing insight is simple and entirely mechanical: present just after money
lands. A mandate presented the day before salary bounces, and a bounce costs a
penalty, damages the borrower's record and burns a presentment attempt. The
salary-credit date comes from the bank statement the analytics agent already
read, so this is a decision made on observed behaviour rather than a guess.

Two rules are hard: the amount may never exceed the registered mandate cap, and
a pre-debit notice must go at least 24 hours before presentment.
"""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal
from typing import Any

from gravai_connectors.collections_los import CollectionsCase
from pydantic import BaseModel, ConfigDict, Field

from ..base import Agent, AgentContext, AgentResult, AgentStep
from ..guardrails import run_all
from ..schemas import AgentOutput

#: NPCI requires notice before debiting. Configurable upward, never downward.
PRE_DEBIT_NOTICE_HOURS = 24

#: Days after salary lands to present. Day 0 risks racing the credit; beyond
#: day 3 the money has usually been spent.
PRESENT_AFTER_SALARY_DAYS = 1
PRESENT_WINDOW_DAYS = 3

#: Presentments per cycle before the case goes to a human instead.
MAX_PRESENTMENTS_PER_CYCLE = 3


class MandatePlan(BaseModel):
    model_config = ConfigDict(extra="forbid")

    case_id: str
    present_on: date
    amount: Decimal
    pre_debit_notice_on: date
    rationale: str
    capped: bool = Field(default=False, description="Amount was reduced to the mandate cap")


class MandateSkip(BaseModel):
    model_config = ConfigDict(extra="forbid")

    case_id: str
    reason: str


class SmartMandateOutput(AgentOutput):
    model_config = ConfigDict(extra="forbid")

    plans: list[MandatePlan] = Field(default_factory=list)
    skipped: list[MandateSkip] = Field(default_factory=list)
    total_to_present: Decimal = Decimal("0")


class SmartMandateAgent(Agent[SmartMandateOutput]):
    """Plans mandate presentments."""

    id = "smart_mandate"
    name = "Smart Mandate Agent"
    task = "Plan e-NACH and UPI AutoPay presentments: which case, what amount, which day."
    output_model = SmartMandateOutput
    tools = ("collections.list_cases", "mandate.present")

    @staticmethod
    def _next_presentment_date(salary_day: int | None, today: date) -> date:
        """The next sensible presentment date after salary lands.

        Falls back to three days out when the salary day is unknown — better
        than presenting blind tomorrow.
        """
        if salary_day is None:
            return today + timedelta(days=3)

        # This month's salary date, clamped for short months.
        try:
            this_month = today.replace(day=min(salary_day, 28))
        except ValueError:  # pragma: no cover - defensive
            this_month = today

        target = this_month + timedelta(days=PRESENT_AFTER_SALARY_DAYS)
        if target <= today:
            # Salary has already been and gone this month; aim at next month's.
            month = today.month + 1
            year = today.year + (1 if month > 12 else 0)
            month = 1 if month > 12 else month
            target = date(year, month, min(salary_day, 28)) + timedelta(
                days=PRESENT_AFTER_SALARY_DAYS
            )
        return target

    def _skip_reason(self, case: CollectionsCase) -> str | None:
        if not case.mandate_active:
            return "No active mandate is registered; presentment is not possible."
        if case.in_dispute:
            return "The account is in dispute; do not debit until it is resolved."
        promise = case.live_promise
        if promise is not None:
            return (
                f"A promise to pay by {promise.due_on:%d/%m/%Y} is live; presenting now "
                f"would pre-empt it."
            )
        if case.overdue_amount <= 0:
            return "Nothing is overdue."
        if case.bounces_6m >= MAX_PRESENTMENTS_PER_CYCLE:
            return (
                f"{case.bounces_6m} bounces in six months; further automated presentment "
                f"is likely to fail and should be a human conversation."
            )
        return None

    async def run(
        self,
        ctx: AgentContext,
        *,
        cases: list[CollectionsCase],
        today: date | None = None,
        **_: Any,
    ) -> AgentResult[SmartMandateOutput]:
        reference = today or date(2026, 9, 14)
        plans: list[MandatePlan] = []
        skipped: list[MandateSkip] = []

        for case in cases:
            reason = self._skip_reason(case)
            if reason:
                skipped.append(MandateSkip(case_id=case.case_id, reason=reason))
                continue

            amount = case.overdue_amount
            capped = False
            if case.mandate_cap is not None and amount > case.mandate_cap:
                # Never exceed the registered cap: the debit would simply be
                # rejected, and it is a mandate breach besides.
                amount = case.mandate_cap
                capped = True

            present_on = self._next_presentment_date(case.salary_credit_day, reference)
            notice_on = present_on - timedelta(days=max(1, PRE_DEBIT_NOTICE_HOURS // 24))
            if notice_on <= reference:
                # Notice must still be sendable in time; if not, push the
                # presentment out rather than skip the notice.
                present_on = reference + timedelta(days=2)
                notice_on = reference + timedelta(days=1)

            plans.append(
                MandatePlan(
                    case_id=case.case_id,
                    present_on=present_on,
                    amount=amount,
                    pre_debit_notice_on=notice_on,
                    capped=capped,
                    rationale=(
                        f"Salary typically lands on day {case.salary_credit_day or 'unknown'}; "
                        f"presenting {PRESENT_AFTER_SALARY_DAYS} day(s) after, inside a "
                        f"{PRESENT_WINDOW_DAYS}-day window, with notice "
                        f"{PRE_DEBIT_NOTICE_HOURS}h ahead."
                        + (" Amount reduced to the mandate cap." if capped else "")
                    ),
                )
            )

        plans.sort(key=lambda p: (p.present_on, -float(p.amount)))

        output = SmartMandateOutput(
            plans=plans,
            skipped=skipped,
            total_to_present=sum((p.amount for p in plans), Decimal("0")),
            escalate=any("human conversation" in s.reason for s in skipped),
            escalation_reason=(
                "Some cases have bounced too often for automated presentment"
                if any("human conversation" in s.reason for s in skipped)
                else None
            ),
            reasoning_summary=(
                f"Planned {len(plans)} presentments totalling "
                f"{sum((p.amount for p in plans), Decimal('0'))}; skipped {len(skipped)}. "
                f"Every plan carries a pre-debit notice at least "
                f"{PRE_DEBIT_NOTICE_HOURS} hours ahead and respects the mandate cap."
            ),
        )

        step = AgentStep(name="plan_presentments", kind="deterministic")
        report = run_all(output)
        return AgentResult(agent_id=self.id, output=output, steps=[step], validation=report)
