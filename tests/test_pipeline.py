"""The credit pipeline, end to end in sandbox.

Documents to memorandum, with no network and no spend. This is the test that
would catch a regression anywhere along the chain.
"""

from __future__ import annotations

from decimal import Decimal

import pytest
from gravai_agents import (
    BankStatementAnalyticsAgent,
    Transaction,
    build_agent,
    implemented_ids,
    run_credit_pipeline,
)
from gravai_agents.implementations.bank_statement_analytics import (
    BankStatementAnalyticsAgent as BSA,
)
from gravai_connectors import SandboxBre, SandboxGraviton
from gravai_core.errors import NotFound
from gravai_sarvam import RateGovernor, build_sarvam


async def _nosleep(_: float) -> None:
    return None


def _sarvam():  # type: ignore[no-untyped-def]
    """A sandbox bundle with the rate ceiling lifted, so tests are fast.

    The ceiling itself is asserted in test_governor.py; re-imposing it here
    would only make every pipeline test wait six seconds a call.
    """
    return build_sarvam(
        polls_before_done=3,
        sleep=_nosleep,
        governor=RateGovernor(limits={"docai": 1_000_000.0, "llm": 1_000_000.0}),
    )


@pytest.fixture
async def pipeline():  # type: ignore[no-untyped-def]
    sarvam = _sarvam()
    result = await run_credit_pipeline(
        sarvam,
        application_id="18302",
        tenant_id="acme",
        tenant_name="Acme Finance Limited",
    )
    yield result
    await sarvam.aclose()


async def test_every_document_is_read(pipeline) -> None:  # type: ignore[no-untyped-def]
    assert len(pipeline.documents.output.documents) == 8
    assert pipeline.documents.output.total_pages > 0


async def test_call_count_exceeds_document_count(pipeline) -> None:  # type: ignore[no-untyped-def]
    """The thesis of the whole platform: requests, not documents, are the unit."""
    documents = len(pipeline.documents.output.documents)
    assert pipeline.documents.output.total_calls > documents * 4


async def test_income_is_verified_from_the_statement(pipeline) -> None:  # type: ignore[no-untyped-def]
    income = pipeline.bank_statement.output.income
    assert income.monthly_net_income_median == Decimal("85000.00")
    assert income.months_observed == 6


async def test_recurring_obligation_is_detected(pipeline) -> None:  # type: ignore[no-untyped-def]
    obligations = pipeline.bank_statement.output.obligations
    assert obligations.total_monthly_emi == Decimal("12000")
    assert obligations.emis[0].lender == "HDFC"


async def test_a_returned_mandate_is_a_bounce_not_an_emi(pipeline) -> None:  # type: ignore[no-untyped-def]
    """Order of classification matters: NACH RTN is a bounce."""
    assert len(pipeline.bank_statement.output.bounces) == 1
    assert "RTN" in pipeline.bank_statement.output.bounces[0].reason


async def test_statement_reconciles(pipeline) -> None:  # type: ignore[no-untyped-def]
    assert pipeline.bank_statement.output.reconciled is True


async def test_eligibility_is_computed_not_generated(pipeline) -> None:  # type: ignore[no-untyped-def]
    """The worked example, arrived at through the whole chain."""
    eligibility = pipeline.appraisal.output.eligibility
    assert eligibility.proposed_emi == Decimal("21742.42")
    assert eligibility.foir_display == "39.7%"


async def test_bre_outcome_is_carried_into_the_memorandum(pipeline) -> None:  # type: ignore[no-untyped-def]
    bre = pipeline.appraisal.output.bre
    assert bre is not None
    assert bre.outcome == "pass"
    assert any(rule.rule_id == "ELIG-FOIR-01" for rule in bre.rules)


async def test_credit_decisions_always_escalate(pipeline) -> None:  # type: ignore[no-untyped-def]
    """Never automated, regardless of how clean the file is."""
    assert pipeline.appraisal.output.escalate is True
    assert "underwriter" in (pipeline.appraisal.output.escalation_reason or "")


async def test_applicant_explanation_is_produced_and_clean(pipeline) -> None:  # type: ignore[no-untyped-def]
    explanation = pipeline.appraisal.output.applicant_explanation
    assert len(explanation) > 40
    assert "ELIG-" not in explanation, "no internal rule ids in applicant-facing text"


async def test_every_stage_passes_its_validators(pipeline) -> None:  # type: ignore[no-untyped-def]
    assert pipeline.documents.validation.ok, pipeline.documents.validation.violations
    assert pipeline.bank_statement.validation.ok
    assert pipeline.appraisal.validation.ok


