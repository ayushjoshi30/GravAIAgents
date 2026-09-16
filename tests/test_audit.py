"""The audit hash chain.

These are the tests that make the audit log evidence rather than a list: an
altered, removed or reordered row must be detectable, and must be located.
"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID, uuid4

from gravai_core.audit import (
    GENESIS_HASH,
    AuditActions,
    AuditEntry,
    canonical_json,
    canonical_timestamp,
    verify_chain,
)
from gravai_core.models import AuditLog
from gravai_core.repositories import AuditRepository
from gravai_core.tenancy import tenant_scope
from gravai_core.time_utils import utc_now
from sqlalchemy import update


def test_canonical_json_is_order_independent() -> None:
    """Hashes must not depend on dict insertion order."""
    assert canonical_json({"b": 1, "a": 2}) == canonical_json({"a": 2, "b": 1})


def test_canonical_json_has_no_incidental_whitespace() -> None:
    assert canonical_json({"a": 1}) == '{"a":1}'


def test_timestamp_hashing_survives_a_storage_round_trip() -> None:
    """A naive UTC value must hash identically to the aware one it came from.

    PostgreSQL returns an aware datetime and SQLite a naive one. Hashing
    ``isoformat()`` directly made every chain fail verification after a reload,
    because the stored and recomputed digests disagreed about the timezone.
    """
    aware = datetime(2026, 9, 14, 10, 30, 45, 123456, tzinfo=UTC)
    naive = aware.replace(tzinfo=None)
    assert canonical_timestamp(aware) == canonical_timestamp(naive)


def test_timestamp_hashing_normalises_other_timezones() -> None:
    from gravai_core.time_utils import IST

    aware_utc = datetime(2026, 9, 14, 5, 0, 0, tzinfo=UTC)
    same_moment_ist = aware_utc.astimezone(IST)
    assert canonical_timestamp(aware_utc) == canonical_timestamp(same_moment_ist)


def test_entry_hash_survives_a_naive_recorded_at() -> None:
    """The same failure, asserted at the level the verifier actually uses."""
    tenant = uuid4()
    aware = datetime(2026, 9, 14, 10, 30, 45, 123456, tzinfo=UTC)

    def build(moment: datetime) -> AuditEntry:
        return AuditEntry(
            tenant_id=tenant,
            seq=1,
            action="x",
            actor_type="user",
            actor_id="u",
            entity_type="e",
            entity_id="1",
            payload={"k": "v"},
            recorded_at=moment,
        )

    assert build(aware).compute_hash(GENESIS_HASH) == build(
        aware.replace(tzinfo=None)
    ).compute_hash(GENESIS_HASH)


def test_entry_hash_is_deterministic() -> None:
    moment = utc_now()
    tenant = uuid4()
    entry = AuditEntry(
        tenant_id=tenant,
        seq=1,
        action="x",
        actor_type="user",
        actor_id="u",
        entity_type="e",
        entity_id="1",
        payload={"k": "v"},
        recorded_at=moment,
    )
    assert entry.compute_hash(GENESIS_HASH) == entry.compute_hash(GENESIS_HASH)


def test_entry_hash_changes_when_payload_changes() -> None:
    moment = utc_now()
    tenant = uuid4()

    def build(payload: dict[str, str]) -> AuditEntry:
        return AuditEntry(
            tenant_id=tenant,
            seq=1,
            action="x",
            actor_type="user",
            actor_id="u",
            entity_type="e",
            entity_id="1",
            payload=payload,
            recorded_at=moment,
        )

    assert build({"k": "v"}).compute_hash(GENESIS_HASH) != build({"k": "w"}).compute_hash(
        GENESIS_HASH
    )


async def test_appending_builds_a_valid_chain(db_session, make_tenant, tenant_a: UUID) -> None:  # type: ignore[no-untyped-def]
    """Three appends produce a chain that verifies."""
    await make_tenant(tenant_a)
    repo = AuditRepository(db_session)

    with tenant_scope(tenant_a, actor_id="priya"):
        for index in range(3):
            await repo.append(
                action=AuditActions.APPLICATION_RECEIVED,
                entity_type="application",
                entity_id=f"app-{index}",
                payload={"index": index},
            )
        await db_session.commit()

        entries = await repo.list_entries()
        assert [e.seq for e in entries] == [1, 2, 3]
        assert entries[0].prev_hash == GENESIS_HASH
        assert entries[1].prev_hash == entries[0].hash
        assert entries[2].prev_hash == entries[1].hash

        result = await repo.verify()
        assert result.ok is True
        assert result.checked == 3


async def test_chain_records_the_actor(db_session, make_tenant, tenant_a: UUID) -> None:  # type: ignore[no-untyped-def]
    await make_tenant(tenant_a)
    repo = AuditRepository(db_session)
    with tenant_scope(tenant_a, actor_id="priya", correlation_id="corr-1"):
        row = await repo.append(
            action=AuditActions.DECISION_APPROVED,
            entity_type="application",
            entity_id="app-1",
        )
        await db_session.commit()
    assert row.actor_id == "priya"
    assert row.correlation_id == "corr-1"


async def test_tampering_with_a_payload_is_detected(  # type: ignore[no-untyped-def]
    db_session, make_tenant, tenant_a: UUID
) -> None:
    """Editing a row after the fact breaks the chain and is located."""
    await make_tenant(tenant_a)
    repo = AuditRepository(db_session)

    with tenant_scope(tenant_a, actor_id="priya"):
        for index in range(3):
            await repo.append(
                action=AuditActions.AGENT_STEP_RECORDED,
                entity_type="run",
                entity_id=f"run-{index}",
                payload={"index": index},
            )
        await db_session.commit()

        # Rewrite the middle entry's payload, leaving its stored hash untouched -
        # exactly what an attacker with database access would attempt.
        await db_session.execute(
            update(AuditLog)
            .where(AuditLog.tenant_id == tenant_a, AuditLog.seq == 2)
            .values(payload={"index": 999})
        )
        await db_session.commit()

        result = await repo.verify()
        assert result.ok is False
        assert result.first_bad_seq == 2
        assert result.reason is not None
        assert "altered" in result.reason


def test_a_missing_row_is_detected_as_a_sequence_gap() -> None:
    """Deleting a row leaves a hole the verifier reports."""

    class Row:
        def __init__(self, seq: int) -> None:
            moment = utc_now()
            self.tenant_id = uuid4()
            self.seq = seq
            self.action = "x"
            self.actor_type = "user"
            self.actor_id = "u"
            self.entity_type = "e"
            self.entity_id = str(seq)
            self.payload: dict[str, int] = {}
            self.recorded_at = moment
            self.correlation_id = None
            self.prev_hash = GENESIS_HASH
            self.hash = ""

    first, third = Row(1), Row(3)
    entry = AuditEntry(
        tenant_id=first.tenant_id,
        seq=1,
        action=first.action,
        actor_type=first.actor_type,
        actor_id=first.actor_id,
        entity_type=first.entity_type,
        entity_id=first.entity_id,
        payload={},
        recorded_at=first.recorded_at,
    )
    first.hash = entry.compute_hash(GENESIS_HASH)
    third.prev_hash = first.hash

    result = verify_chain([first, third])
    assert result.ok is False
    assert result.first_bad_seq == 3
    assert result.reason is not None
    assert "gap" in result.reason


async def test_chains_are_independent_per_tenant(  # type: ignore[no-untyped-def]
    db_session, make_tenant, tenant_a: UUID, tenant_b: UUID
) -> None:
    """Each tenant's sequence starts at 1 and does not interleave (D-008)."""
    await make_tenant(tenant_a)
    await make_tenant(tenant_b)
    repo = AuditRepository(db_session)

    with tenant_scope(tenant_a, actor_id="a"):
        await repo.append(action="x", entity_type="e", entity_id="1")
        await repo.append(action="x", entity_type="e", entity_id="2")
    with tenant_scope(tenant_b, actor_id="b"):
        await repo.append(action="x", entity_type="e", entity_id="1")
    await db_session.commit()

    with tenant_scope(tenant_a):
        a_entries = await repo.list_entries()
        assert [e.seq for e in a_entries] == [1, 2]
        assert (await repo.verify()).ok is True

    with tenant_scope(tenant_b):
        b_entries = await repo.list_entries()
        assert [e.seq for e in b_entries] == [1]
        assert (await repo.verify()).ok is True
