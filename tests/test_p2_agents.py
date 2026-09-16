"""The P2 agents: MSME underwriting, customer intelligence, ops research.

The volume-model tests are the load-bearing ones. They assert that the platform
reproduces, to the call, the figures from the hand-built production analysis it
was designed around — so if anyone changes the poll schedule or the call
accounting, the capacity plan stops agreeing with itself loudly rather than
quietly.
"""

from __future__ import annotations

from dataclasses import replace
from decimal import Decimal

import pytest
from gravai_agents import (
    Counterparty,
    CustomerDataIntelligenceAgent,
    CustomerSignal,
    GstReturn,
    MsmeUnderwritingAgent,
    OpsResearchAgent,
    VolumeAssumptions,
    backlog_projection,
    build_volume_model,
    implemented_ids,
    pending_ids,
    routing_scenarios,
)
from gravai_agents.base import AgentContext
from gravai_sarvam import RateGovernor, build_sarvam


async def _nosleep(_: float) -> None:
    return None


@pytest.fixture
async def sarvam():  # type: ignore[no-untyped-def]
    bundle = build_sarvam(
        polls_before_done=2,
        sleep=_nosleep,
        governor=RateGovernor(limits={"docai": 1_000_000.0, "llm": 1_000_000.0}),
    )
    yield bundle
    await bundle.aclose()


def _ctx() -> AgentContext:
    return AgentContext(tenant_id="acme", tenant_name="Acme Finance Limited")


# --- the volume model reproduces the production analysis ------------------


def test_model_reproduces_the_published_endpoint_volumes() -> None:
    """Every figure from the original hand-built study, to the call."""
    model = build_volume_model()

    assert model.assumptions.polls_per_document == 10
    assert model.endpoint("docai.extract").per_month == 68_976
    assert model.endpoint("docai.status").per_month == 689_760
    assert model.endpoint("docai.results").per_month == 68_976
    assert model.endpoint("chat.completions").per_month == 84_792
    assert model.endpoint("speech.stt").per_month == 3_533
    assert model.endpoint("speech.translate").per_month == 3_533
    assert model.total_calls_per_month == 919_570


def test_polling_is_three_quarters_of_all_traffic() -> None:
    """The finding a document count hides."""
    model = build_volume_model()
    assert model.poll_share == pytest.approx(0.75, abs=0.005)


def test_per_working_day_and_per_minute_match_the_study() -> None:
    model = build_volume_model()
    status = model.endpoint("docai.status")
    assert status.per_working_day() == 31_353
    assert status.per_minute() == pytest.approx(65.3, abs=0.1)


def test_reasoning_volume_is_fixed_per_application_not_per_document() -> None:
    """Doubling the documents must not move the reasoning call count."""
    base = VolumeAssumptions()
    doubled = replace(base, documents_per_month=base.documents_per_month * 2)
    assert (
        build_volume_model(doubled).endpoint("chat.completions").per_month
        == build_volume_model(base).endpoint("chat.completions").per_month
    )


def test_the_month_does_not_fit_inside_business_hours() -> None:
    """The constraint that outranks price."""
    throughput = build_volume_model().throughput
    assert throughput.fits_in_business_hours is False
    assert throughput.utilisation > 1.0


def test_backlog_matches_the_study_under_both_assumptions() -> None:
    """183.6 days if polls are free; 12x that if they count."""
    free = backlog_projection(2_644_052, polls_count=False)
    counted = backlog_projection(2_644_052, polls_count=True)

    assert free.days_continuous == pytest.approx(183.6, abs=0.5)
    assert counted.quota_units_per_document == 12
    assert counted.days_continuous / free.days_continuous == pytest.approx(12.0, abs=0.1)


def test_backoff_on_the_digitise_path_is_worth_millions_of_calls() -> None:
    """What D-006 actually buys.

    Flat 0.8s polling costs 38 polls a document; the back-off costs 10. On an
    all-digitise routing that is the difference between roughly 2.9M calls a
    month and under 1M.
    """
    base = VolumeAssumptions(digitise_share=1.0)
    with_backoff = build_volume_model(base)
    flat = build_volume_model(
        replace(
            base,
            poll_schedule=replace(base.poll_schedule, growth=1.0, cap=base.poll_schedule.first),
        )
    )
    assert flat.total_calls_per_month > 2_800_000
    assert with_backoff.total_calls_per_month < 1_000_000
    assert flat.total_calls_per_month - with_backoff.total_calls_per_month > 1_800_000


