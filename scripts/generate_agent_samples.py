"""Run every agent in sandbox and capture what it actually produced.

The output feeds the agent pages on the site. That matters: the figures shown
there are not illustrations someone typed, they are the result of running the
agent. If an agent changes, the page changes with it, and if an agent breaks,
this script fails rather than the site quietly showing stale claims.

    uv run python scripts/generate_agent_samples.py

Writes apps/web/src/lib/agent-samples.json.
"""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

from gravai_agents import (
    AaDataAgent,
    BankStatementAnalyticsAgent,
    CaseAllocationAgent,
    Counterparty,
    CreditAppraisalAgent,
    CustomerDataIntelligenceAgent,
    CustomerSignal,
    DocIntelligenceAgent,
    GstReturn,
    KycVerificationAgent,
    MsmeUnderwritingAgent,
    OnboardingAssistantAgent,
    OpsResearchAgent,
    RiskScoringAgent,
    SmartMandateAgent,
    SpeechAnalyticsAgent,
    VoiceCollectionsAgent,
    transactions_from_documents,
)
from gravai_agents.base import AgentContext
from gravai_connectors import (
    SandboxBre,
    SandboxCollections,
    SandboxDigilocker,
    SandboxGraviton,
)
from gravai_connectors.account_aggregator import SandboxAccountAggregator
from gravai_sarvam import RateGovernor, build_sarvam

OUT = Path("apps/web/src/lib/agent-samples.json")
WHEN = datetime(2026, 9, 14, 6, 0, tzinfo=UTC)


async def _nosleep(_: float) -> None:
    return None


def _ctx() -> AgentContext:
    return AgentContext(tenant_id="acme", tenant_name="Acme Finance Limited")


