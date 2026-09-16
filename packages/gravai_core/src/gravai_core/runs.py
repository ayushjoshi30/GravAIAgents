"""Persisting agent runs.

Turns an in-memory agent result into the rows the console, the ledger and the
auditor read: the run, its steps, every billable call, an audit entry, and — when
the agent escalated — a task for a human.

This is deliberately in core rather than in the agents package: the API, the MCP
server and the worker all persist runs, and none of them should each invent
their own way of doing it.
"""

from __future__ import annotations

from dataclasses import asdict, is_dataclass
from decimal import Decimal
from typing import Any, Protocol
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from .audit import AuditActions
from .models import AgentRun, AgentStep, Consent, CostLedger, Task
from .repositories import AuditRepository
from .tenancy import current_actor_id, require_tenant_id
from .time_utils import utc_now


class ResultLike(Protocol):
    """What ``persist_run`` needs from an agent result.

    Structural rather than a concrete import, so core does not depend on the
    agents package and create a cycle.
    """

    agent_id: str

    @property
    def cost_inr(self) -> Decimal: ...
    @property
    def escalated(self) -> bool: ...
    @property
    def escalation_reason(self) -> str | None: ...
    def as_dict(self) -> dict[str, Any]: ...


#: Which role must clear an escalation from a given agent. Credit work goes to
#: an underwriter; collections work to a collections manager.
ESCALATION_ROLE: dict[str, str] = {
    "credit_appraisal": "underwriter",
    "bank_statement_analytics": "underwriter",
    "doc_intelligence": "underwriter",
    "msme_underwriting": "underwriter",
    "risk_scoring": "credit_head",
    "kyc_verification": "underwriter",
    "voice_collections": "collections_manager",
    "speech_analytics": "collections_manager",
    "case_allocation": "collections_manager",
    "smart_mandate": "collections_manager",
}


def _to_dict(value: Any) -> dict[str, Any]:
    if is_dataclass(value) and not isinstance(value, type):
        return asdict(value)
    if hasattr(value, "model_dump"):
        return dict(value.model_dump(mode="json"))
    if isinstance(value, dict):
        return value
    return {"value": str(value)}


