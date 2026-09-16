"""Agent catalog endpoints.

Reads the same registry the MCP server and the docs site read, so the three
surfaces can never disagree about which agents exist.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, status
from gravai_agents import AgentTier, get_agent, list_agents
from gravai_core.auth import Scope
from gravai_core.errors import ValidationFailed
from gravai_core.netguard import UnsafeUrl
from gravai_core.settings import get_settings
from gravai_connectors.document_source import ParsedSource, SourceUnusable, fetch_source
from gravai_core.runs import persist_run
from gravai_runner import AgentNotRunnable, run_agent
from gravai_runner.inputs import inputs_for
from pydantic import BaseModel, Field

from ..deps import CurrentPrincipal, DbSession, Sarvam, require_scope

router = APIRouter(prefix="/v1/agents", tags=["agents"])


class AgentOut(BaseModel):
    """One agent as the API exposes it."""

    id: str
    name: str
    tier: str
    summary: str
    tool_name: str = Field(description="MCP tool that invokes this agent")
    scopes: list[str]
    advisory_only: bool = Field(
        description="Advisory agents never take an irreversible action on their own"
    )
    parity_with: str | None = None
    tags: list[str]


def _to_out(spec: object) -> AgentOut:
    return AgentOut(
        id=spec.id,  # type: ignore[attr-defined]
        name=spec.name,  # type: ignore[attr-defined]
        tier=str(spec.tier),  # type: ignore[attr-defined]
        summary=spec.summary,  # type: ignore[attr-defined]
        tool_name=spec.tool_name,  # type: ignore[attr-defined]
        scopes=sorted(s.value for s in spec.scopes),  # type: ignore[attr-defined]
        advisory_only=spec.advisory_only,  # type: ignore[attr-defined]
        parity_with=spec.parity_with,  # type: ignore[attr-defined]
        tags=list(spec.tags),  # type: ignore[attr-defined]
    )


@router.get(
    "",
    response_model=list[AgentOut],
    summary="List agents",
    dependencies=[Depends(require_scope(Scope.AGENTS_RUN, Scope.APPLICATIONS_READ))],
)
async def list_all(tier: AgentTier | None = None) -> list[AgentOut]:
    """Every agent in the catalog, optionally filtered by build tier."""
    return [_to_out(spec) for spec in list_agents(tier)]


@router.get(
    "/{agent_id}",
    response_model=AgentOut,
    summary="Get one agent",
    dependencies=[Depends(require_scope(Scope.AGENTS_RUN, Scope.APPLICATIONS_READ))],
)
async def get_one(agent_id: str) -> AgentOut:
    """One agent by id. Unknown ids return a 404 problem document."""
    return _to_out(get_agent(agent_id))


class AgentInputFieldOut(BaseModel):
    """One editable input, as the console renders a control for it."""

    name: str
    label: str
    kind: str = Field(description="number, money, text, textarea or select")
    default: Any
    help: str = ""
    minimum: float | None = None
    maximum: float | None = None
    choices: list[str] = Field(default_factory=list)
    sourced: bool = Field(
        default=False,
        description="True when a real source supplies this, so blank means read it from there",
    )
    source_label: str = ""
    blank_means: str = Field(default="", description="What leaving this field alone will do")


class AgentInputsOut(BaseModel):
    """What may be changed about a run of this agent.

    An agent with no editable fields still answers, with `caveat` explaining
    why — an empty form and a 404 both leave the reader guessing whether the
    agent takes no input or the feature is missing.
    """

    agent_id: str
    editable: bool
    caveat: str = ""
    fields: list[AgentInputFieldOut] = Field(default_factory=list)


@router.get(
    "/{agent_id}/inputs",
    response_model=AgentInputsOut,
    summary="Inputs this agent accepts",
    dependencies=[Depends(require_scope(Scope.AGENTS_RUN, Scope.APPLICATIONS_READ))],
)
async def get_inputs(agent_id: str) -> AgentInputsOut:
    """The editable surface of one agent.

    Served from the same declaration the runner validates against, so a field
    cannot be rendered here that the run would reject or quietly ignore.
    """
    get_agent(agent_id)  # 404s an unknown id before describing anything.
    spec = inputs_for(agent_id)
    return AgentInputsOut(
        agent_id=agent_id,
        editable=bool(spec.fields),
        caveat=spec.caveat,
        fields=[
            AgentInputFieldOut(
                name=f.name,
                label=f.label,
                kind=f.kind,
                default=f.default,
                help=f.help,
                minimum=f.minimum,
                maximum=f.maximum,
                choices=list(f.choices),
                sourced=f.sourced,
                source_label=f.source_label,
                blank_means=f.blank_means,
            )
            for f in spec.fields
        ],
    )


class DocumentSourceIn(BaseModel):
    """Where to fetch this run's real data from."""

    url: str = Field(description="A GET endpoint returning documents or already-extracted facts")
    headers: dict[str, str] = Field(
        default_factory=dict,
        description="Sent with the request. Dropped if a redirect leaves the original origin.",
    )


class AgentRunIn(BaseModel):
    """What to run with.

    An omitted input is not a default — it is left to whatever supplies it,
    which is `source` when one is given and the connected environment otherwise.
    """

    inputs: dict[str, Any] = Field(default_factory=dict)
    source: DocumentSourceIn | None = None


