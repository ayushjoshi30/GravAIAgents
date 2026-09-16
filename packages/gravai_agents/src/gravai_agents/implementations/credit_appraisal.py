"""Credit Appraisal Agent (P0).

Produces the Credit Appraisal Memorandum and explains every BRE outcome in
language an applicant could be shown.

Two design rules are load-bearing:

* **The numbers are computed, never generated.** FOIR, LTV and the instalment are
  arithmetic; the model never produces them. It writes the narrative *around*
  figures that code has already calculated, so a fluent explanation can never be
  attached to a wrong number.
* **The recommendation is advisory and always escalates.** A human underwriter
  decides. ``escalate`` is hardcoded true for the decision, not left to the
  model's judgement.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from gravai_connectors import BreEvaluation, GravitonApplication, RuleOutcome, SandboxBre
from gravai_core.money import as_percent, emi, foir, format_inr, ltv
from pydantic import BaseModel, ConfigDict, Field

from ..base import Agent, AgentContext, AgentResult
from ..guardrails import run_all
from ..prompting import input_block
from ..schemas import AgentOutput, Citation, Flag, FlagType


class Eligibility(BaseModel):
    model_config = ConfigDict(extra="forbid")

    net_monthly_income: Decimal | None = None
    existing_monthly_emi: Decimal | None = None
    proposed_emi: Decimal | None = None
    foir: Decimal | None = None
    foir_display: str | None = None
    ltv: Decimal | None = None
    ltv_display: str | None = None
    formula_inputs: dict[str, str] = Field(default_factory=dict)
    missing_inputs: list[str] = Field(default_factory=list)


class IncomeLine(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source: str
    monthly: Decimal
    evidence: str
    citation: Citation | None = None


class CrossCheck(BaseModel):
    model_config = ConfigDict(extra="forbid")

    check: str
    result: str = Field(pattern="^(pass|fail|na)$")
    detail: str


class BreRuleSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    rule_id: str
    name: str
    result: str
    observed: str | None = None
    threshold: str | None = None
    plain_language: str


class BreSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    evaluation_id: str
    policy_version: str
    outcome: str
    rules: list[BreRuleSummary] = Field(default_factory=list)


class Deviation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    parameter: str
    policy: str
    actual: str
    severity: str = Field(pattern="^(L1|L2|L3)$")
    justification_needed: bool = True


class Recommendation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    decision: str = Field(pattern="^(recommend_approve|recommend_reject|refer)$")
    amount: Decimal | None = None
    tenure_months: int | None = None
    rate: Decimal | None = None
    conditions: list[str] = Field(default_factory=list)


class CreditAppraisalOutput(AgentOutput):
    model_config = ConfigDict(extra="forbid")

    application_id: str
    eligibility: Eligibility = Field(default_factory=Eligibility)
    income_build_up: list[IncomeLine] = Field(default_factory=list)
    cross_checks: list[CrossCheck] = Field(default_factory=list)
    bre: BreSummary | None = None
    deviations: list[Deviation] = Field(default_factory=list)
    recommendation: Recommendation | None = None
    applicant_explanation: str = Field(
        default="",
        description="Adverse-action wording an applicant may be shown. No jargon, "
        "no protected attributes.",
    )


class Narrative(BaseModel):
    """The only thing the model is asked to produce: words, not numbers."""

    model_config = ConfigDict(extra="forbid")

    summary: str = Field(description="3-8 sentences for the underwriter, citing evidence")
    applicant_explanation: str = Field(
        description="Two to four plain sentences an applicant could be shown"
    )
    conditions: list[str] = Field(default_factory=list)


class CreditAppraisalAgent(Agent[CreditAppraisalOutput]):
    """Builds the Credit Appraisal Memorandum."""

    id = "credit_appraisal"
    name = "Credit Appraisal Agent"
    task = (
        "Write the underwriter's summary and the applicant-facing explanation for a "
        "credit appraisal whose figures have already been computed."
    )
    output_model = CreditAppraisalOutput
    tools = ("bre.evaluate", "bre.explain", "graviton.get_application")
    agent_rules = """
