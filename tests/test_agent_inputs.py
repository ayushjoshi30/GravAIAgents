"""Supplied inputs must actually change the answer.

The failure this guards against is the quiet one: a form field that is
accepted, validated, and then never read, so the console looks interactive
while every run returns the same fixture. Each test below changes one input and
asserts the output moves in the direction it should.
"""

from __future__ import annotations

from decimal import Decimal

import pytest
from gravai_runner import run_agent
from gravai_runner.inputs import AGENT_INPUTS, inputs_for
from gravai_sarvam import build_sarvam


async def _nosleep(_: float) -> None:
    return None


@pytest.fixture
async def sarvam():
    bundle = build_sarvam(polls_before_done=1, sleep=_nosleep)
    yield bundle
    await bundle.aclose()


async def test_a_better_bureau_score_lowers_the_risk(sarvam) -> None:
    poor = await run_agent("risk_scoring", sarvam, inputs={"bureau_score": 560})
    good = await run_agent("risk_scoring", sarvam, inputs={"bureau_score": 820})
    assert poor.output.probability_30dpd_6m > good.output.probability_30dpd_6m


async def test_a_bigger_loan_raises_the_risk_through_foir(sarvam) -> None:
    """FOIR is derived, so the lever is the loan, and it has to reach the score."""
    small = await run_agent("risk_scoring", sarvam, inputs={"loan_amount": "200000"})
    large = await run_agent("risk_scoring", sarvam, inputs={"loan_amount": "4000000"})

    assert large.output.features["foir"] > small.output.features["foir"]
    assert large.output.probability_30dpd_6m > small.output.probability_30dpd_6m


async def test_more_bounces_raise_the_risk(sarvam) -> None:
    clean = await run_agent("risk_scoring", sarvam, inputs={"bounces_6m": 0})
    bouncy = await run_agent("risk_scoring", sarvam, inputs={"bounces_6m": 5})
    assert bouncy.output.probability_30dpd_6m > clean.output.probability_30dpd_6m


async def test_a_bigger_loan_means_a_bigger_emi(sarvam) -> None:
    small = await run_agent("credit_appraisal", sarvam, inputs={"loan_amount": "500000"})
    large = await run_agent("credit_appraisal", sarvam, inputs={"loan_amount": "2000000"})
    assert large.output.eligibility.proposed_emi > small.output.eligibility.proposed_emi


async def test_a_longer_tenure_lowers_the_emi(sarvam) -> None:
    short = await run_agent("credit_appraisal", sarvam, inputs={"tenure_months": 24})
    long = await run_agent("credit_appraisal", sarvam, inputs={"tenure_months": 120})
    assert long.output.eligibility.proposed_emi < short.output.eligibility.proposed_emi


async def test_an_unaffordable_loan_breaches_the_foir_cap(sarvam) -> None:
    """The policy rule has to actually bite, not just be reported."""
    result = await run_agent(
        "credit_appraisal",
        sarvam,
        inputs={"loan_amount": "9000000", "tenure_months": 24, "net_monthly_income": "40000"},
    )
    foir_rule = next(r for r in result.output.bre.rules if r.rule_id == "ELIG-FOIR-01")
    assert foir_rule.result == "fail", f"FOIR was {result.output.eligibility.foir_display}"


async def test_a_closing_balance_that_does_not_add_up_fails_reconciliation(sarvam) -> None:
    """Reconciliation is arithmetic, so a wrong closing balance must be caught."""
    honest = await run_agent("bank_statement_analytics", sarvam)
    assert honest.output.reconciled is True

    wrong = await run_agent(
        "bank_statement_analytics", sarvam, inputs={"closing_balance": "999999"}
    )
    assert wrong.output.reconciled is False


