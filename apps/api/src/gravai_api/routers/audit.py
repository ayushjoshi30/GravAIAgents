"""Audit endpoints.

Backs the console's audit explorer. ``/verify`` recomputes the tenant's whole
hash chain and reports the first row that does not follow, which is what makes
the log evidence rather than merely a list.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from gravai_core.auth import Scope
from gravai_core.repositories import AuditRepository
from pydantic import BaseModel, Field

from ..deps import DbSession, require_scope

router = APIRouter(prefix="/v1/audit", tags=["audit"])


class AuditEntryOut(BaseModel):
    id: UUID
    seq: int
    action: str
    actor_type: str
    actor_id: str
    entity_type: str
    entity_id: str
    payload: dict[str, Any]
    correlation_id: str | None
    prev_hash: str
    hash: str
    recorded_at: datetime

    model_config = {"from_attributes": True}


class ChainVerificationOut(BaseModel):
    ok: bool = Field(description="False means a row was altered, removed or reordered")
    checked: int
    first_bad_seq: int | None = None
    reason: str | None = None


@router.get("", response_model=list[AuditEntryOut], summary="List audit entries")
async def list_entries(
    session: DbSession,
    _: Annotated[object, Depends(require_scope(Scope.AUDIT_READ))],
    entity_type: str | None = None,
    entity_id: str | None = None,
    limit: Annotated[int, Query(ge=1, le=1000)] = 200,
) -> list[Any]:
    """Audit entries for the caller's tenant, in chain order."""
    return await AuditRepository(session).list_entries(
        entity_type=entity_type, entity_id=entity_id, limit=limit
    )


@router.post("/verify", response_model=ChainVerificationOut, summary="Verify chain integrity")
async def verify(
    session: DbSession,
    _: Annotated[object, Depends(require_scope(Scope.AUDIT_READ))],
) -> ChainVerificationOut:
    """Recompute the tenant's audit chain from the genesis hash.

    A failure names the first sequence number that does not follow, so an
    investigation starts at the right row instead of the whole table.
    """
    result = await AuditRepository(session).verify()
    return ChainVerificationOut(
        ok=result.ok,
        checked=result.checked,
        first_bad_seq=result.first_bad_seq,
        reason=result.reason,
    )
