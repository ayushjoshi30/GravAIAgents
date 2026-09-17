"""Uploaded documents: the row a document id resolves to.

``POST /v1/documents`` has been scanning files, storing them and handing back an
id since it was written, and nothing could use that id — there was no table for
it to name. The only durable trace was the audit entry, which records that an
upload happened rather than offering somewhere to look one up. This revision
creates the table that closes the gap, so a run can name an uploaded document
and the platform can resolve it.

As with the previous revisions the table comes from the declarative metadata so
the model stays the single source of truth, and row-level security is applied
only on PostgreSQL. The policy is what makes the tenant check hold twice: the
router filters on the caller's tenant, and on PostgreSQL the database refuses to
return another tenant's row even to a query that forgot to.

Downgrading drops the table and nothing else, and no document is lost when it
does: the objects stay in the bucket under the keys they were written to, and
the audit entry recording each upload stays in ``audit_log``, untouched. What
goes is the ability to look an id up, which is exactly what this revision added.

Revision ID: 0004_documents
Revises: 0003_agent_studio
Create Date: 2026-09-16
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from gravai_core.models import Base

revision: str = "0004_documents"
down_revision: str | None = "0003_agent_studio"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TENANT_GUC = "gravai.tenant_id"

#: Added by this revision. Listed explicitly rather than diffed, so a future
#: model change cannot silently widen what this migration creates.
NEW_TABLES: tuple[str, ...] = ("document",)

#: Tenant-scoped, and not incidentally: the whole point of the table is that an
#: id resolves to a document belonging to one lender and to nobody else.
NEW_TENANT_SCOPED: tuple[str, ...] = NEW_TABLES


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def upgrade() -> None:
    bind = op.get_bind()
    tables = [Base.metadata.tables[name] for name in NEW_TABLES]
    Base.metadata.create_all(bind=bind, tables=tables)

    if not _is_postgres():
        return

    for table in NEW_TENANT_SCOPED:
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        # FORCE matters: without it the table owner bypasses the policy, which
        # is exactly the role the application connects as in most deployments.
        op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
        # Dropped before it is created for the same reason as in 0002 and 0003:
        # 0001 builds the whole schema from the live metadata and applies a
        # policy to every name in TENANT_SCOPED_TABLES, which now includes this
        # one. On a database built from scratch the policy is therefore already
        # there by the time this revision runs, and a bare CREATE POLICY would
        # abort the upgrade partway through. The definition below is
        # byte-for-byte the one 0001 would have created, so replacing it changes
        # nothing on a database that already has it.
        op.execute(f"DROP POLICY IF EXISTS tenant_isolation ON {table}")
        op.execute(
            f"""
            CREATE POLICY tenant_isolation ON {table}
            USING (tenant_id::text = current_setting('{TENANT_GUC}', true))
            WITH CHECK (tenant_id::text = current_setting('{TENANT_GUC}', true))
            """
        )


def downgrade() -> None:
    bind = op.get_bind()

    if _is_postgres():
        for table in NEW_TENANT_SCOPED:
            op.execute(f"DROP POLICY IF EXISTS tenant_isolation ON {table}")
            op.execute(f"ALTER TABLE {table} DISABLE ROW LEVEL SECURITY")

    # Only the table this revision created. ``application`` and ``tenant`` are
    # named by its foreign keys and predate it, and dropping a table because
    # something pointed at it is how a downgrade takes data with it.
    tables = [Base.metadata.tables[name] for name in reversed(NEW_TABLES)]
    Base.metadata.drop_all(bind=bind, tables=tables)


__all__ = ["down_revision", "downgrade", "revision", "sa", "upgrade"]
