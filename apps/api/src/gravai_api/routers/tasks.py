"""The review queue.

Every agent escalation lands here, and nothing in the platform reaches a credit
outcome without one of these being resolved by a person. Resolving requires a
note: an approval with no reasoning is what an audit finding looks like.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from gravai_core.auth import Role, Scope
from gravai_core.errors import Forbidden, ValidationFailed
from gravai_core.models import Task
from gravai_core.repositories import get_or_404, tenant_query
from gravai_core.runs import resolve_task
from pydantic import BaseModel, Field
from sqlalchemy import func

from ..deps import CurrentPrincipal, DbSession, require_scope

router = APIRouter(prefix="/v1/tasks", tags=["tasks"])


class TaskOut(BaseModel):
    id: UUID
    kind: str
    title: str
    detail: str
    application_id: UUID | None
    run_id: UUID | None
    status: str
    severity: str
    required_role: str | None
    assigned_to: str | None
    resolution: str | None
    resolution_note: str | None
    resolved_by: str | None
    resolved_at: datetime | None
    evidence: dict[str, Any]
    created_at: datetime

    model_config = {"from_attributes": True}


class ResolveRequest(BaseModel):
    resolution: str = Field(pattern="^(approve|reject|request_info)$")
    note: str = Field(
        min_length=10,
        max_length=4000,
        description="Why. Required — a decision without reasoning is not auditable.",
    )


@router.get("", response_model=list[TaskOut], summary="List review tasks")
async def list_tasks(
    session: DbSession,
    _: Annotated[object, Depends(require_scope(Scope.APPLICATIONS_READ))],
    status_filter: Annotated[str | None, Query(alias="status")] = "open",
    kind: str | None = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> list[Task]:
    """Tasks for the caller's tenant, most severe and oldest first."""
    statement = tenant_query(Task)
    if status_filter:
        statement = statement.where(Task.status == status_filter)
    if kind:
        statement = statement.where(Task.kind == kind)
    result = await session.execute(
        statement.order_by(Task.severity.desc(), Task.created_at.asc()).limit(limit)
    )
    return list(result.scalars().all())


@router.get("/summary", summary="Open task counts")
async def summary(
    session: DbSession,
    _: Annotated[object, Depends(require_scope(Scope.APPLICATIONS_READ))],
) -> dict[str, int]:
    """Open tasks by severity, for the console's attention tiles."""
    statement = (
        tenant_query(Task)
        .where(Task.status == "open")
        .with_only_columns(Task.severity, func.count(Task.id))
        .group_by(Task.severity)
    )
    return {row[0]: row[1] for row in (await session.execute(statement)).all()}


@router.post("/{task_id}/resolve", response_model=TaskOut, summary="Resolve a task")
async def resolve(
    task_id: UUID,
    body: ResolveRequest,
    session: DbSession,
    principal: CurrentPrincipal,
    _: Annotated[object, Depends(require_scope(Scope.DECISIONS_APPROVE))],
) -> Task:
    """Close a task with a decision and a note.

    The role the task asked for is enforced here, not merely displayed: a
    collections role cannot clear an underwriting escalation even if it can
    reach the endpoint.
    """
    task = await get_or_404(session, Task, task_id)

    if task.status != "open":
        raise ValidationFailed(
            "This task has already been resolved",
            resolved_by=task.resolved_by,
            resolution=task.resolution,
        )

    if task.required_role:
        try:
            required = Role(task.required_role)
        except ValueError:
            required = None
        if required is not None and not principal.has_role(required, Role.TENANT_ADMIN):
            raise Forbidden(
                "This task requires a different role",
                required_role=task.required_role,
                held=sorted(r.value for r in principal.roles),
            )

    return await resolve_task(
        session,
        task,
        resolution=body.resolution,
        note=body.note,
        resolved_by=principal.subject,
    )
