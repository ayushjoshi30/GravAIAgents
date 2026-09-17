"""Agent Studio: the canvas, and the agents it produces.

The shape of this API follows the life of a workflow rather than the tables
underneath it. Someone draws a graph (`/workflows`), asks what is wrong with it
(`/validate`), tries it (`/run`), freezes it (`/compile`), points traffic at the
frozen copy (`/deploy`), and then everything else calls the whole thing as one
agent (`/deployed/{name}/run`).

Two rules are enforced here rather than in the engine, because both are product
decisions rather than execution details:

* **A deployed version is immutable.** Editing one in place would change what a
  live integration receives without the integration ever asking for a change,
  and without leaving a record of what it used to do. A change is a new version.

* **No credential ever travels in a request body or in a definition.** A node
  names a credential; the value is resolved server-side. A definition is saved,
  versioned, listed and read back by anyone who can open the studio, so a token
  written into one would be a token published.
"""

from __future__ import annotations

from collections.abc import Callable
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response, status
from gravai_core.audit import AuditActions
from gravai_core.auth import Principal, Scope
from gravai_core.errors import NotFound, ValidationFailed
from gravai_core.models import Workflow, WorkflowRun, WorkflowVersion
from gravai_core.repositories import AuditRepository, get_or_404, tenant_query
from gravai_core.time_utils import utc_now
from gravai_workflow import (
    FAMILIES,
    NODE_REGISTRY,
    Problem,
    RunResult,
    WorkflowGraph,
    by_family,
    from_dict,
    run_workflow,
)
from pydantic import BaseModel, Field
from sqlalchemy import Select, func, or_, select

from ..deps import CurrentPrincipal, DbSession, Sarvam, require_scope

router = APIRouter(prefix="/v1/studio", tags=["studio"])

#: Reading the studio. Deliberately wider than running it: an auditor who may
#: read applications may also read how the automation that touched them is built.
READ_SCOPES = (Scope.AGENTS_RUN, Scope.APPLICATIONS_READ)

#: Running, compiling and deploying. These spend money or change what a live
#: caller gets, so reading the console is not enough.
WRITE_SCOPES = (Scope.AGENTS_RUN,)


# --- the node library -------------------------------------------------------


class PortOut(BaseModel):
    """One named value a node consumes or produces."""

    name: str
    type: str
    required: bool
    description: str = ""


class ConfigFieldOut(BaseModel):
    """One setting, as the node's panel renders a control for it."""

    name: str
    label: str
    kind: str = Field(description="text, textarea, number, select, boolean, expression or json")
    default: Any = ""
    help: str = ""
    choices: list[str] = Field(default_factory=list)
    required: bool = False
    templated: bool = Field(
        default=False, description="True when the value may contain {{ ... }} state references"
    )


class NodeTypeOut(BaseModel):
    """One node type the canvas may place."""

    type: str
    family: str
    label: str
    summary: str
    inputs: list[PortOut] = Field(default_factory=list)
    outputs: list[PortOut] = Field(default_factory=list)
    config: list[ConfigFieldOut] = Field(default_factory=list)
    uses_llm: bool = Field(description="Running this node calls the language model")
    deterministic: bool = Field(description="The same inputs always give the same output")
    branching: bool = Field(description="Chooses one outgoing edge rather than following all")
    icon: str = "bolt"
    caveat: str = Field(
        default="",
        description="Stated where a node cannot do the whole of what its name implies",
    )


class NodeFamilyOut(BaseModel):
    key: str
    label: str
    nodes: list[NodeTypeOut] = Field(default_factory=list)


class NodeLibraryOut(BaseModel):
    """Everything the canvas can offer, grouped as the palette shows it."""

    families: list[NodeFamilyOut] = Field(default_factory=list)
    total: int


def _node_out(spec: Any) -> NodeTypeOut:
    return NodeTypeOut(
        type=spec.type,
        family=spec.family,
        label=spec.label,
        summary=spec.summary,
        inputs=[
            PortOut(name=p.name, type=p.type, required=p.required, description=p.description)
            for p in spec.inputs
        ],
        outputs=[
            PortOut(name=p.name, type=p.type, required=p.required, description=p.description)
            for p in spec.outputs
        ],
        config=[
            ConfigFieldOut(
                name=c.name,
                label=c.label,
                kind=c.kind,
                default=c.default,
                help=c.help,
                choices=list(c.choices),
                required=c.required,
                templated=c.templated,
            )
            for c in spec.config
        ],
        uses_llm=spec.uses_llm,
        deterministic=spec.deterministic,
        branching=spec.branching,
        icon=spec.icon,
        caveat=spec.caveat,
    )


@router.get(
    "/nodes",
    response_model=NodeLibraryOut,
    summary="The node library",
    dependencies=[Depends(require_scope(*READ_SCOPES))],
)
async def node_library() -> NodeLibraryOut:
    """Every node type, with its ports and settings.

    Served straight from the engine's own registry rather than from a copy kept
    for the front end. The registry is also what the validator checks against and
    what the engine dispatches on, so the canvas cannot offer a node that has no
    executor, nor a field the run would ignore.
    """
    grouped = by_family()
    families = [
        NodeFamilyOut(key=key, label=label, nodes=[_node_out(s) for s in grouped.get(key, [])])
        for key, label in FAMILIES
    ]
    # A family the registry grew that FAMILIES has not been told about still gets
    # shown, at the end. Dropping it would hide a node that genuinely runs.
    known = {key for key, _ in FAMILIES}
    for key, specs in grouped.items():
        if key not in known and specs:
            families.append(
                NodeFamilyOut(
                    key=key,
                    label=key.replace("_", " ").title(),
                    nodes=[_node_out(s) for s in specs],
                )
            )

    return NodeLibraryOut(families=families, total=len(NODE_REGISTRY))


# --- workflows --------------------------------------------------------------
#
# WHO MAY SEE A WORKFLOW. A workflow belongs to the person who built it, inside
# the lender they built it for. Both halves of that sentence are enforced, and
# always in that order: the tenant filter first, from `tenant_query`, and the
# owner filter on top of it. Never the owner alone. `owner_subject` holds a
# token's `sub` claim, which is unique inside a tenant and nowhere else, so an
# owner-only filter would hand one lender's workflow to an identically named
# subject at another — the exact leak the tenant scope exists to prevent.
#
# Both values come from the token on every request. Neither is ever read from a
# request body, a query string or a path, because a caller who can name the
# owner is not scoped by ownership at all.
#
# A workflow whose owner is NULL was built before ownership existed and is
# visible to its whole tenant. It is never quietly claimed by whoever touches it
# next: claiming would hide a colleague's work behind one person's name on the
# strength of a click, which is a worse answer than showing it to everybody.
#
# WHAT A CALLER IS TOLD ABOUT SOMEBODY ELSE'S WORKFLOW. Nothing. Another owner's
# id, another tenant's id, a soft-deleted id and an id that never existed all
# produce the identical 404 that `get_or_404` raises, down to the message. A 403
# would be an oracle: it confirms that the id is real, which is enough to
# enumerate what a tenant has built and who is building it.


#: The server's own limits on the two fields a person types. Constants rather
#: than literals repeated across four request models, because create, update,
#: rename and duplicate have to agree about what a name is — a limit enforced in
#: three of those places and forgotten in the fourth is not a limit. 120 is
#: ``Workflow.name``'s own width, so a name that passes here cannot be refused
#: by the column instead, where it would reach the caller as a 500 rather than
#: as something they can read and fix.
NAME_MAX = 120
DESCRIPTION_MAX = 2000

#: How many nodes a list card's thumbnail carries. A thumbnail is a picture of
#: the shape, and past a few dozen dots it is a smudge either way — but the
#: payload keeps growing, which is the cost this trimmed card exists to avoid.
#: The counts beside it are always the true ones, and `truncated` says plainly
#: that the picture is partial, so nothing here can be read as a small graph.
THUMBNAIL_NODES = 60


def _visible(principal: Principal, *, include_deleted: bool = False) -> Select[tuple[Workflow]]:
    """Every workflow this caller may see, as a query to build on.

    Tenant first and then owner, for the reason set out above. A NULL owner
    passes because it means "built before anyone claimed it", not "nobody's".

    ``include_deleted`` exists for exactly one caller, restore, which has to be
    able to find the row it is undoing. Everywhere else a deleted workflow is
    absent, and the default says so.
    """
    statement = tenant_query(Workflow).where(
        or_(Workflow.owner_subject == principal.subject, Workflow.owner_subject.is_(None))
    )
    if not include_deleted:
        statement = statement.where(Workflow.deleted_at.is_(None))
    return statement


