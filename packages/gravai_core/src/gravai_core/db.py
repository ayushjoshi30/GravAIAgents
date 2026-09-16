"""Database engine and session management.

A session is always opened inside a tenant scope. On PostgreSQL the tenant is
also pushed into a session-local GUC so row-level security policies can see it;
on SQLite that step is a no-op and the service layer is the only guard
(DECISIONS.md D-002).
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from uuid import UUID

from sqlalchemy import event, text
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from .settings import Settings, get_settings
from .tenancy import current_tenant_id, tenant_scope

#: The GUC row-level security policies read.
TENANT_GUC = "gravai.tenant_id"

_engine: AsyncEngine | None = None
_sessionmaker: async_sessionmaker[AsyncSession] | None = None


def build_engine(settings: Settings | None = None) -> AsyncEngine:
    """Create an engine for the configured database."""
    cfg = settings or get_settings()
    kwargs: dict[str, object] = {"echo": False, "future": True}

    if cfg.is_sqlite:
        # SQLite has no pool worth tuning and needs foreign keys switched on
        # explicitly, per connection.
        engine = create_async_engine(cfg.database_url, **kwargs)

        @event.listens_for(engine.sync_engine, "connect")
        def _enable_sqlite_foreign_keys(dbapi_connection: object, _record: object) -> None:
            cursor = dbapi_connection.cursor()  # type: ignore[attr-defined]
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.close()

        return engine

    return create_async_engine(
        cfg.database_url,
        pool_size=10,
        max_overflow=20,
        pool_pre_ping=True,
        pool_recycle=1800,
        **kwargs,
    )


def get_engine(settings: Settings | None = None) -> AsyncEngine:
    """Process-wide engine singleton."""
    global _engine
    if _engine is None:
        _engine = build_engine(settings)
    return _engine


def get_sessionmaker(settings: Settings | None = None) -> async_sessionmaker[AsyncSession]:
    """Process-wide session factory."""
    global _sessionmaker
    if _sessionmaker is None:
        _sessionmaker = async_sessionmaker(
            bind=get_engine(settings),
            expire_on_commit=False,
            autoflush=False,
        )
    return _sessionmaker


async def bind_tenant(session: AsyncSession, tenant_id: UUID) -> None:
    """Push the tenant into the database session for RLS.

    ``set_config(..., true)`` scopes the setting to the current transaction, so
    it cannot leak to the next checkout of a pooled connection.
    """
    bind = session.get_bind()
    if bind.dialect.name != "postgresql":
        return
    await session.execute(
        text("SELECT set_config(:key, :value, true)"),
        {"key": TENANT_GUC, "value": str(tenant_id)},
    )


@asynccontextmanager
async def session_scope(
    tenant_id: UUID | str | None = None,
    *,
    settings: Settings | None = None,
    commit: bool = True,
) -> AsyncIterator[AsyncSession]:
    """Open a session bound to a tenant, committing on clean exit.

    Pass ``tenant_id`` explicitly, or rely on an enclosing ``tenant_scope``.
    """
    resolved: UUID | None
    if tenant_id is not None:
        resolved = UUID(str(tenant_id)) if not isinstance(tenant_id, UUID) else tenant_id
    else:
        resolved = current_tenant_id()

    factory = get_sessionmaker(settings)
    async with factory() as session:
        if resolved is not None:
            await bind_tenant(session, resolved)
        try:
            if resolved is not None and current_tenant_id() != resolved:
                with tenant_scope(resolved):
                    yield session
            else:
                yield session
            if commit:
                await session.commit()
        except Exception:
            await session.rollback()
            raise


@asynccontextmanager
async def admin_session_scope(
    settings: Settings | None = None, *, commit: bool = True
) -> AsyncIterator[AsyncSession]:
    """A session with no tenant bound, for migrations and platform admin.

    On PostgreSQL this still obeys RLS unless the connecting role holds
    ``BYPASSRLS``; the migration role does, application roles do not.
    """
    factory = get_sessionmaker(settings)
    async with factory() as session:
        try:
            yield session
            if commit:
                await session.commit()
        except Exception:
            await session.rollback()
            raise


async def dispose_engine() -> None:
    """Close pooled connections. Call on shutdown and between tests."""
    global _engine, _sessionmaker
    if _engine is not None:
        await _engine.dispose()
    _engine = None
    _sessionmaker = None


async def healthcheck(settings: Settings | None = None) -> bool:
    """Can we reach the database?"""
    try:
        engine = get_engine(settings)
        async with engine.connect() as connection:
            await connection.execute(text("SELECT 1"))
        return True
    except Exception:
        return False
