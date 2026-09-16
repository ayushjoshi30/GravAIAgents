"""Append-only, hash-chained audit log.

Every agent step, tool call, decision and human action is recorded. Each entry
carries the hash of its predecessor, so removing or editing a row breaks the
chain and verification reports exactly where.

The chain is **per tenant** (DECISIONS.md D-008): a global chain would serialise
writes across tenants and let one tenant infer another's activity volume.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

#: Predecessor hash of the first entry in any tenant's chain.
GENESIS_HASH = "0" * 64


def canonical_timestamp(value: datetime) -> str:
    """Render a timestamp identically however storage handed it back.

    A hash must survive a round-trip through the database, and databases do not
    agree about timezones: PostgreSQL ``timestamptz`` returns an aware datetime,
    while SQLite has no timezone type and returns a naive one. Hashing
    ``isoformat()`` directly therefore produced one digest on write and a
    different one on read, and every chain failed verification.

    Naive values are treated as UTC, which is what the platform always stores.
    """
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f") + "Z"


def _json_default(value: Any) -> str:
    if isinstance(value, datetime):
        return canonical_timestamp(value)
    if isinstance(value, UUID):
        return str(value)
    return str(value)


def canonical_json(payload: Any) -> str:
    """Deterministic JSON: sorted keys, no incidental whitespace.

    Hashes must be reproducible across processes and Python versions, so the
    serialisation cannot depend on dict insertion order or default spacing.
    """
    return json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        default=_json_default,
    )


@dataclass(frozen=True, slots=True)
class AuditEntry:
    """The hashable content of one audit record."""

    tenant_id: UUID
    seq: int
    action: str
    actor_type: str
    actor_id: str
    entity_type: str
    entity_id: str
    payload: dict[str, Any]
    recorded_at: datetime
    correlation_id: str | None = None

    def digest_source(self, prev_hash: str) -> str:
        """The exact string that gets hashed. Stable and inspectable."""
        return canonical_json(
            {
                "prev_hash": prev_hash,
                "tenant_id": str(self.tenant_id),
                "seq": self.seq,
                "action": self.action,
                "actor_type": self.actor_type,
                "actor_id": self.actor_id,
                "entity_type": self.entity_type,
                "entity_id": self.entity_id,
                "payload": self.payload,
                "recorded_at": canonical_timestamp(self.recorded_at),
                "correlation_id": self.correlation_id,
            }
        )

    def compute_hash(self, prev_hash: str) -> str:
        """SHA-256 over the canonical representation, chained to its predecessor."""
        return hashlib.sha256(self.digest_source(prev_hash).encode("utf-8")).hexdigest()


@dataclass(frozen=True, slots=True)
class ChainVerification:
    """Result of verifying a range of a tenant's audit chain."""

    ok: bool
    checked: int
    first_bad_seq: int | None = None
    reason: str | None = None

    def __bool__(self) -> bool:
        return self.ok


def verify_chain(
    rows: list[Any],
    *,
    expected_start_hash: str = GENESIS_HASH,
) -> ChainVerification:
    """Recompute a chain and report the first row that does not follow.

    ``rows`` must be ordered by ``seq`` ascending and expose ``tenant_id``,
    ``seq``, ``action``, ``actor_type``, ``actor_id``, ``entity_type``,
    ``entity_id``, ``payload``, ``recorded_at``, ``correlation_id``,
    ``prev_hash`` and ``hash``.
    """
    prev = expected_start_hash
    checked = 0
    previous_seq: int | None = None

    for row in rows:
        if previous_seq is not None and row.seq != previous_seq + 1:
            return ChainVerification(
                ok=False,
                checked=checked,
                first_bad_seq=row.seq,
                reason=f"sequence gap: {previous_seq} -> {row.seq} (a row is missing)",
            )
        if row.prev_hash != prev:
            return ChainVerification(
                ok=False,
                checked=checked,
                first_bad_seq=row.seq,
                reason="prev_hash does not match the previous row's hash",
            )

        entry = AuditEntry(
            tenant_id=row.tenant_id,
            seq=row.seq,
            action=row.action,
            actor_type=row.actor_type,
            actor_id=row.actor_id,
            entity_type=row.entity_type,
            entity_id=row.entity_id,
            payload=row.payload or {},
            recorded_at=row.recorded_at,
            correlation_id=row.correlation_id,
        )
        recomputed = entry.compute_hash(prev)
        if recomputed != row.hash:
            return ChainVerification(
                ok=False,
                checked=checked,
                first_bad_seq=row.seq,
                reason="row content was altered after it was written",
            )

        prev = row.hash
        previous_seq = row.seq
        checked += 1

    return ChainVerification(ok=True, checked=checked)


class AuditActions:
    """Canonical action names. Using constants keeps the log queryable."""

    APPLICATION_RECEIVED = "application.received"
    DOCUMENT_CLASSIFIED = "document.classified"
    EXTRACTION_COMPLETED = "extraction.completed"
    AGENT_RUN_STARTED = "agent_run.started"
    AGENT_RUN_COMPLETED = "agent_run.completed"
    AGENT_RUN_FAILED = "agent_run.failed"
    AGENT_STEP_RECORDED = "agent_step.recorded"
    SARVAM_CALL = "sarvam.call"
    MCP_TOOL_CALLED = "mcp.tool_called"
    CAM_PRODUCED = "cam.produced"
    DECISION_PENDING_REVIEW = "decision.pending_review"
    DECISION_APPROVED = "decision.approved"
    DECISION_REJECTED = "decision.rejected"
    DEVIATION_RAISED = "deviation.raised"
    RISK_SCORED = "risk.scored"
    CASE_ALLOCATED = "case.allocated"
    MANDATE_PLANNED = "mandate.planned"
    CALL_COMPLETED = "call.completed"
    CALL_FLAGGED = "call.flagged"
    PII_ACCESSED = "pii.accessed"
    TENANT_MISMATCH_BLOCKED = "security.tenant_mismatch_blocked"
    AUTH_FAILED = "security.auth_failed"
    CONSENT_RECORDED = "consent.recorded"
    CONSENT_EXPIRED = "consent.expired"
    DATA_EXPORTED = "data.exported"
    WORKFLOW_COMPILED = "workflow.compiled"
    #: Deploying is the moment a name starts resolving to different behaviour
    #: for every caller of it, so it is audited even though nothing ran.
    WORKFLOW_DEPLOYED = "workflow.deployed"
    #: Retiring takes an agent out of service, so every subsequent call by that
    #: name fails. A retirement caused by deploying a successor is already named
    #: in that deployment's own entry; this records one asked for on its own,
    #: which is the more consequential of the two because nothing replaces it.
    WORKFLOW_RETIRED = "workflow.retired"
