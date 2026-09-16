"""Bank Statement Analytics Agent (P0).

Turns statements into income, obligations, bounces and balance behaviour.

The division of labour matters: **arithmetic is code, language is the model.**
Reconciliation, medians and EMI totals are computed deterministically, because
they are arithmetic and a model that is 99% right about a total is wrong. The
model is used only where judgement is genuinely needed — deciding what an
ambiguous narration means.
"""

from __future__ import annotations

import re
import statistics
from collections import defaultdict
from datetime import date
from decimal import Decimal
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from ..base import Agent, AgentContext, AgentResult, AgentStep
from ..guardrails import run_all
from ..schemas import AgentOutput, Citation, Flag, FlagType

# --- narration rules ------------------------------------------------------
# Deterministic first. Only what these cannot decide goes to the model.

SALARY_RE = re.compile(r"\b(SAL(ARY)?|PAYROLL|WAGES|NEFT.*SAL|CMS.*SAL)\b", re.IGNORECASE)
EMI_RE = re.compile(r"\b(NACH|ECS|ACH|EMI|LOAN\s*REPAY|SI\s*DR|MANDATE)\b", re.IGNORECASE)
BOUNCE_RE = re.compile(
    r"\b(RETURN(ED)?|BOUNCE|INSUFFICIENT|INSUFF|ECS\s*RTN|NACH\s*RTN|CHQ\s*RTN|DISHONOU?R)\b",
    re.IGNORECASE,
)
CASH_RE = re.compile(r"\b(CASH\s*DEP|CDM|BY\s*CASH|CASH\s*DEPOSIT)\b", re.IGNORECASE)
SELF_RE = re.compile(r"\b(SELF|OWN\s*ACCOUNT|TRF\s*TO\s*SELF)\b", re.IGNORECASE)

LENDER_RE = re.compile(
    r"\b(HDFC|ICICI|SBI|AXIS|KOTAK|BAJAJ|TATA\s*CAPITAL|IDFC|INDUSIND|YES\s*BANK|"
    r"CHOLA|MUTHOOT|MANAPPURAM|LIC\s*HFL|PNB|CANARA|UNION)\b",
    re.IGNORECASE,
)


class Transaction(BaseModel):
    """One statement line, as read from a document."""

    model_config = ConfigDict(extra="forbid")

    date: date
    narration: str
    amount: Decimal
    direction: str = Field(pattern="^(credit|debit)$")
    balance: Decimal | None = None
    document_id: str | None = None
    page: int | None = None


class AccountSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    account_last4: str
    bank: str | None = None
    period_from: date | None = None
    period_to: date | None = None
    opening_balance: Decimal | None = None
    closing_balance: Decimal | None = None
    avg_monthly_balance: Decimal | None = None
    min_balance: Decimal | None = None


class Credit(BaseModel):
    model_config = ConfigDict(extra="forbid")

    date: date
    amount: Decimal
    narration: str
    citation: Citation | None = None


class Obligation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    lender: str | None = None
    amount: Decimal
    frequency: str = "monthly"
    first_seen: date | None = None
    last_seen: date | None = None
    occurrences: int = 0
    citation: Citation | None = None


class Bounce(BaseModel):
    model_config = ConfigDict(extra="forbid")

    date: date
    amount: Decimal
    reason: str
    citation: Citation | None = None


class IncomeAssessment(BaseModel):
    model_config = ConfigDict(extra="forbid")

    salary_credits: list[Credit] = Field(default_factory=list)
    monthly_net_income_median: Decimal | None = None
    income_stability_score: float = Field(default=0.0, ge=0.0, le=1.0)
    months_observed: int = 0
    basis: str = ""


class ObligationAssessment(BaseModel):
    model_config = ConfigDict(extra="forbid")

    emis: list[Obligation] = Field(default_factory=list)
    total_monthly_emi: Decimal = Decimal("0")


class CashPattern(BaseModel):
    model_config = ConfigDict(extra="forbid")

    cash_deposit_ratio: float = 0.0
    round_amount_credits: int = 0


class BankStatementOutput(AgentOutput):
    model_config = ConfigDict(extra="forbid")

    accounts: list[AccountSummary] = Field(default_factory=list)
    income: IncomeAssessment = Field(default_factory=IncomeAssessment)
    obligations: ObligationAssessment = Field(default_factory=ObligationAssessment)
    bounces: list[Bounce] = Field(default_factory=list)
    cash_pattern: CashPattern = Field(default_factory=CashPattern)
    reconciled: bool = True


