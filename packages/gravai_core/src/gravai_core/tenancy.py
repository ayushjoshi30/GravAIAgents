"""Tenant context.

Every tenant-scoped operation reads the tenant from a context variable rather
than taking it as an argument, so a missing tenant is a loud failure instead of
a silent cross-tenant read. This is the service-layer half of tenant isolation;
the database half is row-level security (PostgreSQL only, DECISIONS.md D-002).
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from uuid import UUID

from .errors import MissingTenantContext, TenantMismatch

_tenant_id: ContextVar[UUID | None] = ContextVar("gravai_tenant_id", default=None)
_actor_id: ContextVar[str | None] = ContextVar("gravai_actor_id", default=None)
_correlation_id: ContextVar[str | None] = ContextVar("gravai_correlation_id", default=None)


def current_tenant_id() -> UUID | None:
    """The tenant bound to this context, if any."""
    return _tenant_id.get()


def require_tenant_id() -> UUID:
    """The tenant bound to this context, or raise.

    Call this from any code path that touches tenant-scoped data.
    """
    tenant = _tenant_id.get()
    if tenant is None:
        raise MissingTenantContext(
            "No tenant bound to the current context. Wrap the operation in "
            "tenant_scope(tenant_id) or resolve a principal first."
        )
    return tenant


def current_actor_id() -> str | None:
    """The user, agent or MCP client acting in this context."""
    return _actor_id.get()


def current_correlation_id() -> str | None:
    """Request/run correlation id, surfaced to users in error messages."""
    return _correlation_id.get()


def assert_same_tenant(row_tenant_id: UUID, *, entity: str = "row") -> None:
    """Guard a row against the bound tenant.

    A mismatch is a security event: it means a query escaped its tenant filter.
    """
    bound = require_tenant_id()
    if row_tenant_id != bound:
        raise TenantMismatch(
            f"{entity} belongs to another tenant",
            bound_tenant=str(bound),
            row_tenant=str(row_tenant_id),
        )


@contextmanager
def tenant_scope(
    tenant_id: UUID | str,
    *,
    actor_id: str | None = None,
    correlation_id: str | None = None,
) -> Iterator[UUID]:
    """Bind a tenant (and optionally an actor) for the duration of the block."""
    resolved = UUID(str(tenant_id)) if not isinstance(tenant_id, UUID) else tenant_id
    tenant_token = _tenant_id.set(resolved)
    actor_token = _actor_id.set(actor_id)
    correlation_token = _correlation_id.set(correlation_id)
    try:
        yield resolved
    finally:
        _tenant_id.reset(tenant_token)
        _actor_id.reset(actor_token)
        _correlation_id.reset(correlation_token)


@contextmanager
def no_tenant() -> Iterator[None]:
    """Explicitly clear the tenant, for platform-admin operations.

    Being explicit keeps "no tenant" from ever being an accident.
    """
    token = _tenant_id.set(None)
    try:
        yield
    finally:
        _tenant_id.reset(token)
