"""Data access.

The audit repository is the only writer of ``audit_log``; it computes the
per-tenant sequence number and chains each entry to its predecessor. Everything
else goes through tenant-guarded queries that refuse to run without a bound
tenant.
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlalchemy import Select, select
from sqlalchemy.ext.asyncio import AsyncSession

from .audit import GENESIS_HASH, AuditEntry, ChainVerification, verify_chain
from .errors import NotFound
from .models import AuditLog, Base, TenantScopedMixin
from .tenancy import current_actor_id, current_correlation_id, require_tenant_id
from .time_utils import utc_now


def tenant_query[ModelT: Base](
    model: type[ModelT], tenant_id: UUID | None = None
) -> Select[tuple[ModelT]]:
    """Build a SELECT already filtered to the bound tenant.

    Using this instead of a bare ``select()`` is what makes a forgotten tenant
    filter impossible rather than merely unlikely.
    """
    resolved = tenant_id or require_tenant_id()
    statement = select(model)
    if issubclass(model, TenantScopedMixin):
        statement = statement.where(model.tenant_id == resolved)
    return statement


async def get_or_404[ModelT: Base](
    session: AsyncSession,
    model: type[ModelT],
    entity_id: UUID | str,
    *,
    tenant_id: UUID | None = None,
) -> ModelT:
    """Fetch one tenant-scoped row or raise NotFound.

    A row belonging to another tenant is reported as missing, never as
    forbidden: telling a caller that an id exists elsewhere is itself a leak.
    """
    resolved_id = UUID(str(entity_id)) if not isinstance(entity_id, UUID) else entity_id
    statement = tenant_query(model, tenant_id).where(model.id == resolved_id)  # type: ignore[attr-defined]
    result = await session.execute(statement)
    row = result.scalar_one_or_none()
    if row is None:
        raise NotFound(f"{model.__name__} not found", entity_id=str(resolved_id))
    return row


class AuditRepository:
    """Append-only writer and verifier for the audit chain."""

    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def _tail(self, tenant_id: UUID) -> AuditLog | None:
        """The most recent entry for a tenant, locked where the dialect allows.

        The lock serialises concurrent appends so two writers cannot claim the
        same sequence number. SQLite serialises writes anyway.
        """
        statement = (
            select(AuditLog)
            .where(AuditLog.tenant_id == tenant_id)
            .order_by(AuditLog.seq.desc())
            .limit(1)
        )
        if self.session.get_bind().dialect.name == "postgresql":
            statement = statement.with_for_update()
        result = await self.session.execute(statement)
        return result.scalar_one_or_none()

    async def append(
        self,
        *,
        action: str,
        entity_type: str,
        entity_id: str,
        payload: dict[str, Any] | None = None,
        actor_type: str = "user",
        actor_id: str | None = None,
        correlation_id: str | None = None,
        tenant_id: UUID | None = None,
    ) -> AuditLog:
        """Append one entry, chained to the tenant's previous entry."""
        tenant = tenant_id or require_tenant_id()
        tail = await self._tail(tenant)

        seq = (tail.seq + 1) if tail else 1
        prev_hash = tail.hash if tail else GENESIS_HASH
        recorded_at = utc_now()

        entry = AuditEntry(
            tenant_id=tenant,
            seq=seq,
            action=action,
            actor_type=actor_type,
            actor_id=actor_id or current_actor_id() or "system",
            entity_type=entity_type,
            entity_id=str(entity_id),
            payload=payload or {},
            recorded_at=recorded_at,
            correlation_id=correlation_id or current_correlation_id(),
        )

        row = AuditLog(
            tenant_id=tenant,
            seq=seq,
            action=entry.action,
            actor_type=entry.actor_type,
            actor_id=entry.actor_id,
            entity_type=entry.entity_type,
            entity_id=entry.entity_id,
            payload=entry.payload,
            correlation_id=entry.correlation_id,
            prev_hash=prev_hash,
            hash=entry.compute_hash(prev_hash),
            recorded_at=recorded_at,
        )
        self.session.add(row)
        await self.session.flush()
        return row

    async def list_entries(
        self,
        *,
        tenant_id: UUID | None = None,
        entity_type: str | None = None,
        entity_id: str | None = None,
        limit: int = 500,
    ) -> list[AuditLog]:
        """Entries in chain order."""
        tenant = tenant_id or require_tenant_id()
        statement = (
            select(AuditLog).where(AuditLog.tenant_id == tenant).order_by(AuditLog.seq.asc())
        )
        if entity_type:
            statement = statement.where(AuditLog.entity_type == entity_type)
        if entity_id:
            statement = statement.where(AuditLog.entity_id == str(entity_id))
        result = await self.session.execute(statement.limit(limit))
        return list(result.scalars().all())

    async def verify(self, *, tenant_id: UUID | None = None) -> ChainVerification:
        """Recompute a tenant's whole chain.

        This backs the console's "verify integrity" action and the audit export
        manifest.
        """
        tenant = tenant_id or require_tenant_id()
        result = await self.session.execute(
            select(AuditLog).where(AuditLog.tenant_id == tenant).order_by(AuditLog.seq.asc())
        )
        return verify_chain(list(result.scalars().all()))
