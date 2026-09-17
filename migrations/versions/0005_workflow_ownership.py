"""Workflows gain an owner and a delete that can be undone.

The Agent Studio has always listed every workflow in a tenant to everyone in
that tenant. That is the right answer for a deployed agent, which the whole
lender calls by name, and the wrong one for the "Your agents" page, which is a
person's own bench. This revision adds the two columns that tell those apart:
``owner_subject``, the ``sub`` claim of the token that created the workflow, and
``deleted_at``, which marks a workflow removed without removing it.

EXISTING ROWS HAVE NO OWNER, AND ARE NOT GIVEN ONE. There is no record of who
created a workflow written before this column existed, and the only candidates
are guesses: the tenant's first user, the last person to edit it, whoever runs
the migration. Every one of them would be a fabricated fact about authorship
written into a table that is read as authoritative, and one of them would
quietly hide the row from everybody else. So ``owner_subject`` is nullable and
stays NULL for every row this revision finds. A NULL owner reads as "built
before anyone claimed it", and the router shows such a row to its whole tenant,
exactly as it did the day before this ran. Nobody loses sight of their work
because the schema learned a new word.

Both columns are nullable for a second reason that matters at the moment of the
upgrade: the table is written to by an API that is still serving traffic while
this runs, and a NOT NULL column with no default would break every insert in
flight between the ALTER and the deploy that knows about it.

DOWNGRADING TAKES NO WORKFLOW WITH IT. It drops the index and the two columns
this revision added, and nothing else: every row, its name, its description and
its definition survive untouched, as do its versions and its runs. Two things do
change, and both are the honest consequence of removing a column rather than a
loss hidden inside one. Ownership is forgotten, because the column that recorded
it is gone and there is nowhere else it was ever kept. And a workflow that was
soft-deleted becomes visible again, because what disappears is the mark, not the
row — the alternative, hard-deleting the rows a user had marked deleted so that
the downgrade "looks right", would be a migration destroying data on the way
back, which is precisely what a downgrade must never do.

Revision ID: 0005_workflow_ownership
Revises: 0004_documents
Create Date: 2026-09-17
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0005_workflow_ownership"
down_revision: str | None = "0004_documents"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "workflow"

#: The list query on the "Your agents" page, in index form: one tenant, not
#: deleted, owned by the caller or by nobody, most recently edited first. The
#: column order is the query's own — the equality-ish filters first, so each of
#: the two owner values the OR asks for is a contiguous run already sorted by
#: ``updated_at``. It matches ``Workflow.__table_args__``; the definition is
#: written out here rather than read from the metadata for the same reason 0004
#: lists its tables explicitly, so a later model change cannot silently alter
#: what this revision created.
INDEX = "ix_workflow_tenant_live_owner_updated"
INDEX_COLUMNS = ("tenant_id", "deleted_at", "owner_subject", "updated_at")

#: Added by this revision, and the only things its downgrade may remove.
NEW_COLUMNS: tuple[str, ...] = ("owner_subject", "deleted_at")


def upgrade() -> None:
    # String(200) matches ``WorkflowVersion.created_by``, which holds the same
    # kind of value — a token subject — so the two agree about how long one can
    # be rather than each guessing separately.
    op.add_column(TABLE, sa.Column("owner_subject", sa.String(length=200), nullable=True))
    op.add_column(TABLE, sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))
    op.create_index(INDEX, TABLE, list(INDEX_COLUMNS))

    # No backfill, deliberately. See the note above: there is no record of who
    # owned these rows, and writing a plausible one would be inventing it.


def downgrade() -> None:
    # The index first: SQLite refuses to drop a column an index still names, and
    # on PostgreSQL dropping the column would take the index with it silently,
    # which leaves the two databases in states that only look the same.
    op.drop_index(INDEX, table_name=TABLE)
    for column in reversed(NEW_COLUMNS):
        op.drop_column(TABLE, column)


__all__ = ["down_revision", "downgrade", "revision", "sa", "upgrade"]