async def test_turnover_follows_the_declared_figures(sarvam) -> None:
    result = await run_agent(
        "msme_underwriting",
        sarvam,
        inputs={
            "monthly_taxable_value": "1000000",
            "bank_credits_annual": "12000000",
            "itr_declared": "11000000",
        },
    )
    # The most conservative of GST (12,000,000), bank (12,000,000), ITR (11,000,000).
    assert result.output.assessed_annual_turnover == Decimal("11000000")


async def test_counterparty_concentration_tracks_the_input(sarvam) -> None:
    spread = await run_agent("msme_underwriting", sarvam, inputs={"top_counterparty_share": 0.5})
    concentrated = await run_agent(
        "msme_underwriting", sarvam, inputs={"top_counterparty_share": 0.95}
    )
    assert concentrated.output.concentration_risk > spread.output.concentration_risk


async def test_a_call_outside_the_window_is_refused(sarvam) -> None:
    """The conduct rule is the point of the agent, so it must respond to the clock."""
    daytime = await run_agent("voice_collections", sarvam, inputs={"hour_ist": 11})
    assert daytime.output.permitted is True

    midnight = await run_agent("voice_collections", sarvam, inputs={"hour_ist": 23})
    assert midnight.output.permitted is False


async def test_the_volume_model_follows_the_assumptions(sarvam) -> None:
    small = await run_agent(
        "ops_research", sarvam, inputs={"applications_per_month": 100, "documents_per_month": 500}
    )
    large = await run_agent(
        "ops_research",
        sarvam,
        inputs={"applications_per_month": 10000, "documents_per_month": 300_000},
    )
    assert large.output.total_calls_per_month > small.output.total_calls_per_month * 10


async def test_a_bigger_book_segments_more_customers(sarvam) -> None:
    small = await run_agent("customer_data_intelligence", sarvam, inputs={"population": 9})
    big = await run_agent("customer_data_intelligence", sarvam, inputs={"population": 60})
    assert big.output.population == 60
    assert big.output.consented > small.output.consented


async def test_an_unknown_field_is_refused(sarvam) -> None:
    """Silently ignoring it is how a form stops meaning anything."""
    with pytest.raises(ValueError, match="Unknown input"):
        await run_agent("risk_scoring", sarvam, inputs={"not_a_field": 1})


async def test_a_value_outside_its_range_is_refused(sarvam) -> None:
    with pytest.raises(ValueError, match="at most"):
        await run_agent("risk_scoring", sarvam, inputs={"bureau_score": 5000})


def test_every_declared_field_is_read_by_the_runner() -> None:
    """A field in the schema that the runner never looks at is a lie.

    Cheap structural check: the field name must appear somewhere in the runner
    source. It cannot prove the value is used well, but it does catch a field
    that was declared and then forgotten.
    """
    import pathlib

    source = (
        pathlib.Path(__file__).resolve().parents[1]
        / "packages/gravai_runner/src/gravai_runner/sandbox.py"
    ).read_text(encoding="utf-8")

    missing: list[str] = []
    for agent_id, spec in AGENT_INPUTS.items():
        for f in spec.fields:
            if f.name not in source:
                missing.append(f"{agent_id}.{f.name}")
    assert not missing, f"declared but never read by the runner: {missing}"


def test_agents_without_editable_inputs_say_why() -> None:
    """Showing an empty form with no explanation is the worst of both."""
    for agent_id, spec in AGENT_INPUTS.items():
        if not spec.fields:
            assert spec.caveat, f"{agent_id} has no fields and no explanation"


# --- an omitted field must read from the source, not from a constant --------


