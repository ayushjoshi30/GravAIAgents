"""Account Aggregator data, and the collections cycle end to end.

The AA tests are mostly about *refusal*: a consent framework is only worth
anything if the code declines to fetch when it should. The collections tests are
about ordering — suppression before scoring, mandates before calls.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from gravai_agents import (
    AaDataAgent,
    BankStatementAnalyticsAgent,
    implemented_ids,
    pending_ids,
    run_collections_pipeline,
)
from gravai_agents.base import AgentContext
from gravai_connectors import (
    ConsentStatus,
    PurposeCode,
    SandboxAccountAggregator,
    SandboxCollections,
)
from gravai_core.errors import Forbidden
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


# --- consent lifecycle ----------------------------------------------------


async def test_a_fresh_consent_permits_a_fetch() -> None:
    aa = SandboxAccountAggregator()
    artefact = await aa.request_consent("cust-1", PurposeCode.LOAN_UNDERWRITING, 12)
    usable, reason = artefact.is_usable()
    assert usable is True
    assert reason is None


async def test_a_revoked_consent_refuses_and_explains() -> None:
    """The borrower may withdraw at any time, and the refusal must be sayable."""
    aa = SandboxAccountAggregator()
    artefact = await aa.request_consent("cust-2")
    await aa.revoke(artefact.consent_handle)

    with pytest.raises(Forbidden, match="revoked"):
        await aa.fetch(artefact.consent_handle)


async def test_an_expired_consent_refuses() -> None:
    aa = SandboxAccountAggregator()
    artefact = await aa.request_consent("cust-3")
    artefact.consent_expiry = datetime.now(UTC) - timedelta(days=1)

    usable, reason = artefact.is_usable()
    assert usable is False
    assert "expired" in (reason or "").lower()


async def test_purpose_limitation_is_enforced() -> None:
    """Data pulled to underwrite a loan may not be reused to market one."""
    aa = SandboxAccountAggregator()
    artefact = await aa.request_consent("cust-4", PurposeCode.LOAN_UNDERWRITING)

    with pytest.raises(Forbidden, match="Purpose limitation"):
        await aa.fetch(artefact.consent_handle, PurposeCode.CUSTOMER_SPENDING)


async def test_fetch_frequency_is_exhausted_after_the_agreed_count() -> None:
    aa = SandboxAccountAggregator()
    artefact = await aa.request_consent("cust-5")
    await aa.fetch(artefact.consent_handle)

    with pytest.raises(Forbidden, match="frequency"):
        await aa.fetch(artefact.consent_handle)


async def test_retention_expiry_is_derived_from_the_artefact() -> None:
    aa = SandboxAccountAggregator()
    artefact = await aa.request_consent("cust-6")
    assert artefact.retention_expires_on > artefact.consent_start.date()


# --- the agent ------------------------------------------------------------


async def test_agent_normalises_aa_data_into_the_statement_shape(sarvam) -> None:  # type: ignore[no-untyped-def]
    """The point of the agent: AA data is a drop-in for the document path."""
    aa = SandboxAccountAggregator()
    result = await AaDataAgent(sarvam).run(_ctx(), connector=aa, customer_ref="cust-7")

    assert result.output.transaction_count == 13
    assert result.output.accounts[0].masked_account_number == "XXXXXXXX9012"
    first = result.output.transactions[0]
    assert first.direction in ("credit", "debit")
    # ReBIT says CREDIT/DEBIT; downstream speaks lowercase.
    assert first.narration


async def test_normalised_data_reaches_the_same_conclusions_as_documents(sarvam) -> None:  # type: ignore[no-untyped-def]
    """A file sourced through AA must underwrite identically to one from PDFs.

    Same borrower, same conduct, same numbers — which is what makes AA a
    replacement for the document path rather than a divergent second one.
    """
    aa = SandboxAccountAggregator()
    fetched = await AaDataAgent(sarvam).run(_ctx(), connector=aa, customer_ref="cust-8")

    analysis = await BankStatementAnalyticsAgent(sarvam).run(
        _ctx(),
        transactions=fetched.output.transactions,
        account_last4="9012",
        bank="HDFC Bank",
        opening_balance=Decimal("52000"),
        closing_balance=Decimal("514000"),
    )

    assert analysis.output.income.monthly_net_income_median == Decimal("85000.00")
    assert analysis.output.obligations.total_monthly_emi == Decimal("12000")
    assert len(analysis.output.bounces) == 1
    assert analysis.output.reconciled is True


async def test_sandbox_data_always_escalates(sarvam) -> None:  # type: ignore[no-untyped-def]
    """Fixture data must never quietly underwrite a real decision."""
    aa = SandboxAccountAggregator()
    result = await AaDataAgent(sarvam).run(_ctx(), connector=aa, customer_ref="cust-9")

    assert result.output.live_data is False
    assert result.output.escalate is True
    assert any("licensed AA" in flag.detail for flag in result.output.flags)


async def test_a_refused_consent_degrades_rather_than_failing(sarvam) -> None:  # type: ignore[no-untyped-def]
    """Revocation is a normal outcome: fall back to documents, do not crash."""
    aa = SandboxAccountAggregator()
    artefact = await aa.request_consent("cust-10")
    await aa.revoke(artefact.consent_handle)

    result = await AaDataAgent(sarvam).run(
        _ctx(),
        connector=aa,
        customer_ref="cust-10",
        consent_handle=artefact.consent_handle,
    )
    assert result.output.transaction_count == 0
    assert result.output.escalate is True
    assert "document path" in (result.output.escalation_reason or "")


async def test_the_consent_is_recorded_for_the_audit_trail(sarvam) -> None:  # type: ignore[no-untyped-def]
    aa = SandboxAccountAggregator()
    result = await AaDataAgent(sarvam).run(_ctx(), connector=aa, customer_ref="cust-11")
    consent = result.output.consent

    assert consent is not None
    assert consent.status == str(ConsentStatus.ACTIVE)
    assert consent.purpose_code == str(PurposeCode.LOAN_UNDERWRITING)
    assert consent.retention_expires_on


async def test_agent_reports_the_document_work_it_avoided(sarvam) -> None:  # type: ignore[no-untyped-def]
    """Structured at source means no extraction, and that is worth stating."""
    aa = SandboxAccountAggregator()
    result = await AaDataAgent(sarvam).run(_ctx(), connector=aa, customer_ref="cust-12")
    assert result.output.api_calls_avoided >= 24


# --- the collections cycle ------------------------------------------------


async def test_collections_pipeline_suppresses_before_it_dials(sarvam) -> None:  # type: ignore[no-untyped-def]
    """Dispute, do-not-call and a live promise must never be called."""
    cases = await SandboxCollections().list_cases()
    result = await run_collections_pipeline(
        sarvam,
        cases=cases,
        tenant_id="acme",
        tenant_name="Acme Finance",
        now=datetime(2026, 9, 14, 6, 0, tzinfo=UTC),  # 11:30 IST, inside the window
    )

    assert {"C-1002", "C-1004", "C-1005"} <= set(result.suppressed)
    called = {call.output.case_id for call in result.calls}
    assert not ({"C-1002", "C-1004", "C-1005"} & called)


async def test_deep_delinquency_is_not_dialled_by_a_machine(sarvam) -> None:  # type: ignore[no-untyped-def]
    """C-1003 has two broken promises: that is a human conversation."""
    cases = await SandboxCollections().list_cases()
    result = await run_collections_pipeline(
        sarvam,
        cases=cases,
        tenant_id="acme",
        now=datetime(2026, 9, 14, 6, 0, tzinfo=UTC),
    )
    assert "C-1003" not in {call.output.case_id for call in result.calls}


async def test_every_placed_call_is_scored(sarvam) -> None:  # type: ignore[no-untyped-def]
    """Every call, not a sample: a breach found in a sample already happened."""
    cases = await SandboxCollections().list_cases()
    result = await run_collections_pipeline(
        sarvam,
        cases=cases,
        tenant_id="acme",
        now=datetime(2026, 9, 14, 6, 0, tzinfo=UTC),
    )
    permitted = [c for c in result.calls if c.output.permitted]
    assert len(result.analyses) == len(permitted)


async def test_mandates_are_planned_alongside_the_cycle(sarvam) -> None:  # type: ignore[no-untyped-def]
    cases = await SandboxCollections().list_cases()
    result = await run_collections_pipeline(
        sarvam, cases=cases, tenant_id="acme", now=datetime(2026, 9, 14, 6, 0, tzinfo=UTC)
    )
    assert result.mandates.output.plans
    for plan in result.mandates.output.plans:
        assert plan.pre_debit_notice_on < plan.present_on


async def test_the_cycle_is_priced(sarvam) -> None:  # type: ignore[no-untyped-def]
    cases = await SandboxCollections().list_cases()
    result = await run_collections_pipeline(
        sarvam, cases=cases, tenant_id="acme", now=datetime(2026, 9, 14, 6, 0, tzinfo=UTC)
    )
    assert result.cost_inr >= Decimal("0")


# --- registry -------------------------------------------------------------


def test_the_catalogue_now_carries_fourteen_agents() -> None:
    assert len(implemented_ids()) == 14
    assert "aa_data" in implemented_ids()
    assert pending_ids() == ()
