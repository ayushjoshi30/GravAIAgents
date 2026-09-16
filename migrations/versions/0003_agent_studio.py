"""Agent Studio: workflows, their versions, and their runs.

Creates the three tables the studio needs to keep a draft, freeze it into
something deployable, and record what each execution did. As with the previous
revisions the tables come from the declarative metadata so the models stay the
single source of truth, and row-level security is applied only on PostgreSQL.

Nothing here enforces the immutability of a deployed version. That rule lives in
the router, because "immutable" here means "the product refuses to change a
version that traffic is pointed at", not "no row may ever be written" — a
version still has to move from draft to deployed to retired, which is a write.

Revision ID: 0003_agent_studio
Revises: 0002_runs_ledger_tasks
Create Date: 2026-09-15
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from gravai_core.models import Base

revision: str = "0003_agent_studio"
down_revision: str | None = "0002_runs_ledger_tasks"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TENANT_GUC = "gravai.tenant_id"

#: Added by this revision. Listed explicitly rather than diffed, so a future
#: model change cannot silently widen what this migration creates.
NEW_TABLES: tuple[str, ...] = (
    "workflow",
    "workflow_version",
    "workflow_run",
)

#: All three are tenant-scoped: a workflow is a lender's own automation, and its
#: runs carry that lender's applicants.
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
        # Dropped before it is created because 0001 builds the whole schema from
        # the live metadata and then applies a policy to every name in
        # TENANT_SCOPED_TABLES — which includes these three. On a database built
        # from scratch the policy therefore already exists by the time this
        # revision runs, and a bare CREATE POLICY would abort the upgrade partway
        # through, leaving the chain unapplicable on a new PostgreSQL. The
        # definition below is byte-for-byte the one 0001 would have created, so
        # replacing it changes nothing on a database that already has it.
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

    # Dropped children first: workflow_run references both of the others.
    tables = [Base.metadata.tables[name] for name in reversed(NEW_TABLES)]
    Base.metadata.drop_all(bind=bind, tables=tables)


__all__ = ["down_revision", "downgrade", "revision", "sa", "upgrade"]