async def test_an_omitted_field_reads_the_application_record(sarvam, monkeypatch) -> None:
    """The bug this guards: a declared default overwriting the real record.

    `resolve` used to fill every field with its default, and the runner could
    not tell that from a caller asking for that value. A no-input run therefore
    replaced whatever the record said with the constants in inputs.py — and the
    constants happened to match the fixture, so nothing looked wrong until the
    fixture moved.
    """
    from gravai_connectors import SandboxGraviton

    original = SandboxGraviton.get_application

    async def poor_applicant(self, external_id):  # type: ignore[no-untyped-def]
        record = await original(self, external_id)
        return record.model_copy(update={"bureau_score": 560, "enquiries_3m": 9})

    monkeypatch.setattr(SandboxGraviton, "get_application", poor_applicant)

    result = await run_agent("risk_scoring", sarvam)
    assert result.output.features["bureau_score"] == 560
    assert result.output.features["enquiries_3m"] == 9


async def test_both_doors_agree_when_nothing_is_supplied(sarvam, monkeypatch) -> None:
    """The REST door passes no fixtures; MCP and the CLI pass their own.

    That difference used to decide whether the resolved defaults were applied,
    so the same agent on the same record answered AMBER through one door and
    RED through the other.
    """
    from gravai_connectors import SandboxGraviton
    from gravai_runner import SandboxFixtures

    original = SandboxGraviton.get_application

    async def poor_applicant(self, external_id):  # type: ignore[no-untyped-def]
        record = await original(self, external_id)
        return record.model_copy(update={"bureau_score": 560})

    monkeypatch.setattr(SandboxGraviton, "get_application", poor_applicant)

    without_fixtures = await run_agent("risk_scoring", sarvam)
    with_fixtures = await run_agent(
        "risk_scoring",
        sarvam,
        fixtures=SandboxFixtures(sarvam, tenant_id="acme", tenant_name="Acme Finance Limited"),
    )

    assert (
        without_fixtures.output.probability_30dpd_6m == with_fixtures.output.probability_30dpd_6m
    )
    assert without_fixtures.output.band == with_fixtures.output.band


async def test_reconciliation_reads_the_balances_the_statement_states(
    sarvam, monkeypatch
) -> None:
    """The runner used to discard the reader's account context.

    It then reconciled the form's opening balance against the form's closing
    balance, which always succeeded, while the caveat claimed reconciliation
    was real.
    """
    from gravai_runner import sandbox as runner_module

    original = runner_module.transactions_from_documents

    def relabelled(result):
        transactions, _ = original(result)
        return transactions, {
            "account_number": "XXXXXXXX1111",
            "bank_name": "ICICI Bank",
            "opening_balance": 999_999,
            "closing_balance": 123_456,
        }

    monkeypatch.setattr(runner_module, "transactions_from_documents", relabelled)

    result = await run_agent("bank_statement_analytics", sarvam)
    account = result.output.accounts[0]

    assert account.bank == "ICICI Bank"
    assert account.account_last4 == "1111"
    assert account.opening_balance == Decimal("999999")
    # Those balances do not describe these transactions, so it must not reconcile.
    assert result.output.reconciled is False


async def test_the_volume_model_defaults_to_the_calibrated_book(sarvam) -> None:
    """A no-input run must report the published figures, not a rebuilt guess."""
    from gravai_agents.volume_model import VolumeAssumptions

    calibrated = await run_agent("ops_research", sarvam)
    assert (
        calibrated.output.assumptions["documents_per_month"]
        == VolumeAssumptions().documents_per_month
    )


async def test_one_changed_assumption_keeps_the_rest_calibrated(sarvam) -> None:
    """Rebuilding from scratch is how the whole model drifted by a quarter."""
    from gravai_agents.volume_model import VolumeAssumptions

    result = await run_agent("ops_research", sarvam, inputs={"job_seconds": 45})
    assert (
        result.output.assumptions["documents_per_month"]
        == VolumeAssumptions().documents_per_month
    )
    assert result.output.assumptions["job_seconds"] == 45


async def test_a_minority_buyer_share_round_trips(sarvam) -> None:
    """0.3 used to come back as 0.7.

    The agent sorts counterparties and takes the largest, so with only two
    buyers a share below half described the other one.
    """
    for share in (0.3, 0.5, 0.8):
        result = await run_agent(
            "msme_underwriting", sarvam, inputs={"top_counterparty_share": share}
        )
        assert abs(float(result.output.concentration_risk) - share) < 0.02, (
            f"share {share} came back as {result.output.concentration_risk}"
        )