async def _workflow_or_404(
    session: Any,
    workflow_id: UUID,
    principal: Principal,
    *,
    include_deleted: bool = False,
) -> Workflow:
    """Fetch one workflow the caller owns, or report it as missing.

    This is `get_or_404` with the owner and the delete marker added, and it
    raises the identical error on purpose — same status, same message, same
    context. Another owner's id, another tenant's id, a deleted id and an
    invented id have to be indistinguishable from outside, or the difference
    between them is a way of asking what exists.
    """
    statement = _visible(principal, include_deleted=include_deleted).where(
        Workflow.id == workflow_id
    )
    row = (await session.execute(statement)).scalar_one_or_none()
    if row is None:
        raise NotFound("Workflow not found", entity_id=str(workflow_id))
    return row


def _live_workflow_ids() -> Select[Any]:
    """The ids of the tenant's workflows that have not been deleted.

    Built from ``tenant_query`` rather than a fresh ``select`` so the tenant
    filter keeps coming from the one place that refuses to run without a bound
    tenant. Used as a subquery by the run history, which hangs off workflows and
    therefore has to disappear with them.
    """
    return (
        tenant_query(Workflow).with_only_columns(Workflow.id).where(Workflow.deleted_at.is_(None))
    )


def _readable_runs(principal: Principal) -> Select[tuple[WorkflowRun]]:
    """Runs this caller may read: their own drafts', and the tenant's live traffic.

    The argument for the split is at the head of the run history section. In one
    line: a deployed run belongs to the lender, and a draft run belongs to the
    person whose canvas it came from — and a draft run's trace is that canvas,
    node by node.
    """
    return (
        tenant_query(WorkflowRun)
        .where(WorkflowRun.workflow_id.in_(_live_workflow_ids()))
        .where(
            or_(
                WorkflowRun.version_id.is_not(None),
                WorkflowRun.workflow_id.in_(_visible(principal).with_only_columns(Workflow.id)),
            )
        )
    )


async def _claim_name(session: Any, name: str, *, exclude: UUID | None = None) -> None:
    """Refuse a name another workflow in this tenant already holds.

    Tenant-wide and blind to ownership, because the unique constraint behind it
    is: the name is the address a deployed agent answers to, and a call by name
    carries no owner. Checking only the caller's own workflows would let the
    insert through to the database and come back as an integrity error, which
    the caller would see as a 500 on a perfectly ordinary refusal.

    Soft-deleted rows count as holding their names, because the constraint
    counts them — they are still rows. When the incumbent is one of those the
    refusal says so, since "that name is taken" about a workflow the caller
    cannot find anywhere is a dead end rather than an explanation.
    """
    statement = tenant_query(Workflow).where(Workflow.name == name)
    if exclude is not None:
        statement = statement.where(Workflow.id != exclude)
    incumbent = (await session.execute(statement)).scalar_one_or_none()
    if incumbent is None:
        return

    # Neither refusal names an id or an owner. That a name is taken is inherent
    # to a tenant-wide address and cannot be hidden; who holds it, and under
    # which id, is not, and would hand over exactly what the 404s withhold.
    if incumbent.deleted_at is not None:
        raise ValidationFailed(
            "A deleted workflow still holds this name",
            name=name,
            hint=(
                "A deleted workflow keeps its name until it is restored, so that restoring it "
                "puts the agent back at the address its callers use. Restore it, or choose "
                "another name."
            ),
        )
    raise ValidationFailed(
        "A workflow with this name already exists",
        name=name,
        hint="Names address a deployed agent, so they are unique within a tenant.",
    )


def _clean_name(value: str) -> str:
    """A name with its surrounding whitespace removed, refused if nothing is left.

    ``min_length=1`` on its own accepts a single space, which lists as a
    nameless card and which no call by name could ever address. Trimming in one
    place keeps create, update, rename and duplicate from disagreeing about
    whether " Credit agent " is the same address as "Credit agent" — they would,
    and the unique constraint would then happily hold both.
    """
    cleaned = value.strip()
    if not cleaned:
        raise ValidationFailed(
            "A workflow needs a name",
            hint="A name of only spaces is not a name; it is how a deployed agent is addressed.",
        )
    return cleaned


class WorkflowSummaryOut(BaseModel):
    """One workflow in the list, without its graph."""

    id: UUID
    name: str
    description: str
    node_count: int
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class WorkflowVersionOut(BaseModel):
    """One frozen version, without its graph."""

    id: UUID
    workflow_id: UUID
    version: str
    status: str = Field(description="draft, deployed or retired")
    input_schema: dict[str, Any]
    output_schema: dict[str, Any]
    created_at: datetime
    created_by: str | None = None

    model_config = {"from_attributes": True}


class WorkflowVersionDetail(WorkflowVersionOut):
    definition: dict[str, Any]


class WorkflowDetail(WorkflowSummaryOut):
    definition: dict[str, Any]
    versions: list[WorkflowVersionOut] = Field(default_factory=list)
    deployed_version: str | None = Field(
        default=None, description="The version a call by name currently reaches, if any"
    )


class ThumbnailNodeOut(BaseModel):
    """One node as the card's small picture of the graph draws it."""

    id: str
    type: str
    x: float | None = Field(default=None, description="Where the canvas put it, if it said")
    y: float | None = None


class ThumbnailEdgeOut(BaseModel):
    """One connection, as the pair of node ids it joins."""

    source: str
    target: str


class ThumbnailOut(BaseModel):
    """Enough of the graph to draw its shape, and nothing that could carry a secret.

    Node ids, node types and positions; edge endpoints. No config, which is
    where prompts, mappings and credential names live — a list of thirty cards
    would otherwise ship thirty full definitions to draw thirty small pictures.
    """

    nodes: list[ThumbnailNodeOut] = Field(default_factory=list)
    edges: list[ThumbnailEdgeOut] = Field(default_factory=list)
    truncated: bool = Field(
        default=False,
        description="True when the graph has more nodes than the thumbnail carries",
    )


class WorkflowCardOut(WorkflowSummaryOut):
    """One workflow as the "Your agents" page draws it.

    A superset of the summary rather than a replacement for it: the fields that
    were there are still there, in the same shape, because this is the payload
    the studio's own list already consumes.
    """

    edge_count: int = Field(description="Connections between steps")
    thumbnail: ThumbnailOut


class WorkflowCreate(BaseModel):
    """A new workflow.

    ``extra: forbid`` for the same reason it is on the run body. The fields this
    model does not have include ``owner_subject`` and ``tenant_id``, and a
    caller who sends one of those is trying to create a workflow as somebody
    else. Pydantic's default would drop the field silently, which looks from the
    outside exactly like it worked.
    """

    name: str = Field(min_length=1, max_length=NAME_MAX)
    description: str = Field(default="", max_length=DESCRIPTION_MAX)
    definition: dict[str, Any] = Field(
        default_factory=dict,
        description="Nodes and edges. An empty graph is a valid starting point.",
    )
    template: str | None = Field(
        default=None,
        description="Start from a named starter instead of an empty canvas",
    )

    model_config = {"extra": "forbid"}


class WorkflowUpdate(BaseModel):
    """A change to the draft. Every field is optional; omitted means untouched."""

    name: str | None = Field(default=None, min_length=1, max_length=NAME_MAX)
    description: str | None = Field(default=None, max_length=DESCRIPTION_MAX)
    definition: dict[str, Any] | None = None

    model_config = {"extra": "forbid"}


class WorkflowRename(BaseModel):
    """A rename, and nothing else.

    Separate from ``WorkflowUpdate`` because renaming is the one edit the list
    page makes, and it should not be able to post a definition by accident. A
    body carrying anything but a name is refused rather than half-applied.
    """

    name: str = Field(min_length=1, max_length=NAME_MAX)

    model_config = {"extra": "forbid"}


class WorkflowDuplicate(BaseModel):
    """What to call the copy. Omit it and the server picks the next free name."""

    name: str | None = Field(default=None, min_length=1, max_length=NAME_MAX)

    model_config = {"extra": "forbid"}


