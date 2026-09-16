"""Tenant isolation at the service layer.

On SQLite this is the only guard; on PostgreSQL row-level security sits beneath
it as well (DECISIONS.md D-002). Both must hold, so these tests run everywhere
and the RLS tests in test_rls.py run when PostgreSQL is available.
"""

from __future__ import annotations

from decimal import Decimal
from uuid import UUID, uuid4

import pytest
from gravai_core.errors import MissingTenantContext, NotFound, TenantMismatch
from gravai_core.models import Application
from gravai_core.repositories import get_or_404, tenant_query
from gravai_core.tenancy import (
    assert_same_tenant,
    current_tenant_id,
    no_tenant,
    require_tenant_id,
    tenant_scope,
)


def test_require_tenant_raises_without_a_scope() -> None:
    """A tenant-scoped operation with no tenant bound must fail loudly."""
    with no_tenant(), pytest.raises(MissingTenantContext):
        require_tenant_id()


def test_tenant_scope_binds_and_restores() -> None:
    tenant = uuid4()
    with no_tenant():
        assert current_tenant_id() is None
        with tenant_scope(tenant):
            assert current_tenant_id() == tenant
        assert current_tenant_id() is None


def test_tenant_scope_nests() -> None:
    outer, inner = uuid4(), uuid4()
    with tenant_scope(outer):
        assert current_tenant_id() == outer
        with tenant_scope(inner):
            assert current_tenant_id() == inner
        assert current_tenant_id() == outer


def test_tenant_scope_accepts_a_string_id() -> None:
    tenant = uuid4()
    with tenant_scope(str(tenant)):
        assert current_tenant_id() == tenant


def test_assert_same_tenant_blocks_a_foreign_row() -> None:
    with tenant_scope(uuid4()), pytest.raises(TenantMismatch):
        assert_same_tenant(uuid4(), entity="application")


def test_tenant_query_without_a_scope_raises() -> None:
    """Building a query with no tenant bound is refused before it can run."""
    with no_tenant(), pytest.raises(MissingTenantContext):
        tenant_query(Application)


async def test_queries_only_return_the_bound_tenants_rows(  # type: ignore[no-untyped-def]
    db_session, make_tenant, tenant_a: UUID, tenant_b: UUID
) -> None:
    await make_tenant(tenant_a)
    await make_tenant(tenant_b)

    db_session.add_all(
        [
            Application(
                tenant_id=tenant_a,
                external_id="A-1",
                product="home_loan",
                applicant_name="Tenant A Applicant",
                loan_amount=Decimal("1000000.00"),
            ),
            Application(
                tenant_id=tenant_b,
                external_id="B-1",
                product="personal_loan",
                applicant_name="Tenant B Applicant",
                loan_amount=Decimal("500000.00"),
            ),
        ]
    )
    await db_session.commit()

    with tenant_scope(tenant_a):
        rows = (await db_session.execute(tenant_query(Application))).scalars().all()
        assert [row.external_id for row in rows] == ["A-1"]

    with tenant_scope(tenant_b):
        rows = (await db_session.execute(tenant_query(Application))).scalars().all()
        assert [row.external_id for row in rows] == ["B-1"]


async def test_fetching_another_tenants_row_reports_not_found(  # type: ignore[no-untyped-def]
    db_session, make_tenant, tenant_a: UUID, tenant_b: UUID
) -> None:
    """Reported as missing, never as forbidden.

    Telling a caller that an id exists but belongs to someone else is itself a
    leak of another tenant's data.
    """
    await make_tenant(tenant_a)
    await make_tenant(tenant_b)

    application = Application(
        tenant_id=tenant_a,
        external_id="A-SECRET",
        product="home_loan",
        applicant_name="Tenant A Applicant",
    )
    db_session.add(application)
    await db_session.commit()

    with tenant_scope(tenant_a):
        found = await get_or_404(db_session, Application, application.id)
        assert found.external_id == "A-SECRET"

    with tenant_scope(tenant_b), pytest.raises(NotFound):
        await get_or_404(db_session, Application, application.id)