def test_digitise_does_not_reduce_submissions() -> None:
    """Routing to digitise buys no throughput relief: same submits, same quota."""
    scenarios = routing_scenarios()
    submits = {s.assumptions.documents_per_month for _, s in scenarios}
    assert len(submits) == 1


def test_digitise_adds_exactly_one_model_call_per_document() -> None:
    baseline = build_volume_model(VolumeAssumptions(digitise_share=0.0))
    everything = build_volume_model(VolumeAssumptions(digitise_share=1.0))
    difference = everything.total_calls_per_month - baseline.total_calls_per_month
    assert difference == baseline.assumptions.documents_per_month


async def test_ops_agent_reports_the_computed_figures(sarvam) -> None:  # type: ignore[no-untyped-def]
    result = await OpsResearchAgent(sarvam).run(_ctx())
    output = result.output

    assert output.total_calls_per_month == 919_570
    assert output.poll_share == pytest.approx(0.75, abs=0.005)
    assert output.throughput is not None
    assert output.throughput.fits_in_business_hours is False
    assert len(output.backlog_scenarios) == 2
    assert output.headline
    # Throughput failure is a capacity decision, not the agent's to take.
    assert output.escalate is True


async def test_ops_agent_surfaces_the_unverified_vendor_behaviour(sarvam) -> None:  # type: ignore[no-untyped-def]
    """The open question must be stated, not buried in a default."""
    result = await OpsResearchAgent(sarvam).run(_ctx())
    joined = " ".join(result.output.open_questions).lower()
    assert "status polls" in joined
    assert len(result.output.open_questions) >= 3


# --- MSME underwriting ----------------------------------------------------


def _returns(monthly: Decimal, gstin: str = "27AAPFU0939F1ZV") -> list[GstReturn]:
    return [
        GstReturn(gstin=gstin, period=f"2026-{month:02d}", taxable_value=monthly)
        for month in range(1, 13)
    ]


async def test_consistent_filings_pass(sarvam) -> None:  # type: ignore[no-untyped-def]
    result = await MsmeUnderwritingAgent(sarvam).run(
        _ctx(),
        application_id="M-1",
        gst_returns=_returns(Decimal("500000")),
        bank_credits_annual=Decimal("6000000"),
        itr_declared=Decimal("5800000"),
    )
    assert result.output.gstin_valid is True
    assert result.output.turnover.bank_to_gst_ratio == pytest.approx(1.0, abs=0.01)
    assert result.output.escalate is False


async def test_bank_credits_far_below_gst_is_flagged(sarvam) -> None:  # type: ignore[no-untyped-def]
    """Turnover declared to GST that never arrived in the bank."""
    result = await MsmeUnderwritingAgent(sarvam).run(
        _ctx(),
        application_id="M-2",
        gst_returns=_returns(Decimal("500000")),
        bank_credits_annual=Decimal("1500000"),
        itr_declared=Decimal("5800000"),
    )
    assert result.output.escalate is True
    assert any("Bank credits" in f.detail for f in result.output.flags)


async def test_income_understated_to_tax_is_flagged(sarvam) -> None:  # type: ignore[no-untyped-def]
    result = await MsmeUnderwritingAgent(sarvam).run(
        _ctx(),
        application_id="M-3",
        gst_returns=_returns(Decimal("500000")),
        bank_credits_annual=Decimal("6000000"),
        itr_declared=Decimal("1200000"),
    )
    assert any("declared to tax" in f.detail for f in result.output.flags)


async def test_invalid_gstin_checksum_is_caught(sarvam) -> None:  # type: ignore[no-untyped-def]
    result = await MsmeUnderwritingAgent(sarvam).run(
        _ctx(),
        application_id="M-4",
        gst_returns=_returns(Decimal("500000"), gstin="27AAPFU0939F1ZA"),
        bank_credits_annual=Decimal("6000000"),
    )
    assert result.output.gstin_valid is False
    assert result.output.escalate is True