def _summary(workflow: Workflow) -> WorkflowSummaryOut:
    nodes = workflow.definition.get("nodes") if isinstance(workflow.definition, dict) else None
    return WorkflowSummaryOut(
        id=workflow.id,
        name=workflow.name,
        description=workflow.description,
        node_count=len(nodes) if isinstance(nodes, list) else 0,
        created_at=workflow.created_at,
        updated_at=workflow.updated_at,
    )


def _position(node: dict[str, Any]) -> tuple[float | None, float | None]:
    """Where the canvas put this node, or nothing at all.

    A node whose definition carries no position, or carries something that is
    not a number, reports none rather than (0, 0). The page can lay out what it
    was not told; it cannot un-believe a coordinate we invented, and a card
    drawn from invented positions shows a graph nobody arranged.
    """
    raw = node.get("position")
    if not isinstance(raw, dict):
        return None, None
    found: list[float | None] = []
    for key in ("x", "y"):
        value = raw.get(key)
        usable = isinstance(value, int | float) and not isinstance(value, bool)
        found.append(float(value) if usable else None)
    return found[0], found[1]


def _card(workflow: Workflow) -> WorkflowCardOut:
    """One row of the list: the counts, the shape, and none of the configuration.

    Everything here is read defensively. A definition is whatever the canvas
    last saved, which is to say arbitrary JSON that an older build, a hand-typed
    import or a half-finished draft may have left in any shape at all, and the
    list is the one screen that must never fail to draw because one row is odd.
    """
    definition = workflow.definition if isinstance(workflow.definition, dict) else {}
    raw_nodes = definition.get("nodes")
    raw_edges = definition.get("edges")
    nodes = [n for n in raw_nodes if isinstance(n, dict)] if isinstance(raw_nodes, list) else []
    edges = [e for e in raw_edges if isinstance(e, dict)] if isinstance(raw_edges, list) else []

    drawn = nodes[:THUMBNAIL_NODES]
    drawn_ids = {str(node.get("id", "")) for node in drawn}
    thumbnail_nodes = []
    for node in drawn:
        x, y = _position(node)
        thumbnail_nodes.append(
            ThumbnailNodeOut(id=str(node.get("id", "")), type=str(node.get("type", "")), x=x, y=y)
        )

    # An edge to a node the thumbnail left out would draw a line into empty
    # space, so it is dropped with the node it pointed at.
    thumbnail_edges = []
    for edge in edges:
        source = str(edge.get("source", ""))
        target = str(edge.get("target", ""))
        if source in drawn_ids and target in drawn_ids:
            thumbnail_edges.append(ThumbnailEdgeOut(source=source, target=target))

    return WorkflowCardOut(
        **_summary(workflow).model_dump(),
        # The counts are of the whole graph, always, even when the picture is
        # only part of it. They are what the card claims about size.
        edge_count=len(edges),
        thumbnail=ThumbnailOut(
            nodes=thumbnail_nodes,
            edges=thumbnail_edges,
            truncated=len(nodes) > len(drawn),
        ),
    )


#: How the list may be ordered. A closed set rather than a column name from the
#: caller: an unrecognised value is refused by FastAPI before the handler runs,
#: and no query string can name a column to sort by.
SortKey = Literal["last_edited", "name", "created"]


def _ordered(statement: Select[tuple[Workflow]], sort: SortKey) -> Select[tuple[Workflow]]:
    """Apply the requested order in SQL, with a tie-break that makes paging honest.

    The tie-break is not decoration. Two workflows saved in the same second hold
    the same ``updated_at``, and a database may return equal rows in any order
    it likes — including a different order for page two than for page one, which
    is how one row appears twice while another never appears at all. The id is
    arbitrary but stable, so the order over the whole set is total.

    Sorting by name is case-insensitive because the list is alphabetical to a
    person reading it, and a raw sort puts "Zeta" before "alpha".
    """
    if sort == "name":
        return statement.order_by(func.lower(Workflow.name).asc(), Workflow.id.asc())
    if sort == "created":
        return statement.order_by(Workflow.created_at.desc(), Workflow.id.asc())
    return statement.order_by(Workflow.updated_at.desc(), Workflow.id.asc())


def _search(statement: Select[tuple[Workflow]], term: str) -> Select[tuple[Workflow]]:
    """Narrow to rows whose name or description contains `term`, case-insensitively.

    In SQL, not in Python. The list is paginated, so a filter applied to the
    rows that came back would search the fifty on this page and report the rest
    as non-matching: the page would say "nothing found" while the match sat on
    page three. The same argument applies to the sort, and to the total.

    The LIKE metacharacters are escaped rather than passed through. Somebody
    searching for "100%" means the literal string, and an unescaped `%` there
    matches every workflow they own — a search that answers everything looks
    exactly like a search that is broken.
    """
    escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    pattern = f"%{escaped}%"
    return statement.where(
        or_(
            Workflow.name.ilike(pattern, escape="\\"),
            Workflow.description.ilike(pattern, escape="\\"),
        )
    )


#: Room kept at the end of a name for the suffix a duplicate adds.
COPY_ROOM = len(" copy 999")


async def _free_copy_name(session: Any, base: str) -> str:
    """The first of "<name> copy", "<name> copy 2" and so on that nobody holds.

    A numbered suffix, rather than the alternative of narrowing
    ``uq_workflow_tenant_name`` so that copies stop colliding. The constraint is
    what makes a name an address: a deployed agent is invoked by name, with no
    owner attached to the call, so two rows answering to one name inside a
    tenant would leave a live integration reaching whichever the query returned
    first. Duplicating is a convenience; addressing an agent is the product. The
    convenience gives way.

    Asked tenant-wide and blind to ownership, because the constraint is. The
    caller never sees a colleague's names, but a name a colleague holds is still
    one this copy cannot take, and a candidate chosen from only our own rows
    would be refused by the database instead of by us. Soft-deleted rows hold
    their names too, for the same reason.
    """
    # Long names are trimmed before the suffix is added rather than after, so
    # the part that makes the copy unique is the part that survives. A copy of a
    # copy of a 120-character name would otherwise be refused by the column, on
    # a button that should always work.
    stem = base if len(base) + COPY_ROOM <= NAME_MAX else base[: NAME_MAX - COPY_ROOM].rstrip()

    rows = await session.execute(
        tenant_query(Workflow).where(Workflow.name.startswith(stem, autoescape=True))
    )
    taken = {row.name for row in rows.scalars().all()}

    candidate = f"{stem} copy"
    index = 2
    while candidate in taken:
        if index > 999:
            # Refused rather than silently widened past the room the name has.
            # Somebody with a thousand copies of one workflow has a problem the
            # server cannot name for them.
            raise ValidationFailed(
                "There are too many copies of this workflow to name another one",
                name=base,
                hint="Send a name for this copy.",
            )
        candidate = f"{stem} copy {index}"
        index += 1
    return candidate


# --- starters ---------------------------------------------------------------
#
# WHY THE RETAIL-LOAN STARTER IS WRITTEN OUT HERE. It is also written out in
# `apps/web/src/lib/studioTemplates.ts`, which holds four of them and is where
# the canvas reads its picker from. Two copies of one thing drift, so this is a
# deliberate choice and not an oversight, and the shape of the choice is:
#
#   * The API cannot read the TypeScript. Parsing a file from `apps/web` at
#     request time would make the API depend on the web app being deployed
#     beside it, which it is not, and on a file that is data in the shape of
#     code.
#   * The web app cannot yet read the API. Fetching the starters over HTTP is
#     the right end state — one definition, served from the side that validates
#     it — but it is a change to the canvas, and this commit is the API only.
#
# So one starter is transcribed, not four: the one the brief asks for. The other
# three would be three more copies to drift with nothing reading them yet. The
# drift that matters is caught rather than hoped about —
# `tests/test_your_agents_api.py` reads the TypeScript and fails if the node
# ids, the types, the positions, the edges or the narration prompt below stop
# matching it. When the canvas moves to fetching these, this dict becomes the
# single source and the TypeScript becomes the client of it.


#: Grid spacing, as `studioTemplates.ts` lays it out. Kept as the same
#: arithmetic rather than as transcribed coordinates, because a copied number
#: is a number that can be copied wrong.
TEMPLATE_COL = 330
TEMPLATE_ROW = 190


def _template_node(
    node_id: str,
    node_type: str,
    name: str,
    col: int,
    row: int,
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "id": node_id,
        "type": node_type,
        "name": name,
        "config": deepcopy(config) if config else {},
        "position": {"x": 60 + col * TEMPLATE_COL, "y": 90 + row * TEMPLATE_ROW},
    }


