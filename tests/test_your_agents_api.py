"""The "Your agents" API: whose workflow is whose, and what a stranger is told.

Three people, because two are not enough to test ownership. Ana and Bharat work
at the same lender; Chandra works at another. Ana and Bharat share a tenant and
share nothing else, which is the case that the tenant filter alone gets wrong
and the case this commit exists for.

Most of what follows is about what a caller is NOT told. A workflow that is not
yours has to be indistinguishable from a workflow that does not exist — same
status, same words — because a 403 confirms the id is real, and an id that is
confirmed real can be enumerated. So the assertions here are usually "404, and
the same 404 as an invented id", rather than "not 200".

The other half is the soft delete. Deleting has to look total from outside: gone
from the list, missing on every endpoint, its versions and its runs gone with
it. And it has to be undone by one call, because that is the difference between
an undo and an apology.
"""

from __future__ import annotations

import importlib.util
import re
from functools import partial
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from gravai_api.main import app
from gravai_api.routers.studio import NAME_MAX, TEMPLATES, _retail_loan
from gravai_core.auth import Role, issue_dev_token
from gravai_core.models import Base, Workflow
from gravai_workflow import NODE_REGISTRY
from httpx import ASGITransport, AsyncClient
from sqlalchemy import create_engine, inspect, select, text
from sqlalchemy.exc import IntegrityError

# The scanner the template test already owns, rather than a second one written
# here. It reads `studioTemplates.ts` as the data it is; see that module for why
# it is a scanner and not a TypeScript toolchain.
from test_studio_templates import _balanced, _split_args

REPO_ROOT = Path(__file__).resolve().parents[1]
TEMPLATES_TS = Path("apps/web/src/lib/studioTemplates.ts")

#: One lender, two people. Same tenant, different subjects: the pair that a
#: tenant-only filter treats as one person.
TENANT = uuid4()
ANA = "user:ana"
BHARAT = "user:bharat"

#: A different lender, whose subject is deliberately one of the two above. A
#: subject is unique inside a tenant and nowhere else, and an owner filter
#: applied without the tenant filter would hand Chandra Ana's workflows.
OTHER_TENANT = uuid4()
CHANDRA = ANA


def _auth(subject: str = ANA, tenant_id: UUID = TENANT) -> dict[str, str]:
    token = issue_dev_token(tenant_id=tenant_id, subject=subject, roles=[Role.UNDERWRITER])
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
async def client(_schema: None, db_session, make_tenant):  # type: ignore[no-untyped-def]
    for tenant in (TENANT, OTHER_TENANT):
        try:
            await make_tenant(tenant, slug=f"agents-{tenant.hex[:8]}")
        except IntegrityError:
            # Already inserted by an earlier test in this module. The rollback
            # is not optional: a session left in a failed transaction takes the
            # next statement down with it.
            await db_session.rollback()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as http:
        yield http


def _graph(fact: str = "score") -> dict[str, Any]:
    """A small deterministic graph, so a run asserts against arithmetic.

    No language-model node: the AI layer is sandboxed in this suite, and a test
    that turned on canned prose would be asserting about the fixtures rather
    than about the router.
    """
    return {
        "nodes": [
            {
                "id": "start",
                "type": "input",
                "name": "Application",
                "config": {"schema": {"bureau_score": "number"}},
                "position": {"x": 60, "y": 90},
            },
            {
                "id": "read",
                "type": "calculator",
                "name": "Read the score",
                "config": {"expression": "workflow.facts.bureau_score", "fact_name": fact},
                "position": {"x": 390, "y": 90},
            },
            {
                "id": "answer",
                "type": "output",
                "name": "Answer",
                "config": {"mapping": {fact: f"{{{{workflow.facts.{fact}}}}}"}},
                "position": {"x": 720, "y": 90},
            },
        ],
        "edges": [
            {"id": "start->read", "source": "start", "target": "read"},
            {"id": "read->answer", "source": "read", "target": "answer"},
        ],
    }


