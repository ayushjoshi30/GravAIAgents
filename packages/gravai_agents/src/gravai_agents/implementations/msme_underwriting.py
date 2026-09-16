"""MSME Underwriting Agent (P2).

Underwrites thin-file business borrowers by cross-verifying the three things a
business declares in three different places: GST returns, income-tax returns,
and money actually arriving in the bank.

The value is entirely in the disagreements. Each source is filed for a different
reason and audited by a different body, so a business that has overstated
turnover to a lender will usually be consistent with itself in one place and not
the others. The agent computes the gaps; it does not decide what they mean.
"""

from __future__ import annotations

from collections import defaultdict
from decimal import Decimal
from typing import Any

from gravai_core.pii import is_valid_gstin
from pydantic import BaseModel, ConfigDict, Field

from ..base import Agent, AgentContext, AgentResult, AgentStep
from ..guardrails import run_all
from ..schemas import AgentOutput, Flag, FlagType


class GstReturn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    gstin: str
    period: str
    taxable_value: Decimal
    tax: Decimal = Decimal("0")


class Counterparty(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    inbound: Decimal = Decimal("0")
    outbound: Decimal = Decimal("0")


class TurnoverView(BaseModel):
    model_config = ConfigDict(extra="forbid")

    gst_annual: Decimal | None = None
    bank_credits_annual: Decimal | None = None
    itr_declared: Decimal | None = None
    #: Bank credits divided by GST turnover. Near 1.0 is consistent.
    bank_to_gst_ratio: float | None = None
    itr_to_gst_ratio: float | None = None


class MsmeOutput(AgentOutput):
    model_config = ConfigDict(extra="forbid")

    application_id: str
    gstin: str | None = None
    gstin_valid: bool = False
    turnover: TurnoverView = Field(default_factory=TurnoverView)
    monthly_gst_turnover: dict[str, str] = Field(default_factory=dict)
    seasonality_ratio: float | None = Field(
        default=None, description="Peak month over median month"
    )
    top_counterparties: list[Counterparty] = Field(default_factory=list)
    concentration_risk: float = Field(
        default=0.0, description="Largest counterparty share of inbound value"
    )
    circular_counterparties: list[str] = Field(default_factory=list)
    assessed_annual_turnover: Decimal | None = None
    basis: str = ""


class MsmeUnderwritingAgent(Agent[MsmeOutput]):
    """Cross-verifies a business borrower's declared turnover."""

    id = "msme_underwriting"
    name = "MSME Underwriting Agent"
    task = "Cross-verify GST, ITR and bank turnover for a business borrower."
    output_model = MsmeOutput
    tools = ("docai.extract", "graviton.get_application")
    allow_pii_fields = frozenset({"gstin", "name", "value"})

    #: Bank credits within this band of GST turnover are consistent.
    CONSISTENT_LOW = 0.75
    CONSISTENT_HIGH = 1.25
    #: A single counterparty above this share of inbound value is a concentration.
    CONCENTRATION_LIMIT = 0.25

    async def run(
        self,
        ctx: AgentContext,
        *,
        application_id: str,
        gst_returns: list[GstReturn],
        bank_credits_annual: Decimal | None = None,
        itr_declared: Decimal | None = None,
        counterparties: list[Counterparty] | None = None,
        **_: Any,
    ) -> AgentResult[MsmeOutput]:
        flags: list[Flag] = []

        gstin = gst_returns[0].gstin if gst_returns else None
        gstin_valid = bool(gstin and is_valid_gstin(gstin))
        if gstin and not gstin_valid:
            flags.append(
                Flag(
                    type=FlagType.MISMATCH,
                    detail="GSTIN fails its checksum; the number is not genuine",
                    evidence=gstin,
                    severity="high",
                )
            )
        if gst_returns and len({r.gstin for r in gst_returns}) > 1:
            flags.append(
                Flag(
                    type=FlagType.MISMATCH,
                    detail="Returns were filed under more than one GSTIN",
                    severity="medium",
                )
            )

        # --- turnover ----------------------------------------------------
        monthly: dict[str, Decimal] = defaultdict(lambda: Decimal("0"))
        for entry in gst_returns:
            monthly[entry.period] += entry.taxable_value
        gst_annual = sum(monthly.values(), Decimal("0")) if monthly else None

        bank_ratio = (
            float(bank_credits_annual / gst_annual)
            if gst_annual and gst_annual > 0 and bank_credits_annual is not None
            else None
        )
        itr_ratio = (
            float(itr_declared / gst_annual)
            if gst_annual and gst_annual > 0 and itr_declared is not None
            else None
        )

        if bank_ratio is not None and not (
            self.CONSISTENT_LOW <= bank_ratio <= self.CONSISTENT_HIGH
        ):
            flags.append(
                Flag(
                    type=FlagType.MISMATCH,
                    detail=(
                        f"Bank credits are {bank_ratio:.0%} of GST turnover; consistent "
                        f"filings fall between {self.CONSISTENT_LOW:.0%} and "
                        f"{self.CONSISTENT_HIGH:.0%}"
                    ),
                    severity="high" if bank_ratio < 0.5 or bank_ratio > 2.0 else "medium",
                )
            )
        if itr_ratio is not None and itr_ratio < self.CONSISTENT_LOW:
            flags.append(
                Flag(
                    type=FlagType.MISMATCH,
                    detail=(
                        f"Income declared to tax is {itr_ratio:.0%} of GST turnover; the "
                        f"business has reported materially less to one authority than the other"
                    ),
                    severity="high",
                )
            )

        # --- seasonality --------------------------------------------------
        seasonality: float | None = None
        if len(monthly) >= 3:
            values = sorted(monthly.values())
            median = values[len(values) // 2]
            if median > 0:
                seasonality = round(float(max(values) / median), 2)

        # --- counterparties -----------------------------------------------
        parties = counterparties or []
        total_inbound = sum((p.inbound for p in parties), Decimal("0"))
        top = sorted(parties, key=lambda p: p.inbound, reverse=True)[:5]
        concentration = (
            round(float(top[0].inbound / total_inbound), 4) if top and total_inbound > 0 else 0.0
        )
        if concentration > self.CONCENTRATION_LIMIT:
            flags.append(
                Flag(
                    type=FlagType.QUALITY,
                    detail=(
                        f"{concentration:.0%} of inbound value comes from a single "
                        f"counterparty; losing it would remove most of the revenue"
                    ),
                    severity="medium",
                )
            )

        # Money going out to, and coming back from, the same party is the
        # signature of turnover inflated by circular trading.
        circular = [
            p.name
            for p in parties
            if p.inbound > 0
            and p.outbound > 0
            and min(p.inbound, p.outbound) / max(p.inbound, p.outbound) > Decimal("0.7")
        ]
        if circular:
            flags.append(
                Flag(
                    type=FlagType.FRAUD_SIGNAL,
                    detail=(
                        "Near-equal money in and out with the same counterparties, which is "
                        "consistent with circular trading inflating turnover"
                    ),
                    evidence=", ".join(circular),
                    severity="high",
                )
            )

        # The lowest credible figure is the one to underwrite on.
        candidates = [v for v in (gst_annual, bank_credits_annual, itr_declared) if v]
        assessed = min(candidates) if candidates else None
        basis = (
            "The most conservative of GST, bank credits and declared income."
            if candidates
            else "No turnover evidence was available."
        )

        output = MsmeOutput(
            application_id=application_id,
            gstin=gstin,
            gstin_valid=gstin_valid,
            turnover=TurnoverView(
                gst_annual=gst_annual,
                bank_credits_annual=bank_credits_annual,
                itr_declared=itr_declared,
                bank_to_gst_ratio=round(bank_ratio, 4) if bank_ratio is not None else None,
                itr_to_gst_ratio=round(itr_ratio, 4) if itr_ratio is not None else None,
            ),
            monthly_gst_turnover={k: str(v) for k, v in sorted(monthly.items())},
            seasonality_ratio=seasonality,
            top_counterparties=top,
            concentration_risk=concentration,
            circular_counterparties=circular,
            assessed_annual_turnover=assessed,
            basis=basis,
            flags=flags,
            escalate=any(f.severity == "high" for f in flags) or assessed is None,
            escalation_reason=(
                "; ".join(f.detail for f in flags if f.severity == "high")
                or ("No turnover evidence was available" if assessed is None else None)
            ),
            reasoning_summary=(
                f"Cross-verified {len(gst_returns)} GST return(s) against bank credits and "
                f"declared income. {len(flags)} discrepancy flag(s). Underwriting turnover "
                f"taken as the most conservative source."
            ),
        )

        step = AgentStep(name="cross_verify_turnover", kind="deterministic")
        report = run_all(
            output, known_document_ids=ctx.document_ids, allow_pii_fields=self.allow_pii_fields
        )
        return AgentResult(agent_id=self.id, output=output, steps=[step], validation=report)