def _template_edge(source: str, target: str, branch: str = "") -> dict[str, Any]:
    return {
        "id": f"{source}->{target}" + (f":{branch}" if branch else ""),
        "source": source,
        "target": target,
        "branch": branch,
    }


#: The narration asked of the retail-loan starter's risk node, transcribed from
#: `NARRATE_THE_SCORE` in `studioTemplates.ts`, where the wording is argued at
#: length. The short of it: the scorecard has already decided by the time this
#: runs, so the prompt asks for sentences and never for a probability, a band, a
#: score or a recommendation. Arithmetic comes from code and language comes from
#: the model, and a generated number that looks like a scored one is the single
#: failure this platform cannot have.
NARRATE_THE_SCORE: dict[str, Any] = {
    "prompt": "\n".join(
        [
            "Scorecard {{result.model_version}} has already scored this application, and "
            "its full result is below.",
            "",
            "Write the note an underwriter reads before opening the file: what the top "
            "drivers say about this borrower in plain English, and what the imputed "
            "values leave unanswered. Where you mention the probability or the band, "
            "quote them exactly as they stand in the result.",
            "",
            "Do not offer a probability, a band, a score or a recommendation of your "
            "own. That call is already made, by code, and your work here is to put it "
            "into words a person can act on.",
        ]
    ),
    "output_schema": {
        "plain_english": (
            "Two or three sentences putting the drivers above into the words an "
            "underwriter would use. Describe what the scorecard found; do not restate "
            "it as a judgement of your own."
        ),
        "open_questions": (
            "What the imputed values leave unanswered, as a list of things a person "
            "could go and check before this file is decided."
        ),
    },
}


def _retail_loan() -> dict[str, Any]:
    """Retail lending end to end, as a shape to start from.

    Documents and statements read in parallel, a scored risk with its
    explanation attached to the scoring step itself, and a branch that sends
    everything outside the green band to a person. Config is left empty
    everywhere except the narration: a starter is a shape, and filling in
    thresholds or prompts would be inventing credit policy for a lender whose
    rules we do not know.
    """
    return {
        "nodes": [
            _template_node("input", "input", "Application received", 0, 1),
            _template_node(
                "doc_intelligence", "agent.doc_intelligence", "Read the documents", 1, 0
            ),
            _template_node(
                "bank_statements", "agent.bank_statement_analytics", "Read the statements", 1, 2
            ),
            # The explanation sits on the scoring node rather than on a node
            # after it, so the words and the figures they describe come out of
            # one step. A standalone model node reading the score back could
            # publish whatever it generated into the facts the next branch
            # decides on; this cannot.
            _template_node(
                "risk_scoring", "agent.risk_scoring", "Score the risk", 2, 1, NARRATE_THE_SCORE
            ),
            _template_node("band", "condition", "Risk band is GREEN", 3, 1),
            _template_node(
                "credit_appraisal", "agent.credit_appraisal", "Write the memorandum", 4, 0
            ),
            _template_node("human_approval", "human_approval", "Underwriter decides", 4, 2),
            _template_node("output", "output", "Decision", 5, 1),
        ],
        "edges": [
            _template_edge("input", "doc_intelligence"),
            _template_edge("input", "bank_statements"),
            _template_edge("doc_intelligence", "risk_scoring"),
            _template_edge("bank_statements", "risk_scoring"),
            _template_edge("risk_scoring", "band"),
            # A branching node's edges must name a branch it declares, or the
            # graph fails validation. `condition` declares true and false.
            _template_edge("band", "credit_appraisal", "true"),
            _template_edge("band", "human_approval", "false"),
            _template_edge("credit_appraisal", "output"),
            _template_edge("human_approval", "output"),
        ],
    }


@dataclass(frozen=True)
class StudioTemplate:
    """One starter a new workflow can be seeded from."""

    id: str
    label: str
    description: str
    #: A function rather than a dict, so two people starting from one template
    #: never share a mutable object — and so nothing a caller does to their own
    #: workflow can reach into the next caller's starter.
    build: Callable[[], dict[str, Any]]


TEMPLATES: dict[str, StudioTemplate] = {
    "credit": StudioTemplate(
        id="credit",
        label="Credit agent",
        description=(
            "Retail loan decisioning end to end: document intelligence, statement analytics, "
            "a risk score, the explanation that goes with it, and a human for everything the "
            "policy does not clear outright."
        ),
        build=_retail_loan,
    ),
}


def _seed_from_template(template_id: str) -> tuple[dict[str, Any], StudioTemplate]:
    """The definition a starter seeds, checked against the engine's own registry.

    Checked here, loudly, rather than left for the save that follows. A starter
    naming a node type this build does not have produces a workflow that looks
    fine on the canvas and cannot be validated, run or compiled — the person
    would meet "'x' is not a node type this build knows" about a node they never
    chose, in a workflow they did not write. Refusing at creation puts the
    failure where somebody can act on it, and leaves nothing unsavable behind.

    Dropping the unknown node instead would be worse still: a starter silently
    missing its scoring step is a shape that means something different from the
    one the person asked for.
    """
    template = TEMPLATES.get(template_id)
    if template is None:
        raise ValidationFailed(
            "No starter of this name",
            template=template_id,
            available=sorted(TEMPLATES),
        )

    definition = template.build()
    nodes = definition.get("nodes", [])
    missing = sorted(
        {str(node.get("type", "")) for node in nodes if isinstance(node, dict)} - set(NODE_REGISTRY)
    )
    if missing:
        raise ValidationFailed(
            f"The {template.label} starter needs node types this build does not have",
            template=template.id,
            missing=missing,
            hint=(
                "This is a fault in the build rather than in the request: the starter names a "
                "node the engine no longer registers. Start from an empty canvas meanwhile."
            ),
        )
    return definition, template


async def _versions(session: Any, workflow_id: UUID) -> list[WorkflowVersion]:
    """A workflow's versions, newest first."""
    result = await session.execute(
        tenant_query(WorkflowVersion)
        .where(WorkflowVersion.workflow_id == workflow_id)
        .order_by(WorkflowVersion.created_at.desc())
    )
    return list(result.scalars().all())


async def _workflow_detail(session: Any, workflow: Workflow) -> WorkflowDetail:
    """A workflow with its versions and whatever a call by name reaches today.

    One place rather than five: get, update, rename, duplicate and restore all
    answer with the same thing, and five copies of this would eventually be five
    slightly different answers to one question.
    """
    versions = await _versions(session, workflow.id)
    deployed = next((v for v in versions if v.status == "deployed"), None)
    return WorkflowDetail(
        **_summary(workflow).model_dump(),
        definition=workflow.definition,
        versions=[WorkflowVersionOut.model_validate(v) for v in versions],
        deployed_version=deployed.version if deployed else None,
    )


def _graph(workflow: Workflow) -> WorkflowGraph:
    """The saved definition as the engine's own object.

    The stored name wins over whatever the definition happens to carry, because
    the name is the address the deployed agent answers to and the two drifting
    apart would make a call by name land somewhere surprising.
    """
    graph = from_dict(workflow.definition if isinstance(workflow.definition, dict) else {})
    graph.name = workflow.name
    graph.description = workflow.description
    return graph