def _plain(value: Any) -> Any:
    """JSON-safe, and readable rather than exhaustive."""
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, datetime | date):
        return value.isoformat()
    if isinstance(value, dict):
        return {k: _plain(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_plain(v) for v in value]
    return value


def _trim(payload: dict[str, Any], *, keep: int = 2) -> dict[str, Any]:
    """Shorten long lists so a sample stays a sample.

    A page showing 197 documents is not clearer than one showing two and saying
    how many there were.
    """
    out: dict[str, Any] = {}
    for key, value in payload.items():
        if isinstance(value, list) and len(value) > keep:
            out[key] = [*[_plain(v) for v in value[:keep]], f"... {len(value) - keep} more"]
        else:
            out[key] = _plain(value)
    return out


async def main() -> int:
    sarvam = build_sarvam(
        polls_before_done=10,
        sleep=_nosleep,
        governor=RateGovernor(limits={"docai": 1e9, "llm": 1e9}),
    )
    graviton = SandboxGraviton()
    collections = SandboxCollections()
    samples: dict[str, Any] = {}

    def record(agent_id: str, inputs: dict[str, Any], result: Any) -> None:
        samples[agent_id] = {
            "inputs": _trim(inputs),
            "output": _trim(result.output.model_dump(mode="json")),
            "escalated": result.escalated,
            "escalation_reason": result.escalation_reason,
            "validation_ok": result.validation.ok,
            "steps": [
                {"name": s.name, "kind": s.kind, "attempts": s.attempts}
                for s in result.steps[:3]
            ],
            "cost_inr": str(result.cost_inr),
        }

    application = await graviton.get_application("18302")
    documents = await graviton.list_documents("18302")
    weak = await graviton.get_application("18303")

    # --- documents ----------------------------------------------------
    docs = await DocIntelligenceAgent(sarvam).run(_ctx(), documents=documents)
    record(
        "doc_intelligence",
        {
            "documents": [f"{d.declared_type} ({d.pages}pp)" for d in documents],
            "application": application.external_id,
        },
        docs,
    )

    # --- bank statement ----------------------------------------------
    transactions, _account = transactions_from_documents(docs.output)
    bsa = await BankStatementAnalyticsAgent(sarvam).run(
        _ctx(),
        transactions=transactions,
        account_last4="9012",
        bank="HDFC Bank",
        opening_balance=Decimal("52000"),
        closing_balance=Decimal("514000"),
    )
    record(
        "bank_statement_analytics",
        {
            "transactions": [f"{t.date:%d/%m/%Y} {t.narration} {t.amount}" for t in transactions],
            "opening_balance": "52000",
            "closing_balance": "514000",
        },
        bsa,
    )

    # --- credit appraisal --------------------------------------------
    cam = await CreditAppraisalAgent(sarvam).run(
        _ctx(), application=application, bre=SandboxBre(), bank_statement=bsa.output
    )
    record(
        "credit_appraisal",
        {
            "application": application.external_id,
            "loan_amount": str(application.loan_amount),
            "tenure_months": application.tenure_months,
            "rate_pct": str(application.interest_rate_pct),
            "verified_income": str(bsa.output.income.monthly_net_income_median),
        },
        cam,
    )

    # --- risk ---------------------------------------------------------
    risk = await RiskScoringAgent(sarvam).run(
        _ctx(), application=application, bank_statement=bsa.output
    )
    record(
        "risk_scoring",
        {"application": application.external_id, "bureau_score": application.bureau_score},
        risk,
    )

    # --- KYC ----------------------------------------------------------
    kyc_record = await SandboxDigilocker(graviton).verify("18302")
    kyc = await KycVerificationAgent(sarvam).run(
        _ctx(),
        application=application,
        kyc=kyc_record,
        declared_date_of_birth=kyc_record.date_of_birth,
    )
    record(
        "kyc_verification",
        {"application": application.external_id, "source": "DigiLocker"},
        kyc,
    )

    # --- account aggregator -------------------------------------------
    aa = await AaDataAgent(sarvam).run(
        _ctx(), connector=SandboxAccountAggregator(), customer_ref="cust-18302"
    )
    record("aa_data", {"customer_ref": "cust-18302", "purpose": "Loan underwriting"}, aa)

    # --- collections ---------------------------------------------------
    cases = await collections.list_cases()
    allocation = await CaseAllocationAgent(sarvam).run(_ctx(), cases=cases)
    record(
        "case_allocation",
        {"cases": [f"{c.case_id} {c.dpd}dpd {c.overdue_amount}" for c in cases]},
        allocation,
    )

    mandates = await SmartMandateAgent(sarvam).run(_ctx(), cases=cases)
    record("smart_mandate", {"cases": [c.case_id for c in cases]}, mandates)

    call = await VoiceCollectionsAgent(sarvam).run(
        _ctx(), case=cases[0], now=WHEN, lender_name="Acme Finance"
    )
    record(
        "voice_collections",
        {"case": cases[0].case_id, "language": cases[0].language, "at": "11:30 IST"},
        call,
    )

    transcript = [("agent", u.text) for u in call.output.script if not u.blocked]
    speech = await SpeechAnalyticsAgent(sarvam).run(
        _ctx(), call_id="C-1001-call", transcript=transcript
    )
    record("speech_analytics", {"transcript_lines": [t for _, t in transcript]}, speech)

    # --- support --------------------------------------------------------
    support = await OnboardingAssistantAgent(sarvam).run(
        _ctx(),
        application=weak,
        question="What is happening with my loan application?",
        pendencies=await graviton.list_pendencies("18303"),
    )
    record(
        "onboarding_assistant",
        {"application": weak.external_id, "question": "What is happening with my application?"},
        support,
    )

    # --- MSME -----------------------------------------------------------
    returns = [
        GstReturn(gstin="27AAPFU0939F1ZV", period=f"2026-{m:02d}", taxable_value=Decimal("500000"))
        for m in range(1, 13)
    ]
    msme = await MsmeUnderwritingAgent(sarvam).run(
        _ctx(),
        application_id="M-1",
        gst_returns=returns,
        bank_credits_annual=Decimal("6000000"),
        itr_declared=Decimal("5800000"),
        counterparties=[
            Counterparty(name="Bharat Retail", inbound=Decimal("3000000")),
            Counterparty(name="Sunrise Distributors", inbound=Decimal("3000000")),
        ],
    )
    record(
        "msme_underwriting",
        {"gst_returns": "12 monthly returns", "bank_credits": "6000000", "itr": "5800000"},
        msme,
    )

    # --- segmentation -----------------------------------------------------
    signals = [
        CustomerSignal(
            customer_ref=f"C{i}",
            consent_purposes=["marketing"] if i % 3 else ["underwriting"],
            months_on_book=18,
            original_principal=Decimal("1000000"),
            outstanding_principal=Decimal("400000"),
            emi_amount=Decimal("20000"),
            monthly_income=Decimal("100000"),
            risk_band="GREEN",
        )
        for i in range(1, 10)
    ]
    cdi = await CustomerDataIntelligenceAgent(sarvam).run(_ctx(), signals=signals)
    record("customer_data_intelligence", {"customers": len(signals), "purpose": "marketing"}, cdi)

    # --- ops --------------------------------------------------------------
    ops = await OpsResearchAgent(sarvam).run(_ctx())
    record(
        "ops_research",
        {"question": "What does the document pipeline cost and can it keep up?"},
        ops,
    )

    await sarvam.aclose()

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(
            {
                "generated_note": (
                    "Produced by running each agent against the sandbox. Figures are "
                    "real agent output, not illustrations."
                ),
                "agents": samples,
            },
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    print(f"wrote {OUT} — {len(samples)} agents")
    for agent_id, sample in samples.items():
        mark = "escalated" if sample["escalated"] else "clean"
        print(f"  {agent_id:<28} {mark:<10} validation_ok={sample['validation_ok']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
