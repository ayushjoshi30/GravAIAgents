"""The worked-example panels must keep telling the truth.

`apps/web/src/lib/agent-usecase.ts` transcribes figures out of
`apps/web/src/lib/agent-samples.json` so each agent page can show the two or
three facts that matter rather than a full output dump. Transcription drifts:
an agent changes, the sample is regenerated, and the page quietly keeps quoting
the old number.

These assertions pin the headline figure of every panel to the generated
sample. If one fails, the agent's behaviour changed — update the panel, never
the sample.
"""

from __future__ import annotations

import json
from decimal import Decimal
from pathlib import Path

import pytest

WEB = Path(__file__).resolve().parents[1] / "apps" / "web" / "src" / "lib"
SAMPLES = WEB / "agent-samples.json"
USE_CASES = WEB / "agent-usecase.ts"


@pytest.fixture(scope="module")
def samples() -> dict:
    return json.loads(SAMPLES.read_text(encoding="utf-8"))["agents"]


@pytest.fixture(scope="module")
def use_case_source() -> str:
    return USE_CASES.read_text(encoding="utf-8")


def test_every_agent_in_the_catalog_has_a_panel(use_case_source: str, samples: dict) -> None:
    """A missing panel is a silently blank section on a live page."""
    missing = [
        agent_id for agent_id in samples if f'agentId: "{agent_id}"' not in use_case_source
    ]
    assert not missing, f"agents with no worked example: {missing}"


def test_no_panel_names_an_agent_that_does_not_exist(
    use_case_source: str, samples: dict
) -> None:
    import re

    named = set(re.findall(r'agentId: "([a-z_]+)"', use_case_source))
    assert named <= set(samples), f"panels for unknown agents: {named - set(samples)}"


def test_the_demo_persona_is_the_one_the_sandbox_actually_returns(samples: dict) -> None:
    """The flow names a borrower; the sandbox has to agree it is that borrower."""
    fields = samples["doc_intelligence"]["output"]["documents"][0]["fields"]
    assert fields["name"]["value"] == "Ayush Joshi"
    assert samples["kyc_verification"]["output"]["pan"] == "AXKPJ8891L"


def test_document_intelligence_figures(samples: dict) -> None:
    output = samples["doc_intelligence"]["output"]
    assert output["total_calls"] == 98
    assert output["total_pages"] == 29
    assert output["unknown_type_ratio"] == 0.0
    assert samples["doc_intelligence"]["cost_inr"] == "26.0000"


def test_bank_statement_figures(samples: dict) -> None:
    output = samples["bank_statement_analytics"]["output"]
    assert output["income"]["monthly_net_income_median"] == "85000.00"
    assert output["income"]["income_stability_score"] == 0.989
    assert output["income"]["months_observed"] == 6
    assert output["obligations"]["total_monthly_emi"] == "12000"
    assert len(output["bounces"]) == 1
    assert output["reconciled"] is True


def test_account_aggregator_figures(samples: dict) -> None:
    output = samples["aa_data"]["output"]
    assert output["transaction_count"] == 13
    assert output["api_calls_avoided"] == 24
    assert output["consent"]["status"] == "ACTIVE"
    assert output["consent"]["purpose_code"] == "105"
    assert output["consent"]["fetches_permitted"] == 1
    assert samples["aa_data"]["escalated"] is True


def test_kyc_figures(samples: dict) -> None:
    output = samples["kyc_verification"]["output"]
    assert output["verified"] is True
    assert output["overall_score"] == 1.0
    assert output["aadhaar_last4"] == "9017"


def test_credit_appraisal_figures(samples: dict) -> None:
    output = samples["credit_appraisal"]["output"]
    assert output["eligibility"]["proposed_emi"] == "21742.42"
    assert output["eligibility"]["foir_display"] == "39.7%"
    assert output["recommendation"]["decision"] == "refer"
    assert len(output["bre"]["rules"]) == 5
    assert samples["credit_appraisal"]["escalated"] is True


def test_risk_figures(samples: dict) -> None:
    output = samples["risk_scoring"]["output"]
    assert output["probability_30dpd_6m"] == 0.0658
    assert output["band"] == "AMBER"
    assert output["model_version"] == "scorecard-v1-illustrative"
    assert output["imputed_features"] == ["ltv"]


def test_msme_figures(samples: dict) -> None:
    output = samples["msme_underwriting"]["output"]
    assert output["assessed_annual_turnover"] == "5800000"
    assert output["turnover"]["bank_to_gst_ratio"] == 1.0
    assert output["turnover"]["itr_to_gst_ratio"] == 0.9667
    assert output["concentration_risk"] == 0.5
    assert output["gstin_valid"] is True


def test_onboarding_figures(samples: dict) -> None:
    output = samples["onboarding_assistant"]["output"]
    assert len(output["outstanding_requirements"]) == 2
    assert output["handoff_required"] is False


def test_case_allocation_figures(samples: dict) -> None:
    output = samples["case_allocation"]["output"]
    assert output["total_cases"] == 5
    assert output["suppressed_cases"] == 3
    assert output["contactable_cases"] == 2
    assert output["total_overdue"] == "191065"
    assert samples["case_allocation"]["escalated"] is True


def test_smart_mandate_figures(samples: dict) -> None:
    output = samples["smart_mandate"]["output"]
    assert output["total_to_present"] == "35952"
    assert len(output["plans"]) == 2
    # Every plan must carry a pre-debit notice at least a day ahead.
    for plan in output["plans"]:
        assert plan["pre_debit_notice_on"] < plan["present_on"]


def test_voice_collections_figures(samples: dict) -> None:
    output = samples["voice_collections"]["output"]
    assert output["permitted"] is True
    assert output["outcome"] == "promise_to_pay"
    assert output["promise"]["amount"] == "21742"
    assert output["compliance"]["prohibited_blocked"] == 0
    assert output["compliance"]["disclosed_ai"] is True
    assert output["compliance"]["disclosed_recording"] is True


def test_speech_analytics_figures(samples: dict) -> None:
    output = samples["speech_analytics"]["output"]
    assert output["score_percent"] == 83.3
    assert output["compliance_violations"] == []
    assert output["unverified_quotes_dropped"] == 0


def test_segmentation_figures(samples: dict) -> None:
    output = samples["customer_data_intelligence"]["output"]
    assert output["population"] == 9
    assert output["consented"] == 6
    assert output["excluded_no_consent"] == 3
    assert output["unsegmented"] == 0


def test_ops_research_figures(samples: dict) -> None:
    output = samples["ops_research"]["output"]
    assert output["total_calls_per_month"] == 919570
    assert output["poll_calls_per_month"] == 689760
    assert output["poll_share"] == 0.7501
    assert output["throughput"]["hours_required_per_month"] == 1379.5
    assert output["throughput"]["business_hours_available"] == 176
    assert round(Decimal(str(output["throughput"]["utilisation"])), 2) == Decimal("7.84")
    assert samples["ops_research"]["escalated"] is True


def test_the_panels_agree_with_the_samples_about_who_escalates(
    use_case_source: str, samples: dict
) -> None:
    """A panel calling a run clean when the agent escalated would be a lie."""
    import re

    blocks = re.split(r'agentId: "', use_case_source)[1:]
    for block in blocks:
        agent_id = block.split('"', 1)[0]
        panel_escalated = 'kind: "escalated"' in block.split("agentId:")[0]
        assert panel_escalated == samples[agent_id]["escalated"], (
            f"{agent_id}: panel says escalated={panel_escalated}, "
            f"sample says {samples[agent_id]['escalated']}"
        )