async def test_the_run_is_priced(pipeline) -> None:  # type: ignore[no-untyped-def]
    assert pipeline.cost_inr > Decimal("0")


async def test_a_weak_file_produces_real_bre_failures() -> None:
    """Application 18303 fails bureau and is referred on enquiries and vintage."""
    sarvam = _sarvam()
    try:
        result = await run_credit_pipeline(
            sarvam,
            application_id="18303",
            tenant_id="acme",
            graviton=SandboxGraviton(),
            bre=SandboxBre(),
        )
        bre = result.appraisal.output.bre
        assert bre is not None
        assert bre.outcome == "fail"
        failed = [r.name for r in bre.rules if r.result == "fail"]
        assert "Credit bureau score" in failed
        assert result.appraisal.output.recommendation.decision == "recommend_reject"
        assert result.appraisal.output.deviations, "failures must become deviations"
    finally:
        await sarvam.aclose()


async def test_pipeline_warns_when_income_cannot_be_verified() -> None:
    """No statement means declared income, and the run says so rather than hiding it."""
    sarvam = _sarvam()
    los = SandboxGraviton()
    application = await los.get_application("18303")
    los.set_documents(
        "18303",
        [d for d in application.documents if d.declared_type != "income.bank_statement"],
    )
    try:
        result = await run_credit_pipeline(
            sarvam, application_id="18303", tenant_id="acme", graviton=los
        )
        assert result.bank_statement is None
        assert any("declared income" in w for w in result.warnings)
        # The appraisal still runs; it just rests on unverified figures.
        assert result.appraisal.output.eligibility.foir is not None
    finally:
        await sarvam.aclose()


# --- the analytics agent in isolation ------------------------------------


@pytest.mark.parametrize(
    ("narration", "direction", "expected"),
    [
        ("NEFT SALARY CREDIT ACME LTD", "credit", "salary"),
        ("NACH DR HDFC HOME LOAN", "debit", "emi"),
        ("NACH RTN INSUFFICIENT FUNDS", "debit", "bounce"),
        ("CASH DEP CDM BRANCH 0421", "credit", "cash_deposit"),
        ("TRF TO SELF", "credit", "self_transfer"),
        ("UPI/1234/GROCERY", "debit", "other_debit"),
    ],
)
def test_narration_classification(narration: str, direction: str, expected: str) -> None:
    assert BSA.classify(narration, direction) == expected


async def test_reconciliation_failure_is_flagged_and_escalates() -> None:
    """A statement whose balances do not add up must not be quietly used."""
    from datetime import date

    sarvam = _sarvam()
    try:
        agent = BankStatementAnalyticsAgent(sarvam)
        result = await agent.run(
            __import__("gravai_agents").AgentContext(tenant_id="acme"),
            transactions=[
                Transaction(
                    date=date(2026, 3, 1),
                    narration="NEFT SALARY CREDIT ACME LTD",
                    amount=Decimal("85000"),
                    direction="credit",
                )
            ],
            opening_balance=Decimal("1000"),
            closing_balance=Decimal("999999"),
        )
        assert result.output.reconciled is False
        assert result.output.escalate is True
        assert any(f.type == "reconciliation_failed" for f in result.output.flags)
    finally:
        await sarvam.aclose()


# --- registry -------------------------------------------------------------


def test_the_three_p0_agents_are_implemented() -> None:
    """The credit core. The full registry state is asserted in test_p1_agents."""
    assert {"doc_intelligence", "bank_statement_analytics", "credit_appraisal"} <= set(
        implemented_ids()
    )


def test_building_an_unimplemented_agent_says_so_plainly(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """A catalog entry without an implementation must say so, not fail obscurely.

    Every agent is implemented now, so the gap is simulated. The behaviour still
    matters: it is what a fourteenth catalog entry would hit.
    """
    from gravai_agents import registry

    patched = dict(registry.IMPLEMENTATIONS)
    patched.pop("ops_research")
    monkeypatch.setattr(registry, "IMPLEMENTATIONS", patched)

    with pytest.raises(NotFound, match="no implementation"):
        registry.build_agent("ops_research", _sarvam())


def test_building_an_unknown_agent_raises() -> None:
    sarvam = _sarvam()
    with pytest.raises(NotFound, match="Unknown agent"):
        build_agent("not_an_agent", sarvam)
