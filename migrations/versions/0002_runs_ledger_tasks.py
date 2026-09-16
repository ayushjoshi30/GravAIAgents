"""Agent runs, cost ledger, tasks, prompt versions and consent.

Creates the tables Phase 1 needs to record what agents did, what it cost, and
what a human still has to decide. As with the baseline, tables come from the
declarative metadata so the models stay the single source of truth; row-level
security and the append-only audit trigger are PostgreSQL-only and applied
conditionally.

Revision ID: 0002_runs_ledger_tasks
Revises: 0001_baseline
Create Date: 2026-09-14
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from gravai_core.models import Base

revision: str = "0002_runs_ledger_tasks"
down_revision: str | None = "0001_baseline"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TENANT_GUC = "gravai.tenant_id"

#: Added by this revision. Listed explicitly rather than diffed, so a future
#: model change cannot silently widen what this migration creates.
NEW_TABLES: tuple[str, ...] = (
    "agent_run",
    "agent_step",
    "cost_ledger",
    "task",
    "prompt_version",
    "consent",
)

#: Of those, the ones carrying a tenant_id. ``prompt_version`` is platform-wide:
#: a prompt belongs to an agent, not to a lender.
NEW_TENANT_SCOPED: tuple[str, ...] = (
    "agent_run",
    "agent_step",
    "cost_ledger",
    "task",
    "consent",
)


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
        # Dropped before it is created for the same reason as in 0003: 0001
        # builds the whole schema from the live metadata and applies a policy to
        # every name in TENANT_SCOPED_TABLES, these five among them, so on a
        # database built from scratch the policy is already there and a bare
        # CREATE POLICY would abort the upgrade. Fixing only the later revision
        # would change nothing, because the chain stops here first.
        op.execute(f"DROP POLICY IF EXISTS tenant_isolation ON {table}")
        op.execute(
            f"""
            CREATE POLICY tenant_isolation ON {table}
            USING (tenant_id::text = current_setting('{TENANT_GUC}', true))
            WITH CHECK (tenant_id::text = current_setting('{TENANT_GUC}', true))
            """
        )

    # The ledger is evidence for a commercial conversation and for an audit, so
    # it is append-only like the audit log.
    op.execute(
        """
        CREATE TRIGGER cost_ledger_append_only
        BEFORE UPDATE OR DELETE ON cost_ledger
        FOR EACH ROW EXECUTE FUNCTION gravai_audit_is_append_only();
        """
    )


def downgrade() -> None:
    bind = op.get_bind()

    if _is_postgres():
        op.execute("DROP TRIGGER IF EXISTS cost_ledger_append_only ON cost_ledger")
        for table in NEW_TENANT_SCOPED:
            op.execute(f"DROP POLICY IF EXISTS tenant_isolation ON {table}")
            op.execute(f"ALTER TABLE {table} DISABLE ROW LEVEL SECURITY")

    tables = [Base.metadata.tables[name] for name in NEW_TABLES]
    Base.metadata.drop_all(bind=bind, tables=tables)


__all__ = ["down_revision", "downgrade", "revision", "sa", "upgrade"]
