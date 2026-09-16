"""Collections cases and mandates.

The shapes the collections agents work with, plus a sandbox portfolio with
enough variety to exercise the decisions that matter: a case in its cure period,
one with a live promise to pay, one that has bounced repeatedly, and one that
has asked not to be called.
"""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field


class ContactOutcome(StrEnum):
    CONNECTED = "connected"
    NO_ANSWER = "no_answer"
    WRONG_NUMBER = "wrong_number"
    REFUSED = "refused"
    PROMISE = "promise"
    DISPUTE = "dispute"


class PromiseToPay(BaseModel):
    model_config = ConfigDict(extra="forbid")

    promised_on: date
    due_on: date
    amount: Decimal
    kept: bool | None = None


class ContactAttempt(BaseModel):
    model_config = ConfigDict(extra="forbid")

    attempted_at: date
    channel: str
    outcome: ContactOutcome


class CollectionsCase(BaseModel):
    """A delinquent account."""

    model_config = ConfigDict(extra="forbid")

    case_id: str
    application_id: str | None = None
    borrower_name: str
    borrower_mobile_masked: str = ""
    language: str = "en-IN"

    dpd: int = Field(ge=0, description="Days past due")
    outstanding_principal: Decimal
    emi_amount: Decimal
    overdue_amount: Decimal

    bounces_6m: int = 0
    risk_band: str | None = None
    mandate_active: bool = True
    mandate_cap: Decimal | None = None
    salary_credit_day: int | None = Field(
        default=None, ge=1, le=31, description="Day of month salary usually lands"
    )

    promises: list[PromiseToPay] = Field(default_factory=list)
    contacts: list[ContactAttempt] = Field(default_factory=list)

    #: Set when the borrower has asked not to be contacted, or is on DND.
    do_not_call: bool = False
    in_dispute: bool = False

    @property
    def live_promise(self) -> PromiseToPay | None:
        """An unbroken promise whose due date has not passed."""
        today = date(2026, 9, 14)
        for promise in sorted(self.promises, key=lambda p: p.due_on, reverse=True):
            if promise.kept is None and promise.due_on >= today:
                return promise
        return None

    @property
    def attempts_today(self) -> int:
        today = date(2026, 9, 14)
        return sum(1 for c in self.contacts if c.attempted_at == today)

    @property
    def broken_promises(self) -> int:
        return sum(1 for p in self.promises if p.kept is False)


class SandboxCollections:
    """A small portfolio covering the cases that actually change the decision."""

    def __init__(self) -> None:
        today = date(2026, 9, 14)
        self._cases: dict[str, CollectionsCase] = {}
        for case in [
            # Early-stage, contactable, no history: the routine digital nudge.
            CollectionsCase(
                case_id="C-1001",
                application_id="18302",
                borrower_name="Ayush Joshi",
                borrower_mobile_masked="XXXXXX3210",
                language="en-IN",
                dpd=8,
                outstanding_principal=Decimal("940000"),
                emi_amount=Decimal("21742"),
                overdue_amount=Decimal("21742"),
                bounces_6m=1,
                risk_band="AMBER",
                mandate_cap=Decimal("25000"),
                salary_credit_day=1,
            ),
            # Live promise: must NOT be chased again before it falls due.
            CollectionsCase(
                case_id="C-1002",
                borrower_name="Uday Singh",
                borrower_mobile_masked="XXXXXX7781",
                language="hi-IN",
                dpd=23,
                outstanding_principal=Decimal("3820000"),
                emi_amount=Decimal("35347"),
                overdue_amount=Decimal("35347"),
                bounces_6m=1,
                risk_band="GREEN",
                mandate_cap=Decimal("40000"),
                salary_credit_day=2,
                promises=[
                    PromiseToPay(
                        promised_on=today - timedelta(days=2),
                        due_on=today + timedelta(days=3),
                        amount=Decimal("35347"),
                    )
                ],
            ),
            # Deep delinquency with repeated breaks: a human conversation.
            CollectionsCase(
                case_id="C-1003",
                borrower_name="Farhan Qureshi",
                borrower_mobile_masked="XXXXXX4412",
                language="ta-IN",
                dpd=78,
                outstanding_principal=Decimal("2410000"),
                emi_amount=Decimal("33322"),
                overdue_amount=Decimal("99966"),
                bounces_6m=4,
                risk_band="RED",
                mandate_active=False,
                salary_credit_day=5,
                promises=[
                    PromiseToPay(
                        promised_on=today - timedelta(days=40),
                        due_on=today - timedelta(days=30),
                        amount=Decimal("33322"),
                        kept=False,
                    ),
                    PromiseToPay(
                        promised_on=today - timedelta(days=20),
                        due_on=today - timedelta(days=12),
                        amount=Decimal("33322"),
                        kept=False,
                    ),
                ],
            ),
            # Do-not-call: must be excluded from every voice plan.
            CollectionsCase(
                case_id="C-1004",
                borrower_name="Meera Iyer",
                borrower_mobile_masked="XXXXXX9023",
                dpd=15,
                outstanding_principal=Decimal("512000"),
                emi_amount=Decimal("14210"),
                overdue_amount=Decimal("14210"),
                risk_band="AMBER",
                do_not_call=True,
                salary_credit_day=7,
            ),
            # Disputed: collections stops, the dispute is worked instead.
            CollectionsCase(
                case_id="C-1005",
                borrower_name="Vikram Rao",
                borrower_mobile_masked="XXXXXX5567",
                dpd=41,
                outstanding_principal=Decimal("188000"),
                emi_amount=Decimal("9900"),
                overdue_amount=Decimal("19800"),
                risk_band="AMBER",
                in_dispute=True,
                salary_credit_day=1,
            ),
        ]:
            self._cases[case.case_id] = case

    async def list_cases(self, *, min_dpd: int = 0) -> list[CollectionsCase]:
        return [c for c in self._cases.values() if c.dpd >= min_dpd]

    async def get_case(self, case_id: str) -> CollectionsCase:
        from gravai_core.errors import NotFound

        try:
            return self._cases[case_id]
        except KeyError as exc:
            raise NotFound("Collections case not found", case_id=case_id) from exc