8. The figures in the input block are already computed and verified. Repeat them
   exactly if you reference them. Never recompute, round differently, or estimate
   any number.
9. The applicant explanation must be understandable by someone with no financial
   training, must not mention internal rule ids, and must not state or imply a
   final decision - a human underwriter decides.
"""

    async def run(
        self,
        ctx: AgentContext,
        *,
        application: GravitonApplication,
        bre: Any = None,
        bank_statement: Any = None,
        **_: Any,
    ) -> AgentResult[CreditAppraisalOutput]:
        bre_connector = bre or SandboxBre()

        # --- arithmetic, in code ----------------------------------------
        missing: list[str] = []
        for name in ("loan_amount", "tenure_months", "interest_rate_pct"):
            if getattr(application, name) is None:
                missing.append(name)

        instalment: Decimal | None = None
        if not missing:
            instalment = emi(
                application.loan_amount,  # type: ignore[arg-type]
                application.interest_rate_pct,  # type: ignore[arg-type]
                application.tenure_months,  # type: ignore[arg-type]
            )

        income = application.net_monthly_income
        if bank_statement is not None and getattr(bank_statement, "income", None) is not None:
            # Verified income beats declared income wherever we have it.
            verified = bank_statement.income.monthly_net_income_median
            if verified:
                income = verified

        existing = application.existing_monthly_emi or Decimal("0")
        if bank_statement is not None and getattr(bank_statement, "obligations", None):
            observed = bank_statement.obligations.total_monthly_emi
            if observed:
                existing = observed

        ratio: Decimal | None = None
        if instalment is not None and income:
            ratio = foir(income, existing, instalment)
        elif not income:
            missing.append("net_monthly_income")

        loan_to_value: Decimal | None = None
        if application.loan_amount and application.collateral_value:
            loan_to_value = ltv(application.loan_amount, application.collateral_value)
        elif application.collateral_value is None:
            missing.append("collateral_value")

        eligibility = Eligibility(
            net_monthly_income=income,
            existing_monthly_emi=existing,
            proposed_emi=instalment,
            foir=ratio,
            foir_display=as_percent(ratio) if ratio is not None else None,
            ltv=loan_to_value,
            ltv_display=as_percent(loan_to_value) if loan_to_value is not None else None,
            formula_inputs={
                "emi": "P * r * (1+r)^n / ((1+r)^n - 1), r = annual rate / 1200",
                "foir": "(existing_monthly_emi + proposed_emi) / net_monthly_income",
                "ltv": "loan_amount / collateral_value",
            },
            missing_inputs=sorted(set(missing)),
        )

        # --- policy, from the BRE ---------------------------------------
        evaluation: BreEvaluation = await bre_connector.evaluate(
            application, policy_version=ctx.policy_version or None
        )
        bre_summary = BreSummary(
            evaluation_id=evaluation.evaluation_id,
            policy_version=evaluation.policy_version,
            outcome=str(evaluation.outcome),
            rules=[
                BreRuleSummary(
                    rule_id=rule.rule_id,
                    name=rule.name,
                    result=str(rule.outcome),
                    observed=rule.observed,
                    threshold=rule.threshold,
                    plain_language=rule.plain_language,
                )
                for rule in evaluation.rules
            ],
        )

        deviations = [
            Deviation(
                parameter=rule.name,
                policy=rule.threshold or "per policy",
                actual=rule.observed or "unknown",
                severity=rule.severity,
                justification_needed=True,
            )
            for rule in evaluation.rules
            if rule.outcome in (RuleOutcome.FAIL, RuleOutcome.REFER)
        ]

        # --- income build-up and cross-checks ---------------------------
        income_build_up: list[IncomeLine] = []
        cross_checks: list[CrossCheck] = []
        if bank_statement is not None and getattr(bank_statement, "income", None):
            bsa_income = bank_statement.income
            if bsa_income.monthly_net_income_median:
                income_build_up.append(
                    IncomeLine(
                        source="salary_credits",
                        monthly=bsa_income.monthly_net_income_median,
                        evidence=bsa_income.basis,
                    )
                )
            declared = application.net_monthly_income
            if declared and bsa_income.monthly_net_income_median:
                gap = abs(declared - bsa_income.monthly_net_income_median) / declared
                cross_checks.append(
                    CrossCheck(
                        check="declared income vs bank credits",
                        result="pass" if gap <= Decimal("0.20") else "fail",
                        detail=(
                            f"declared {format_inr(declared)}, observed "
                            f"{format_inr(bsa_income.monthly_net_income_median)} "
                            f"({as_percent(gap)} apart)"
                        ),
                    )
                )
            cross_checks.append(
                CrossCheck(
                    check="statement reconciliation",
                    result="pass" if bank_statement.reconciled else "fail",
                    detail=(
                        "month-end balances reconcile"
                        if bank_statement.reconciled
                        else "statement does not reconcile; treat figures as unverified"
                    ),
                )
            )

        # --- decision ----------------------------------------------------
        if evaluation.outcome is RuleOutcome.FAIL:
            decision = "recommend_reject"
        elif evaluation.outcome is RuleOutcome.REFER or deviations or missing:
            decision = "refer"
        else:
            decision = "recommend_approve"

        # --- narrative, from the model ----------------------------------
        facts = input_block(
            {
                "application_id": application.application_id,
                "product": application.product,
                "loan_amount": str(application.loan_amount),
                "tenure_months": application.tenure_months,
                "interest_rate_pct": str(application.interest_rate_pct),
                "computed_emi": str(instalment),
                "net_monthly_income_used": str(income),
                "existing_monthly_emi_used": str(existing),
                "foir": eligibility.foir_display,
                "ltv": eligibility.ltv_display,
                "bre_outcome": str(evaluation.outcome),
                "failed_or_referred_rules": [
                    {
                        "name": r.name,
                        "observed": r.observed,
                        "threshold": r.threshold,
                        "plain_language": r.plain_language,
                    }
                    for r in evaluation.rules
                    if r.outcome in (RuleOutcome.FAIL, RuleOutcome.REFER)
                ],
                "missing_inputs": eligibility.missing_inputs,
                "provisional_decision": decision,
            }
        )
        narrative, step, calls = await self.ask(
            ctx,
            "Write the underwriter summary and the applicant-facing explanation for "
            "this appraisal. Use the figures exactly as given.\n\n" + facts,
            Narrative,
            step_name="write_memorandum",
        )

        flags: list[Flag] = []
        if missing:
            flags.append(
                Flag(
                    type=FlagType.QUALITY,
                    detail=f"Appraisal incomplete: missing {', '.join(sorted(set(missing)))}",
                    severity="medium",
                )
            )

        output = CreditAppraisalOutput(
            application_id=application.application_id,
            eligibility=eligibility,
            income_build_up=income_build_up,
            cross_checks=cross_checks,
            bre=bre_summary,
            deviations=deviations,
            recommendation=Recommendation(
                decision=decision,
                amount=application.loan_amount,
                tenure_months=application.tenure_months,
                rate=application.interest_rate_pct,
                conditions=narrative.conditions,
            ),
            applicant_explanation=narrative.applicant_explanation,
            flags=flags,
            # Always. A credit decision is a human's to make.
            escalate=True,
            escalation_reason="credit decisions require underwriter approval",
            reasoning_summary=narrative.summary,
        )

        report = run_all(
            output, known_document_ids=ctx.document_ids, allow_pii_fields=self.allow_pii_fields
        )
        return AgentResult(
            agent_id=self.id, output=output, steps=[step], validation=report, calls=calls
        )