@router.get(
    "/workflows",
    response_model=list[WorkflowCardOut],
    summary="List workflows",
    dependencies=[Depends(require_scope(*READ_SCOPES))],
)
async def list_workflows(
    session: DbSession,
    principal: CurrentPrincipal,
    response: Response,
    q: Annotated[str, Query(max_length=NAME_MAX, description="Search names and descriptions")] = "",
    sort: Annotated[SortKey, Query()] = "last_edited",
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> list[WorkflowCardOut]:
    """The caller's own agents: their tenant's, theirs or unclaimed, not deleted.

    Searched, sorted and counted in the database. The page is a window onto a
    set that is usually larger than it, so every one of those has to be decided
    over the whole set: a search run over the rows that came back would miss
    matches on the pages that did not, and a count of them would be the size of
    the window rather than the size of the set.

    The total goes in `X-Total-Count` rather than into the body. The body is a
    JSON array today and the studio reads it as one, so wrapping the rows in an
    envelope to carry a number would break every existing caller of a path this
    commit promises to keep working. The header carries the count without moving
    the rows.
    """
    statement = _visible(principal)
    if q:
        statement = _search(statement, q)

    total = await session.scalar(select(func.count()).select_from(statement.subquery()))
    response.headers["X-Total-Count"] = str(total or 0)

    result = await session.execute(_ordered(statement, sort).limit(limit).offset(offset))
    return [_card(row) for row in result.scalars().all()]


@router.post(
    "/workflows",
    response_model=WorkflowDetail,
    status_code=status.HTTP_201_CREATED,
    summary="Create a workflow",
    dependencies=[Depends(require_scope(*READ_SCOPES))],
)
async def create_workflow(
    body: WorkflowCreate,
    session: DbSession,
    principal: CurrentPrincipal,
) -> WorkflowDetail:
    """Start a new agent, owned by whoever is asking.

    An empty graph is allowed: the canvas creates the workflow before anything is
    on it, and refusing that would mean the first node had nowhere to be saved.
    Validity is asked for separately, when there is something to be valid.

    A `template` seeds the definition from one of the starters instead. Sending
    both a template and a definition is refused rather than resolved by
    precedence — whichever one lost would be a graph the caller asked for and did
    not get, and they would find out by opening the canvas.
    """
    name = _clean_name(body.name)
    definition = body.definition
    description = body.description

    if body.template is not None:
        if definition:
            raise ValidationFailed(
                "Send either a template or a definition, not both",
                template=body.template,
                hint="A starter seeds the definition; there is nothing for it to seed over.",
            )
        definition, template = _seed_from_template(body.template)
        # The starter's own description, only where the caller wrote none. It
        # describes the shape they just chose, and it is the same sentence the
        # canvas shows in the picker — not something invented on their behalf.
        description = description or template.description

    await _claim_name(session, name)

    workflow = Workflow(
        # Both of these come from the token and neither is in the request model.
        # A tenant or an owner a caller could name is not a scope, it is a form
        # field.
        tenant_id=principal.tenant_id,
        owner_subject=principal.subject,
        name=name,
        description=description,
        definition=definition,
    )
    session.add(workflow)
    await session.flush()
    return WorkflowDetail(**_summary(workflow).model_dump(), definition=workflow.definition)


@router.get(
    "/workflows/{workflow_id}",
    response_model=WorkflowDetail,
    summary="Get a workflow with its versions",
    dependencies=[Depends(require_scope(*READ_SCOPES))],
)
async def get_workflow(
    workflow_id: UUID, session: DbSession, principal: CurrentPrincipal
) -> WorkflowDetail:
    """One workflow.

    Another tenant's id, another owner's id and a deleted id all report as
    missing, never as forbidden, and in the same words.
    """
    workflow = await _workflow_or_404(session, workflow_id, principal)
    return await _workflow_detail(session, workflow)


@router.put(
    "/workflows/{workflow_id}",
    response_model=WorkflowDetail,
    summary="Update the draft",
    dependencies=[Depends(require_scope(*READ_SCOPES))],
)
async def update_workflow(
    workflow_id: UUID,
    body: WorkflowUpdate,
    session: DbSession,
    principal: CurrentPrincipal,
) -> WorkflowDetail:
    """Save the canvas.

    This writes the draft only. A deployed version is unaffected by anything here
    — that separation is the whole reason versions exist, and it is what lets
    someone rework a live agent without the live agent changing while they do it.

    Saving never changes who owns the workflow. Editing an unclaimed one leaves
    it unclaimed, so a colleague's work does not disappear from their list
    because somebody else opened it.
    """
    workflow = await _workflow_or_404(session, workflow_id, principal)

    if body.name is not None:
        name = _clean_name(body.name)
        if name != workflow.name:
            await _claim_name(session, name, exclude=workflow.id)
            workflow.name = name

    if body.description is not None:
        workflow.description = body.description
    if body.definition is not None:
        workflow.definition = body.definition

    await session.flush()
    return await _workflow_detail(session, workflow)


@router.patch(
    "/workflows/{workflow_id}",
    response_model=WorkflowDetail,
    summary="Rename a workflow",
    dependencies=[Depends(require_scope(*READ_SCOPES))],
)
async def rename_workflow(
    workflow_id: UUID,
    body: WorkflowRename,
    session: DbSession,
    principal: CurrentPrincipal,
) -> WorkflowDetail:
    """Change the name, and only the name.

    The list page renames in place, where there is no canvas open and nothing
    else to save. It is a separate endpoint from the full save because a rename
    that could also carry a definition would let a stale list page overwrite the
    graph somebody has open in another tab.

    Renaming a deployed agent changes the address it answers to, which the
    refusal to delete one does not cover. That is left possible on purpose: the
    name is the lender's to choose, and a version stays reachable by id whatever
    the workflow is called. What it is not is silent — the new name is what the
    list, the canvas and `/deployed/{name}/run` all use from here.
    """
    workflow = await _workflow_or_404(session, workflow_id, principal)
    name = _clean_name(body.name)
    if name != workflow.name:
        await _claim_name(session, name, exclude=workflow.id)
        workflow.name = name
        await session.flush()
    return await _workflow_detail(session, workflow)


@router.post(
    "/workflows/{workflow_id}/duplicate",
    response_model=WorkflowDetail,
    status_code=status.HTTP_201_CREATED,
    summary="Duplicate a workflow",
    dependencies=[Depends(require_scope(*READ_SCOPES))],
)
async def duplicate_workflow(
    workflow_id: UUID,
    session: DbSession,
    principal: CurrentPrincipal,
    body: WorkflowDuplicate | None = None,
) -> WorkflowDetail:
    """Copy the definition and the description under a new name.

    The copy belongs to whoever asked for it, not to whoever owned the original.
    That is what makes duplicating the way to work from an unclaimed workflow, or
    from one a colleague built and shared: the result is yours to change without
    touching theirs.

    It copies the draft and nothing else. No version is compiled and nothing is
    deployed, because a copy that arrived already live would be an agent nobody
    decided to run.
    """
    original = await _workflow_or_404(session, workflow_id, principal)
    if body and body.name:
        name = _clean_name(body.name)
    else:
        name = await _free_copy_name(session, original.name)
    await _claim_name(session, name)

    copy = Workflow(
        tenant_id=principal.tenant_id,
        owner_subject=principal.subject,
        name=name,
        description=original.description,
        # A copy of the definition, not a reference to it. Two rows sharing one
        # JSON object would be one workflow wearing two names.
        definition=deepcopy(original.definition or {}),
    )
    session.add(copy)
    await session.flush()
    return await _workflow_detail(session, copy)


@router.delete(
    "/workflows/{workflow_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a workflow",
    dependencies=[Depends(require_scope(*READ_SCOPES))],
)
async def delete_workflow(
    workflow_id: UUID, session: DbSession, principal: CurrentPrincipal
) -> Response:
    """Mark a workflow deleted, and take its versions and runs out of sight with it.

    A soft delete: `deleted_at` is set and nothing is destroyed. From outside it
    is indistinguishable from the old behaviour — the row is gone from the list,
    every endpoint reports it as missing, and its versions and runs go with it —
    but `POST /workflows/{id}/restore` can put it all back, which is what makes
    the undo on the list page an undo rather than an apology. Deleting an agent
    is the one action on that page with no partial version of itself, and a
    misclick used to cost a graph, its history and the record of what it
    decided.

    WHAT HAPPENS TO A WORKFLOW WITH DEPLOYED VERSIONS: it is still refused,
    exactly as before, and the soft delete does not change that. The two
    alternatives are both worse. Marking it deleted while `/deployed/{name}/run`
    kept answering would leave the lender running an agent nobody can see, open
    or explain. Marking it deleted and silently stopping the name would break
    every integration calling it, at the moment of a click, with no audit entry
    saying an agent had been withdrawn. Retiring is that record, and it is one
    call away; the refusal hands over the id to make it with.

    The name stays held while the row is deleted, because restoring has to put
    the agent back at the address its callers use. Create says so when it
    refuses a name on those grounds.
    """
    workflow = await _workflow_or_404(session, workflow_id, principal)

    deployed = await session.execute(
        tenant_query(WorkflowVersion)
        .where(WorkflowVersion.workflow_id == workflow.id)
        .where(WorkflowVersion.status == "deployed")
    )
    live = deployed.scalar_one_or_none()
    if live is not None:
        raise ValidationFailed(
            "This workflow has a deployed version and is still callable",
            version=live.version,
            version_id=str(live.id),
            hint=(
                "Retire it first: POST /v1/studio/workflows/{id}/versions/{version_id}/retire. "
                "The id to use is in this response."
            ),
        )

    # Idempotent: deleting something already deleted cannot reach here, because
    # a deleted workflow is missing to every endpoint including this one.
    workflow.deleted_at = utc_now()
    await session.flush()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/workflows/{workflow_id}/restore",
    response_model=WorkflowDetail,
    summary="Undo a delete",
    dependencies=[Depends(require_scope(*READ_SCOPES))],
)
async def restore_workflow(
    workflow_id: UUID, session: DbSession, principal: CurrentPrincipal
) -> WorkflowDetail:
    """Clear the delete mark, putting the workflow, its versions and its runs back.

    The only endpoint that can see a deleted row, and it is owner-scoped like
    every other: a workflow that was never the caller's is not theirs to restore,
    and reports as missing rather than as forbidden. Deleting is not a way to
    make somebody else's id answer.

    Restoring something that is not deleted returns it unchanged rather than
    refusing. This is the undo behind a button that can be pressed twice, and the
    state the caller asked for — this workflow is not deleted — is already true.
    That is different from retiring a version, which is refused when it would
    change nothing, because there the caller is being told traffic moved when it
    did not.

    No name check is needed here. A deleted workflow keeps its name and create
    refuses to take one from it, so there is nothing for the restored row to
    collide with.
    """
    workflow = await _workflow_or_404(session, workflow_id, principal, include_deleted=True)
    if workflow.deleted_at is not None:
        workflow.deleted_at = None
        await session.flush()
    return await _workflow_detail(session, workflow)


