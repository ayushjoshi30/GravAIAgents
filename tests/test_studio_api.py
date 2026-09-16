"""The Agent Studio API.

These follow one workflow through its whole life — drawn, checked, run, frozen,
deployed, called by name — because that sequence is the product, and each step
only means anything if the one before it held.

The graph used throughout is deliberately free of language-model nodes. The AI
layer is sandboxed in the suite, so a run that depended on it would be asserting
against canned prose; a router, a calculator and two state writers assert against
arithmetic that has one right answer.
"""

from __future__ import annotations

from typing import Any
from uuid import UUID, uuid4

import pytest
from gravai_api.main import app
from gravai_core.auth import Role, issue_dev_token
from httpx import ASGITransport, AsyncClient
from sqlalchemy.exc import IntegrityError

TENANT = uuid4()
OTHER_TENANT = uuid4()


def _auth(tenant_id: UUID = TENANT, role: Role = Role.UNDERWRITER) -> dict[str, str]:
    token = issue_dev_token(
        tenant_id=tenant_id,
        subject="test:studio",
        roles=[role],
    )
    return {"Authorization": f"Bearer {token}"}


def _triage_graph(threshold: int = 700) -> dict[str, Any]:
    """A small, entirely deterministic credit triage.

    Input, read a fact, branch on it, write the decision the branch implies, and
    assemble an answer. Every node here is arithmetic or a comparison, so the
    same inputs always give the same output and the assertions below are real.

    ``threshold`` moves the approve/review boundary. It exists so a test can
    produce a second graph that answers the same question differently, which is
    the only way to tell a frozen version apart from a live draft.
    """
    return {
        "nodes": [
            {
                "id": "start",
                "type": "input",
                "name": "Application",
                "config": {"schema": {"bureau_score": "number", "loan_amount": "number"}},
            },
            {
                "id": "score",
                "type": "calculator",
                "config": {
                    "expression": "workflow.facts.bureau_score",
                    "fact_name": "score",
                },
            },
            {
                "id": "triage",
                "type": "router",
                "config": {
                    "branches": [
                        {
                            "label": "approve",
                            "condition": f"workflow.facts.score >= {threshold}",
                        },
                        {"label": "review", "condition": "true"},
                    ]
                },
            },
            {
                "id": "approve",
                "type": "set_state",
                "config": {"facts": {"decision": "approve"}},
            },
            {
                "id": "review",
                "type": "set_state",
                "config": {"facts": {"decision": "review"}},
            },
            {
                "id": "answer",
                "type": "output",
                "config": {
                    "mapping": {
                        "decision": "{{workflow.facts.decision}}",
                        "score": "{{workflow.facts.score}}",
                    }
                },
            },
        ],
        "edges": [
            {"source": "start", "target": "score"},
            {"source": "score", "target": "triage"},
            {"source": "triage", "target": "approve", "branch": "approve"},
            {"source": "triage", "target": "review", "branch": "review"},
            {"source": "approve", "target": "answer"},
            {"source": "review", "target": "answer"},
        ],
    }


def _broken_graph() -> dict[str, Any]:
    """Two calculators pointing at each other, one with its expression blanked.

    The expression is present and empty rather than absent: an omitted setting
    falls back to the node type's own default, which is a perfectly good
    expression, so leaving it out would produce a valid node rather than the
    error this graph exists to provoke.
    """
    return {
        "nodes": [
            {"id": "a", "type": "calculator", "config": {"expression": "", "fact_name": "a"}},
            {
                "id": "b",
                "type": "calculator",
                "config": {"expression": "workflow.facts.a", "fact_name": "b"},
            },
        ],
        "edges": [
            {"source": "a", "target": "b"},
            {"source": "b", "target": "a"},
        ],
    }


@pytest.fixture
async def client(_schema: None, db_session, make_tenant):  # type: ignore[no-untyped-def]
    # Both tenants exist for the whole module; the isolation test needs the
    # second one to be real, so that "sees nothing" means isolation rather than
    # a missing foreign key. From the second test onwards they are already
    # there, and the duplicate insert has to be rolled back explicitly — a
    # session left in a failed transaction would take the next insert with it.
    for tenant in (TENANT, OTHER_TENANT):
        try:
            await make_tenant(tenant, slug=f"studio-{tenant.hex[:8]}")
        except IntegrityError:
            await db_session.rollback()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as http:
        yield http


