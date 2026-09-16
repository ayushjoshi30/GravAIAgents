"""The P1 agents: risk, KYC, collections, voice, speech, support.

The theme running through these: anything that can be decided by a rule is
decided by a rule, and the model is confined to language. These tests pin that
boundary, because it is the one an eager refactor would quietly erase.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal

import pytest
from gravai_agents import (
    Band,
    CaseAllocationAgent,
    KycVerificationAgent,
    OnboardingAssistantAgent,
    RiskFeatures,
    RiskScoringAgent,
    SmartMandateAgent,
    SpeechAnalyticsAgent,
    VoiceCollectionsAgent,
    check_transcript,
    check_utterance,
    implemented_ids,
    match_names,
    may_call,
    pending_ids,
    score_risk,
)
from gravai_agents.base import AgentContext
from gravai_connectors import (
    CollectionsCase,
    KycResult,
    SandboxCollections,
    SandboxDigilocker,
    SandboxGraviton,
)
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


# --- scorecard ------------------------------------------------------------


def test_bands_follow_the_published_thresholds() -> None:
    assert Band.for_probability(0.03) is Band.GREEN
    assert Band.for_probability(0.06) is Band.AMBER
    assert Band.for_probability(0.15) is Band.AMBER
    assert Band.for_probability(0.21) is Band.RED


def test_worse_inputs_produce_a_worse_score() -> None:
    """Monotonic in the obvious direction — the basic sanity of a scorecard."""
    good = score_risk(RiskFeatures(foir=0.25, bureau_score=790, bounces_6m=0, enquiries_3m=1))
    bad = score_risk(RiskFeatures(foir=0.62, bureau_score=610, bounces_6m=4, enquiries_3m=9))
    assert bad.probability_30dpd_6m > good.probability_30dpd_6m


def test_missing_features_are_imputed_and_reported() -> None:
    """A thin file is scored on neutral values, and says so."""
    result = score_risk(RiskFeatures(foir=0.4))
    assert "bureau_score" in result.imputed_features
    assert any(c.imputed for c in result.contributions)


def test_drivers_are_real_contributions_not_narrative() -> None:
    """Every stated driver corresponds to an actual term in the model."""
    result = score_risk(RiskFeatures(foir=0.7, bureau_score=620, bounces_6m=5, enquiries_3m=10))
    drivers = result.top_drivers(3)
    assert len(drivers) == 3
    assert all(abs(d.contribution) > 0 for d in drivers)
    assert abs(drivers[0].contribution) >= abs(drivers[-1].contribution)


def test_probability_is_bounded() -> None:
    extreme = score_risk(RiskFeatures(foir=5.0, bureau_score=300, bounces_6m=99, enquiries_3m=99))
    assert 0.0 <= extreme.probability_30dpd_6m <= 1.0


async def test_risk_agent_never_lets_the_model_pick_the_number(sarvam) -> None:  # type: ignore[no-untyped-def]
    """The agent's probability must equal the scorecard's, exactly."""
    graviton = SandboxGraviton()
    application = await graviton.get_application("18303")
    agent = RiskScoringAgent(sarvam)
    result = await agent.run(_ctx(), application=application)

    expected = score_risk(RiskScoringAgent._features(application))
    assert result.output.probability_30dpd_6m == expected.probability_30dpd_6m
    assert result.output.band == expected.band
    assert result.output.model_version == expected.version


async def test_red_band_escalates(sarvam) -> None:  # type: ignore[no-untyped-def]
    graviton = SandboxGraviton()
    application = await graviton.get_application("18303")
    result = await RiskScoringAgent(sarvam).run(_ctx(), application=application)
    if result.output.band is Band.RED:
        assert result.output.escalate is True


# --- name matching --------------------------------------------------------


@pytest.mark.parametrize(
    ("left", "right", "floor"),
    [
        ("Lakshmi Narayanan", "Narayanan Lakshmi", 0.99),
        ("Lakshmi Narayanan", "LAKSHMI NARAYANAN", 0.99),
        ("Shri Lakshmi Narayanan", "Lakshmi Narayanan", 0.99),
        ("Lakshmi Narayanan", "Laxmi Narayanan", 0.85),
        ("L. Narayanan", "Lakshmi Narayanan", 0.80),
        ("Krishna Kumar", "Krishnaa Kumar", 0.85),
    ],
)
def test_indian_name_variants_match(left: str, right: str, floor: float) -> None:
    assert match_names(left, right).score >= floor


def test_different_people_do_not_match() -> None:
    assert match_names("Lakshmi Narayanan", "Farhan Qureshi").score < 0.5


def test_relational_suffix_is_stripped() -> None:
    """'S/o Ramesh' introduces the father's name, not the applicant's."""
    assert match_names("Lakshmi Narayanan S/o Ramesh", "Lakshmi Narayanan").score >= 0.99


async def test_kyc_flags_a_name_mismatch(sarvam) -> None:  # type: ignore[no-untyped-def]
    graviton = SandboxGraviton()
    application = await graviton.get_application("18302")
    imposter = KycResult(
        application_id="18302",
        name="Farhan Qureshi",
        date_of_birth=date(1991, 11, 2),
        # Deliberately the application's own Aadhaar and PAN: the point of this
        # test is that a name mismatch alone is disqualifying, so every other
        # identifier has to agree.
        aadhaar_last4="9017",
        pan="AXKPJ8891L",
        verified=True,
    )
    result = await KycVerificationAgent(sarvam).run(_ctx(), application=application, kyc=imposter)
    assert result.output.verified is False
    assert result.output.escalate is True


async def test_kyc_passes_a_genuine_match(sarvam) -> None:  # type: ignore[no-untyped-def]
    graviton = SandboxGraviton()
    application = await graviton.get_application("18302")
    kyc = await SandboxDigilocker(graviton).verify("18302")
    result = await KycVerificationAgent(sarvam).run(
        _ctx(),
        application=application,
        kyc=kyc,
        declared_date_of_birth=kyc.date_of_birth,
    )
    assert result.output.verified is True
    assert result.output.aadhaar_last4 == "9017"


async def test_kyc_never_emits_a_full_aadhaar(sarvam) -> None:  # type: ignore[no-untyped-def]
    graviton = SandboxGraviton()
    application = await graviton.get_application("18302")
    kyc = await SandboxDigilocker(graviton).verify("18302")
    result = await KycVerificationAgent(sarvam).run(_ctx(), application=application, kyc=kyc)
    dumped = result.output.model_dump_json()
    assert result.output.aadhaar_last4 is not None
    assert len(result.output.aadhaar_last4) == 4
    assert "234567894821" not in dumped


# --- collections conduct --------------------------------------------------


@pytest.mark.parametrize(
    "line",
    [
        "If you do not pay we will send the police to your house.",
        "I will tell your employer about this debt.",
        "You are a shameless fraudster.",
        "A legal notice has been sent and you will be blacklisted forever.",
    ],
)
def test_prohibited_collections_language_is_caught(line: str) -> None:
    assert check_utterance(line), f"should have been blocked: {line}"


def test_ordinary_collections_language_passes() -> None:
    line = "Your instalment of 21,742 rupees is overdue. When can you make the payment?"
    assert check_utterance(line) == []


def test_transcript_requires_both_disclosures() -> None:
    """Missing the automated-caller or recording notice is itself a breach."""
    report = check_transcript(
        [("agent", "Hello, your payment is overdue."), ("borrower", "Who is this?")]
    )
    assert "ai_disclosure" in report.missing_disclosures
    assert "recording_notice" in report.missing_disclosures


def test_a_borrower_cannot_discharge_the_lenders_disclosure() -> None:
    """Only what the agent said counts."""
    report = check_transcript(
        [
            ("borrower", "Is this call recorded? Are you an automated system?"),
            ("agent", "Your payment is overdue."),
        ]
    )
    assert "recording_notice" in report.missing_disclosures


def test_calling_outside_the_window_is_refused() -> None:
    late = datetime(2026, 9, 14, 16, 30, tzinfo=UTC)  # 22:00 IST
    permission = may_call(at=late, do_not_call=False, in_dispute=False, attempts_today=0)
    assert permission.allowed is False
    assert "outside the permitted window" in (permission.reason or "")


def test_do_not_call_is_refused_before_anything_else() -> None:
    fine = datetime(2026, 9, 14, 6, 0, tzinfo=UTC)  # 11:30 IST
    permission = may_call(at=fine, do_not_call=True, in_dispute=False, attempts_today=0)
    assert permission.allowed is False
    assert "do-not-call" in (permission.reason or "")


def test_attempt_limit_is_enforced() -> None:
    fine = datetime(2026, 9, 14, 6, 0, tzinfo=UTC)
    permission = may_call(at=fine, do_not_call=False, in_dispute=False, attempts_today=3)
    assert permission.allowed is False


# --- case allocation ------------------------------------------------------


async def test_suppression_beats_priority(sarvam) -> None:  # type: ignore[no-untyped-def]
    """A live promise, a dispute or do-not-call removes a case from outreach."""
    cases = await SandboxCollections().list_cases()
    result = await CaseAllocationAgent(sarvam).run(_ctx(), cases=cases)

    by_case = {a.case_id: a for a in result.output.allocations}
    assert by_case["C-1002"].suppressed, "live promise must suppress"
    assert by_case["C-1004"].suppressed, "do-not-call must suppress"
    assert by_case["C-1005"].suppressed, "dispute must suppress"
    assert not by_case["C-1001"].suppressed


async def test_deep_delinquency_goes_to_a_human(sarvam) -> None:  # type: ignore[no-untyped-def]
    cases = await SandboxCollections().list_cases()
    result = await CaseAllocationAgent(sarvam).run(_ctx(), cases=cases)
    allocation = next(a for a in result.output.allocations if a.case_id == "C-1003")
    assert allocation.requires_human is True
    assert allocation.next_action in ("human_call", "field_visit")


async def test_voice_actions_carry_a_calling_window(sarvam) -> None:  # type: ignore[no-untyped-def]
    cases = await SandboxCollections().list_cases()
    result = await CaseAllocationAgent(sarvam).run(_ctx(), cases=cases)
    for allocation in result.output.allocations:
        if allocation.channel in ("voice", "field"):
            assert allocation.earliest_contact_local


# --- smart mandate --------------------------------------------------------


async def test_mandate_never_exceeds_the_cap(sarvam) -> None:  # type: ignore[no-untyped-def]
    case = CollectionsCase(
        case_id="C-CAP",
        borrower_name="Test Borrower",
        dpd=10,
        outstanding_principal=Decimal("500000"),
        emi_amount=Decimal("30000"),
        overdue_amount=Decimal("60000"),
        mandate_cap=Decimal("25000"),
        salary_credit_day=1,
    )
    result = await SmartMandateAgent(sarvam).run(_ctx(), cases=[case])
    plan = result.output.plans[0]
    assert plan.amount == Decimal("25000")
    assert plan.capped is True


async def test_pre_debit_notice_precedes_presentment(sarvam) -> None:  # type: ignore[no-untyped-def]
    cases = await SandboxCollections().list_cases()
    result = await SmartMandateAgent(sarvam).run(_ctx(), cases=cases)
    for plan in result.output.plans:
        assert plan.pre_debit_notice_on < plan.present_on


async def test_live_promise_is_not_pre_empted_by_a_debit(sarvam) -> None:  # type: ignore[no-untyped-def]
    cases = await SandboxCollections().list_cases()
    result = await SmartMandateAgent(sarvam).run(_ctx(), cases=cases)
    skipped = {s.case_id for s in result.output.skipped}
    assert "C-1002" in skipped


async def test_inactive_mandate_is_skipped(sarvam) -> None:  # type: ignore[no-untyped-def]
    cases = await SandboxCollections().list_cases()
    result = await SmartMandateAgent(sarvam).run(_ctx(), cases=cases)
    reasons = {s.case_id: s.reason for s in result.output.skipped}
    assert "C-1003" in reasons


# --- voice collections ----------------------------------------------------


async def test_voice_agent_refuses_a_do_not_call_case(sarvam) -> None:  # type: ignore[no-untyped-def]
    case = await SandboxCollections().get_case("C-1004")
    result = await VoiceCollectionsAgent(sarvam).run(
        _ctx(), case=case, now=datetime(2026, 9, 14, 6, 0, tzinfo=UTC)
    )
    assert result.output.permitted is False
    assert str(result.output.outcome) == "not_permitted"
    assert result.output.earliest_retry_utc


async def test_voice_agent_refuses_outside_calling_hours(sarvam) -> None:  # type: ignore[no-untyped-def]
    case = await SandboxCollections().get_case("C-1001")
    result = await VoiceCollectionsAgent(sarvam).run(
        _ctx(),
        case=case,
        now=datetime(2026, 9, 14, 18, 0, tzinfo=UTC),  # 23:30 IST
    )
    assert result.output.permitted is False


async def test_permitted_call_discloses_automation_and_recording(sarvam) -> None:  # type: ignore[no-untyped-def]
    case = await SandboxCollections().get_case("C-1001")
    result = await VoiceCollectionsAgent(sarvam).run(
        _ctx(),
        case=case,
        now=datetime(2026, 9, 14, 6, 0, tzinfo=UTC),
        lender_name="Acme Finance",
    )
    assert result.output.permitted is True
    assert result.output.compliance.disclosed_ai is True
    assert result.output.compliance.disclosed_recording is True
    assert all(not u.blocked for u in result.output.script)


async def test_a_prohibited_line_is_blocked_not_spoken(sarvam) -> None:  # type: ignore[no-untyped-def]
    """If the model produces a threat, the line is dropped and the run escalates."""
    import json

    sarvam.chat.responses = {
        '"identity_question"': json.dumps(
            {
                "greeting": (
                    "This is an automated assistant calling on behalf of your lender. "
                    "This call is recorded."
                ),
                "identity_question": "Please confirm your date of birth.",
                "purpose": "If you do not pay today we will send the police to your house.",
                "promise_request": "When will you pay?",
                "closing": "Goodbye.",
            }
        )
    }
    case = await SandboxCollections().get_case("C-1001")
    result = await VoiceCollectionsAgent(sarvam).run(
        _ctx(), case=case, now=datetime(2026, 9, 14, 6, 0, tzinfo=UTC)
    )
    blocked = [u for u in result.output.script if u.blocked]
    assert blocked, "the threat should have been blocked"
    assert result.output.compliance.prohibited_blocked >= 1
    assert result.output.escalate is True


# --- speech analytics -----------------------------------------------------


async def test_speech_analytics_detects_a_breach(sarvam) -> None:  # type: ignore[no-untyped-def]
    transcript = [
        ("agent", "Hello, this is an automated assistant. This call is recorded."),
        ("agent", "If you do not pay we will send the police."),
        ("borrower", "Please give me a week."),
    ]
    result = await SpeechAnalyticsAgent(sarvam).run(_ctx(), call_id="CALL-1", transcript=transcript)
    assert result.output.compliance_violations
    assert result.output.escalate is True


async def test_speech_analytics_quotes_are_verbatim(sarvam) -> None:  # type: ignore[no-untyped-def]
    """A quality report that paraphrases is useless in a dispute."""
    transcript = [
        ("agent", "Hello, this is an automated assistant. This call is recorded."),
        ("agent", "You are a shameless fraudster."),
    ]
    joined = " ".join(t for _, t in transcript).lower()
    result = await SpeechAnalyticsAgent(sarvam).run(_ctx(), call_id="CALL-2", transcript=transcript)
    for violation in result.output.compliance_violations:
        assert violation.quote.lower() in joined
    assert result.output.unverified_quotes_dropped == 0


async def test_clean_call_scores_without_escalating(sarvam) -> None:  # type: ignore[no-untyped-def]
    transcript = [
        (
            "agent",
            "Good morning, this is an automated assistant calling on behalf of Acme "
            "Finance. This call is recorded.",
        ),
        ("agent", "Your instalment is overdue. When can you make the payment?"),
        ("borrower", "I will pay on Friday."),
    ]
    result = await SpeechAnalyticsAgent(sarvam).run(_ctx(), call_id="CALL-3", transcript=transcript)
    assert result.output.compliance_violations == []
    assert result.output.escalate is False
    assert 0 < result.output.score_percent <= 100


# --- onboarding -----------------------------------------------------------


async def test_support_agent_answers_a_status_question(sarvam) -> None:  # type: ignore[no-untyped-def]
    graviton = SandboxGraviton()
    application = await graviton.get_application("18303")
    pendencies = await graviton.list_pendencies("18303")
    result = await OnboardingAssistantAgent(sarvam).run(
        _ctx(),
        application=application,
        question="What is happening with my loan application?",
        pendencies=pendencies,
    )
    assert result.output.answer
    assert len(result.output.outstanding_requirements) == 2


# --- registry -------------------------------------------------------------


def test_all_p0_and_p1_agents_are_implemented() -> None:
    """The credit core and the P1 tier. The full count is asserted in test_p2_agents."""
    assert {
        "doc_intelligence",
        "bank_statement_analytics",
        "credit_appraisal",
        "risk_scoring",
        "kyc_verification",
        "case_allocation",
        "smart_mandate",
        "voice_collections",
        "speech_analytics",
        "onboarding_assistant",
    } <= set(implemented_ids())
    assert pending_ids() == ()