# --- validation -------------------------------------------------------------


class ProblemOut(BaseModel):
    """One thing wrong with the graph, addressed to whoever drew it."""

    severity: str = Field(description="error stops a run; warning does not")
    message: str
    node_id: str = Field(default="", description="Which node to mark on the canvas")
    field: str = Field(default="", description="Which setting of that node, where it is one")


class ValidationOut(BaseModel):
    runnable: bool = Field(description="False when at least one problem is an error")
    problems: list[ProblemOut] = Field(default_factory=list)
    errors: int
    warnings: int


def _problems_out(problems: list[Problem]) -> ValidationOut:
    return ValidationOut(
        runnable=not any(p.blocking for p in problems),
        problems=[
            ProblemOut(severity=p.severity, message=p.message, node_id=p.node_id, field=p.field)
            for p in problems
        ],
        errors=sum(1 for p in problems if p.blocking),
        warnings=sum(1 for p in problems if not p.blocking),
    )


@router.post(
    "/workflows/{workflow_id}/validate",
    response_model=ValidationOut,
    summary="Check the draft",
    dependencies=[Depends(require_scope(*READ_SCOPES))],
)
async def validate_workflow(
    workflow_id: UUID, session: DbSession, principal: CurrentPrincipal
) -> ValidationOut:
    """Report everything wrong with the saved draft, without running it.

    Warnings are returned alongside errors rather than filtered out. A graph with
    no Output node runs perfectly well and returns something nobody asked for,
    which is worth saying while the author is still looking at the canvas.
    """
    workflow = await _workflow_or_404(session, workflow_id, principal)
    return _problems_out(_graph(workflow).validate())


# --- running ----------------------------------------------------------------


class WorkflowRunIn(BaseModel):
    """What to run with.

    ``extra: forbid`` is load-bearing. A caller who puts a token in this body
    gets a refusal instead of silence, which is the difference between finding
    out now and finding a credential in a request log later. Credentials are
    named in the node's own configuration and resolved server-side.
    """

    inputs: dict[str, Any] = Field(default_factory=dict)

    model_config = {"extra": "forbid"}


class WorkflowRunOut(BaseModel):
    """One run as the history list shows it."""

    id: UUID
    workflow_id: UUID
    version_id: UUID | None = None
    status: str = Field(description="completed, failed or awaiting_approval")
    duration_ms: int
    input_tokens: int
    output_tokens: int
    cost_inr: Decimal
    started_at: datetime
    finished_at: datetime | None = None

    model_config = {"from_attributes": True}


class WorkflowRunDetail(WorkflowRunOut):
    """A run with everything the studio's test panel draws."""

    inputs: dict[str, Any] = Field(default_factory=dict)
    output: dict[str, Any] = Field(default_factory=dict)
    trace: list[dict[str, Any]] = Field(
        default_factory=list, description="What each node did, in the order it settled"
    )
    state: dict[str, Any] = Field(
        default_factory=dict, description="The facts, decisions and warnings the run accumulated"
    )
    problems: list[str] = Field(default_factory=list)


def _credentials(principal: Principal) -> dict[str, str]:
    """Resolve the credential names a definition uses into actual values.

    Empty in this build: there is no credential store yet, so a node that names
    one receives nothing and says so in its own output rather than pretending it
    was authenticated. What matters is where this is *not* read from. The value
    never arrives in the request body and is never written into a definition,
    because a definition is saved, versioned, listed and read back by anyone who
    can open the studio — a token written into one would be a token published.
    """
    return {}


def _detail(run: WorkflowRun) -> WorkflowRunDetail:
    stored = run.trace if isinstance(run.trace, dict) else {}
    nodes = stored.get("nodes")
    return WorkflowRunDetail(
        id=run.id,
        workflow_id=run.workflow_id,
        version_id=run.version_id,
        status=run.status,
        duration_ms=run.duration_ms,
        input_tokens=run.input_tokens,
        output_tokens=run.output_tokens,
        cost_inr=run.cost_inr,
        started_at=run.started_at,
        finished_at=run.finished_at,
        inputs=run.inputs or {},
        output=run.output or {},
        trace=list(nodes) if isinstance(nodes, list) else [],
        state=stored.get("state") or {},
        problems=list(stored.get("problems") or []),
    )


async def _execute(
    session: Any,
    workflow: Workflow,
    graph: WorkflowGraph,
    *,
    inputs: dict[str, Any],
    principal: Principal,
    sarvam: Any,
    version: WorkflowVersion | None,
) -> WorkflowRunDetail:
    """Run a graph, record what happened, and hand back the whole outcome.

    A graph that does not validate is refused with its problems rather than
    recorded as a run. Nothing executed, nothing was billed and no state was
    touched, so a row in the run history claiming otherwise would be a lie the
    next reader has no way to detect. `/validate` exists so the canvas never has
    to discover this here.
    """
    started_at = utc_now()
    result: RunResult = await run_workflow(
        graph,
        sarvam,
        inputs=inputs,
        tenant_id=str(principal.tenant_id),
        tenant_name="",
        credentials=_credentials(principal),
    )

    if result.status == "invalid":
        raise ValidationFailed(
            "This workflow cannot run as drawn",
            problems=result.problems,
            hint="Ask POST /v1/studio/workflows/{id}/validate for the node each problem is on.",
        )

    payload = result.as_dict()
    run = WorkflowRun(
        tenant_id=principal.tenant_id,
        workflow_id=workflow.id,
        version_id=version.id if version else None,
        status=result.status,
        inputs=inputs,
        output=payload["output"],
        trace={
            "nodes": payload["trace"],
            "problems": payload["problems"],
            "state": payload["state"],
        },
        duration_ms=result.duration_ms,
        input_tokens=result.input_tokens,
        output_tokens=result.output_tokens,
        cost_inr=result.cost_inr,
        started_at=started_at,
        finished_at=utc_now(),
    )
    session.add(run)
    await session.flush()
    return _detail(run)


@router.post(
    "/workflows/{workflow_id}/run",
    response_model=WorkflowRunDetail,
    status_code=status.HTTP_201_CREATED,
    summary="Run the draft",
    dependencies=[Depends(require_scope(*WRITE_SCOPES))],
)
async def run_draft(
    workflow_id: UUID,
    session: DbSession,
    principal: CurrentPrincipal,
    sarvam: Sarvam,
    body: WorkflowRunIn | None = None,
) -> WorkflowRunDetail:
    """Execute the draft and record the run.

    This is the TEST button, and it runs the same engine as a deployed call: a
    test that took a shortcut would be worth nothing. The run is recorded with no
    version attached, which is how the history tells a trial from live traffic.

    A run that halts at an approval gate is a success — the workflow was drawn to
    stop there — so it returns 201 with `awaiting_approval`, not an error.
    """
    workflow = await _workflow_or_404(session, workflow_id, principal)
    return await _execute(
        session,
        workflow,
        _graph(workflow),
        inputs=body.inputs if body else {},
        principal=principal,
        sarvam=sarvam,
        version=None,
    )