async def _create(client: AsyncClient, name: str, definition: dict[str, Any] | None = None):  # type: ignore[no-untyped-def]
    response = await client.post(
        "/v1/studio/workflows",
        headers=_auth(),
        json={
            "name": name,
            "description": "Deterministic triage used by the studio tests",
            "definition": definition if definition is not None else _triage_graph(),
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


# --- the node library -------------------------------------------------------


async def test_the_node_library_tells_the_canvas_what_it_may_draw(client) -> None:
    response = await client.get("/v1/studio/nodes", headers=_auth())
    assert response.status_code == 200, response.text
    body = response.json()

    by_key = {family["key"]: family for family in body["families"]}
    assert {"intelligence", "gravai", "data", "business", "control", "memory"} <= set(by_key)

    every = [node for family in body["families"] for node in family["nodes"]]
    assert len(every) == body["total"]

    router_node = next(node for node in every if node["type"] == "router")
    assert router_node["branching"] is True
    assert router_node["deterministic"] is True
    assert router_node["uses_llm"] is False
    assert any(setting["name"] == "branches" for setting in router_node["config"])

    # A node that cannot do the whole of what its name implies has to say so
    # here, because here is where someone decides to place it.
    source = next(node for node in every if node["type"] == "document_source")
    assert "document-AI" in source["caveat"]

    llm = next(node for node in every if node["type"] == "llm")
    assert llm["uses_llm"] is True
    assert [port["name"] for port in llm["outputs"]] == ["text", "data"]


# --- the draft --------------------------------------------------------------


async def test_a_workflow_can_be_created_listed_read_and_updated(client) -> None:
    created = await _create(client, f"triage-crud-{uuid4().hex[:6]}")
    assert created["node_count"] == 6

    listed = await client.get("/v1/studio/workflows", headers=_auth())
    assert listed.status_code == 200
    assert any(row["id"] == created["id"] for row in listed.json())

    fetched = await client.get(f"/v1/studio/workflows/{created['id']}", headers=_auth())
    assert fetched.status_code == 200, fetched.text
    assert fetched.json()["versions"] == []
    assert fetched.json()["deployed_version"] is None

    updated = await client.put(
        f"/v1/studio/workflows/{created['id']}",
        headers=_auth(),
        json={"description": "Now with a reason"},
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["description"] == "Now with a reason"
    # An omitted field means untouched, not blanked.
    assert updated.json()["definition"]["nodes"][0]["id"] == "start"

    deleted = await client.delete(f"/v1/studio/workflows/{created['id']}", headers=_auth())
    assert deleted.status_code == 204
    assert (
        await client.get(f"/v1/studio/workflows/{created['id']}", headers=_auth())
    ).status_code == 404


async def test_two_workflows_cannot_share_a_name(client) -> None:
    """The name is how a deployed agent is addressed, so it has to be unique."""
    name = f"triage-unique-{uuid4().hex[:6]}"
    await _create(client, name)
    again = await client.post(
        "/v1/studio/workflows",
        headers=_auth(),
        json={"name": name, "definition": {}},
    )
    assert again.status_code == 422, again.text


# --- validation -------------------------------------------------------------


async def test_a_good_graph_validates_with_nothing_to_report(client) -> None:
    created = await _create(client, f"triage-valid-{uuid4().hex[:6]}")
    response = await client.post(f"/v1/studio/workflows/{created['id']}/validate", headers=_auth())
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["runnable"] is True
    assert body["errors"] == 0
    assert body["problems"] == []


async def test_a_bad_graph_is_reported_against_the_nodes_that_are_wrong(client) -> None:
    """The canvas marks nodes, so every problem it can place must carry an id."""
    created = await _create(client, f"triage-bad-{uuid4().hex[:6]}", _broken_graph())
    response = await client.post(f"/v1/studio/workflows/{created['id']}/validate", headers=_auth())
    assert response.status_code == 200, response.text
    body = response.json()

    assert body["runnable"] is False
    assert body["errors"] >= 2

    missing = next(p for p in body["problems"] if p["field"] == "expression")
    assert missing["severity"] == "error"
    assert missing["node_id"] == "a"

    loop = next(p for p in body["problems"] if "loop" in p["message"])
    assert loop["severity"] == "error"

    # Warnings are reported too: a graph with no Output node runs and returns
    # something nobody asked for, which is worth saying while it can be fixed.
    assert any(p["severity"] == "warning" for p in body["problems"])


async def test_a_cycle_is_refused_before_anything_runs(client) -> None:
    created = await _create(client, f"triage-cycle-{uuid4().hex[:6]}", _broken_graph())
    response = await client.post(f"/v1/studio/workflows/{created['id']}/run", headers=_auth())
    assert response.status_code == 422, response.text
    assert "cannot run as drawn" in response.text

    # Nothing executed, so nothing may appear in the run history.
    history = await client.get(f"/v1/studio/runs?workflowId={created['id']}", headers=_auth())
    assert history.json() == []


# --- running ----------------------------------------------------------------


async def test_a_run_returns_a_trace_of_what_each_node_did(client) -> None:
    created = await _create(client, f"triage-run-{uuid4().hex[:6]}")
    response = await client.post(
        f"/v1/studio/workflows/{created['id']}/run",
        headers=_auth(),
        json={"inputs": {"bureau_score": 780, "loan_amount": 500000}},
    )
    assert response.status_code == 201, response.text
    body = response.json()

    assert body["status"] == "completed"
    assert body["output"]["decision"] == "approve"
    assert body["version_id"] is None  # a test run, not live traffic

    by_id = {entry["node_id"]: entry for entry in body["trace"]}
    assert by_id["score"]["status"] == "ok"
    assert by_id["triage"]["branch"] == "approve"
    assert by_id["approve"]["status"] == "ok"
    # The branch not taken is skipped, not failed — otherwise every branching
    # workflow would report errors for doing exactly what it was drawn to do.
    assert by_id["review"]["status"] == "skipped"

    assert body["state"]["facts"]["score"] == 780

    detail = await client.get(f"/v1/studio/runs/{body['id']}", headers=_auth())
    assert detail.status_code == 200, detail.text
    assert len(detail.json()["trace"]) == len(body["trace"])

    history = await client.get(f"/v1/studio/runs?workflowId={created['id']}", headers=_auth())
    assert [row["id"] for row in history.json()] == [body["id"]]


async def test_a_different_input_takes_a_different_branch(client) -> None:
    """The whole point of a router: a worse score has to be routed differently."""
    created = await _create(client, f"triage-branch-{uuid4().hex[:6]}")
    poor = await client.post(
        f"/v1/studio/workflows/{created['id']}/run",
        headers=_auth(),
        json={"inputs": {"bureau_score": 540, "loan_amount": 500000}},
    )
    assert poor.status_code == 201, poor.text
    assert poor.json()["output"]["decision"] == "review"


async def test_a_run_refuses_a_credential_in_the_body(client) -> None:
    """A token in a request body is a token in a request log.

    Nodes name a credential and the value is resolved server-side, so there is
    nothing this field could legitimately be.
    """
    created = await _create(client, f"triage-creds-{uuid4().hex[:6]}")
    response = await client.post(
        f"/v1/studio/workflows/{created['id']}/run",
        headers=_auth(),
        json={"inputs": {}, "credentials": {"bureau": "secret-token"}},
    )
    assert response.status_code == 422, response.text


# --- compiling and deploying ------------------------------------------------


async def test_compiling_produces_a_version_with_schemas_read_off_the_graph(client) -> None:
    created = await _create(client, f"triage-compile-{uuid4().hex[:6]}")
    response = await client.post(f"/v1/studio/workflows/{created['id']}/compile", headers=_auth())
    assert response.status_code == 201, response.text
    version = response.json()

    assert version["version"] == "1.0"
    assert version["status"] == "draft"
    assert version["input_schema"] == {"bureau_score": "number", "loan_amount": "number"}
    # Every output field is text because the Output node renders its mapping
    # through the template engine, which produces text.
    assert version["output_schema"] == {"decision": "string", "score": "string"}
    assert version["definition"]["nodes"]

    second = await client.post(f"/v1/studio/workflows/{created['id']}/compile", headers=_auth())
    assert second.json()["version"] == "1.1"

    listed = await client.get(f"/v1/studio/workflows/{created['id']}", headers=_auth())
    assert {v["version"] for v in listed.json()["versions"]} == {"1.0", "1.1"}


async def test_an_invalid_draft_cannot_be_compiled(client) -> None:
    """Compiling a broken graph would move the failure to the first real call."""
    created = await _create(client, f"triage-nocompile-{uuid4().hex[:6]}", _broken_graph())
    response = await client.post(f"/v1/studio/workflows/{created['id']}/compile", headers=_auth())
    assert response.status_code == 422, response.text


async def test_a_deployed_version_can_be_called_by_name(client) -> None:
    name = f"triage-deployed-{uuid4().hex[:6]}"
    created = await _create(client, name)

    # Before deployment the name resolves to nothing runnable.
    early = await client.post(f"/v1/studio/deployed/{name}/run", headers=_auth(), json={})
    assert early.status_code == 404, early.text

    version = (
        await client.post(f"/v1/studio/workflows/{created['id']}/compile", headers=_auth())
    ).json()
    deployed = await client.post(
        f"/v1/studio/workflows/{created['id']}/deploy",
        headers=_auth(),
        json={"version": version["version"]},
    )
    assert deployed.status_code == 200, deployed.text
    assert deployed.json()["deployed"]["status"] == "deployed"
    assert deployed.json()["retired"] is None

    response = await client.post(
        f"/v1/studio/deployed/{name}/run",
        headers=_auth(),
        json={"inputs": {"bureau_score": 812, "loan_amount": 250000}},
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["status"] == "completed"
    assert body["output"]["decision"] == "approve"
    # A live call is attributed to the version that served it, which is what
    # makes the answer explainable months later.
    assert body["version_id"] == version["id"]

    unknown = await client.post(
        f"/v1/studio/deployed/{name}/run",
        headers=_auth(),
        json={"inputs": {"nonsense": 1}},
    )
    assert unknown.status_code == 422, unknown.text
    assert "nonsense" in unknown.text


async def test_deploying_a_successor_retires_the_incumbent(client) -> None:
    name = f"triage-succeed-{uuid4().hex[:6]}"
    created = await _create(client, name)

    first = (
        await client.post(f"/v1/studio/workflows/{created['id']}/compile", headers=_auth())
    ).json()
    await client.post(
        f"/v1/studio/workflows/{created['id']}/deploy",
        headers=_auth(),
        json={"version": first["version"]},
    )
    second = (
        await client.post(f"/v1/studio/workflows/{created['id']}/compile", headers=_auth())
    ).json()
    promoted = await client.post(
        f"/v1/studio/workflows/{created['id']}/deploy",
        headers=_auth(),
        json={"version_id": second["id"]},
    )
    assert promoted.status_code == 200, promoted.text
    assert promoted.json()["retired"] == first["version"]

    detail = await client.get(f"/v1/studio/workflows/{created['id']}", headers=_auth())
    statuses = {v["version"]: v["status"] for v in detail.json()["versions"]}
    assert statuses == {first["version"]: "retired", second["version"]: "deployed"}
    assert detail.json()["deployed_version"] == second["version"]


async def test_a_deployed_version_cannot_be_edited(client) -> None:
    """Editing a live version would change an integration's answers silently."""
    name = f"triage-frozen-{uuid4().hex[:6]}"
    created = await _create(client, name)
    version = (
        await client.post(f"/v1/studio/workflows/{created['id']}/compile", headers=_auth())
    ).json()

    # While it is only compiled, correcting it is allowed.
    allowed = await client.put(
        f"/v1/studio/workflows/{created['id']}/versions/{version['id']}",
        headers=_auth(),
        json={"definition": _triage_graph()},
    )
    assert allowed.status_code == 200, allowed.text

    await client.post(
        f"/v1/studio/workflows/{created['id']}/deploy",
        headers=_auth(),
        json={"version": version["version"]},
    )

    refused = await client.put(
        f"/v1/studio/workflows/{created['id']}/versions/{version['id']}",
        headers=_auth(),
        json={"definition": {"nodes": [], "edges": []}},
    )
    assert refused.status_code == 422, refused.text
    assert "cannot be edited" in refused.text

    # And the version still holds exactly what was deployed.
    stored = await client.get(
        f"/v1/studio/workflows/{created['id']}/versions/{version['id']}", headers=_auth()
    )
    assert len(stored.json()["definition"]["nodes"]) == 6

    # The draft, by contrast, is still free to change — that separation is the
    # reason versions exist at all.
    draft = await client.put(
        f"/v1/studio/workflows/{created['id']}",
        headers=_auth(),
        json={"definition": {"nodes": [], "edges": []}},
    )
    assert draft.status_code == 200, draft.text


async def test_a_deployed_agent_ignores_later_edits_to_the_draft(client) -> None:
    """The property the whole version table exists for.

    Everywhere else in this file the draft and the deployed version hold the same
    graph, so every one of those assertions passes just as happily against a
    router that re-reads the draft on every call — which would mean a live
    integration's answers changing the moment someone dragged a node about. The
    only way to tell the two apart is to make them disagree: the draft is edited
    to a graph that routes the same score differently, and the deployed name has
    to keep giving the old answer until a new version is deployed on purpose.
    """
    name = f"triage-frozen-answer-{uuid4().hex[:6]}"
    created = await _create(client, name)
    score = {"inputs": {"bureau_score": 780, "loan_amount": 500000}}

    first = (
        await client.post(f"/v1/studio/workflows/{created['id']}/compile", headers=_auth())
    ).json()
    await client.post(
        f"/v1/studio/workflows/{created['id']}/deploy",
        headers=_auth(),
        json={"version": first["version"]},
    )

    live = await client.post(f"/v1/studio/deployed/{name}/run", headers=_auth(), json=score)
    assert live.status_code == 201, live.text
    assert live.json()["output"]["decision"] == "approve"

    # A draft that would send this very score to review instead.
    edited = await client.put(
        f"/v1/studio/workflows/{created['id']}",
        headers=_auth(),
        json={"definition": _triage_graph(threshold=900)},
    )
    assert edited.status_code == 200, edited.text

    unchanged = await client.post(f"/v1/studio/deployed/{name}/run", headers=_auth(), json=score)
    assert unchanged.status_code == 201, unchanged.text
    assert unchanged.json()["output"]["decision"] == "approve"
    assert unchanged.json()["version_id"] == first["id"]

    # The draft itself does answer differently, which is what makes the line
    # above a statement about the version rather than about the edit failing.
    trial = await client.post(
        f"/v1/studio/workflows/{created['id']}/run", headers=_auth(), json=score
    )
    assert trial.status_code == 201, trial.text
    assert trial.json()["output"]["decision"] == "review"

    # And deploying the edit deliberately is the thing that moves live traffic.
    second = (
        await client.post(f"/v1/studio/workflows/{created['id']}/compile", headers=_auth())
    ).json()
    await client.post(
        f"/v1/studio/workflows/{created['id']}/deploy",
        headers=_auth(),
        json={"version_id": second["id"]},
    )
    moved = await client.post(f"/v1/studio/deployed/{name}/run", headers=_auth(), json=score)
    assert moved.json()["output"]["decision"] == "review"
    assert moved.json()["version_id"] == second["id"]

    # The retired version still holds the graph that produced the earlier
    # answer, which is what makes that answer explainable afterwards.
    old = await client.get(
        f"/v1/studio/workflows/{created['id']}/versions/{first['id']}", headers=_auth()
    )
    assert old.json()["status"] == "retired"
    assert "700" in str(old.json()["definition"])


async def test_a_deployed_workflow_cannot_be_deleted_out_from_under_its_callers(client) -> None:
    name = f"triage-live-{uuid4().hex[:6]}"
    created = await _create(client, name)
    version = (
        await client.post(f"/v1/studio/workflows/{created['id']}/compile", headers=_auth())
    ).json()
    await client.post(
        f"/v1/studio/workflows/{created['id']}/deploy",
        headers=_auth(),
        json={"version": version["version"]},
    )

    response = await client.delete(f"/v1/studio/workflows/{created['id']}", headers=_auth())
    assert response.status_code == 422, response.text
    assert "still callable" in response.text


async def test_the_retirement_the_delete_refusal_names_is_a_step_that_exists(client) -> None:
    """A refusal that names an impossible remedy is worse than no hint at all.

    Refusing to delete a live agent is right. But the refusal tells the caller to
    retire the version first, and if nothing can do that then a deployed workflow
    is simply undeletable for ever, with the error politely describing a door
    that is not there. So the hint is followed literally here.
    """
    name = f"triage-retire-{uuid4().hex[:6]}"
    created = await _create(client, name)
    version = (
        await client.post(f"/v1/studio/workflows/{created['id']}/compile", headers=_auth())
    ).json()
    await client.post(
        f"/v1/studio/workflows/{created['id']}/deploy",
        headers=_auth(),
        json={"version": version["version"]},
    )

    refused = await client.delete(f"/v1/studio/workflows/{created['id']}", headers=_auth())
    assert refused.status_code == 422, refused.text
    # The refusal has to hand over the id its own hint asks for.
    assert refused.json()["context"]["version_id"] == version["id"]

    retired = await client.post(
        f"/v1/studio/workflows/{created['id']}/versions/{version['id']}/retire",
        headers=_auth(),
    )
    assert retired.status_code == 200, retired.text
    assert retired.json()["status"] == "retired"

    # Out of service means the name stops answering, not that the row vanished.
    gone = await client.post(f"/v1/studio/deployed/{name}/run", headers=_auth(), json={})
    assert gone.status_code == 404, gone.text
    assert (
        await client.get(
            f"/v1/studio/workflows/{created['id']}/versions/{version['id']}", headers=_auth()
        )
    ).status_code == 200

    # A retired version is as closed to editing as a deployed one: it is the
    # record of what the runs that used it actually did.
    assert (
        await client.put(
            f"/v1/studio/workflows/{created['id']}/versions/{version['id']}",
            headers=_auth(),
            json={"definition": {"nodes": [], "edges": []}},
        )
    ).status_code == 422

    # Retiring twice would report a change that did not happen.
    again = await client.post(
        f"/v1/studio/workflows/{created['id']}/versions/{version['id']}/retire",
        headers=_auth(),
    )
    assert again.status_code == 422, again.text

    deleted = await client.delete(f"/v1/studio/workflows/{created['id']}", headers=_auth())
    assert deleted.status_code == 204, deleted.text


async def test_deleting_a_workflow_takes_its_versions_and_runs_with_it(client) -> None:
    """Delete says it removes the history too, and nothing else would remove it.

    The cascade is declared on the foreign keys rather than written out here, so
    it holds only while SQLite is asked to enforce foreign keys at all. That is a
    connection-level setting one edit away from being lost, and losing it would
    leave rows pointing at a workflow that no longer exists.
    """
    created = await _create(client, f"triage-cascade-{uuid4().hex[:6]}")
    version = (
        await client.post(f"/v1/studio/workflows/{created['id']}/compile", headers=_auth())
    ).json()
    run = await client.post(
        f"/v1/studio/workflows/{created['id']}/run",
        headers=_auth(),
        json={"inputs": {"bureau_score": 780, "loan_amount": 500000}},
    )
    assert run.status_code == 201, run.text

    assert (
        await client.delete(f"/v1/studio/workflows/{created['id']}", headers=_auth())
    ).status_code == 204

    history = await client.get(f"/v1/studio/runs?workflowId={created['id']}", headers=_auth())
    assert history.json() == []
    assert (
        await client.get(f"/v1/studio/runs/{run.json()['id']}", headers=_auth())
    ).status_code == 404
    assert (
        await client.get(
            f"/v1/studio/workflows/{created['id']}/versions/{version['id']}", headers=_auth()
        )
    ).status_code == 404


async def test_compiling_deploying_and_retiring_are_written_to_the_audit_log(client) -> None:
    """Each of these changes what a caller reaches without anything having run.

    A deployment leaves no trace in the run history — no run happened — so the
    audit log is the only place that records the moment a name started resolving
    to different behaviour.
    """
    # Credit head, because this principal both changes the agent and reads the
    # log; an underwriter holds no audit scope.
    head = _auth(role=Role.CREDIT_HEAD)
    name = f"triage-audited-{uuid4().hex[:6]}"
    created = await _create(client, name)

    version = (
        await client.post(f"/v1/studio/workflows/{created['id']}/compile", headers=head)
    ).json()
    await client.post(
        f"/v1/studio/workflows/{created['id']}/deploy",
        headers=head,
        json={"version": version["version"]},
    )
    await client.post(
        f"/v1/studio/workflows/{created['id']}/versions/{version['id']}/retire",
        headers=head,
    )

    entries = await client.get(f"/v1/audit?entity_id={version['id']}", headers=head)
    assert entries.status_code == 200, entries.text
    assert [row["action"] for row in entries.json()] == [
        "workflow.compiled",
        "workflow.deployed",
        "workflow.retired",
    ]
    assert all(row["entity_type"] == "workflow_version" for row in entries.json())


# --- tenancy ----------------------------------------------------------------


async def test_one_tenant_cannot_see_another_tenants_workflows(client) -> None:
    """The one that matters: a workflow is a lender's own automation.

    A foreign id reports as missing rather than as forbidden, because telling a
    caller that an id exists somewhere else is itself a leak.
    """
    name = f"triage-private-{uuid4().hex[:6]}"
    mine = await _create(client, name)

    listed = await client.get("/v1/studio/workflows", headers=_auth(OTHER_TENANT))
    assert listed.status_code == 200
    assert all(row["id"] != mine["id"] for row in listed.json())

    for call in (
        client.get(f"/v1/studio/workflows/{mine['id']}", headers=_auth(OTHER_TENANT)),
        client.put(
            f"/v1/studio/workflows/{mine['id']}",
            headers=_auth(OTHER_TENANT),
            json={"description": "not yours"},
        ),
        client.delete(f"/v1/studio/workflows/{mine['id']}", headers=_auth(OTHER_TENANT)),
        client.post(f"/v1/studio/workflows/{mine['id']}/validate", headers=_auth(OTHER_TENANT)),
        client.post(f"/v1/studio/workflows/{mine['id']}/run", headers=_auth(OTHER_TENANT)),
        client.post(f"/v1/studio/workflows/{mine['id']}/compile", headers=_auth(OTHER_TENANT)),
    ):
        assert (await call).status_code == 404

    # And the name is a per-tenant address, so it resolves to nothing here even
    # though it resolves to a deployed agent elsewhere.
    version = (
        await client.post(f"/v1/studio/workflows/{mine['id']}/compile", headers=_auth())
    ).json()
    await client.post(
        f"/v1/studio/workflows/{mine['id']}/deploy",
        headers=_auth(),
        json={"version": version["version"]},
    )
    foreign = await client.post(
        f"/v1/studio/deployed/{name}/run", headers=_auth(OTHER_TENANT), json={}
    )
    assert foreign.status_code == 404, foreign.text

    # The same name is therefore free for the other tenant to use.
    theirs = await client.post(
        "/v1/studio/workflows",
        headers=_auth(OTHER_TENANT),
        json={"name": name, "definition": _triage_graph()},
    )
    assert theirs.status_code == 201, theirs.text


async def test_one_tenants_runs_are_invisible_to_another(client) -> None:
    created = await _create(client, f"triage-runs-private-{uuid4().hex[:6]}")
    run = await client.post(
        f"/v1/studio/workflows/{created['id']}/run",
        headers=_auth(),
        json={"inputs": {"bureau_score": 700, "loan_amount": 100000}},
    )
    assert run.status_code == 201, run.text

    listed = await client.get("/v1/studio/runs", headers=_auth(OTHER_TENANT))
    assert all(row["id"] != run.json()["id"] for row in listed.json())

    fetched = await client.get(f"/v1/studio/runs/{run.json()['id']}", headers=_auth(OTHER_TENANT))
    assert fetched.status_code == 404


# --- authorisation ----------------------------------------------------------


async def test_the_studio_is_closed_without_a_token(client) -> None:
    assert (await client.get("/v1/studio/workflows")).status_code == 401
    assert (await client.get("/v1/studio/nodes")).status_code == 401


async def test_a_role_that_cannot_run_agents_cannot_deploy_one(client) -> None:
    """Reading how an agent is built is not authority to make it live."""
    created = await _create(client, f"triage-scope-{uuid4().hex[:6]}")
    token = issue_dev_token(tenant_id=TENANT, subject="test:reader", roles=[Role.DEVELOPER])
    reader = {"Authorization": f"Bearer {token}"}

    assert (await client.get("/v1/studio/workflows", headers=reader)).status_code == 200
    assert (
        await client.post(f"/v1/studio/workflows/{created['id']}/compile", headers=reader)
    ).status_code == 403
    assert (
        await client.post(f"/v1/studio/workflows/{created['id']}/run", headers=reader)
    ).status_code == 403
