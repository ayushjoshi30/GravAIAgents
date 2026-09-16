"""Business Rules Engine connector.

Graviton's BRE is the decisioning core: policy lives with the business team in a
no-code flow, not in this repository. GravAI never re-implements policy — it
calls the BRE and *explains* the result.

The sandbox adapter below evaluates a small, real rule set so the platform can
be exercised end to end without a live BRE. It is explicitly not the tenant's
policy, and says so in its policy version.
"""

from __future__ import annotations

import hashlib
from decimal import Decimal
from typing import Protocol

from gravai_core.money import as_percent, emi, foir, format_inr, ltv

from .models import BreEvaluation, BreRule, GravitonApplication, RuleOutcome

#: Marks an evaluation as coming from the sandbox, so nothing downstream can
#: mistake a demo decision for a policy decision.
SANDBOX_POLICY_VERSION = "sandbox-policy-v1 (NOT a tenant policy pack)"


class BreConnector(Protocol):
    async def evaluate(
        self, application: GravitonApplication, *, policy_version: str | None = None
    ) -> BreEvaluation: ...

    async def explain(self, evaluation: BreEvaluation) -> str: ...


def _evaluation_id(application_id: str, policy_version: str) -> str:
    digest = hashlib.sha256(f"{application_id}:{policy_version}".encode()).hexdigest()
    return f"bre-{digest[:12]}"