# --- compiling and deploying ------------------------------------------------


def _next_version(existing: list[str]) -> str:
    """1.0, then 1.1, 1.2, and so on.

    The major number stays at 1 because nothing in this build makes the kind of
    declared breaking change that moving it would signal, and a number that moves
    for no stated reason tells the reader less than one that does not move at all.
    """
    highest = -1
    for value in existing:
        _, _, minor = value.partition(".")
        try:
            highest = max(highest, int(minor))
        except ValueError:
            continue
    return f"1.{highest + 1}"


def _derive_schemas(graph: WorkflowGraph) -> tuple[dict[str, Any], dict[str, Any]]:
    """What this agent accepts and returns, read off the graph itself.

    The input side comes from the Input node's declared fields. The output side
    comes from the Output node's mapping keys, and every one of them is typed as
    text: the Output node renders each mapping through the template engine, which
    produces a string. Claiming a richer type here would be a promise the run
    does not keep.

    A graph with no Input node takes no arguments, and one with no Output node
    returns the whole state — both are legal, and both are described as they are
    rather than as an empty schema that says nothing.
    """
    input_schema: dict[str, Any] = {}
    output_schema: dict[str, Any] = {}

    node = next((n for n in graph.nodes if n.type == "input"), None)
    if node is not None:
        declared = node.config.get("schema", {})
        if isinstance(declared, dict):
            input_schema = {str(k): str(v) for k, v in declared.items()}

    node = next((n for n in graph.nodes if n.type == "output"), None)
    if node is not None:
        mapping = node.config.get("mapping", {})
        if isinstance(mapping, dict):
            output_schema = {str(key): "string" for key in mapping}
    else:
        output_schema = {"facts": "object", "decisions": "array"}

    return input_schema, output_schema


@router.post(
    "/workflows/{workflow_id}/compile",
    response_model=WorkflowVersionDetail,
    status_code=status.HTTP_201_CREATED,
    summary="Freeze the draft into a version",
    dependencies=[Depends(require_scope(*WRITE_SCOPES))],
)
async def compile_workflow(
    workflow_id: UUID,
    session: DbSession,
    principal: CurrentPrincipal,
) -> WorkflowVersionDetail:
    """Take a copy of the draft that will not change again.

    Refused when the draft has errors. Compiling an invalid graph would produce
    something deployable that cannot run, and the failure would then surface at
    the first real call instead of here, where the person who drew it is present.

    The new version is a draft until it is deployed. Compiling does not change
    what any caller currently reaches.
    """
    workflow = await _workflow_or_404(session, workflow_id, principal)
    graph = _graph(workflow)

    problems = graph.validate()
    blocking = [p for p in problems if p.blocking]
    if blocking:
        raise ValidationFailed(
            "This workflow cannot be compiled as drawn",
            problems=[
                {"message": p.message, "node_id": p.node_id, "field": p.field} for p in blocking
            ],
        )

    existing = await _versions(session, workflow.id)
    input_schema, output_schema = _derive_schemas(graph)

    version = WorkflowVersion(
        tenant_id=principal.tenant_id,
        workflow_id=workflow.id,
        version=_next_version([v.version for v in existing]),
        # A copy, not a reference: the point of a version is that later edits to
        # the draft cannot reach it.
        definition=dict(workflow.definition or {}),
        input_schema=input_schema,
        output_schema=output_schema,
        status="draft",
        created_by=principal.subject,
    )
    session.add(version)
    await session.flush()

    await AuditRepository(session).append(
        action=AuditActions.WORKFLOW_COMPILED,
        entity_type="workflow_version",
        entity_id=str(version.id),
        payload={"workflow": workflow.name, "version": version.version},
        actor_type="service" if principal.is_service else "user",
        actor_id=principal.subject,
    )

    return WorkflowVersionDetail.model_validate(version, from_attributes=True)


@router.get(
    "/workflows/{workflow_id}/versions/{version_id}",
    response_model=WorkflowVersionDetail,
    summary="Get one version with its graph",
    dependencies=[Depends(require_scope(*READ_SCOPES))],
)
async def get_version(
    workflow_id: UUID,
    version_id: UUID,
    session: DbSession,
    principal: CurrentPrincipal,
) -> WorkflowVersionDetail:
    """One frozen version, definition included.

    This is how a past run is explained: the trace names the version, and the
    version still holds the graph exactly as it ran.

    A version is reached through its workflow, so it is exactly as visible as the
    workflow is: a version of somebody else's, or of a deleted one, reports as
    missing. The two checks below know about tenants and about which workflow a
    version belongs to, and nothing about owners — so the workflow is loaded
    first, through the lookup that does.
    """
    await _workflow_or_404(session, workflow_id, principal)
    version = await get_or_404(session, WorkflowVersion, version_id)
    if version.workflow_id != workflow_id:
        raise NotFound("WorkflowVersion not found", entity_id=str(version_id))
    return WorkflowVersionDetail.model_validate(version, from_attributes=True)


class VersionEdit(BaseModel):
    """A change to a version that has not been deployed."""

    definition: dict[str, Any]


@router.put(
    "/workflows/{workflow_id}/versions/{version_id}",
    response_model=WorkflowVersionDetail,
    summary="Edit a version that is not deployed",
    dependencies=[Depends(require_scope(*WRITE_SCOPES))],
)
async def edit_version(
    workflow_id: UUID,
    version_id: UUID,
    body: VersionEdit,
    session: DbSession,
    principal: CurrentPrincipal,
) -> WorkflowVersionDetail:
    """Correct a compiled version, while it is still only a draft version.

    Refused once the version is deployed or retired. A deployed version is what a
    live integration is calling: editing it would change the answers that
    integration receives without it asking for a change, and with nothing left to
    show what the behaviour used to be. Retired versions are equally closed,
    because they are the record of what an earlier run actually did.

    The remedy in both cases is to change the draft and compile again, which is
    cheap, and which leaves the history intact.
    """
    await _workflow_or_404(session, workflow_id, principal)
    version = await get_or_404(session, WorkflowVersion, version_id)
    if version.workflow_id != workflow_id:
        raise NotFound("WorkflowVersion not found", entity_id=str(version_id))

    if version.status != "draft":
        raise ValidationFailed(
            f"Version {version.version} is {version.status} and cannot be edited",
            version=version.version,
            status=version.status,
            hint="Change the draft workflow and compile a new version.",
        )

    version.definition = body.definition
    graph = from_dict(body.definition)
    graph.name = ""
    version.input_schema, version.output_schema = _derive_schemas(graph)
    await session.flush()
    return WorkflowVersionDetail.model_validate(version, from_attributes=True)


class DeployIn(BaseModel):
    """Which version to point traffic at.

    One of the two is required. There is deliberately no "deploy the newest"
    default: promoting whatever happened to be compiled last, without anyone
    naming it, is how the wrong graph goes live.
    """

    version_id: UUID | None = None
    version: str | None = None


class DeploymentOut(BaseModel):
    workflow_id: UUID
    name: str = Field(description="What a call by name uses")
    deployed: WorkflowVersionOut
    retired: str | None = Field(
        default=None, description="The version this one replaced, if there was one"
    )


@router.post(
    "/workflows/{workflow_id}/deploy",
    response_model=DeploymentOut,
    summary="Deploy a version",
    dependencies=[Depends(require_scope(*WRITE_SCOPES))],
)
async def deploy_version(
    workflow_id: UUID,
    body: DeployIn,
    session: DbSession,
    principal: CurrentPrincipal,
) -> DeploymentOut:
    """Make one version the one a call by name reaches.

    The incumbent is retired in the same transaction as the successor is
    promoted, so there is no moment at which the name resolves to two graphs or
    to none.
    """
    workflow = await _workflow_or_404(session, workflow_id, principal)

    if body.version_id is None and not body.version:
        raise ValidationFailed(
            "Name the version to deploy",
            hint="Send either version_id or version.",
        )

    statement = tenant_query(WorkflowVersion).where(WorkflowVersion.workflow_id == workflow.id)
    if body.version_id is not None:
        statement = statement.where(WorkflowVersion.id == body.version_id)
    else:
        statement = statement.where(WorkflowVersion.version == body.version)

    version = (await session.execute(statement)).scalar_one_or_none()
    if version is None:
        raise NotFound(
            "WorkflowVersion not found",
            entity_id=str(body.version_id or body.version),
        )

    retired: str | None = None
    if version.status != "deployed":
        incumbents = await session.execute(
            tenant_query(WorkflowVersion)
            .where(WorkflowVersion.workflow_id == workflow.id)
            .where(WorkflowVersion.status == "deployed")
        )
        for incumbent in incumbents.scalars().all():
            incumbent.status = "retired"
            retired = incumbent.version
        version.status = "deployed"
        await session.flush()

    await AuditRepository(session).append(
        action=AuditActions.WORKFLOW_DEPLOYED,
        entity_type="workflow_version",
        entity_id=str(version.id),
        payload={"workflow": workflow.name, "version": version.version, "retired": retired},
        actor_type="service" if principal.is_service else "user",
        actor_id=principal.subject,
    )

    return DeploymentOut(
        workflow_id=workflow.id,
        name=workflow.name,
        deployed=WorkflowVersionOut.model_validate(version, from_attributes=True),
        retired=retired,
    )


