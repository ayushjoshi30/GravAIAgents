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

from datetime import datetime
from decimal import Decimal
from typing import Annotated, Any
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


class WorkflowCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=2000)
    definition: dict[str, Any] = Field(
        default_factory=dict,
        description="Nodes and edges. An empty graph is a valid starting point.",
    )


class WorkflowUpdate(BaseModel):
    """A change to the draft. Every field is optional; omitted means untouched."""

    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=2000)
    definition: dict[str, Any] | None = None


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


async def _versions(session: Any, workflow_id: UUID) -> list[WorkflowVersion]:
    """A workflow's versions, newest first."""
    result = await session.execute(
        tenant_query(WorkflowVersion)
        .where(WorkflowVersion.workflow_id == workflow_id)
        .order_by(WorkflowVersion.created_at.desc())
    )
    return list(result.scalars().all())


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
    response_model=list[WorkflowSummaryOut],
    summary="List workflows",
    dependencies=[Depends(require_scope(*READ_SCOPES))],
)
async def list_workflows(
    session: DbSession,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> list[WorkflowSummaryOut]:
    """Workflows for the caller's tenant, most recently changed first."""
    result = await session.execute(
        tenant_query(Workflow).order_by(Workflow.updated_at.desc()).limit(limit).offset(offset)
    )
    return [_summary(row) for row in result.scalars().all()]


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
    """Start a new agent.

    An empty graph is allowed: the canvas creates the workflow before anything is
    on it, and refusing that would mean the first node had nowhere to be saved.
    Validity is asked for separately, when there is something to be valid.
    """
    clash = await session.execute(tenant_query(Workflow).where(Workflow.name == body.name))
    if clash.scalar_one_or_none() is not None:
        raise ValidationFailed(
            "A workflow with this name already exists",
            name=body.name,
            hint="Names address a deployed agent, so they are unique within a tenant.",
        )

    workflow = Workflow(
        tenant_id=principal.tenant_id,
        name=body.name,
        description=body.description,
        definition=body.definition,
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
async def get_workflow(workflow_id: UUID, session: DbSession) -> WorkflowDetail:
    """One workflow. Another tenant's id reports as missing, never as forbidden."""
    workflow = await get_or_404(session, Workflow, workflow_id)
    versions = await _versions(session, workflow.id)
    deployed = next((v for v in versions if v.status == "deployed"), None)
    return WorkflowDetail(
        **_summary(workflow).model_dump(),
        definition=workflow.definition,
        versions=[WorkflowVersionOut.model_validate(v) for v in versions],
        deployed_version=deployed.version if deployed else None,
    )


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
) -> WorkflowDetail:
    """Save the canvas.

    This writes the draft only. A deployed version is unaffected by anything here
    — that separation is the whole reason versions exist, and it is what lets
    someone rework a live agent without the live agent changing while they do it.
    """
    workflow = await get_or_404(session, Workflow, workflow_id)

    if body.name is not None and body.name != workflow.name:
        clash = await session.execute(
            tenant_query(Workflow)
            .where(Workflow.name == body.name)
            .where(Workflow.id != workflow.id)
        )
        if clash.scalar_one_or_none() is not None:
            raise ValidationFailed("A workflow with this name already exists", name=body.name)
        workflow.name = body.name

    if body.description is not None:
        workflow.description = body.description
    if body.definition is not None:
        workflow.definition = body.definition

    await session.flush()
    versions = await _versions(session, workflow.id)
    deployed = next((v for v in versions if v.status == "deployed"), None)
    return WorkflowDetail(
        **_summary(workflow).model_dump(),
        definition=workflow.definition,
        versions=[WorkflowVersionOut.model_validate(v) for v in versions],
        deployed_version=deployed.version if deployed else None,
    )


@router.delete(
    "/workflows/{workflow_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a workflow",
    dependencies=[Depends(require_scope(*READ_SCOPES))],
)
async def delete_workflow(workflow_id: UUID, session: DbSession) -> Response:
    """Remove a workflow, its versions and its run history.

    Refused while a version is deployed. Deleting a deployed agent would break
    every caller of it with nothing left to explain why, and "retire it first" is
    a deliberate second step rather than an obstacle.
    """
    workflow = await get_or_404(session, Workflow, workflow_id)

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

    await session.delete(workflow)
    await session.flush()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


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
async def validate_workflow(workflow_id: UUID, session: DbSession) -> ValidationOut:
    """Report everything wrong with the saved draft, without running it.

    Warnings are returned alongside errors rather than filtered out. A graph with
    no Output node runs perfectly well and returns something nobody asked for,
    which is worth saying while the author is still looking at the canvas.
    """
    workflow = await get_or_404(session, Workflow, workflow_id)
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
    workflow = await get_or_404(session, Workflow, workflow_id)
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
    workflow = await get_or_404(session, Workflow, workflow_id)
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
    workflow_id: UUID, version_id: UUID, session: DbSession
) -> WorkflowVersionDetail:
    """One frozen version, definition included.

    This is how a past run is explained: the trace names the version, and the
    version still holds the graph exactly as it ran.
    """
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
    workflow = await get_or_404(session, Workflow, workflow_id)

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
    """
    found = await session.execute(tenant_query(Workflow).where(Workflow.name == name))
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


@router.get(
    "/runs",
    response_model=list[WorkflowRunOut],
    summary="List workflow runs",
    dependencies=[Depends(require_scope(*READ_SCOPES))],
)
async def list_runs(
    session: DbSession,
    workflow_id: Annotated[UUID | None, Query(alias="workflowId")] = None,
    status_filter: Annotated[str | None, Query(alias="status")] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> list[WorkflowRun]:
    """Runs for the caller's tenant, newest first."""
    statement = tenant_query(WorkflowRun).order_by(WorkflowRun.started_at.desc())
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
async def get_run(run_id: UUID, session: DbSession) -> WorkflowRunDetail:
    """One run, with every node's inputs, outputs and timings."""
    return _detail(await get_or_404(session, WorkflowRun, run_id))


__all__ = ["router"]