async def persist_run(
    session: AsyncSession,
    result: ResultLike,
    *,
    application_id: UUID | None = None,
    case_id: str | None = None,
    rate_card_version: str = "",
    sandbox: bool = True,
    tenant_id: UUID | None = None,
) -> AgentRun:
    """Write a completed agent run and everything it implies.

    One transaction: the run, its steps, its ledger rows, an audit entry, and a
    task if a human must act. Partially recording a run would leave the console
    showing work that the ledger cannot account for.
    """
    tenant = tenant_id or require_tenant_id()
    payload = result.as_dict()
    now = utc_now()

    run = AgentRun(
        tenant_id=tenant,
        agent_id=result.agent_id,
        application_id=application_id,
        case_id=case_id,
        status="escalated" if result.escalated else "succeeded",
        started_at=now,
        finished_at=now,
        escalated=result.escalated,
        escalation_reason=result.escalation_reason,
        cost_inr=Decimal(str(payload.get("cost_inr", "0"))),
        sarvam_calls=len(getattr(result, "calls", []) or []),
        output=payload.get("output", {}),
        validation=payload.get("validation", {}),
    )
    session.add(run)
    await session.flush()

    for index, step in enumerate(payload.get("steps", []), start=1):
        session.add(
            AgentStep(
                tenant_id=tenant,
                run_id=run.id,
                seq=index,
                name=str(step.get("name", f"step-{index}")),
                kind=str(step.get("kind", "llm")),
                model=step.get("model"),
                prompt_version=step.get("prompt_version"),
                input_digest=str(step.get("input_digest", ""))[:32],
                output_digest=str(step.get("output_digest", ""))[:32],
                input_tokens=int(step.get("input_tokens", 0)),
                output_tokens=int(step.get("output_tokens", 0)),
                pages=int(step.get("pages", 0)),
                audio_seconds=Decimal(str(step.get("audio_seconds", 0))),
                latency_ms=int(step.get("latency_ms", 0)),
                cost_inr=Decimal(str(step.get("cost_inr", "0"))),
                attempts=int(step.get("attempts", 1)),
                estimated_usage=bool(step.get("estimated_usage", False)),
                validation=list(step.get("validation", [])),
            )
        )

    for call in getattr(result, "calls", []) or []:
        record = _to_dict(call)
        session.add(
            CostLedger(
                tenant_id=tenant,
                run_id=run.id,
                agent_id=result.agent_id,
                product=str(record.get("product", "")),
                endpoint=str(record.get("endpoint", ""))[:120],
                model=record.get("model"),
                input_tokens=int(record.get("input_tokens", 0)),
                output_tokens=int(record.get("output_tokens", 0)),
                pages=int(record.get("pages", 0)),
                audio_seconds=Decimal(str(record.get("audio_seconds", 0))),
                characters=int(record.get("characters", 0)),
                rate_card_version=rate_card_version,
                cost_inr=Decimal(str(record.get("cost_inr", "0"))),
                latency_ms=int(record.get("latency_ms", 0)),
                status=str(record.get("status", "ok")),
                sandbox=bool(record.get("sandbox", sandbox)),
            )
        )

    if result.escalated:
        session.add(
            Task(
                tenant_id=tenant,
                kind=f"{result.agent_id}.escalation",
                title=f"{result.agent_id.replace('_', ' ').title()} needs review",
                detail=result.escalation_reason or "The agent asked for a human decision.",
                application_id=application_id,
                run_id=run.id,
                status="open",
                severity="high" if not payload.get("validation", {}).get("ok", True) else "medium",
                required_role=ESCALATION_ROLE.get(result.agent_id, "underwriter"),
                evidence={
                    "validation": payload.get("validation", {}),
                    "escalation_reason": result.escalation_reason,
                },
            )
        )

    await AuditRepository(session).append(
        action=(
            AuditActions.AGENT_RUN_COMPLETED
            if not result.escalated
            else AuditActions.DECISION_PENDING_REVIEW
        ),
        entity_type="agent_run",
        entity_id=str(run.id),
        payload={
            "agent_id": result.agent_id,
            "cost_inr": str(run.cost_inr),
            "escalated": result.escalated,
            "validation_ok": payload.get("validation", {}).get("ok", True),
        },
        actor_type="agent",
        actor_id=current_actor_id() or result.agent_id,
        tenant_id=tenant,
    )

    return run


async def resolve_task(
    session: AsyncSession,
    task: Task,
    *,
    resolution: str,
    note: str,
    resolved_by: str,
) -> Task:
    """Close a task with a decision and a mandatory note.

    The note is not optional: an approval with no reasoning is exactly what an
    audit finding looks like.
    """
    if not note.strip():
        raise ValueError("A resolution note is required")

    task.status = "resolved"
    task.resolution = resolution
    task.resolution_note = note
    task.resolved_by = resolved_by
    task.resolved_at = utc_now()

    await AuditRepository(session).append(
        action=(
            AuditActions.DECISION_APPROVED
            if resolution == "approve"
            else AuditActions.DECISION_REJECTED
        ),
        entity_type="task",
        entity_id=str(task.id),
        payload={"resolution": resolution, "note": note, "kind": task.kind},
        actor_type="user",
        actor_id=resolved_by,
        tenant_id=task.tenant_id,
    )
    return task


async def record_consent(
    session: AsyncSession,
    *,
    subject_ref: str,
    source: str,
    purpose: str,
    purpose_code: str | None = None,
    artefact_id: str | None = None,
    artefact: dict[str, Any] | None = None,
    expires_at: Any = None,
    application_id: UUID | None = None,
    tenant_id: UUID | None = None,
) -> Consent:
    """Record a consent artefact and audit it."""
    tenant = tenant_id or require_tenant_id()
    consent = Consent(
        tenant_id=tenant,
        subject_ref=subject_ref,
        application_id=application_id,
        source=source,
        purpose=purpose,
        purpose_code=purpose_code,
        artefact_id=artefact_id,
        artefact=artefact or {},
        expires_at=expires_at,
    )
    session.add(consent)
    await session.flush()

    await AuditRepository(session).append(
        action=AuditActions.CONSENT_RECORDED,
        entity_type="consent",
        entity_id=str(consent.id),
        payload={"source": source, "purpose": purpose, "expires_at": str(expires_at)},
        actor_type="system",
        tenant_id=tenant,
    )
    return consent
