"""Agent catalog endpoints.

Reads the same registry the MCP server and the docs site read, so the three
surfaces can never disagree about which agents exist.
"""

from __future__ import annotations

from dataclasses import replace
from decimal import Decimal
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, status
from gravai_agents import AgentTier, get_agent, list_agents
from gravai_connectors.document_source import (
    ParsedSource,
    SourceDocument,
    SourceUnusable,
    fetch_source,
)
from gravai_core.auth import Scope
from gravai_core.blobstore import BlobStore, BlobStoreError
from gravai_core.errors import NotFound, ValidationFailed
from gravai_core.models import Document
from gravai_core.netguard import UnsafeUrl
from gravai_core.repositories import get_or_404
from gravai_core.runs import persist_run
from gravai_core.settings import get_settings
from gravai_runner import AgentNotRunnable, run_agent
from gravai_runner.inputs import inputs_for
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from ..deps import CurrentPrincipal, DbSession, Sarvam, require_scope
from .documents import BlobStoreDep

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

    `source` and `document_ids` are not alternatives. A file someone had in
    their hand and an endpoint holding the same applicant's figures are both
    real, and a run may carry either or both.
    """

    inputs: dict[str, Any] = Field(default_factory=dict)
    source: DocumentSourceIn | None = None
    document_ids: list[str] = Field(
        default_factory=list,
        description=(
            "Ids returned by POST /v1/documents. Each is resolved against your own "
            "tenant: an id that is not yours answers exactly as one that does not "
            "exist does."
        ),
    )


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


async def _resolve_documents(
    session: AsyncSession,
    store: BlobStore,
    tenant_id: UUID,
    document_ids: list[str],
) -> tuple[SourceDocument, ...]:
    """Turn uploaded ids into documents, each checked against the tenant first.

    Every id is looked up with the caller's own tenant in the WHERE clause, and
    that predicate is the security property of this endpoint. A document id is a
    bearer of nothing — holding one says nothing whatever about being allowed to
    read what it names — and one lender reading another's bureau report is worse
    than any outage this platform could have, because it is a breach the lender
    has to report. The blob keys are random and tenant-prefixed, which is worth
    having and is not the check: an attacker never sees a key, only an id, so it
    is the id that has to be refused.

    An id belonging to another tenant and an id belonging to nobody produce the
    same 404 with the same body, because answering the two differently would
    turn this endpoint into a way to ask which ids are real. A string that is not
    a UUID is answered the same way for the same reason: one question, one
    answer, whatever was sent.
    """
    resolved: list[SourceDocument] = []
    seen: set[UUID] = set()

    for raw in document_ids:
        try:
            document_id = UUID(raw)
        except ValueError as exc:
            raise NotFound("Document not found", entity_id=raw) from exc

        # Deduplicated on the parsed id and not on the string that carried it,
        # with the first occurrence winning, so the caller's order is the order
        # the documents reach the run. Comparing the strings would have missed
        # every respelling ``UUID()`` accepts — the urn form, the braced form,
        # any mixture of case — and four spellings of one id would then have
        # been four reads out of storage and the same file handed to the agent
        # four times, as though four documents had been sent.
        if document_id in seen:
            continue
        seen.add(document_id)

        # The tenant is passed explicitly rather than left to the ambient
        # request context. It is the same value either way, and this is the one
        # line in the file where a reader needs to see the check rather than
        # trust that something upstream bound it.
        row = await get_or_404(session, Document, document_id, tenant_id=tenant_id)

        # Resolved through the blob store, which refuses any reference that is
        # not ``blob://`` — so a stored row can never send the server off to
        # fetch a URL. A store that cannot be reached raises BlobStoreError,
        # which is a 502: a storage outage must not be dressed up as "no such
        # document", both because it is not true and because it would send the
        # reader looking for a bad id instead of a broken bucket.
        content = await store.resolve(row.uri)
        if not content:
            # The upload refuses an empty file, so no row can honestly describe
            # zero bytes. Nothing to read means the object is not the object
            # that was stored, and an agent handed an empty document would
            # report on a file it never saw.
            raise BlobStoreError(
                "The object store returned no bytes for this document",
                document_id=str(row.id),
            )

        resolved.append(
            SourceDocument(
                document_id=str(row.id),
                # ``declared_type`` is what a source endpoint said a document
                # was. An upload carries no such claim, and inventing one here
                # would make this router the origin of a fact nobody stated.
                declared_type=None,
                mime_type=row.mime_type,
                filename=row.filename,
                content=content,
                pages=row.pages,
            )
        )

    return tuple(resolved)


def _uploads_note(uploaded: tuple[SourceDocument, ...]) -> str:
    """What the source report says about documents that came from an upload."""
    return (
        f"{len(uploaded)} uploaded document{'' if len(uploaded) == 1 else 's'} "
        "resolved from storage and added to this run"
    )


def _merge(
    fetched: ParsedSource | None, uploaded: tuple[SourceDocument, ...]
) -> ParsedSource | None:
    """One ParsedSource carrying the fetched source and the uploads together.

    When both are present neither replaces the other: the fetched documents keep
    their place at the front, the uploads are appended after them, and
    everything else the fetch produced — the statement lines, the application
    fields, the account, the parser's notes — is left exactly as it was.
    Discarding either would have the run quietly answer a question nobody asked:
    the one without the file, or the one without the figures.
    """
    if not uploaded:
        return fetched
    if fetched is None:
        return ParsedSource(documents=uploaded, notes=(_uploads_note(uploaded),))
    return replace(
        fetched,
        documents=(*fetched.documents, *uploaded),
        notes=(*fetched.notes, _uploads_note(uploaded)),
    )


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
    store: BlobStoreDep,
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

    `document_ids` name files this tenant uploaded earlier, and they are
    resolved — scope checked, tenant checked, bytes read — before the agent is
    asked to do anything. A run therefore either has every document it named or
    does not happen at all: an agent reporting on a file it could not read would
    be worse than a request that failed, and it would cost a model call to say
    so.
    """
    spec = get_agent(agent_id)
    supplied = body.inputs if body else {}

    uploaded: tuple[SourceDocument, ...] = ()
    if body and body.document_ids:
        # Naming an uploaded document is reading it, so it costs what reading a
        # document costs. `agents:run` on its own is held by roles this platform
        # deliberately keeps away from files — a collections manager has it and
        # holds neither documents:read nor documents:write — and without this
        # line the new field would hand one of them a bureau report by way of an
        # agent. Asked only when the field is used, so a caller that never sends
        # one is answered exactly as it was before.
        principal.require_scope(Scope.DOCUMENTS_READ)
        # Resolved before the source is fetched, so an id that is not this
        # tenant's is refused before the server makes any outbound request on
        # the caller's behalf.
        uploaded = await _resolve_documents(session, store, principal.tenant_id, body.document_ids)

    fetched = await _fetch(body.source) if body and body.source else None
    parsed = _merge(fetched, uploaded)

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
        # The url is empty when the documents came from uploads alone: the report
        # describes what this run actually read, and there was no URL to name.
        # Either way the counts include the uploads, which is why the report is
        # built from the merged source rather than from the fetch.
        source=_report(body.source.url if body and body.source else "", parsed)
        if parsed is not None
        else None,
        output=result.output.model_dump(mode="json"),
    )