class SandboxBre:
    """A small but genuine rule set: FOIR, LTV, bureau, enquiries, vintage.

    Thresholds are illustrative. The point is that the Credit Appraisal Agent
    consumes real pass/fail structure with real observed values, so its
    explanations are exercised rather than mocked.
    """

    FOIR_CAP = Decimal("0.55")
    LTV_CAP = Decimal("0.80")
    MIN_BUREAU = 700
    MAX_ENQUIRIES_3M = 6
    MIN_VINTAGE_MONTHS = 6

    async def evaluate(
        self, application: GravitonApplication, *, policy_version: str | None = None
    ) -> BreEvaluation:
        version = policy_version or SANDBOX_POLICY_VERSION
        rules: list[BreRule] = []

        instalment: Decimal | None = None
        if (
            application.loan_amount
            and application.interest_rate_pct is not None
            and application.tenure_months
        ):
            instalment = emi(
                application.loan_amount,
                application.interest_rate_pct,
                application.tenure_months,
            )

        # --- FOIR -------------------------------------------------------
        if instalment is not None and application.net_monthly_income:
            ratio = foir(
                application.net_monthly_income,
                application.existing_monthly_emi or Decimal(0),
                instalment,
            )
            passed = ratio <= self.FOIR_CAP
            rules.append(
                BreRule(
                    rule_id="ELIG-FOIR-01",
                    name="Fixed Obligation to Income Ratio",
                    category="eligibility",
                    outcome=RuleOutcome.PASS if passed else RuleOutcome.FAIL,
                    observed=as_percent(ratio),
                    threshold=f"at most {as_percent(self.FOIR_CAP)}",
                    plain_language=(
                        f"Your total monthly loan repayments would be {as_percent(ratio)} "
                        f"of your monthly income. This lender allows up to "
                        f"{as_percent(self.FOIR_CAP)}."
                    ),
                    severity="L1" if not passed else "L3",
                )
            )
        else:
            rules.append(
                BreRule(
                    rule_id="ELIG-FOIR-01",
                    name="Fixed Obligation to Income Ratio",
                    category="eligibility",
                    outcome=RuleOutcome.NOT_APPLICABLE,
                    observed=None,
                    threshold=f"at most {as_percent(self.FOIR_CAP)}",
                    plain_language=(
                        "Income or instalment details were not available to assess this."
                    ),
                )
            )

        # --- LTV --------------------------------------------------------
        if application.loan_amount and application.collateral_value:
            ratio = ltv(application.loan_amount, application.collateral_value)
            passed = ratio <= self.LTV_CAP
            rules.append(
                BreRule(
                    rule_id="ELIG-LTV-01",
                    name="Loan to Value",
                    category="eligibility",
                    outcome=RuleOutcome.PASS if passed else RuleOutcome.FAIL,
                    observed=as_percent(ratio),
                    threshold=f"at most {as_percent(self.LTV_CAP)}",
                    plain_language=(
                        f"The loan is {as_percent(ratio)} of the property value of "
                        f"{format_inr(application.collateral_value)}. This lender lends up "
                        f"to {as_percent(self.LTV_CAP)}."
                    ),
                    severity="L1" if not passed else "L3",
                )
            )
        else:
            rules.append(
                BreRule(
                    rule_id="ELIG-LTV-01",
                    name="Loan to Value",
                    category="eligibility",
                    outcome=RuleOutcome.NOT_APPLICABLE,
                    threshold=f"at most {as_percent(self.LTV_CAP)}",
                    plain_language="No collateral was recorded, so this check does not apply.",
                )
            )

        # --- Bureau -----------------------------------------------------
        if application.bureau_score is not None:
            passed = application.bureau_score >= self.MIN_BUREAU
            rules.append(
                BreRule(
                    rule_id="RISK-BUREAU-01",
                    name="Credit bureau score",
                    category="risk",
                    outcome=RuleOutcome.PASS if passed else RuleOutcome.FAIL,
                    observed=str(application.bureau_score),
                    threshold=f"at least {self.MIN_BUREAU}",
                    plain_language=(
                        f"Your credit bureau score is {application.bureau_score}. "
                        f"This lender requires at least {self.MIN_BUREAU}."
                    ),
                    severity="L1" if not passed else "L3",
                )
            )

        # --- Recent enquiries -------------------------------------------
        if application.enquiries_3m is not None:
            passed = application.enquiries_3m <= self.MAX_ENQUIRIES_3M
            rules.append(
                BreRule(
                    rule_id="RISK-ENQ-01",
                    name="Credit enquiries in last 3 months",
                    category="risk",
                    outcome=RuleOutcome.PASS if passed else RuleOutcome.REFER,
                    observed=str(application.enquiries_3m),
                    threshold=f"at most {self.MAX_ENQUIRIES_3M}",
                    plain_language=(
                        f"There have been {application.enquiries_3m} credit enquiries on "
                        f"your file in the last three months; more than "
                        f"{self.MAX_ENQUIRIES_3M} is reviewed manually."
                    ),
                    severity="L2",
                )
            )

        # --- Employment vintage -----------------------------------------
        if application.employment_vintage_months is not None:
            passed = application.employment_vintage_months >= self.MIN_VINTAGE_MONTHS
            rules.append(
                BreRule(
                    rule_id="POLICY-VINTAGE-01",
                    name="Employment vintage",
                    category="policy",
                    outcome=RuleOutcome.PASS if passed else RuleOutcome.REFER,
                    observed=f"{application.employment_vintage_months} months",
                    threshold=f"at least {self.MIN_VINTAGE_MONTHS} months",
                    plain_language=(
                        f"You have been with your current employer for "
                        f"{application.employment_vintage_months} months; this lender "
                        f"reviews applications below {self.MIN_VINTAGE_MONTHS} months."
                    ),
                    severity="L2",
                )
            )

        if any(rule.outcome is RuleOutcome.FAIL for rule in rules):
            outcome = RuleOutcome.FAIL
        elif any(rule.outcome is RuleOutcome.REFER for rule in rules):
            outcome = RuleOutcome.REFER
        else:
            outcome = RuleOutcome.PASS

        return BreEvaluation(
            evaluation_id=_evaluation_id(application.application_id, version),
            application_id=application.application_id,
            policy_version=version,
            outcome=outcome,
            rules=rules,
        )

    async def explain(self, evaluation: BreEvaluation) -> str:
        """Plain-language summary for an adverse-action note."""
        if evaluation.outcome is RuleOutcome.PASS:
            return "Every policy check was met."
        lines = [
            rule.plain_language
            for rule in evaluation.rules
            if rule.outcome in (RuleOutcome.FAIL, RuleOutcome.REFER)
        ]
        return " ".join(lines) if lines else "No policy check explanation is available."