async def test_circular_trading_is_detected(sarvam) -> None:  # type: ignore[no-untyped-def]
    """Near-equal money in and out with the same party inflates turnover."""
    result = await MsmeUnderwritingAgent(sarvam).run(
        _ctx(),
        application_id="M-5",
        gst_returns=_returns(Decimal("500000")),
        bank_credits_annual=Decimal("6000000"),
        counterparties=[
            Counterparty(
                name="Mirror Traders", inbound=Decimal("3000000"), outbound=Decimal("2900000")
            ),
            Counterparty(name="Genuine Buyer", inbound=Decimal("3000000")),
        ],
    )
    assert "Mirror Traders" in result.output.circular_counterparties
    assert result.output.escalate is True


async def test_underwriting_uses_the_most_conservative_turnover(sarvam) -> None:  # type: ignore[no-untyped-def]
    result = await MsmeUnderwritingAgent(sarvam).run(
        _ctx(),
        application_id="M-6",
        gst_returns=_returns(Decimal("500000")),
        bank_credits_annual=Decimal("5000000"),
        itr_declared=Decimal("5800000"),
    )
    assert result.output.assessed_annual_turnover == Decimal("5000000")


# --- customer data intelligence -------------------------------------------


def _signal(ref: str, **kwargs: object) -> CustomerSignal:
    base: dict[str, object] = {
        "customer_ref": ref,
        "consent_purposes": ["marketing"],
        "months_on_book": 18,
        "original_principal": Decimal("1000000"),
        "outstanding_principal": Decimal("500000"),
        "emi_amount": Decimal("20000"),
        "monthly_income": Decimal("100000"),
    }
    base.update(kwargs)
    return CustomerSignal(**base)  # type: ignore[arg-type]


async def test_customers_without_marketing_consent_are_excluded(sarvam) -> None:  # type: ignore[no-untyped-def]
    """Data collected to underwrite may not be used to market."""
    signals = [
        _signal("C1"),
        _signal("C2", consent_purposes=["underwriting"]),
    ]
    result = await CustomerDataIntelligenceAgent(sarvam).run(_ctx(), signals=signals)

    assert result.output.consented == 1
    assert result.output.excluded_no_consent == 1
    members = {c for s in result.output.segments for c in s.customers}
    assert "C2" not in members


async def test_every_segment_carries_a_readable_rule(sarvam) -> None:  # type: ignore[no-untyped-def]
    """A segment nobody can explain cannot be defended."""
    result = await CustomerDataIntelligenceAgent(sarvam).run(_ctx(), signals=[_signal("C1")])
    for segment in result.output.segments:
        assert len(segment.rule) > 20
        assert segment.suggested_action


async def test_top_up_segment_matches_a_clean_seasoned_borrower(sarvam) -> None:  # type: ignore[no-untyped-def]
    result = await CustomerDataIntelligenceAgent(sarvam).run(
        _ctx(), signals=[_signal("C1", risk_band="GREEN")]
    )
    top_up = next(s for s in result.output.segments if s.segment == "top_up_ready")
    assert "C1" in top_up.customers


async def test_pre_delinquency_catches_a_currently_clean_account(sarvam) -> None:  # type: ignore[no-untyped-def]
    """Up to date today, but the warning signs are there."""
    result = await CustomerDataIntelligenceAgent(sarvam).run(
        _ctx(), signals=[_signal("C9", bounces_12m=3, days_past_due=0)]
    )
    watch = next(s for s in result.output.segments if s.segment == "pre_delinquency_watch")
    assert "C9" in watch.customers


async def test_stretched_borrower_is_identified(sarvam) -> None:  # type: ignore[no-untyped-def]
    result = await CustomerDataIntelligenceAgent(sarvam).run(
        _ctx(),
        signals=[_signal("C5", emi_amount=Decimal("60000"), monthly_income=Decimal("100000"))],
    )
    stretched = next(s for s in result.output.segments if s.segment == "repayment_stretched")
    assert "C5" in stretched.customers


# --- registry -------------------------------------------------------------


def test_every_catalogued_agent_is_now_implemented() -> None:
    """All fourteen. Nothing in the catalog is a promise any more."""
    assert len(implemented_ids()) == 14
    assert pending_ids() == ()