async def _create(
    client: AsyncClient,
    name: str,
    *,
    subject: str = ANA,
    tenant_id: UUID = TENANT,
    description: str = "A deterministic agent used by the ownership tests",
    definition: dict[str, Any] | None = None,
) -> dict[str, Any]:
    response = await client.post(
        "/v1/studio/workflows",
        headers=_auth(subject, tenant_id),
        json={
            "name": name,
            "description": description,
            "definition": _graph() if definition is None else definition,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


async def _row(db_session, workflow_id: str) -> Workflow | None:  # type: ignore[no-untyped-def]
    """The stored row, read outside the API, including if it is soft-deleted.

    Rolled back and expired first. This session has its own connection and its
    own identity map, so without both it would answer from what it loaded before
    the request rather than from what the request wrote — and a test that asserts
    on a stale copy of a row passes whatever the endpoint did.
    """
    await db_session.rollback()
    db_session.expire_all()
    found = await db_session.execute(select(Workflow).where(Workflow.id == UUID(workflow_id)))
    return found.scalar_one_or_none()


def _marker() -> str:
    """A token unique to one test, so its rows never mix with another test's.

    The suite shares one database, and a list endpoint returns whatever is in
    it. A test that asserted on the whole list would pass alone and fail beside
    its neighbours.
    """
    return uuid4().hex[:8]


# --- the list ---------------------------------------------------------------


async def test_the_list_shows_my_agents_and_not_my_colleagues(client) -> None:
    """The one that matters: same tenant, different people, separate benches."""
    marker = _marker()
    mine = await _create(client, f"{marker}-ana", subject=ANA)
    theirs = await _create(client, f"{marker}-bharat", subject=BHARAT)

    listed = await client.get(f"/v1/studio/workflows?q={marker}", headers=_auth(ANA))
    assert listed.status_code == 200, listed.text
    ids = [row["id"] for row in listed.json()]
    assert mine["id"] in ids
    assert theirs["id"] not in ids

    # And symmetrically, because an isolation that only holds one way is not
    # isolation, it is an ordering coincidence.
    listed = await client.get(f"/v1/studio/workflows?q={marker}", headers=_auth(BHARAT))
    assert [row["id"] for row in listed.json()] == [theirs["id"]]


async def test_an_identical_subject_at_another_lender_sees_nothing(client) -> None:
    """The tenant filter is never dropped, only added to.

    Chandra's subject is the same string as Ana's. If ownership were filtered on
    its own — which reads as the natural thing to do, since a subject looks
    unique — this list would carry another lender's automation.
    """
    marker = _marker()
    mine = await _create(client, f"{marker}-ana", subject=ANA)

    listed = await client.get(
        f"/v1/studio/workflows?q={marker}", headers=_auth(CHANDRA, OTHER_TENANT)
    )
    assert listed.status_code == 200, listed.text
    assert listed.json() == []

    fetched = await client.get(
        f"/v1/studio/workflows/{mine['id']}", headers=_auth(CHANDRA, OTHER_TENANT)
    )
    assert fetched.status_code == 404


async def test_a_card_carries_the_shape_and_not_the_configuration(client) -> None:
    """The list is thirty cards; the definition is where prompts live.

    Shipping the whole definition per card would put every prompt, mapping and
    credential name on a screen that only needs to draw a small picture of the
    graph — and would make the page heavy for no benefit.
    """
    marker = _marker()
    created = await _create(client, f"{marker}-card")

    listed = await client.get(f"/v1/studio/workflows?q={marker}", headers=_auth(ANA))
    card = listed.json()[0]

    assert card["node_count"] == 3
    assert card["edge_count"] == 2
    assert "definition" not in card

    thumbnail = card["thumbnail"]
    assert [node["type"] for node in thumbnail["nodes"]] == ["input", "calculator", "output"]
    assert thumbnail["nodes"][0]["x"] == 60
    assert thumbnail["nodes"][0]["y"] == 90
    assert [(e["source"], e["target"]) for e in thumbnail["edges"]] == [
        ("start", "read"),
        ("read", "answer"),
    ]
    # Nothing from any node's config reaches the card. `expression` is the
    # calculator's only setting here, and it stands in for the prompt a real
    # graph would carry.
    assert "expression" not in listed.text
    assert "workflow.facts.bureau_score" not in listed.text

    # The detail endpoint is where the definition lives, and still does.
    detail = await client.get(f"/v1/studio/workflows/{created['id']}", headers=_auth(ANA))
    assert detail.json()["definition"]["nodes"][1]["config"]["expression"]


async def test_a_node_without_a_position_reports_none_rather_than_a_corner(client) -> None:
    """A definition is arbitrary JSON, and a made-up coordinate is still made up.

    Reporting (0, 0) for a node the canvas never placed would draw a card
    showing a graph nobody arranged, and the page could not tell that apart from
    a node genuinely at the origin.
    """
    marker = _marker()
    definition = {
        "nodes": [
            {"id": "a", "type": "input"},
            {"id": "b", "type": "output", "position": {"x": "not a number", "y": 12}},
        ],
        "edges": [{"source": "a", "target": "b"}, "this is not an edge"],
    }
    await _create(client, f"{marker}-odd", definition=definition)

    listed = await client.get(f"/v1/studio/workflows?q={marker}", headers=_auth(ANA))
    assert listed.status_code == 200, listed.text
    thumbnail = listed.json()[0]["thumbnail"]
    assert thumbnail["nodes"][0]["x"] is None
    assert thumbnail["nodes"][1]["x"] is None
    assert thumbnail["nodes"][1]["y"] == 12
    # The malformed edge is dropped rather than drawn or raised.
    assert len(thumbnail["edges"]) == 1


async def test_the_total_counts_the_whole_set_not_the_page(client) -> None:
    """A count of the page is the size of the window, not the size of the set."""
    marker = _marker()
    for index in range(5):
        await _create(client, f"{marker}-{index}")

    listed = await client.get(f"/v1/studio/workflows?q={marker}&limit=2", headers=_auth(ANA))
    assert listed.status_code == 200, listed.text
    assert len(listed.json()) == 2
    assert listed.headers["X-Total-Count"] == "5"

    # And the total respects the same filters as the rows, or it is a count of
    # something the caller is not looking at.
    listed = await client.get(f"/v1/studio/workflows?q={marker}-3", headers=_auth(ANA))
    assert listed.headers["X-Total-Count"] == "1"


async def test_searching_and_sorting_happen_in_sql(client) -> None:
    """Paginate past a page boundary and the page has to be the globally sorted one.

    This is the assertion that tells a SQL sort from a Python one. The rows are
    created in an order that is deliberately not their alphabetical order, so a
    server that fetched a page and sorted what it got would return the third
    slice of the insertion order, sorted — which is a different set of names
    from the third slice of the alphabet.
    """
    marker = _marker()
    letters = ["delta", "alpha", "foxtrot", "charlie", "bravo", "echo", "golf"]
    for letter in letters:
        await _create(client, f"{marker}-{letter}")

    expected = sorted(f"{marker}-{letter}" for letter in letters)

    page = await client.get(
        f"/v1/studio/workflows?q={marker}&sort=name&limit=3&offset=3", headers=_auth(ANA)
    )
    assert page.status_code == 200, page.text
    assert [row["name"] for row in page.json()] == expected[3:6]
    assert page.headers["X-Total-Count"] == "7"

    # The same argument for the search itself: the match is on the last page of
    # the insertion order, so a filter applied after fetching page one would
    # find nothing at all.
    found = await client.get(f"/v1/studio/workflows?q={marker}-golf&limit=2", headers=_auth(ANA))
    assert [row["name"] for row in found.json()] == [f"{marker}-golf"]


async def test_search_reads_the_description_too_and_is_case_insensitive(client) -> None:
    marker = _marker()
    await _create(client, f"{marker}-plain", description="Collections follow-up for the north")

    for term in ("COLLECTIONS", "collections", "north"):
        found = await client.get(f"/v1/studio/workflows?q={term}", headers=_auth(ANA))
        names = [row["name"] for row in found.json()]
        assert f"{marker}-plain" in names, term


async def test_a_search_for_a_wildcard_is_a_search_for_that_character(client) -> None:
    """`%` is a literal to the person typing it, whatever LIKE thinks.

    An unescaped wildcard matches every workflow the caller owns, which reads as
    a search that ignored them — the same symptom as a broken filter, arrived at
    by a different route.
    """
    marker = _marker()
    await _create(client, f"{marker}-hundred-%-percent")
    await _create(client, f"{marker}-ordinary")

    found = await client.get("/v1/studio/workflows?q=%25", headers=_auth(ANA))
    assert found.status_code == 200, found.text
    names = [row["name"] for row in found.json()]
    assert f"{marker}-hundred-%-percent" in names
    assert f"{marker}-ordinary" not in names


async def test_an_unknown_sort_is_refused_rather_than_guessed(client) -> None:
    """The sort names a column, so the set of names is closed.

    Falling back to a default on an unrecognised value would answer a question
    the caller did not ask and look exactly like the sort having worked.
    """
    response = await client.get("/v1/studio/workflows?sort=owner_subject", headers=_auth(ANA))
    assert response.status_code == 422, response.text


# --- ownership --------------------------------------------------------------


def _every_endpoint(client: AsyncClient, workflow_id: str, subject: str):  # type: ignore[no-untyped-def]
    """Every route that takes a workflow id, as calls waiting to be made.

    Partials rather than coroutines, so a test that skips one of these is
    skipping a call rather than leaving an un-awaited coroutine behind.

    The list is exhaustive on purpose. "A deleted workflow is absent" and "a
    colleague's id is missing" are single decisions, and the way they stop being
    single decisions is a route added later that nobody came back to check.
    """
    headers = _auth(subject)
    version_id = uuid4()
    base = f"/v1/studio/workflows/{workflow_id}"
    versions = f"{base}/versions/{version_id}"
    return {
        "get": partial(client.get, base, headers=headers),
        "put": partial(client.put, base, headers=headers, json={"description": "mine now"}),
        "patch": partial(client.patch, base, headers=headers, json={"name": "mine now"}),
        "delete": partial(client.delete, base, headers=headers),
        "restore": partial(client.post, f"{base}/restore", headers=headers),
        "duplicate": partial(client.post, f"{base}/duplicate", headers=headers),
        "validate": partial(client.post, f"{base}/validate", headers=headers),
        "run": partial(client.post, f"{base}/run", headers=headers, json={}),
        "compile": partial(client.post, f"{base}/compile", headers=headers),
        "deploy": partial(client.post, f"{base}/deploy", headers=headers, json={"version": "1.0"}),
        "get_version": partial(client.get, versions, headers=headers),
        "edit_version": partial(
            client.put, versions, headers=headers, json={"definition": {"nodes": [], "edges": []}}
        ),
        "retire_version": partial(client.post, f"{versions}/retire", headers=headers),
    }


async def test_a_colleagues_id_is_missing_on_every_endpoint_and_never_forbidden(client) -> None:
    """404, not 403, everywhere — and the same 404 an invented id gets.

    A 403 says "this id is real and is somebody else's", which is enough to walk
    the tenant's ids and learn what is being built and by whom. The two
    responses are compared field by field rather than only by status, because a
    message that differed would be the same oracle in a politer voice.
    """
    marker = _marker()
    theirs = await _create(client, f"{marker}-bharat", subject=BHARAT)
    invented = uuid4()

    for route, call in _every_endpoint(client, theirs["id"], ANA).items():
        response = await call()
        assert response.status_code == 404, f"{route}: {response.status_code} {response.text}"

    for route, call in _every_endpoint(client, str(invented), ANA).items():
        missing = await call()
        assert missing.status_code == 404, route

    real = await client.get(f"/v1/studio/workflows/{theirs['id']}", headers=_auth(ANA))
    fictional = await client.get(f"/v1/studio/workflows/{invented}", headers=_auth(ANA))
    assert real.json()["title"] == fictional.json()["title"]
    assert real.json()["detail"] == fictional.json()["detail"]

    # Nothing happened to the row that was refused.
    still = await client.get(f"/v1/studio/workflows/{theirs['id']}", headers=_auth(BHARAT))
    assert still.status_code == 200, still.text
    assert still.json()["name"] == f"{marker}-bharat"
    assert still.json()["description"] != "mine now"


async def test_a_workflow_with_no_owner_stays_visible_to_its_whole_tenant(
    client, db_session
) -> None:
    """The rows that predate ownership are not hidden, and not claimed either.

    `owner_subject` is nullable because there is no record of who wrote these
    and no honest way to invent one — the migration says so at length. A NULL
    owner therefore means "built before anyone claimed it", and the tenant keeps
    seeing it. Hiding somebody's work to tidy a schema is not a migration, it is
    data loss with extra steps.

    Nor does touching it claim it. If the first person to open one became its
    owner, the rows would disappear from everybody else's list one save at a
    time, which is the same loss arriving slowly.
    """
    marker = _marker()
    unclaimed = Workflow(
        tenant_id=TENANT,
        name=f"{marker}-from-before",
        description="Written before this column existed",
        definition=_graph(),
        owner_subject=None,
    )
    db_session.add(unclaimed)
    await db_session.commit()
    workflow_id = str(unclaimed.id)

    for subject in (ANA, BHARAT):
        listed = await client.get(f"/v1/studio/workflows?q={marker}", headers=_auth(subject))
        assert [row["id"] for row in listed.json()] == [workflow_id], subject
        opened = await client.get(f"/v1/studio/workflows/{workflow_id}", headers=_auth(subject))
        assert opened.status_code == 200, subject

    saved = await client.put(
        f"/v1/studio/workflows/{workflow_id}",
        headers=_auth(ANA),
        json={"description": "Ana had a look"},
    )
    assert saved.status_code == 200, saved.text

    row = await _row(db_session, workflow_id)
    assert row is not None
    assert row.owner_subject is None
    assert row.description == "Ana had a look"

    # Still Bharat's to see, after Ana edited it.
    listed = await client.get(f"/v1/studio/workflows?q={marker}", headers=_auth(BHARAT))
    assert [row["id"] for row in listed.json()] == [workflow_id]

    # Duplicating is how you take a copy of one of these without taking it from
    # anybody: the copy is yours, the original is still everyone's.
    copied = await client.post(
        f"/v1/studio/workflows/{workflow_id}/duplicate", headers=_auth(BHARAT)
    )
    assert copied.status_code == 201, copied.text
    copy_row = await _row(db_session, copied.json()["id"])
    assert copy_row is not None
    assert copy_row.owner_subject == BHARAT
    assert (await _row(db_session, workflow_id)).owner_subject is None


async def test_the_owner_is_taken_from_the_token_and_never_from_the_body(
    client, db_session
) -> None:
    """The first thing to try against an owner check is naming the owner.

    Pydantic's default would drop an unknown field silently, which from outside
    is indistinguishable from the field having been accepted — so a caller who
    tries to create a workflow as somebody else would have no way of knowing it
    had not worked, and neither would a reviewer reading the request log. The
    request models forbid extra fields so the attempt is answered rather than
    ignored.
    """
    marker = _marker()
    for body in (
        {"name": f"{marker}-as-bharat", "owner_subject": BHARAT, "definition": {}},
        {"name": f"{marker}-as-other", "tenant_id": str(OTHER_TENANT), "definition": {}},
    ):
        refused = await client.post("/v1/studio/workflows", headers=_auth(ANA), json=body)
        assert refused.status_code == 422, refused.text

    # And nothing was created under either name.
    listed = await client.get(f"/v1/studio/workflows?q={marker}", headers=_auth(ANA))
    assert listed.json() == []

    mine = await _create(client, f"{marker}-mine")
    handed_over = await client.put(
        f"/v1/studio/workflows/{mine['id']}",
        headers=_auth(ANA),
        json={"description": "still mine", "owner_subject": BHARAT},
    )
    assert handed_over.status_code == 422, handed_over.text

    row = await _row(db_session, mine["id"])
    assert row is not None
    assert row.owner_subject == ANA
    assert row.tenant_id == TENANT


async def test_a_version_of_a_colleagues_workflow_cannot_be_read_through_my_own(client) -> None:
    """Two ids in the path, and both have to agree.

    The workflow is loaded through the owner-scoped lookup, and the version has
    to belong to it. Putting your own workflow id in front of a colleague's
    version id is the obvious way to try to read a graph you cannot open, and it
    has to report as missing like everything else.
    """
    marker = _marker()
    mine = await _create(client, f"{marker}-mine", subject=ANA)
    theirs = await _create(client, f"{marker}-theirs", subject=BHARAT)

    their_version = await client.post(
        f"/v1/studio/workflows/{theirs['id']}/compile", headers=_auth(BHARAT)
    )
    assert their_version.status_code == 201, their_version.text
    version_id = their_version.json()["id"]

    smuggled = await client.get(
        f"/v1/studio/workflows/{mine['id']}/versions/{version_id}", headers=_auth(ANA)
    )
    assert smuggled.status_code == 404, smuggled.text
    assert "bureau_score" not in smuggled.text


async def test_a_deployed_agent_answers_to_its_name_for_the_whole_tenant(client) -> None:
    """The documented edge of the ownership model, asserted so it stays deliberate.

    A deployed agent is addressed by name, and a call by name carries no owner —
    the caller is usually an integration or a service token, which owns nothing.
    Scoping `/deployed/{name}/run` to the person who drew the graph would turn
    every existing integration off. So deploying publishes within the tenant,
    which is why it is a separate, audited act, and why a deployed workflow
    cannot be deleted without retiring it first.

    What is NOT published is the draft: until Bharat deploys, his name resolves
    to nothing for Ana, and his canvas is his own either way.
    """
    marker = _marker()
    theirs = await _create(client, f"{marker}-shared", subject=BHARAT)

    before = await client.post(
        f"/v1/studio/deployed/{marker}-shared/run", headers=_auth(ANA), json={}
    )
    assert before.status_code == 404, before.text

    version = await client.post(
        f"/v1/studio/workflows/{theirs['id']}/compile", headers=_auth(BHARAT)
    )
    assert version.status_code == 201, version.text
    deployed = await client.post(
        f"/v1/studio/workflows/{theirs['id']}/deploy",
        headers=_auth(BHARAT),
        json={"version": version.json()["version"]},
    )
    assert deployed.status_code == 200, deployed.text

    called = await client.post(
        f"/v1/studio/deployed/{marker}-shared/run",
        headers=_auth(ANA),
        json={"inputs": {"bureau_score": 742}},
    )
    assert called.status_code == 201, called.text
    assert called.json()["output"]["score"] == "742"

    # Publishing the agent still does not hand over the canvas.
    assert (
        await client.get(f"/v1/studio/workflows/{theirs['id']}", headers=_auth(ANA))
    ).status_code == 404

    # Nor does it cross the tenant boundary.
    outside = await client.post(
        f"/v1/studio/deployed/{marker}-shared/run", headers=_auth(CHANDRA, OTHER_TENANT), json={}
    )
    assert outside.status_code == 404, outside.text


async def test_a_colleagues_test_run_cannot_be_read_through_the_run_history(client) -> None:
    """The hole standing open beside the door this commit locked.

    The workflow endpoints return 404 for somebody else's id, and `/runs` did
    not: it was tenant-wide, and a draft run's trace is the canvas it came from
    — every node's output, the state the run built, the graph it ran. Listing
    the history and following an id would have handed all of that over, whatever
    the 404 on the workflow said. Found by trying it; closed here.

    The split is where the rest of the studio's is. A run through a deployed
    version is the lender's live traffic and stays visible to the tenant, because
    the people who watch that traffic are not usually the person who drew the
    graph.
    """
    marker = _marker()
    theirs = await _create(client, f"{marker}-bharats", subject=BHARAT)
    draft_run = await client.post(
        f"/v1/studio/workflows/{theirs['id']}/run",
        headers=_auth(BHARAT),
        json={"inputs": {"bureau_score": 733}},
    )
    assert draft_run.status_code == 201, draft_run.text
    run_id = draft_run.json()["id"]

    listed = await client.get("/v1/studio/runs?limit=200", headers=_auth(ANA))
    assert run_id not in [row["id"] for row in listed.json()]
    assert (
        await client.get(f"/v1/studio/runs?workflowId={theirs['id']}", headers=_auth(ANA))
    ).json() == []

    hidden = await client.get(f"/v1/studio/runs/{run_id}", headers=_auth(ANA))
    assert hidden.status_code == 404, hidden.text
    assert "733" not in hidden.text

    # Bharat's own history is untouched by any of that.
    mine = await client.get(f"/v1/studio/runs/{run_id}", headers=_auth(BHARAT))
    assert mine.status_code == 200, mine.text

    # Once it is deployed, the traffic through it is the lender's record.
    version = await client.post(
        f"/v1/studio/workflows/{theirs['id']}/compile", headers=_auth(BHARAT)
    )
    await client.post(
        f"/v1/studio/workflows/{theirs['id']}/deploy",
        headers=_auth(BHARAT),
        json={"version": version.json()["version"]},
    )
    live = await client.post(
        f"/v1/studio/deployed/{marker}-bharats/run",
        headers=_auth(ANA),
        json={"inputs": {"bureau_score": 611}},
    )
    assert live.status_code == 201, live.text
    seen = await client.get(f"/v1/studio/runs/{live.json()['id']}", headers=_auth(ANA))
    assert seen.status_code == 200, seen.text
    assert seen.json()["version_id"] == version.json()["id"]


# --- deleting, and undoing it -----------------------------------------------


async def test_deleting_hides_it_everywhere_without_destroying_it(client, db_session) -> None:
    """A soft delete has to be total from outside and reversible from inside."""
    marker = _marker()
    created = await _create(client, f"{marker}-doomed")
    run = await client.post(
        f"/v1/studio/workflows/{created['id']}/run",
        headers=_auth(ANA),
        json={"inputs": {"bureau_score": 700}},
    )
    assert run.status_code == 201, run.text
    version = await client.post(f"/v1/studio/workflows/{created['id']}/compile", headers=_auth(ANA))
    assert version.status_code == 201, version.text

    deleted = await client.delete(f"/v1/studio/workflows/{created['id']}", headers=_auth(ANA))
    assert deleted.status_code == 204, deleted.text

    listed = await client.get(f"/v1/studio/workflows?q={marker}", headers=_auth(ANA))
    assert listed.json() == []
    assert listed.headers["X-Total-Count"] == "0"

    for route, call in _every_endpoint(client, created["id"], ANA).items():
        # Restore is the one endpoint that can still see it. That is the whole
        # difference between this and a delete that cannot be undone.
        if route == "restore":
            continue
        response = await call()
        assert response.status_code == 404, f"{route}: {response.status_code} {response.text}"

    # Its history goes with it, exactly as a hard delete's cascade used to.
    history = await client.get(f"/v1/studio/runs?workflowId={created['id']}", headers=_auth(ANA))
    assert history.json() == []
    assert (
        await client.get(f"/v1/studio/runs/{run.json()['id']}", headers=_auth(ANA))
    ).status_code == 404

    # And none of it is gone. This is the whole difference: the row is marked,
    # not removed, and the definition is still there to come back to.
    row = await _row(db_session, created["id"])
    assert row is not None
    assert row.deleted_at is not None
    assert row.definition["nodes"][1]["config"]["expression"] == "workflow.facts.bureau_score"


async def test_restore_brings_back_the_workflow_its_versions_and_its_runs(client) -> None:
    marker = _marker()
    created = await _create(client, f"{marker}-undo")
    run = await client.post(
        f"/v1/studio/workflows/{created['id']}/run",
        headers=_auth(ANA),
        json={"inputs": {"bureau_score": 812}},
    )
    version = await client.post(f"/v1/studio/workflows/{created['id']}/compile", headers=_auth(ANA))
    await client.delete(f"/v1/studio/workflows/{created['id']}", headers=_auth(ANA))

    restored = await client.post(
        f"/v1/studio/workflows/{created['id']}/restore", headers=_auth(ANA)
    )
    assert restored.status_code == 200, restored.text
    assert restored.json()["name"] == f"{marker}-undo"
    assert [v["id"] for v in restored.json()["versions"]] == [version.json()["id"]]

    listed = await client.get(f"/v1/studio/workflows?q={marker}", headers=_auth(ANA))
    assert [row["id"] for row in listed.json()] == [created["id"]]

    recovered = await client.get(f"/v1/studio/runs/{run.json()['id']}", headers=_auth(ANA))
    assert recovered.status_code == 200, recovered.text
    assert recovered.json()["output"]["score"] == "812"

    # Undo is a button that can be pressed twice. The state asked for is already
    # true, so the second press reports it rather than refusing.
    again = await client.post(f"/v1/studio/workflows/{created['id']}/restore", headers=_auth(ANA))
    assert again.status_code == 200, again.text


async def test_a_colleague_cannot_restore_what_they_could_never_see(client, db_session) -> None:
    """Deleting is not a way to make somebody else's id start answering."""
    marker = _marker()
    theirs = await _create(client, f"{marker}-bharat", subject=BHARAT)
    await client.delete(f"/v1/studio/workflows/{theirs['id']}", headers=_auth(BHARAT))

    refused = await client.post(f"/v1/studio/workflows/{theirs['id']}/restore", headers=_auth(ANA))
    assert refused.status_code == 404, refused.text

    row = await _row(db_session, theirs["id"])
    assert row is not None
    assert row.deleted_at is not None


async def test_a_deployed_workflow_is_still_refused_rather_than_softly_deleted(client) -> None:
    """Softening the delete does not soften what it means to be live.

    Marking a deployed agent deleted would leave the lender running something
    nobody can see or explain; making the delete stop the name answering would
    break its callers at the moment of a click, with no record that an agent had
    been withdrawn. Retiring is that record, and the refusal hands over the id to
    do it with.
    """
    marker = _marker()
    created = await _create(client, f"{marker}-live")
    version = (
        await client.post(f"/v1/studio/workflows/{created['id']}/compile", headers=_auth(ANA))
    ).json()
    await client.post(
        f"/v1/studio/workflows/{created['id']}/deploy",
        headers=_auth(ANA),
        json={"version": version["version"]},
    )

    refused = await client.delete(f"/v1/studio/workflows/{created['id']}", headers=_auth(ANA))
    assert refused.status_code == 422, refused.text
    assert refused.json()["context"]["version_id"] == version["id"]

    # Still listed, still callable: a refused delete changed nothing.
    listed = await client.get(f"/v1/studio/workflows?q={marker}", headers=_auth(ANA))
    assert [row["id"] for row in listed.json()] == [created["id"]]
    called = await client.post(
        f"/v1/studio/deployed/{marker}-live/run",
        headers=_auth(ANA),
        json={"inputs": {"bureau_score": 650}},
    )
    assert called.status_code == 201, called.text


async def test_a_deleted_workflow_keeps_its_name_and_says_so(client) -> None:
    """The name is an address, and restoring has to put the agent back at it.

    So a deleted workflow goes on holding its name, and create refuses it. The
    refusal has to explain which case it is: "that name is taken" about a
    workflow the caller cannot find anywhere is a dead end rather than an
    answer.
    """
    marker = _marker()
    created = await _create(client, f"{marker}-held")
    await client.delete(f"/v1/studio/workflows/{created['id']}", headers=_auth(ANA))

    refused = await client.post(
        "/v1/studio/workflows",
        headers=_auth(ANA),
        json={"name": f"{marker}-held", "definition": {}},
    )
    assert refused.status_code == 422, refused.text
    assert "deleted workflow" in refused.json()["detail"].lower()
    # The refusal names the name, which is a tenant-wide address, and nothing
    # else: no id and no owner, which is what the 404s are careful to withhold.
    assert refused.json()["context"]["name"] == f"{marker}-held"
    assert created["id"] not in refused.text

    restored = await client.post(
        f"/v1/studio/workflows/{created['id']}/restore", headers=_auth(ANA)
    )
    assert restored.status_code == 200, restored.text
    assert restored.json()["name"] == f"{marker}-held"


# --- duplicating ------------------------------------------------------------


async def test_a_second_copy_does_not_collide_with_the_first(client, db_session) -> None:
    """A suffix that counts, rather than a constraint that bends.

    The unique constraint stays tenant-wide because the name is how a deployed
    agent is invoked, and two rows answering to one name would leave a live
    caller reaching whichever came back first. Duplicating is a convenience, so
    the convenience is what gives way.
    """
    marker = _marker()
    original = await _create(client, f"{marker}-original")

    names = []
    for _ in range(3):
        copied = await client.post(
            f"/v1/studio/workflows/{original['id']}/duplicate", headers=_auth(ANA)
        )
        assert copied.status_code == 201, copied.text
        names.append(copied.json()["name"])

    assert names == [
        f"{marker}-original copy",
        f"{marker}-original copy 2",
        f"{marker}-original copy 3",
    ]

    # The copy carries the graph and the description, and nothing that was live.
    latest = copied.json()
    assert latest["definition"] == original["definition"]
    assert latest["description"] == original["description"]
    assert latest["versions"] == []
    assert latest["deployed_version"] is None

    row = await _row(db_session, latest["id"])
    assert row is not None
    assert row.owner_subject == ANA


async def test_a_copy_is_owned_by_whoever_asked_for_it(client, db_session) -> None:
    """Duplicating a shared workflow gives you your own, not a share of theirs."""
    marker = _marker()
    unclaimed = Workflow(
        tenant_id=TENANT,
        name=f"{marker}-communal",
        description="No owner, visible to all",
        definition=_graph(),
        owner_subject=None,
    )
    db_session.add(unclaimed)
    await db_session.commit()

    copied = await client.post(
        f"/v1/studio/workflows/{unclaimed.id}/duplicate",
        headers=_auth(BHARAT),
        json={"name": f"{marker}-bharats-own"},
    )
    assert copied.status_code == 201, copied.text

    # Ana cannot see the copy, though she can still see the original.
    listed = await client.get(f"/v1/studio/workflows?q={marker}", headers=_auth(ANA))
    assert [row["name"] for row in listed.json()] == [f"{marker}-communal"]

    row = await _row(db_session, copied.json()["id"])
    assert row is not None
    assert row.owner_subject == BHARAT


async def test_a_copys_name_stays_inside_the_column(client) -> None:
    """A copy of a copy of a long name must not be refused by the database.

    The base gives way and the suffix survives, because the suffix is the part
    that makes the name unique. The alternative is a 500 from a column width, on
    a button that should always work.
    """
    marker = _marker()
    long_name = f"{marker}-{'x' * (NAME_MAX - len(marker) - 1)}"
    assert len(long_name) == NAME_MAX

    original = await _create(client, long_name)
    first = await client.post(
        f"/v1/studio/workflows/{original['id']}/duplicate", headers=_auth(ANA)
    )
    assert first.status_code == 201, first.text
    assert len(first.json()["name"]) <= NAME_MAX
    assert first.json()["name"].endswith(" copy")

    second = await client.post(
        f"/v1/studio/workflows/{original['id']}/duplicate", headers=_auth(ANA)
    )
    assert second.status_code == 201, second.text
    assert len(second.json()["name"]) <= NAME_MAX
    assert second.json()["name"] != first.json()["name"]


# --- renaming and lengths ---------------------------------------------------


async def test_rename_changes_the_name_and_nothing_else(client) -> None:
    marker = _marker()
    created = await _create(client, f"{marker}-before")

    renamed = await client.patch(
        f"/v1/studio/workflows/{created['id']}",
        headers=_auth(ANA),
        json={"name": f"{marker}-after"},
    )
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["name"] == f"{marker}-after"
    assert renamed.json()["definition"] == created["definition"]

    # A rename that could also carry a definition would let a stale list page
    # overwrite the canvas somebody has open elsewhere.
    refused = await client.patch(
        f"/v1/studio/workflows/{created['id']}",
        headers=_auth(ANA),
        json={"name": f"{marker}-after", "definition": {"nodes": [], "edges": []}},
    )
    assert refused.status_code == 422, refused.text

    reread = await client.get(f"/v1/studio/workflows/{created['id']}", headers=_auth(ANA))
    assert reread.json()["definition"]["nodes"]


async def test_a_name_a_colleague_holds_is_refused_without_saying_whose(client) -> None:
    marker = _marker()
    await _create(client, f"{marker}-taken", subject=BHARAT)
    mine = await _create(client, f"{marker}-mine", subject=ANA)

    refused = await client.patch(
        f"/v1/studio/workflows/{mine['id']}",
        headers=_auth(ANA),
        json={"name": f"{marker}-taken"},
    )
    assert refused.status_code == 422, refused.text
    assert BHARAT not in refused.text


@pytest.mark.parametrize(
    "field, value",
    [
        ("name", "x" * (NAME_MAX + 1)),
        ("name", "   "),
        ("name", ""),
        ("description", "d" * 2001),
    ],
)
async def test_lengths_are_enforced_by_the_server(client, field: str, value: str) -> None:
    """The browser is not where a limit lives.

    `name` is 120 characters in the database, so a name that passed here and
    failed there would reach the caller as a 500 rather than as something they
    can read and fix. A name of only spaces passes a minimum length and is still
    not a name: it lists as a nameless card and no call by name could address
    it.
    """
    marker = _marker()
    body = {"name": f"{marker}-ok", "description": "fine", "definition": {}}
    body[field] = value

    refused = await client.post("/v1/studio/workflows", headers=_auth(ANA), json=body)
    assert refused.status_code == 422, refused.text

    created = await _create(client, f"{marker}-exists")
    refused = await client.put(
        f"/v1/studio/workflows/{created['id']}", headers=_auth(ANA), json={field: value}
    )
    assert refused.status_code == 422, refused.text

    unchanged = await client.get(f"/v1/studio/workflows/{created['id']}", headers=_auth(ANA))
    assert unchanged.json()["name"] == f"{marker}-exists"


async def test_a_name_is_trimmed_before_it_is_stored(client) -> None:
    """A padded name and a bare one are one address, not two.

    Without this the unique constraint would happily hold both, and a call by
    name would reach one of them for reasons nobody could see on the page.
    """
    marker = _marker()
    created = await _create(client, f"  {marker}-padded  ")
    assert created["name"] == f"{marker}-padded"

    clash = await client.post(
        "/v1/studio/workflows",
        headers=_auth(ANA),
        json={"name": f"{marker}-padded ", "definition": {}},
    )
    assert clash.status_code == 422, clash.text


# --- starters ---------------------------------------------------------------


async def test_the_starter_seeds_a_graph_made_of_nodes_this_build_has(client) -> None:
    """The one test the starter exists to pass.

    A starter naming a type the engine does not register looks fine in the
    picker, renders on the canvas and fails at the save, with "'x' is not a node
    type this build knows" about a node the person never chose. Checking against
    the engine's own registry — the same one that dispatches the run — is the
    only check that means anything.
    """
    marker = _marker()
    created = await client.post(
        "/v1/studio/workflows",
        headers=_auth(ANA),
        json={"name": f"{marker}-credit", "template": "credit"},
    )
    assert created.status_code == 201, created.text

    definition = created.json()["definition"]
    types = [node["type"] for node in definition["nodes"]]
    assert types, "the starter seeded an empty graph"
    assert set(types) <= set(NODE_REGISTRY), sorted(set(types) - set(NODE_REGISTRY))

    # And the engine agrees, on the saved row, through the endpoint the canvas
    # uses: no problem here may be about an unknown node type.
    checked = await client.post(
        f"/v1/studio/workflows/{created.json()['id']}/validate", headers=_auth(ANA)
    )
    assert checked.status_code == 200, checked.text
    unknown = [p for p in checked.json()["problems"] if "not a node type" in p["message"]]
    assert unknown == []

    # The starter's own description, since the caller wrote none.
    assert "Retail loan decisioning end to end" in created.json()["description"]
    row = created.json()
    assert row["node_count"] == len(definition["nodes"])


async def test_a_starter_that_named_a_missing_node_would_be_refused_at_creation(
    client, monkeypatch
) -> None:
    """Loudly, and before anything is stored.

    The alternative is a workflow that exists, cannot be validated, run or
    compiled, and blames a node its owner did not choose. Dropping the unknown
    node instead would be worse: a credit starter silently missing its scoring
    step is a different shape from the one that was asked for.
    """
    marker = _marker()

    def _broken() -> dict[str, Any]:
        definition = _retail_loan()
        definition["nodes"][3]["type"] = "agent.a_node_this_build_does_not_have"
        return definition

    monkeypatch.setitem(
        TEMPLATES,
        "credit",
        TEMPLATES["credit"].__class__(
            id="credit",
            label="Credit agent",
            description="",
            build=_broken,
        ),
    )

    refused = await client.post(
        "/v1/studio/workflows",
        headers=_auth(ANA),
        json={"name": f"{marker}-broken", "template": "credit"},
    )
    assert refused.status_code == 422, refused.text
    assert refused.json()["context"]["missing"] == ["agent.a_node_this_build_does_not_have"]

    # Nothing unsavable was left behind.
    listed = await client.get(f"/v1/studio/workflows?q={marker}", headers=_auth(ANA))
    assert listed.json() == []


async def test_an_unknown_starter_says_which_ones_there_are(client) -> None:
    refused = await client.post(
        "/v1/studio/workflows",
        headers=_auth(ANA),
        json={"name": f"{_marker()}-nope", "template": "collections"},
    )
    assert refused.status_code == 422, refused.text
    assert refused.json()["context"]["available"] == sorted(TEMPLATES)


async def test_a_starter_and_a_definition_together_are_refused(client) -> None:
    """Whichever one lost would be a graph the caller asked for and did not get."""
    refused = await client.post(
        "/v1/studio/workflows",
        headers=_auth(ANA),
        json={"name": f"{_marker()}-both", "template": "credit", "definition": _graph()},
    )
    assert refused.status_code == 422, refused.text


async def test_two_workflows_from_one_starter_do_not_share_a_definition(client) -> None:
    """A starter is built fresh each time, so editing one cannot reach the other."""
    marker = _marker()
    first = await client.post(
        "/v1/studio/workflows",
        headers=_auth(ANA),
        json={"name": f"{marker}-a", "template": "credit"},
    )
    edited = first.json()["definition"]
    edited["nodes"] = edited["nodes"][:2]
    await client.put(
        f"/v1/studio/workflows/{first.json()['id']}",
        headers=_auth(ANA),
        json={"definition": edited},
    )

    second = await client.post(
        "/v1/studio/workflows",
        headers=_auth(ANA),
        json={"name": f"{marker}-b", "template": "credit"},
    )
    assert len(second.json()["definition"]["nodes"]) == len(_retail_loan()["nodes"])


# --- the starter and the canvas's copy of it --------------------------------
#
# The retail-loan starter is written out twice: here in the API, and in
# `apps/web/src/lib/studioTemplates.ts`, where the canvas reads its picker from.
# The router says why that is the current answer and what would replace it.
# These tests are the part that makes it safe: two copies of one thing drift,
# and drift that is caught is a failed test rather than two different starters
# called by one name.


def _credit_block() -> str:
    """The `credit` template's own text, from the TypeScript module."""
    source = TEMPLATES_TS.read_text(encoding="utf-8")
    start = source.index('id: "credit"')
    end = source.index('id: "msme"')
    assert start < end, "has studioTemplates.ts changed shape?"
    return source[start:end]


def _ts_credit_nodes() -> list[tuple[str, str, str, int, int]]:
    """Every node the TypeScript credit template declares, with its grid cell."""
    block = _credit_block()
    found = []
    for match in re.finditer(r"(?<!function )\bnode\(", block):
        body, _ = _balanced(block, match.end())
        args = _split_args(body)
        assert len(args) >= 5, f"node() called with {len(args)} arguments"
        found.append(
            (
                args[0].strip('"'),
                args[1].strip('"'),
                args[2].strip('"'),
                int(args[3]),
                int(args[4]),
            )
        )
    assert found, "found no node() calls in the credit template"
    return found


def _ts_credit_edges() -> list[tuple[str, str, str]]:
    pattern = r'\bedge\(\s*"([^"]+)"\s*,\s*"([^"]+)"(?:\s*,\s*"([^"]*)")?'
    found = [(s, t, b or "") for s, t, b in re.findall(pattern, _credit_block())]
    assert found, "found no edge() calls in the credit template"
    return found


def _ts_narration_prompt() -> str:
    """The narration prompt as the TypeScript builds it, reassembled.

    The prompt is an array of lines joined with newlines, each line a run of
    concatenated string literals. Concatenating every literal in order gives the
    prompt with its newlines removed, which is what this compares.
    """
    source = TEMPLATES_TS.read_text(encoding="utf-8")
    start = source.index("const NARRATE_THE_SCORE")
    opens = source.index("prompt: [", start)
    closes = source.index('].join("\\n")', opens)
    literals = re.findall(r'"((?:[^"\\]|\\.)*)"', source[opens:closes])
    assert literals, "found no strings in the narration prompt"
    return "".join(literal.replace('\\"', '"') for literal in literals)


def test_the_api_starter_still_matches_the_one_the_canvas_offers() -> None:
    """Same ids, same types, same names, same grid cells, same edges."""
    definition = _retail_loan()

    api_nodes = [
        (node["id"], node["type"], node["name"], node["position"]["x"], node["position"]["y"])
        for node in definition["nodes"]
    ]
    ts_nodes = [
        (node_id, node_type, name, 60 + col * 330, 90 + row * 190)
        for node_id, node_type, name, col, row in _ts_credit_nodes()
    ]
    assert api_nodes == ts_nodes

    api_edges = [(e["source"], e["target"], e["branch"]) for e in definition["edges"]]
    assert api_edges == _ts_credit_edges()


def test_the_narration_prompt_is_the_same_words_on_both_sides() -> None:
    """The prompt is the product's central claim, so it is the worst thing to drift.

    It tells the model the scorecard has already decided and asks it for
    sentences, never for a probability, a band, a score or a recommendation.
    Two copies saying slightly different things about that would be two
    different promises.
    """
    node = next(n for n in _retail_loan()["nodes"] if n["id"] == "risk_scoring")
    prompt = node["config"]["prompt"]

    assert prompt.replace("\n", "") == _ts_narration_prompt()
    for forbidden in ("Do not offer a probability", "already made, by code"):
        assert forbidden in prompt

    schema = node["config"]["output_schema"]
    assert sorted(schema) == ["open_questions", "plain_english"]


def test_every_starter_node_type_is_one_the_engine_registers() -> None:
    """The same check the endpoint makes, without needing a request to make it."""
    for template in TEMPLATES.values():
        types = {node["type"] for node in template.build()["nodes"]}
        assert types <= set(NODE_REGISTRY), sorted(types - set(NODE_REGISTRY))


# --- the migration ----------------------------------------------------------


def _revision():  # type: ignore[no-untyped-def]
    """Load 0005 from its path; the versions directory is not an importable package."""
    path = REPO_ROOT / "migrations" / "versions" / "0005_workflow_ownership.py"
    spec = importlib.util.spec_from_file_location("gravai_migration_0005", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _apply(engine, step) -> None:  # type: ignore[no-untyped-def]
    """Run one migration function against a connection, as alembic would."""
    with engine.begin() as connection:
        context = MigrationContext.configure(connection)
        with Operations.context(context):
            step()


def test_the_migration_round_trips_and_takes_no_workflow_with_it(tmp_path: Path) -> None:
    """Upgrade, downgrade, upgrade — on a database of its own.

    The downgrade is the half worth testing. It drops the two columns it added
    and nothing else: the workflows are all still there afterwards, including
    the one that had been marked deleted, because what goes away is the mark and
    not the row. Hard-deleting those rows to make the downgrade "look right"
    would be a migration destroying data on the way back.
    """
    revision = _revision()
    assert revision.revision == "0005_workflow_ownership"
    assert revision.down_revision == "0004_documents"

    engine = create_engine(f"sqlite:///{(tmp_path / 'migration.db').as_posix()}")
    Base.metadata.create_all(
        engine, tables=[Base.metadata.tables["tenant"], Base.metadata.tables["workflow"]]
    )

    tenant_id = uuid4()
    with engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO tenant (id, slug, name, is_active, config, created_at, updated_at) "
                "VALUES (:id, 'acme', 'Acme Finance', 1, '{}', :now, :now)"
            ),
            {"id": str(tenant_id), "now": "2026-09-17 00:00:00"},
        )
        # The columns exist in the metadata this test built the table from, so
        # they are dropped first to stand in for a database as 0004 leaves it.
        # The index goes before them, and not by preference: SQLite refuses to
        # drop a column an index still names, which is the same ordering the
        # migration's own downgrade has to observe.
        connection.execute(text("DROP INDEX IF EXISTS ix_workflow_tenant_live_owner_updated"))
        for column in ("owner_subject", "deleted_at"):
            connection.execute(text(f"ALTER TABLE workflow DROP COLUMN {column}"))
        for suffix in ("before", "during"):
            connection.execute(
                text(
                    "INSERT INTO workflow (id, tenant_id, name, description, definition, "
                    "created_at, updated_at) VALUES (:id, :tenant, :name, '', '{}', :now, :now)"
                ),
                {
                    "id": str(uuid4()),
                    "tenant": str(tenant_id),
                    "name": f"written-{suffix}",
                    "now": "2026-09-17 00:00:00",
                },
            )

    columns = {c["name"] for c in inspect(engine).get_columns("workflow")}
    assert "owner_subject" not in columns

    _apply(engine, revision.upgrade)
    columns = {c["name"] for c in inspect(engine).get_columns("workflow")}
    assert {"owner_subject", "deleted_at"} <= columns
    assert "ix_workflow_tenant_live_owner_updated" in {
        index["name"] for index in inspect(engine).get_indexes("workflow")
    }

    with engine.begin() as connection:
        # No backfill: the rows that predate the column have no owner, and the
        # only candidates for one would be guesses written into a table that is
        # read as authoritative.
        owners = connection.execute(text("SELECT owner_subject FROM workflow")).scalars().all()
        assert owners == [None, None]
        connection.execute(
            text("UPDATE workflow SET deleted_at = :when WHERE name = 'written-during'"),
            {"when": "2026-09-17 01:00:00"},
        )

    _apply(engine, revision.downgrade)
    columns = {c["name"] for c in inspect(engine).get_columns("workflow")}
    assert "owner_subject" not in columns
    assert "deleted_at" not in columns

    with engine.begin() as connection:
        surviving = connection.execute(text("SELECT name FROM workflow ORDER BY name")).scalars()
        # Both rows, including the one that had been marked deleted.
        assert list(surviving) == ["written-before", "written-during"]
        assert connection.execute(text("SELECT slug FROM tenant")).scalars().all() == ["acme"]

    _apply(engine, revision.upgrade)
    assert "owner_subject" in {c["name"] for c in inspect(engine).get_columns("workflow")}

    engine.dispose()


def test_the_column_and_the_migration_both_say_why_a_null_owner_is_allowed() -> None:
    """The reason lives beside the column and in the migration, not in a commit message.

    Whoever next reads either one has to be able to see that a NULL owner is a
    deliberate state and not a bug to tighten away. The tightening is what would
    hide somebody's work: a NOT NULL added with a backfill would either invent an
    author for every row that predates the column, or hide those rows from the
    tenant that has been using them.

    Asserted on the source text because a `#:` comment is documentation and
    nothing at run time can see it — which is exactly why it is the kind of
    reasoning that quietly disappears in a later edit.
    """
    model = (
        REPO_ROOT / "packages" / "gravai_core" / "src" / "gravai_core" / "models.py"
    ).read_text(encoding="utf-8")
    column = model[model.index("owner_subject: Mapped[str | None]") - 1200 :]
    assert "Nullable because the rows that existed before this column did" in column
    assert "data loss with extra steps" in column

    migration = (REPO_ROOT / "migrations" / "versions" / "0005_workflow_ownership.py").read_text(
        encoding="utf-8"
    )
    assert "EXISTING ROWS HAVE NO OWNER" in migration
    assert "DOWNGRADING TAKES NO WORKFLOW WITH IT" in migration
