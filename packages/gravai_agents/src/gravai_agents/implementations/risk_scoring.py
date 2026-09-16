"""Risk Agent (P1).

Probability of 30+ DPD within six months, banded GREEN / AMBER / RED.

The division of labour is the point: the **scorecard** computes the probability
and the contributions; the **model** writes the explanation from those
contributions and nothing else. That is what makes the explanation faithful —
a stated driver always corresponds to a real term in the score.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from gravai_connectors import GravitonApplication
from gravai_core.money import emi, foir, ltv
from pydantic import BaseModel, ConfigDict, Field

from ..base import Agent, AgentContext, AgentResult
from ..guardrails import run_all
from ..prompting import input_block
from ..schemas import AgentOutput, Band
from ..scorecard import RiskFeatures, ScoreResult, score


class DriverOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    feature: str
    value: float | int | None = None
    contribution: float
    direction: str
    imputed: bool = False


class RiskOutput(AgentOutput):
    model_config = ConfigDict(extra="forbid")

    application_id: str
    model_version: str
    features: dict[str, float | int | None] = Field(default_factory=dict)
    probability_30dpd_6m: float = Field(ge=0.0, le=1.0)
    band: Band
    band_thresholds: dict[str, str] = Field(
        default_factory=lambda: {
            "GREEN": "below 6%",
            "AMBER": "6% to 15%",
            "RED": "above 15%",
        }
    )
    top_drivers: list[DriverOut] = Field(default_factory=list)
    imputed_features: list[str] = Field(default_factory=list)
    explanation: str = ""


class RiskNarrative(BaseModel):
    """The only thing the model produces: words describing given drivers."""

    model_config = ConfigDict(extra="forbid")

    explanation: str = Field(
        description="Two to four sentences explaining the band using only the drivers given"
    )


class RiskScoringAgent(Agent[RiskOutput]):
    """Scores default risk from a versioned scorecard."""

    id = "risk_scoring"
    name = "Risk Agent"
    task = (
        "Explain, in plain language, why an application scored the risk band it did, "
        "using only the scorecard drivers supplied."
    )
    output_model = RiskOutput
    tools = ("risk.score_dpd", "graviton.get_application")
    agent_rules = """
8. You are NOT computing the risk. The probability, the band and the driver
   contributions are given to you, already calculated by a versioned scorecard.
   Repeat them exactly; never recompute, re-rank or round them differently.
9. Mention only drivers that appear in the supplied list. Inventing a reason the
   model did not actually use makes the explanation unfaithful, which is worse
   than no explanation at all.
10. Where a driver is marked imputed, say the information was unavailable rather
   than implying it was measured.
"""

    async def run(
        self,
        ctx: AgentContext,
        *,
        application: GravitonApplication,
        bank_statement: Any = None,
        **_: Any,
    ) -> AgentResult[RiskOutput]:
        features = self._features(application, bank_statement)
        result: ScoreResult = score(features)

        drivers = [
            DriverOut(
                feature=c.feature,
                value=c.value,
                contribution=c.contribution,
                direction=c.direction,
                imputed=c.imputed,
            )
            for c in result.top_drivers(4)
        ]

        facts = input_block(
            {
                "application_id": application.application_id,
                "scorecard_version": result.version,
                "probability_30dpd_6m": result.probability_30dpd_6m,
                "band": str(result.band),
                "band_thresholds": "GREEN below 6%, AMBER 6-15%, RED above 15%",
                "drivers": [d.model_dump() for d in drivers],
                "features_unavailable": result.imputed_features,
            }
        )
        narrative, step, calls = await self.ask(
            ctx,
            "Explain this risk band using only the drivers given.\n\n" + facts,
            RiskNarrative,
            step_name="explain_score",
        )

        output = RiskOutput(
            application_id=application.application_id,
            model_version=result.version,
            features=features.as_dict(),
            probability_30dpd_6m=result.probability_30dpd_6m,
            band=result.band,
            top_drivers=drivers,
            imputed_features=result.imputed_features,
            explanation=narrative.explanation,
            # A RED band is a human decision, and so is a score built mostly on
            # imputed features — the number is only as good as its inputs.
            escalate=result.band is Band.RED or len(result.imputed_features) >= 3,
            escalation_reason=(
                "RED band requires credit head review"
                if result.band is Band.RED
                else (
                    f"{len(result.imputed_features)} of 7 features were unavailable; "
                    "the score rests largely on imputed values"
                )
                if len(result.imputed_features) >= 3
                else None
            ),
            reasoning_summary=(
                f"Scored by {result.version}: probability "
                f"{result.probability_30dpd_6m:.1%}, band {result.band}. "
                f"Largest driver: {drivers[0].feature if drivers else 'none'}. "
                f"{len(result.imputed_features)} features were imputed."
            ),
        )

        report = run_all(output, known_document_ids=ctx.document_ids)
        return AgentResult(
            agent_id=self.id, output=output, steps=[step], validation=report, calls=calls
        )

    @staticmethod
    def _features(application: GravitonApplication, bank_statement: Any = None) -> RiskFeatures:
        """Assemble model inputs, preferring verified data over declared.

        Income and obligations observed in a bank statement beat what the
        applicant wrote on the form; that is the whole reason for reading the
        statement first.
        """
        income = application.net_monthly_income
        existing = application.existing_monthly_emi or Decimal("0")
        stability: float | None = None
        bounces: int | None = None

        if bank_statement is not None:
            assessment = getattr(bank_statement, "income", None)
            if assessment is not None:
                if assessment.monthly_net_income_median:
                    income = assessment.monthly_net_income_median
                stability = assessment.income_stability_score
            obligations = getattr(bank_statement, "obligations", None)
            if obligations is not None and obligations.total_monthly_emi:
                existing = obligations.total_monthly_emi
            bounces = len(getattr(bank_statement, "bounces", []) or [])

        ratio: float | None = None
        if (
            application.loan_amount
            and application.interest_rate_pct is not None
            and application.tenure_months
            and income
        ):
            instalment = emi(
                application.loan_amount,
                application.interest_rate_pct,
                application.tenure_months,
            )
            ratio = float(foir(income, existing, instalment))

        loan_to_value: float | None = None
        if application.loan_amount and application.collateral_value:
            loan_to_value = float(ltv(application.loan_amount, application.collateral_value))

        return RiskFeatures(
            foir=ratio,
            ltv=loan_to_value,
            bounces_6m=bounces,
            income_stability=stability,
            bureau_score=application.bureau_score,
            enquiries_3m=application.enquiries_3m,
            employment_vintage_months=application.employment_vintage_months,
        )