class SourceReportOut(BaseModel):
    """What the fetch actually produced, so nothing about it is implicit."""

    url: str
    content_type: str = ""
    bytes_fetched: int = 0
    documents: int = 0
    documents_with_content: int = 0
    transactions: int = 0
    application_fields: list[str] = Field(default_factory=list)
    account_fields: list[str] = Field(default_factory=list)
    #: Every field-name mapping the parser inferred, in plain words.
    notes: list[str] = Field(default_factory=list)
    #: True when this alone can drive the run with no document-AI layer.
    usable_without_extraction: bool = False


def _report(url: str, parsed: ParsedSource) -> SourceReportOut:
    return SourceReportOut(
        url=url,
        content_type=parsed.content_type,
        bytes_fetched=parsed.bytes_fetched,
        documents=len(parsed.documents),
        documents_with_content=sum(1 for doc in parsed.documents if doc.content),
        transactions=len(parsed.transactions),
        application_fields=sorted(parsed.application),
        account_fields=sorted(parsed.account),
        notes=list(parsed.notes),
        usable_without_extraction=parsed.has_facts,
    )


async def _fetch(source: DocumentSourceIn) -> ParsedSource:
    """Fetch and parse, turning either failure into a problem document."""
    settings = get_settings()
    try:
        return await fetch_source(
            source.url,
            headers=source.headers,
            allow_private=settings.document_source_allow_private,
            timeout=settings.document_source_timeout_seconds,
            max_bytes=settings.document_source_max_bytes,
            max_redirects=settings.document_source_max_redirects,
        )
    except UnsafeUrl as exc:
        raise ValidationFailed(
            str(exc),
            url=source.url,
            hint="The server will only fetch publicly routable addresses.",
        ) from exc
    except SourceUnusable as exc:
        raise ValidationFailed(str(exc), url=source.url) from exc


@router.post(
    "/source/check",
    response_model=SourceReportOut,
    summary="Check a document source without running anything",
    dependencies=[Depends(require_scope(Scope.AGENTS_RUN))],
)
async def check_source(body: DocumentSourceIn) -> SourceReportOut:
    """Fetch the endpoint and report what was found.

    Separate from running an agent so a URL can be corrected without spending a
    run on it, and so the parser's inferences can be read before they are acted
    on.
    """
    return _report(body.url, await _fetch(body))


class AgentRunOut(BaseModel):
    """What one agent produced, as the console renders it."""

    agent_id: str
    name: str
    run_id: UUID
    sandbox: bool = Field(description="Sandbox output must never underwrite a decision")
    escalated: bool
    escalation_reason: str | None = None
    guardrails_passed: bool
    guardrail_violations: list[str] = Field(default_factory=list)
    reasoning_summary: str | None = None
    cost_inr: Decimal
    steps: list[dict[str, Any]] = Field(default_factory=list)
    overrides_applied: dict[str, Any] = Field(
        default_factory=dict,
        description="Only the values you supplied. Everything else was read from the source.",
    )
    source: SourceReportOut | None = None
    output: dict[str, Any]


@router.post(
    "/{agent_id}/run",
    response_model=AgentRunOut,
    status_code=status.HTTP_201_CREATED,
    summary="Run one agent",
    dependencies=[Depends(require_scope(Scope.AGENTS_RUN))],
)
async def run_one(
    agent_id: str,
    session: DbSession,
    principal: CurrentPrincipal,
    sarvam: Sarvam,
    body: AgentRunIn | None = None,
) -> AgentRunOut:
    """Execute a single agent and record the run.

    The catalog says which agents exist; `gravai_runner` knows how to assemble
    the inputs each one needs. Both this endpoint and the MCP server go through
    that same runner, so an agent cannot behave differently depending on which
    door the request came in by.

    Escalation is not an error. Four of the fourteen hand their decision to a
    person by design, and `persist_run` raises the review task that makes that
    real — so a 201 carrying `escalated: true` is a success.

    Supplied inputs are validated against the agent's declared schema. An
    unknown field is refused rather than dropped: a value the caller believes
    was applied and was not is the worst outcome available here.
    """
    spec = get_agent(agent_id)
    supplied = body.inputs if body else {}
    parsed = await _fetch(body.source) if body and body.source else None

    try:
        result = await run_agent(agent_id, sarvam, inputs=supplied, source=parsed)
    except AgentNotRunnable as exc:
        raise ValidationFailed(
            "This agent has no input wiring yet",
            agent_id=agent_id,
            hint="It is in the catalog but the runner cannot assemble its inputs.",
        ) from exc
    except ValueError as exc:
        raise ValidationFailed(
            str(exc),
            agent_id=agent_id,
            hint="Ask GET /v1/agents/{agent_id}/inputs for the fields this agent accepts.",
        ) from exc

    run = await persist_run(
        session,
        result,
        rate_card_version=sarvam.rate_card.version,
        sandbox=sarvam.sandbox,
        tenant_id=principal.tenant_id,
    )

    return AgentRunOut(
        agent_id=agent_id,
        name=spec.name,
        run_id=run.id,
        sandbox=sarvam.sandbox,
        escalated=result.escalated,
        escalation_reason=result.escalation_reason,
        guardrails_passed=result.validation.ok,
        guardrail_violations=list(result.validation.violations),
        reasoning_summary=getattr(result.output, "reasoning_summary", None),
        cost_inr=result.cost_inr,
        steps=[
            {"name": step.name, "kind": step.kind, "attempts": step.attempts}
            for step in result.steps
        ],
        overrides_applied={
            key: str(value) if isinstance(value, Decimal) else value
            for key, value in inputs_for(agent_id).resolve(supplied).items()
        },
        source=_report(body.source.url, parsed) if body and body.source and parsed else None,
        output=result.output.model_dump(mode="json"),
    )