@router.post(
    "/workflows/{workflow_id}/versions/{version_id}/retire",
    response_model=WorkflowVersionOut,
    summary="Take a deployed version out of service",
    dependencies=[Depends(require_scope(*WRITE_SCOPES))],
)
async def retire_version(
    workflow_id: UUID,
    version_id: UUID,
    session: DbSession,
    principal: CurrentPrincipal,
) -> WorkflowVersionOut:
    """Stop a name resolving to this version, without promoting a replacement.

    Deploying a successor already retires the incumbent, so this exists for the
    case that has no successor: an agent that should stop answering at all. That
    case is not hypothetical — it is the first step of deleting a workflow, which
    is refused while a version is live.

    Retiring is not deleting. The version keeps its definition, because it is the
    only remaining explanation of what the runs that used it actually did.
    """
    await _workflow_or_404(session, workflow_id, principal)
    version = await get_or_404(session, WorkflowVersion, version_id)
    if version.workflow_id != workflow_id:
        raise NotFound("WorkflowVersion not found", entity_id=str(version_id))

    if version.status != "deployed":
        # Retiring a draft would be a no-op dressed as an action, and retiring a
        # retired version would suggest something changed when nothing did.
        raise ValidationFailed(
            f"Version {version.version} is {version.status}, so there is nothing to take "
            "out of service",
            version=version.version,
            status=version.status,
        )

    version.status = "retired"
    await session.flush()

    await AuditRepository(session).append(
        action=AuditActions.WORKFLOW_RETIRED,
        entity_type="workflow_version",
        entity_id=str(version.id),
        payload={"version": version.version},
        actor_type="service" if principal.is_service else "user",
        actor_id=principal.subject,
    )

    return WorkflowVersionOut.model_validate(version, from_attributes=True)


@router.post(
    "/deployed/{name}/run",
    response_model=WorkflowRunDetail,
    status_code=status.HTTP_201_CREATED,
    summary="Run a deployed agent by name",
    dependencies=[Depends(require_scope(*WRITE_SCOPES))],
)
async def run_deployed(
    name: str,
    session: DbSession,
    principal: CurrentPrincipal,
    sarvam: Sarvam,
    body: WorkflowRunIn | None = None,
) -> WorkflowRunDetail:
    """Call a whole workflow as one agent.

    This is the endpoint an integration uses, and the only one that runs a frozen
    definition. It reads the deployed version's own copy of the graph, not the
    draft: someone editing the canvas while this is being called must not change
    what the caller gets.

    THE ONE PLACE OWNERSHIP IS NOT APPLIED, and deliberately. A deployed agent is
    addressed by name, and a call by name carries no owner: the caller is a
    payments service, a nightly job, a colleague's integration. Scoping this to
    the person who drew the graph would mean a service token — which owns nothing
    — could never call anything, and would quietly turn every existing
    integration off the moment ownership shipped. Deploying is publication within
    the tenant, which is exactly why it takes a separate, audited act, and why a
    deployed workflow cannot be deleted without retiring it first.

    A deleted workflow does not answer here either. That case is unreachable
    today, because a workflow with a deployed version cannot be deleted at all;
    the filter is here so that it stays unreachable if that ever changes, rather
    than depending on a rule enforced somewhere else.
    """
    found = await session.execute(
        tenant_query(Workflow).where(Workflow.name == name).where(Workflow.deleted_at.is_(None))
    )
    workflow = found.scalar_one_or_none()
    if workflow is None:
        raise NotFound("No agent of this name", name=name)

    deployed = await session.execute(
        tenant_query(WorkflowVersion)
        .where(WorkflowVersion.workflow_id == workflow.id)
        .where(WorkflowVersion.status == "deployed")
    )
    version = deployed.scalar_one_or_none()
    if version is None:
        raise NotFound(
            "This agent has no deployed version",
            name=name,
            hint="Compile a version and deploy it before calling it by name.",
        )

    inputs = body.inputs if body else {}
    declared = version.input_schema or {}
    if declared:
        # Refused rather than dropped, as everywhere else a caller supplies
        # values: a field the caller believes was applied and was not is the
        # worst outcome available here. Absence is not checked, because the
        # schema names fields without saying which are mandatory.
        unknown = sorted(set(inputs) - set(declared))
        if unknown:
            raise ValidationFailed(
                "This agent does not accept these fields",
                unknown=unknown,
                accepts=sorted(declared),
            )

    graph = from_dict(version.definition or {})
    graph.name = workflow.name
    graph.description = workflow.description

    return await _execute(
        session,
        workflow,
        graph,
        inputs=inputs,
        principal=principal,
        sarvam=sarvam,
        version=version,
    )


# --- run history ------------------------------------------------------------
#
# WHOSE RUNS THESE ARE. The history splits exactly where the rest of the studio
# does, between a draft and a deployed version.
#
# A run with a version attached went through a deployed agent — a name the whole
# lender calls, usually from an integration or a nightly job. Those runs are the
# lender's operational record and stay tenant-wide, because narrowing live
# traffic to whoever happened to draw the graph would hide it from the people
# whose work is watching it.
#
# A run with no version is somebody pressing TEST on their own canvas. It is
# part of their bench, and it carries the whole trace: every node's output, the
# state the run accumulated, the graph it ran. Leaving those tenant-wide would
# have handed a colleague's private draft to anyone who listed `/runs` and
# followed an id — the ownership check on the workflow closed the front door
# while this stood open beside it.
#
# Existence follows the workflow either way. A run of a deleted workflow is as
# absent as the workflow, because a delete the history sees through is not a
# delete the person can see through, and restoring brings both back together.


@router.get(
    "/runs",
    response_model=list[WorkflowRunOut],
    summary="List workflow runs",
    dependencies=[Depends(require_scope(*READ_SCOPES))],
)
async def list_runs(
    session: DbSession,
    principal: CurrentPrincipal,
    workflow_id: Annotated[UUID | None, Query(alias="workflowId")] = None,
    status_filter: Annotated[str | None, Query(alias="status")] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> list[WorkflowRun]:
    """The tenant's live traffic and the caller's own test runs, newest first."""
    statement = _readable_runs(principal).order_by(WorkflowRun.started_at.desc())
    if workflow_id is not None:
        statement = statement.where(WorkflowRun.workflow_id == workflow_id)
    if status_filter:
        statement = statement.where(WorkflowRun.status == status_filter)
    result = await session.execute(statement.limit(limit).offset(offset))
    return list(result.scalars().all())


@router.get(
    "/runs/{run_id}",
    response_model=WorkflowRunDetail,
    summary="Get a run with its full trace",
    dependencies=[Depends(require_scope(*READ_SCOPES))],
)
async def get_run(
    run_id: UUID, session: DbSession, principal: CurrentPrincipal
) -> WorkflowRunDetail:
    """One run, with every node's inputs, outputs and timings.

    This is where a trace is read in full, which is why the draft half of the
    split matters here rather than only in the list: the trace of a test run is
    the canvas it came from, node by node.

    A run whose workflow has been deleted reports as missing, in the same words
    `get_or_404` would use for a run that never existed. Restoring the workflow
    brings its history back with it, which is the point of deleting softly.
    """
    result = await session.execute(_readable_runs(principal).where(WorkflowRun.id == run_id))
    run = result.scalar_one_or_none()
    if run is None:
        raise NotFound("WorkflowRun not found", entity_id=str(run_id))
    return _detail(run)


__all__ = ["router"]