def test_a_sourced_field_says_it_reads_from_its_source() -> None:
    """The form has to be able to say what leaving a field blank will do."""
    risk = inputs_for("risk_scoring")
    bureau = next(f for f in risk.fields if f.name == "bureau_score")
    assert bureau.sourced is True
    assert "bureau report" in bureau.blank_means

    hour = next(f for f in inputs_for("voice_collections").fields if f.name == "hour_ist")
    assert hour.sourced is False
    assert hour.blank_means == "use 11"


def test_resolve_returns_only_what_was_supplied() -> None:
    assert inputs_for("risk_scoring").resolve(None) == {}
    assert inputs_for("risk_scoring").resolve({"bureau_score": 640}) == {"bureau_score": 640}
    # A blank string is "leave it to the source", not "use the default".
    assert inputs_for("risk_scoring").resolve({"bureau_score": ""}) == {}


# --- a real source, supplied by the tenant ---------------------------------


def _source(payload: dict) -> object:
    import json

    from gravai_connectors.document_source import parse_source

    return parse_source(json.dumps(payload).encode(), "application/json")


REAL_STATEMENT = {
    "account": {
        "bank": "Kotak Mahindra Bank",
        "account_last4": "7731",
        "opening_balance": "25000",
        "closing_balance": "61000",
    },
    "transactions": [
        {"date": "2026-05-01", "description": "SALARY MAY", "credit": "90000"},
        {"date": "2026-05-05", "description": "HOME LOAN EMI", "debit": "32000"},
        {"date": "2026-05-20", "description": "NACH RTN INSUFFICIENT FUNDS", "debit": "22000"},
    ],
}


async def test_supplied_statement_lines_drive_the_real_analysis(sarvam) -> None:
    """No document-AI key involved: everything after extraction is arithmetic."""
    result = await run_agent("bank_statement_analytics", sarvam, source=_source(REAL_STATEMENT))
    account = result.output.accounts[0]

    assert account.bank == "Kotak Mahindra Bank"
    assert account.account_last4 == "7731"
    # 25,000 + 90,000 - 32,000 - 22,000 = 61,000
    assert result.output.reconciled is True
    # Found by the same regex that reads a real statement, on supplied narration.
    assert len(result.output.bounces) == 1


async def test_a_supplied_closing_balance_that_does_not_add_up_fails(sarvam) -> None:
    broken = {**REAL_STATEMENT, "account": {**REAL_STATEMENT["account"], "closing_balance": "99999"}}
    result = await run_agent("bank_statement_analytics", sarvam, source=_source(broken))
    assert result.output.reconciled is False


async def test_a_supplied_application_reaches_the_scorecard(sarvam) -> None:
    result = await run_agent(
        "risk_scoring",
        sarvam,
        source=_source({"application": {"bureau_score": 590, "loan_amount": "3000000"}}),
    )
    assert result.output.features["bureau_score"] == 590


async def test_an_explicit_override_still_beats_the_source(sarvam) -> None:
    """The form is a deliberate act; the source is data. The act wins."""
    result = await run_agent(
        "risk_scoring",
        sarvam,
        inputs={"bureau_score": 800},
        source=_source({"application": {"bureau_score": 590}}),
    )
    assert result.output.features["bureau_score"] == 800


async def test_a_field_the_application_model_does_not_have_is_ignored_not_fatal(sarvam) -> None:
    """Real endpoints carry extra columns; that must not fail the run."""
    result = await run_agent(
        "risk_scoring",
        sarvam,
        source=_source(
            {"application": {"bureau_score": 605, "branch_code": "MUM-11", "notes": "n/a"}}
        ),
    )
    assert result.output.features["bureau_score"] == 605
