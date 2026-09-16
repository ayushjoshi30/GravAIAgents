"""Test configuration.

The environment is set before ``gravai_core.settings`` is first imported, so the
suite always runs against a throwaway SQLite database with SANDBOX forced on.
No test can reach Sarvam, and no test can touch a developer's real database.
"""

from __future__ import annotations

import os
import tempfile
from collections.abc import AsyncIterator
from pathlib import Path
from uuid import UUID, uuid4

import pytest

_TMP_DIR = Path(tempfile.mkdtemp(prefix="gravai-test-"))

os.environ["APP_ENV"] = "local"
os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{(_TMP_DIR / 'test.db').as_posix()}"
# At least 32 bytes: PyJWT warns below the RFC 7518 minimum for HS256.
os.environ["AUTH_DEV_SECRET"] = "gravai-test-secret-not-for-production-32b"
os.environ["OIDC_JWKS_URL"] = ""
os.environ["OIDC_ISSUER"] = ""
os.environ["OIDC_AUDIENCE"] = "gravai"
# Sandbox is pinned here, explicitly, rather than being inferred.
#
# Settings force sandbox when no key is present, and this file clears the key —
# which looks like enough and is not. An env var set to the empty string does
# not reliably shadow a value in `.env`, so once a developer put a real
# SARVAM_API_KEY and SARVAM_SANDBOX=0 in their own `.env`, the suite picked both
# up and started making live, billed calls to api.sarvam.ai. Four MCP tests
# failed with provider errors, which is the polite version of the failure; the
# rude version is a test run that passes and quietly costs money.
#
# A test suite must never be able to reach a paid API because of what is in
# somebody's local environment, so the flag is set here and not merely implied.
os.environ["SARVAM_API_KEY"] = ""
os.environ["SARVAM_SANDBOX"] = "1"
os.environ["LOG_LEVEL"] = "WARNING"

from gravai_core.db import get_engine, get_sessionmaker  # noqa: E402
from gravai_core.models import Base, Tenant  # noqa: E402
from gravai_core.settings import Settings, get_settings  # noqa: E402

get_settings.cache_clear()


@pytest.fixture(scope="session")
def settings() -> Settings:
    """The settings the suite runs under."""
    return get_settings()


@pytest.fixture
async def _schema() -> AsyncIterator[None]:
    """Ensure the schema exists. ``create_all`` is idempotent."""
    engine = get_engine()
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    yield


@pytest.fixture
async def db_session(_schema: None) -> AsyncIterator[object]:
    """A database session. Tests commit explicitly when they mean to."""
    factory = get_sessionmaker()
    async with factory() as session:
        yield session


@pytest.fixture
def tenant_a() -> UUID:
    """A unique tenant id per test, so tests never collide on shared rows."""
    return uuid4()


@pytest.fixture
def tenant_b() -> UUID:
    """A second tenant, for isolation tests."""
    return uuid4()


@pytest.fixture
async def make_tenant(db_session: object):  # type: ignore[no-untyped-def]
    """Insert a tenant row and return it, for tests that need the foreign key."""

    async def _make(tenant_id: UUID, slug: str | None = None) -> Tenant:
        tenant = Tenant(
            id=tenant_id,
            slug=slug or f"t-{tenant_id.hex[:8]}",
            name=f"Test Tenant {tenant_id.hex[:6]}",
            config={},
        )
        db_session.add(tenant)  # type: ignore[attr-defined]
        await db_session.commit()  # type: ignore[attr-defined]
        return tenant

    return _make
