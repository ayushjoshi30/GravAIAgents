"""POST /v1/agents/{id}/run — the console's way to execute an agent.

Until this existed the console could read runs but never start one, and the
only executable endpoint was the whole credit pipeline. These check that one
agent can be run on its own, that the run is recorded like any other, and that
an escalation is reported as the outcome rather than as a failure.
"""

from __future__ import annotations

import contextlib
from uuid import UUID, uuid4

import pytest
from gravai_api.main import app
from gravai_core.auth import Role, issue_dev_token
from httpx import ASGITransport, AsyncClient
from sqlalchemy.exc import IntegrityError

TENANT = uuid4()


def _auth(tenant_id: UUID = TENANT) -> dict[str, str]:
    token = issue_dev_token(
        tenant_id=tenant_id,
        subject="test:console",
        roles=[Role.UNDERWRITER, Role.COLLECTIONS_MANAGER],
    )
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
async def client(_schema: None, make_tenant):  # type: ignore[no-untyped-def]
    # One tenant for the whole module, so runs accumulate somewhere real. The
    # second test onwards finds it already there.
    with contextlib.suppress(IntegrityError):
        await make_tenant(TENANT, slug=f"run-{TENANT.hex[:8]}")
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as http:
        yield http


async def test_an_agent_can_be_run_and_the_run_is_recorded(client) -> None:
    response = await client.post("/v1/agents/risk_scoring/run", headers=_auth())
    assert response.status_code == 201, response.text

    body = response.json()
    assert body["agent_id"] == "risk_scoring"
    assert body["guardrails_passed"] is True
    assert body["sandbox"] is True
    assert body["output"]["band"] == "AMBER"
    assert body["output"]["probability_30dpd_6m"] == 0.0658

    # The run must be readable back through the same API the console uses.
    runs = await client.get("/v1/runs?agentId=risk_scoring", headers=_auth())
    assert runs.status_code == 200
    assert any(r["id"] == body["run_id"] for r in runs.json())


async def test_an_escalating_agent_still_returns_201(client) -> None:
    """Escalation is the designed outcome, not an error status."""
    response = await client.post("/v1/agents/case_allocation/run", headers=_auth())
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["escalated"] is True
    assert body["escalation_reason"]


async def test_an_unknown_agent_is_a_404(client) -> None:
    response = await client.post("/v1/agents/not_an_agent/run", headers=_auth())
    assert response.status_code == 404


@pytest.mark.parametrize(
    "agent_id", ["doc_intelligence", "kyc_verification", "ops_research", "aa_data"]
)
async def test_every_wired_agent_runs_clean(client, agent_id: str) -> None:
    """A guardrail failure anywhere would make the console show bad output."""
    response = await client.post(f"/v1/agents/{agent_id}/run", headers=_auth())
    assert response.status_code == 201, response.text
    assert response.json()["guardrails_passed"] is True


async def test_the_inputs_endpoint_describes_what_the_form_may_send(client) -> None:
    response = await client.get("/v1/agents/risk_scoring/inputs", headers=_auth())
    assert response.status_code == 200, response.text

    body = response.json()
    assert body["editable"] is True
    assert body["caveat"]

    names = {field["name"] for field in body["fields"]}
    assert "bureau_score" in names
    # FOIR is derived by the scorecard, so it must not be offered as a control.
    assert "foir" not in names

    score = next(f for f in body["fields"] if f["name"] == "bureau_score")
    assert (score["minimum"], score["maximum"]) == (300, 900)


async def test_an_agent_with_nothing_to_vary_still_explains_itself(client) -> None:
    """An empty form and a 404 both leave the reader guessing."""
    response = await client.get("/v1/agents/doc_intelligence/inputs", headers=_auth())
    assert response.status_code == 200
    body = response.json()
    assert body["editable"] is False
    assert body["fields"] == []
    assert "never looks at the file" in body["caveat"]


async def test_supplied_inputs_reach_the_agent(client) -> None:
    """The whole point: a different number has to produce a different answer."""
    poor = await client.post(
        "/v1/agents/risk_scoring/run", headers=_auth(), json={"inputs": {"bureau_score": 540}}
    )
    good = await client.post(
        "/v1/agents/risk_scoring/run", headers=_auth(), json={"inputs": {"bureau_score": 830}}
    )
    assert poor.status_code == 201, poor.text
    assert good.status_code == 201, good.text
    assert (
        poor.json()["output"]["probability_30dpd_6m"]
        > good.json()["output"]["probability_30dpd_6m"]
    )


async def test_the_response_says_which_values_were_overridden(client) -> None:
    """Only the overrides, because only those were the caller's doing.

    Reporting untouched fields here would restate the constants that used to
    overwrite the record, and imply the caller chose them.
    """
    response = await client.post(
        "/v1/agents/risk_scoring/run", headers=_auth(), json={"inputs": {"bureau_score": 640}}
    )
    assert response.status_code == 201, response.text
    applied = response.json()["overrides_applied"]
    assert applied == {"bureau_score": 640}


async def test_an_omitted_field_is_not_reported_as_an_override(client) -> None:
    response = await client.post("/v1/agents/risk_scoring/run", headers=_auth(), json={})
    assert response.status_code == 201, response.text
    assert response.json()["overrides_applied"] == {}


async def test_the_inputs_endpoint_says_what_a_blank_field_does(client) -> None:
    response = await client.get("/v1/agents/risk_scoring/inputs", headers=_auth())
    assert response.status_code == 200
    fields = {f["name"]: f for f in response.json()["fields"]}

    assert fields["bureau_score"]["sourced"] is True
    assert "bureau report" in fields["bureau_score"]["blank_means"]

    hour = await client.get("/v1/agents/voice_collections/inputs", headers=_auth())
    by_name = {f["name"]: f for f in hour.json()["fields"]}
    assert by_name["hour_ist"]["sourced"] is False
    assert by_name["hour_ist"]["blank_means"] == "use 11"


async def test_a_source_url_on_a_private_address_is_refused(client) -> None:
    """The console must not become a proxy into the loopback services."""
    response = await client.post(
        "/v1/agents/risk_scoring/run",
        headers=_auth(),
        json={"inputs": {}, "source": {"url": "http://169.254.169.254/latest/meta-data/"}},
    )
    assert response.status_code == 422, response.text
    assert "link-local" in response.text or "metadata" in response.text


async def test_a_source_that_is_not_a_url_is_refused(client) -> None:
    response = await client.post(
        "/v1/agents/source/check", headers=_auth(), json={"url": "file:///etc/passwd"}
    )
    assert response.status_code == 422, response.text


async def test_running_with_no_body_still_works(client) -> None:
    """The endpoint predates the form; an existing caller must not break."""
    response = await client.post("/v1/agents/risk_scoring/run", headers=_auth())
    assert response.status_code == 201, response.text
    assert response.json()["output"]["probability_30dpd_6m"] == 0.0658


async def test_an_unknown_input_is_refused_not_ignored(client) -> None:
    response = await client.post(
        "/v1/agents/risk_scoring/run", headers=_auth(), json={"inputs": {"nonsense": 1}}
    )
    assert response.status_code == 422, response.text
    assert "nonsense" in response.text


async def test_an_out_of_range_input_is_refused(client) -> None:
    response = await client.post(
        "/v1/agents/risk_scoring/run", headers=_auth(), json={"inputs": {"bureau_score": 9999}}
    )
    assert response.status_code == 422, response.text
