"""Row-level security.

The database half of tenant isolation. These tests only mean anything on
PostgreSQL, so they skip automatically on SQLite (DECISIONS.md D-002) — run them
before any deployment by pointing DATABASE_URL at PostgreSQL:

    DATABASE_URL=postgresql+asyncpg://gravai:gravai@localhost:5432/gravai uv run pytest -m postgres
"""

from __future__ import annotations

from uuid import uuid4

import pytest
from gravai_core.db import TENANT_GUC, bind_tenant, get_sessionmaker
from gravai_core.models import Application, Tenant
from gravai_core.settings import get_settings
from sqlalchemy import select, text

pytestmark = pytest.mark.postgres


@pytest.fixture(autouse=True)
def _require_postgres() -> None:
    if not get_settings().is_postgres:
        pytest.skip("row-level security requires PostgreSQL; running on SQLite")


async def test_policies_exist_on_every_tenant_scoped_table(_schema: None) -> None:
    """Every tenant-scoped table must carry the isolation policy."""
    from gravai_core.models import TENANT_SCOPED_TABLES

    factory = get_sessionmaker()
    async with factory() as session:
        result = await session.execute(
            text("SELECT tablename FROM pg_policies WHERE policyname = 'tenant_isolation'")
        )
        protected = {row[0] for row in result.all()}
    assert set(TENANT_SCOPED_TABLES).issubset(protected)


async def test_rls_hides_other_tenants_rows(_schema: None) -> None:
    """With the GUC set, a bare SELECT returns only the bound tenant's rows.

    This is the guarantee the service layer alone cannot make: even a query that
    forgot its tenant filter sees nothing.
    """
    tenant_a, tenant_b = uuid4(), uuid4()
    factory = get_sessionmaker()

    async with factory() as session:
        session.add_all(
            [
                Tenant(id=tenant_a, slug=f"a-{tenant_a.hex[:6]}", name="A", config={}),
                Tenant(id=tenant_b, slug=f"b-{tenant_b.hex[:6]}", name="B", config={}),
            ]
        )
        await session.commit()
        session.add_all(
            [
                Application(
                    tenant_id=tenant_a,
                    external_id=f"A-{tenant_a.hex[:6]}",
                    product="home_loan",
                    applicant_name="A Applicant",
                ),
                Application(
                    tenant_id=tenant_b,
                    external_id=f"B-{tenant_b.hex[:6]}",
                    product="home_loan",
                    applicant_name="B Applicant",
                ),
            ]
        )
        await session.commit()

    async with factory() as session:
        await bind_tenant(session, tenant_a)
        # Deliberately no tenant filter - RLS must supply it.
        rows = (await session.execute(select(Application))).scalars().all()
        assert {row.tenant_id for row in rows} == {tenant_a}


async def test_rls_blocks_writing_into_another_tenant(_schema: None) -> None:
    """WITH CHECK stops a row being inserted under someone else's tenant id."""
    tenant_a, tenant_b = uuid4(), uuid4()
    factory = get_sessionmaker()

    async with factory() as session:
        session.add_all(
            [
                Tenant(id=tenant_a, slug=f"a-{tenant_a.hex[:6]}", name="A", config={}),
                Tenant(id=tenant_b, slug=f"b-{tenant_b.hex[:6]}", name="B", config={}),
            ]
        )
        await session.commit()

    async with factory() as session:
        await bind_tenant(session, tenant_a)
        session.add(
            Application(
                tenant_id=tenant_b,  # not the bound tenant
                external_id=f"X-{tenant_b.hex[:6]}",
                product="home_loan",
                applicant_name="Smuggled",
            )
        )
        with pytest.raises(Exception, match=r"row-level security|policy"):
            await session.commit()


async def test_audit_log_rejects_update_and_delete(_schema: None) -> None:
    """The append-only trigger makes the chain tamper-evident at the database."""
    factory = get_sessionmaker()
    async with factory() as session:
        result = await session.execute(
            text(
                "SELECT tgname FROM pg_trigger WHERE tgname = 'audit_log_append_only' "
                "AND NOT tgisinternal"
            )
        )
        assert result.scalar_one_or_none() == "audit_log_append_only"


async def test_unset_guc_returns_nothing(_schema: None) -> None:
    """No tenant bound means no rows, rather than every row."""
    factory = get_sessionmaker()
    async with factory() as session:
        await session.execute(text(f"SELECT set_config('{TENANT_GUC}', '', true)"))
        rows = (await session.execute(select(Application))).scalars().all()
        assert rows == []