class BankStatementAnalyticsAgent(Agent[BankStatementOutput]):
    """Income, obligations and conduct, reconciled month by month."""

    id = "bank_statement_analytics"
    name = "Bank Statement Analytics Agent"
    task = "Assess income, obligations, bounces and balance behaviour from bank statements."
    output_model = BankStatementOutput
    tools = ()
    allow_pii_fields = frozenset({"account_last4", "narration", "value"})

    #: A salary needs at least this many consistent monthly credits.
    MIN_SALARY_OCCURRENCES = 3
    #: More than this many bounces in the window is an escalation.
    MAX_BOUNCES = 2
    #: Month-end balances must reconcile within a rupee.
    RECONCILIATION_TOLERANCE = Decimal("1.00")

    @staticmethod
    def classify(narration: str, direction: str) -> str:
        """Deterministic narration classification.

        Order matters: a returned NACH is a bounce, not an EMI, so the bounce
        rule is tested first.
        """
        if BOUNCE_RE.search(narration):
            return "bounce"
        if direction == "credit":
            if SELF_RE.search(narration):
                return "self_transfer"
            if SALARY_RE.search(narration):
                return "salary"
            if CASH_RE.search(narration):
                return "cash_deposit"
            return "other_credit"
        if EMI_RE.search(narration):
            return "emi"
        return "other_debit"

    async def run(
        self,
        ctx: AgentContext,
        *,
        transactions: list[Transaction],
        account_last4: str = "0000",
        bank: str | None = None,
        opening_balance: Decimal | None = None,
        closing_balance: Decimal | None = None,
        **_: Any,
    ) -> AgentResult[BankStatementOutput]:
        flags: list[Flag] = []
        steps: list[AgentStep] = []

        def cite(txn: Transaction) -> Citation | None:
            if txn.document_id:
                return Citation(document_id=txn.document_id, page=txn.page or 1)
            return None

        classified = [(txn, self.classify(txn.narration, txn.direction)) for txn in transactions]

        # --- income -----------------------------------------------------
        salary = [
            Credit(date=t.date, amount=t.amount, narration=t.narration, citation=cite(t))
            for t, kind in classified
            if kind == "salary"
        ]
        by_month: dict[tuple[int, int], list[Decimal]] = defaultdict(list)
        for credit in salary:
            by_month[(credit.date.year, credit.date.month)].append(credit.amount)
        # Seed the sum with Decimal so an empty month yields Decimal("0") rather
        # than int 0, which would make the list heterogeneous.
        monthly_totals: list[Decimal] = [sum(values, Decimal("0")) for values in by_month.values()]

        median_income: Decimal | None = None
        stability = 0.0
        basis = "no recurring salary credit identified"
        if len(monthly_totals) >= self.MIN_SALARY_OCCURRENCES:
            median_income = Decimal(str(statistics.median(monthly_totals))).quantize(
                Decimal("0.01")
            )
            if len(monthly_totals) > 1 and median_income > 0:
                spread = statistics.pstdev([float(v) for v in monthly_totals])
                stability = max(0.0, min(1.0, 1.0 - spread / float(median_income)))
            else:
                stability = 1.0
            basis = (
                f"median of {len(monthly_totals)} monthly salary credits identified by narration"
            )
        elif salary:
            basis = (
                f"only {len(monthly_totals)} month(s) of salary credits found; "
                f"at least {self.MIN_SALARY_OCCURRENCES} are required"
            )

        # --- obligations ------------------------------------------------
        emi_groups: dict[tuple[str | None, Decimal], list[Transaction]] = defaultdict(list)
        for txn, kind in classified:
            if kind != "emi":
                continue
            lender_match = LENDER_RE.search(txn.narration)
            lender = lender_match.group(1).upper() if lender_match else None
            emi_groups[(lender, txn.amount)].append(txn)

        obligations: list[Obligation] = []
        for (lender, amount), group in emi_groups.items():
            ordered = sorted(group, key=lambda t: t.date)
            obligations.append(
                Obligation(
                    lender=lender,
                    amount=amount,
                    frequency="monthly" if len(ordered) > 1 else "one_off",
                    first_seen=ordered[0].date,
                    last_seen=ordered[-1].date,
                    occurrences=len(ordered),
                    citation=cite(ordered[0]),
                )
            )
        # Only recurring debits count as an ongoing obligation.
        recurring = [o for o in obligations if o.occurrences > 1]
        total_emi = sum((o.amount for o in recurring), Decimal("0"))

        # --- bounces ----------------------------------------------------
        bounces = [
            Bounce(date=t.date, amount=t.amount, reason=t.narration, citation=cite(t))
            for t, kind in classified
            if kind == "bounce"
        ]
        if len(bounces) > self.MAX_BOUNCES:
            flags.append(
                Flag(
                    type=FlagType.FRAUD_SIGNAL,
                    detail=f"{len(bounces)} bounces in the statement window",
                    severity="high",
                )
            )

        # --- cash behaviour ---------------------------------------------
        credits = [t for t, k in classified if t.direction == "credit" and k != "self_transfer"]
        cash_total = sum((t.amount for t, k in classified if k == "cash_deposit"), Decimal("0"))
        credit_total = sum((t.amount for t in credits), Decimal("0"))
        cash_ratio = float(cash_total / credit_total) if credit_total else 0.0
        round_credits = sum(1 for t in credits if t.amount % Decimal("10000") == 0)

        # --- reconciliation ---------------------------------------------
        reconciled = True
        if opening_balance is not None and closing_balance is not None and transactions:
            net = sum(
                (t.amount if t.direction == "credit" else -t.amount for t in transactions),
                Decimal("0"),
            )
            expected = opening_balance + net
            if abs(expected - closing_balance) > self.RECONCILIATION_TOLERANCE:
                reconciled = False
                flags.append(
                    Flag(
                        type=FlagType.RECONCILIATION_FAILED,
                        detail=(
                            f"opening + credits - debits = {expected}, but the statement "
                            f"closes at {closing_balance}"
                        ),
                        severity="high",
                    )
                )

        balances = [t.balance for t in transactions if t.balance is not None]
        escalate = not reconciled or len(bounces) > self.MAX_BOUNCES or median_income is None

        output = BankStatementOutput(
            accounts=[
                AccountSummary(
                    account_last4=account_last4,
                    bank=bank,
                    period_from=min((t.date for t in transactions), default=None),
                    period_to=max((t.date for t in transactions), default=None),
                    opening_balance=opening_balance,
                    closing_balance=closing_balance,
                    avg_monthly_balance=(
                        Decimal(str(statistics.mean([float(b) for b in balances]))).quantize(
                            Decimal("0.01")
                        )
                        if balances
                        else None
                    ),
                    min_balance=min(balances) if balances else None,
                )
            ],
            income=IncomeAssessment(
                salary_credits=salary,
                monthly_net_income_median=median_income,
                income_stability_score=round(stability, 3),
                months_observed=len(monthly_totals),
                basis=basis,
            ),
            obligations=ObligationAssessment(emis=recurring, total_monthly_emi=total_emi),
            bounces=bounces,
            cash_pattern=CashPattern(
                cash_deposit_ratio=round(cash_ratio, 4), round_amount_credits=round_credits
            ),
            reconciled=reconciled,
            flags=flags,
            escalate=escalate,
            escalation_reason=(
                "statement does not reconcile"
                if not reconciled
                else f"{len(bounces)} bounces exceed the tolerance of {self.MAX_BOUNCES}"
                if len(bounces) > self.MAX_BOUNCES
                else "no reliable salary income could be established"
                if median_income is None
                else None
            ),
            reasoning_summary=(
                f"Classified {len(transactions)} transactions. Income basis: {basis}. "
                f"Found {len(recurring)} recurring obligations totalling {total_emi} per month "
                f"and {len(bounces)} bounces. Reconciliation "
                f"{'succeeded' if reconciled else 'FAILED'}."
            ),
        )

        steps.append(
            AgentStep(
                name="classify_transactions",
                kind="deterministic",
                output_digest=str(len(classified)),
                validation=[],
            )
        )

        known = {t.document_id for t in transactions if t.document_id}
        report = run_all(output, known_document_ids=known, allow_pii_fields=self.allow_pii_fields)
        return AgentResult(agent_id=self.id, output=output, steps=steps, validation=report)
