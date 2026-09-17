"""Persistence model.

Types are deliberately dialect-portable (``Uuid``, ``JSON``, ``Numeric``) so the
identical schema runs on SQLite locally and PostgreSQL in production
(DECISIONS.md D-002). PostgreSQL additionally enforces row-level security; the
baseline migration attaches those policies to every table carrying
``TenantScopedMixin``.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

from .audit import GENESIS_HASH
from .time_utils import utc_now


class Base(DeclarativeBase):
    """Declarative base with portable type defaults."""

    type_annotation_map = {
        dict[str, Any]: JSON,
        list[str]: JSON,
        Decimal: Numeric(18, 2),
    }


def _uuid_pk() -> Mapped[UUID]:
    return mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid4)


class TimestampMixin:
    """Created/updated stamps, written in UTC."""

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=utc_now, nullable=False
    )


class TenantScopedMixin:
    """Marks a table as tenant-scoped.

    The baseline migration enables RLS on every table with this mixin, and the
    service layer refuses to query one without a bound tenant.
    """

    tenant_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("tenant.id", ondelete="CASCADE"), nullable=False, index=True
    )


# --- Tenancy and identity -------------------------------------------------


class Tenant(Base, TimestampMixin):
    """A lender using the platform."""

    __tablename__ = "tenant"

    id: Mapped[UUID] = _uuid_pk()
    slug: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    #: Per-tenant configuration: languages, calling window, budgets, automation
    #: flags, connector endpoints. Kept as JSON so onboarding a tenant needs no
    #: migration; validated by a Pydantic model on read.
    config: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)

    users: Mapped[list[AppUser]] = relationship(
        back_populates="tenant", cascade="all, delete-orphan"
    )

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<Tenant {self.slug}>"


class Role(Base, TimestampMixin):
    """A named role. Seeded from gravai_core.auth.Role."""

    __tablename__ = "role"

    id: Mapped[UUID] = _uuid_pk()
    name: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)


class AppUser(Base, TimestampMixin, TenantScopedMixin):
    """A human user, federated from the tenant's identity provider."""

    __tablename__ = "app_user"
    __table_args__ = (UniqueConstraint("tenant_id", "email", name="uq_app_user_tenant_email"),)

    id: Mapped[UUID] = _uuid_pk()
    email: Mapped[str] = mapped_column(String(320), nullable=False)
    full_name: Mapped[str] = mapped_column(String(200), nullable=False)
    subject: Mapped[str | None] = mapped_column(String(200), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    tenant: Mapped[Tenant] = relationship(back_populates="users")
    roles: Mapped[list[UserRole]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )


class UserRole(Base, TimestampMixin, TenantScopedMixin):
    """Assignment of a role to a user within a tenant."""

    __tablename__ = "user_role"
    __table_args__ = (UniqueConstraint("user_id", "role_id", name="uq_user_role"),)

    id: Mapped[UUID] = _uuid_pk()
    user_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("app_user.id", ondelete="CASCADE"), nullable=False
    )
    role_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("role.id", ondelete="CASCADE"), nullable=False
    )

    user: Mapped[AppUser] = relationship(back_populates="roles")
    role: Mapped[Role] = relationship()


class ApiKey(Base, TimestampMixin, TenantScopedMixin):
    """A tenant API key or registered MCP client.

    Only the hash is stored; the plaintext is shown once at creation.
    """

    __tablename__ = "api_key"

    id: Mapped[UUID] = _uuid_pk()
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    key_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    prefix: Mapped[str] = mapped_column(String(12), nullable=False)
    kind: Mapped[str] = mapped_column(String(20), default="api", nullable=False)
    scopes: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


# --- Commercial -----------------------------------------------------------


class RateCard(Base, TimestampMixin):
    """Versioned, effective-dated Sarvam pricing.

    Rates are never hardcoded: the cost ledger references a rate card version so
    a price change re-prices future calls without rewriting history.
    """

    __tablename__ = "rate_card"
    __table_args__ = (
        UniqueConstraint("version", "product", "unit", name="uq_rate_card_version_product"),
    )

    id: Mapped[UUID] = _uuid_pk()
    version: Mapped[str] = mapped_column(String(40), nullable=False)
    product: Mapped[str] = mapped_column(String(60), nullable=False)
    unit: Mapped[str] = mapped_column(String(30), nullable=False)
    rate_inr: Mapped[Decimal] = mapped_column(Numeric(18, 6), nullable=False)
    effective_from: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    source: Mapped[str] = mapped_column(Text, nullable=False)
    notes: Mapped[str] = mapped_column(Text, default="", nullable=False)


# --- Lending --------------------------------------------------------------


class Application(Base, TimestampMixin, TenantScopedMixin):
    """A loan application, mirrored from Graviton.

    GravAI holds a projection, not the system of record: Graviton remains
    authoritative for status transitions.
    """

    __tablename__ = "application"
    __table_args__ = (
        UniqueConstraint("tenant_id", "external_id", name="uq_application_tenant_external"),
        Index("ix_application_tenant_status", "tenant_id", "status"),
    )

    id: Mapped[UUID] = _uuid_pk()
    external_id: Mapped[str] = mapped_column(String(64), nullable=False)
    product: Mapped[str] = mapped_column(String(60), nullable=False)
    status: Mapped[str] = mapped_column(String(40), default="received", nullable=False)

    applicant_name: Mapped[str] = mapped_column(String(200), nullable=False)
    applicant_mobile_masked: Mapped[str] = mapped_column(String(20), default="", nullable=False)
    aadhaar_last4: Mapped[str | None] = mapped_column(String(4), nullable=True)
    pan: Mapped[str | None] = mapped_column(String(10), nullable=True)

    loan_amount: Mapped[Decimal | None] = mapped_column(Numeric(18, 2), nullable=True)
    tenure_months: Mapped[int | None] = mapped_column(Integer, nullable=True)
    interest_rate_pct: Mapped[Decimal | None] = mapped_column(Numeric(6, 3), nullable=True)
    collateral_value: Mapped[Decimal | None] = mapped_column(Numeric(18, 2), nullable=True)

    net_monthly_income: Mapped[Decimal | None] = mapped_column(Numeric(18, 2), nullable=True)
    existing_monthly_emi: Mapped[Decimal | None] = mapped_column(Numeric(18, 2), nullable=True)

    document_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    extra: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<Application {self.external_id} {self.status}>"


# --- Documents ------------------------------------------------------------


class Document(Base, TenantScopedMixin):
    """A file a tenant uploaded, and the only thing a document id resolves to.

    The upload endpoint has always scanned a file, stored it and handed back an
    id. Without this table that id named nothing: the bytes were in the bucket
    and the audit log recorded that they had arrived, but an audit entry is a
    record of what happened rather than somewhere to look one up, so nothing
    could turn the id back into a document. This row is what makes the id
    usable — a run names it and the platform resolves it here.

    Tenant-scoped for the reason everything else in this file is, only more so.
    A document id is a bearer of nothing: holding one says nothing about being
    allowed to read what it names, so every path that resolves one filters on
    the tenant. The blob keys are random and already carry the tenant in their
    prefix; that is defence in depth, not the check. The check is the
    ``tenant_id`` predicate in the query, because one lender reading another's
    bureau report is the worst outcome this platform can produce.

    No ``updated_at``. The row describes bytes that cannot change: the object is
    written once, under a key nothing will ever be written to twice, and the
    digest below is what proves the two still agree. A field implying the row
    gets edited would be describing something that does not happen.
    """

    __tablename__ = "document"
    __table_args__ = (
        # Resolving an id is a primary-key lookup with a tenant predicate, and
        # the primary key already serves it — there is no index to add for the
        # query this table exists for. This one is for the other question that
        # gets asked of it, "what did this applicant send us", which is the only
        # lookup here that reads more than one row.
        Index("ix_document_tenant_application", "tenant_id", "application_id"),
    )

    id: Mapped[UUID] = _uuid_pk()

    #: Optional because a file can arrive before anyone has decided which
    #: application it belongs to — the upload form offers the field and does not
    #: require it. SET NULL rather than CASCADE: the object outlives the
    #: application record, and a row that still resolves to real bytes is worth
    #: more than no row at all.
    application_id: Mapped[UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("application.id", ondelete="SET NULL"), nullable=True
    )

    #: A ``blob://bucket/key`` reference, never a URL. ``gravai_core.blobstore``
    #: refuses anything else, which is what stops a stored row from becoming a
    #: way to make the server fetch an address somebody chose.
    uri: Mapped[str] = mapped_column(String(500), nullable=False)
    #: Determined from the bytes at upload, not from what the client declared.
    mime_type: Mapped[str] = mapped_column(String(100), nullable=False)
    filename: Mapped[str] = mapped_column(String(200), nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    #: Null for anything that is not a PDF, and for a PDF whose count could not
    #: be read. The upload records what it counted and never a guess.
    pages: Mapped[int | None] = mapped_column(Integer, nullable=True)
    #: SHA-256 of the bytes that were scanned and stored, the same digest the
    #: audit entry carries. It is what lets a later reader prove the object it
    #: fetched is the object that was accepted.
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)

    #: When the object landed in the store. Named for the event rather than for
    #: the row, like ``AuditLog.recorded_at``, because that moment is the fact
    #: worth keeping: the row is only written once the write has happened.
    stored_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, nullable=False
    )

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<Document {self.filename} {self.mime_type}>"


# --- Audit ----------------------------------------------------------------


class AuditLog(Base, TenantScopedMixin):
    """Append-only, hash-chained record of everything that happened.

    Never updated or deleted. On PostgreSQL a trigger enforces that; on SQLite
    the repository layer is the only writer and refuses mutation.
    """

    __tablename__ = "audit_log"
    __table_args__ = (
        UniqueConstraint("tenant_id", "seq", name="uq_audit_tenant_seq"),
        Index("ix_audit_tenant_recorded", "tenant_id", "recorded_at"),
        Index("ix_audit_entity", "tenant_id", "entity_type", "entity_id"),
    )

    id: Mapped[UUID] = _uuid_pk()
    seq: Mapped[int] = mapped_column(Integer, nullable=False)

    action: Mapped[str] = mapped_column(String(80), nullable=False)
    actor_type: Mapped[str] = mapped_column(String(20), nullable=False)
    actor_id: Mapped[str] = mapped_column(String(200), nullable=False)
    entity_type: Mapped[str] = mapped_column(String(60), nullable=False)
    entity_id: Mapped[str] = mapped_column(String(200), nullable=False)

    payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    correlation_id: Mapped[str | None] = mapped_column(String(64), nullable=True)

    prev_hash: Mapped[str] = mapped_column(String(64), default=GENESIS_HASH, nullable=False)
    hash: Mapped[str] = mapped_column(String(64), nullable=False)

    recorded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, nullable=False
    )


# --- Agent runs -----------------------------------------------------------


class AgentRun(Base, TimestampMixin, TenantScopedMixin):
    """One execution of one agent.

    The console's run list and the auditor's decision trail are both built from
    this table, so it carries the output and the validator verdict, not just a
    status.
    """

    __tablename__ = "agent_run"
    __table_args__ = (
        Index("ix_agent_run_tenant_agent", "tenant_id", "agent_id"),
        Index("ix_agent_run_tenant_status", "tenant_id", "status"),
        Index("ix_agent_run_application", "tenant_id", "application_id"),
    )

    id: Mapped[UUID] = _uuid_pk()
    agent_id: Mapped[str] = mapped_column(String(60), nullable=False)
    application_id: Mapped[UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("application.id", ondelete="SET NULL"), nullable=True
    )
    case_id: Mapped[str | None] = mapped_column(String(64), nullable=True)

    status: Mapped[str] = mapped_column(String(20), default="running", nullable=False)
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, nullable=False
    )
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    escalated: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    escalation_reason: Mapped[str | None] = mapped_column(Text, nullable=True)

    cost_inr: Mapped[Decimal] = mapped_column(Numeric(18, 4), default=Decimal("0"), nullable=False)
    sarvam_calls: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    #: The agent's validated output, exactly as produced.
    output: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    #: Guardrail verdict: ok, violations, warnings.
    validation: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)

    steps: Mapped[list[AgentStep]] = relationship(
        back_populates="run", cascade="all, delete-orphan", order_by="AgentStep.seq"
    )


class AgentStep(Base, TimestampMixin, TenantScopedMixin):
    """One model or tool interaction inside a run.

    Carries the prompt version and content digests rather than the raw prompt,
    so a run can be audited without the log itself becoming a store of customer
    data.
    """

    __tablename__ = "agent_step"
    __table_args__ = (UniqueConstraint("run_id", "seq", name="uq_agent_step_run_seq"),)

    id: Mapped[UUID] = _uuid_pk()
    run_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("agent_run.id", ondelete="CASCADE"), nullable=False
    )
    seq: Mapped[int] = mapped_column(Integer, nullable=False)

    name: Mapped[str] = mapped_column(String(120), nullable=False)
    kind: Mapped[str] = mapped_column(String(20), default="llm", nullable=False)
    model: Mapped[str | None] = mapped_column(String(80), nullable=True)
    prompt_version: Mapped[str | None] = mapped_column(String(40), nullable=True)

    input_digest: Mapped[str] = mapped_column(String(32), default="", nullable=False)
    output_digest: Mapped[str] = mapped_column(String(32), default="", nullable=False)

    input_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    pages: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    audio_seconds: Mapped[Decimal] = mapped_column(
        Numeric(12, 2), default=Decimal("0"), nullable=False
    )
    latency_ms: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    cost_inr: Mapped[Decimal] = mapped_column(Numeric(18, 4), default=Decimal("0"), nullable=False)
    attempts: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    estimated_usage: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    validation: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)

    run: Mapped[AgentRun] = relationship(back_populates="steps")


class CostLedger(Base, TenantScopedMixin):
    """Every billable interaction, priced against a rate-card version.

    This is what reproduces the monthly volume model: calls per endpoint, pages,
    tokens, audio seconds and rupees, sliced by tenant and agent. Sandbox rows
    are marked so they can never be mixed into a real figure.
    """

    __tablename__ = "cost_ledger"
    __table_args__ = (
        Index("ix_cost_ledger_tenant_created", "tenant_id", "created_at"),
        Index("ix_cost_ledger_tenant_product", "tenant_id", "product"),
    )

    id: Mapped[UUID] = _uuid_pk()
    run_id: Mapped[UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("agent_run.id", ondelete="SET NULL"), nullable=True
    )
    agent_id: Mapped[str | None] = mapped_column(String(60), nullable=True)

    product: Mapped[str] = mapped_column(String(40), nullable=False)
    endpoint: Mapped[str] = mapped_column(String(120), default="", nullable=False)
    model: Mapped[str | None] = mapped_column(String(80), nullable=True)

    input_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    pages: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    audio_seconds: Mapped[Decimal] = mapped_column(
        Numeric(12, 2), default=Decimal("0"), nullable=False
    )
    characters: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    rate_card_version: Mapped[str] = mapped_column(String(60), default="", nullable=False)
    cost_inr: Mapped[Decimal] = mapped_column(Numeric(18, 6), default=Decimal("0"), nullable=False)
    latency_ms: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="ok", nullable=False)
    sandbox: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, nullable=False
    )


class Task(Base, TimestampMixin, TenantScopedMixin):
    """Work waiting on a human: an escalation, a deviation, an approval.

    Every agent escalation lands here. Nothing in the platform decides a credit
    outcome without one of these being resolved by a person.
    """

    __tablename__ = "task"
    __table_args__ = (
        Index("ix_task_tenant_status", "tenant_id", "status"),
        Index("ix_task_tenant_kind", "tenant_id", "kind"),
    )

    id: Mapped[UUID] = _uuid_pk()
    kind: Mapped[str] = mapped_column(String(40), nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    detail: Mapped[str] = mapped_column(Text, default="", nullable=False)

    application_id: Mapped[UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("application.id", ondelete="CASCADE"), nullable=True
    )
    run_id: Mapped[UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("agent_run.id", ondelete="SET NULL"), nullable=True
    )

    status: Mapped[str] = mapped_column(String(20), default="open", nullable=False)
    severity: Mapped[str] = mapped_column(String(10), default="medium", nullable=False)
    required_role: Mapped[str | None] = mapped_column(String(40), nullable=True)
    assigned_to: Mapped[str | None] = mapped_column(String(200), nullable=True)

    due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    resolved_by: Mapped[str | None] = mapped_column(String(200), nullable=True)
    resolution: Mapped[str | None] = mapped_column(String(20), nullable=True)
    resolution_note: Mapped[str | None] = mapped_column(Text, nullable=True)

    evidence: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)


class PromptVersion(Base, TimestampMixin):
    """A versioned agent prompt.

    Promotion is gated on evals. Runs record which version produced them, so a
    regression can be traced to the prompt that caused it and rolled back.
    """

    __tablename__ = "prompt_version"
    __table_args__ = (UniqueConstraint("agent_id", "version", name="uq_prompt_agent_version"),)

    id: Mapped[UUID] = _uuid_pk()
    agent_id: Mapped[str] = mapped_column(String(60), nullable=False)
    version: Mapped[str] = mapped_column(String(40), nullable=False)
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    promoted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    eval_summary: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)


class Consent(Base, TimestampMixin, TenantScopedMixin):
    """A consent artefact, with its purpose and expiry.

    Required by both the Account Aggregator framework and the DPDP Act. Purpose
    limitation is enforced against this row, not against a developer's memory of
    why the data was collected.
    """

    __tablename__ = "consent"
    __table_args__ = (Index("ix_consent_tenant_subject", "tenant_id", "subject_ref"),)

    id: Mapped[UUID] = _uuid_pk()
    subject_ref: Mapped[str] = mapped_column(String(120), nullable=False)
    application_id: Mapped[UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("application.id", ondelete="CASCADE"), nullable=True
    )

    source: Mapped[str] = mapped_column(String(40), nullable=False)
    purpose: Mapped[str] = mapped_column(String(120), nullable=False)
    purpose_code: Mapped[str | None] = mapped_column(String(20), nullable=True)
    artefact_id: Mapped[str | None] = mapped_column(String(120), nullable=True)
    artefact: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)

    granted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, nullable=False
    )
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    def is_active(self, at: datetime | None = None) -> bool:
        """Consent is active only while unrevoked and unexpired."""
        moment = at or utc_now()
        if self.revoked_at is not None and self.revoked_at <= moment:
            return False
        if self.expires_at is not None and self.expires_at <= moment:
            return False
        return self.granted_at <= moment


# --- Agent Studio ---------------------------------------------------------


class Workflow(Base, TimestampMixin, TenantScopedMixin):
    """A workflow as drawn on the canvas: the one editable draft.

    The draft is mutable by design — the canvas saves on every change — which is
    precisely why it is not the thing an integration calls. Running traffic goes
    to a ``WorkflowVersion``, so someone dragging a node about cannot alter what
    a live caller gets.

    The name is unique within a tenant because it is an address: the deployed
    agent is invoked by name, and two workflows answering to one name would make
    that call ambiguous at the worst possible moment.
    """

    __tablename__ = "workflow"
    __table_args__ = (
        UniqueConstraint("tenant_id", "name", name="uq_workflow_tenant_name"),
        Index("ix_workflow_tenant_updated", "tenant_id", "updated_at"),
    )

    id: Mapped[UUID] = _uuid_pk()
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)

    #: Nodes, edges and their configuration — whatever the canvas saved. Kept as
    #: JSON rather than as rows per node: the shape is the engine's contract and
    #: it changes with the node library, so modelling it in tables would mean a
    #: migration every time a node gains a setting.
    definition: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<Workflow {self.name}>"


class WorkflowVersion(Base, TenantScopedMixin):
    """A frozen snapshot of a workflow, and the only thing that can be deployed.

    A deployed version is immutable. Editing one in place would change the
    behaviour of a running integration underneath it: the caller would keep
    sending the same request to the same name and start getting answers produced
    by a graph they never saw, with no record that anything had changed. So a
    change means a new version and a fresh deployment, and the previous version
    is retired rather than overwritten — which also leaves the old definition
    readable when someone asks why last Tuesday's run decided what it did.

    No ``updated_at``: a row that is not supposed to change should not carry a
    field implying it does.
    """

    __tablename__ = "workflow_version"
    __table_args__ = (
        UniqueConstraint("workflow_id", "version", name="uq_workflow_version_number"),
        Index("ix_workflow_version_tenant_status", "tenant_id", "status"),
    )

    id: Mapped[UUID] = _uuid_pk()
    workflow_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("workflow.id", ondelete="CASCADE"), nullable=False
    )
    version: Mapped[str] = mapped_column(String(20), nullable=False)

    definition: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)

    #: What this agent accepts and returns when called by name, derived from the
    #: graph's own Input and Output nodes rather than written out separately —
    #: two hand-maintained copies of a contract diverge.
    input_schema: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    output_schema: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)

    #: draft | deployed | retired. At most one deployed version per workflow;
    #: the router retires the incumbent in the same transaction as it promotes
    #: the successor, so there is no instant where a name resolves to two graphs.
    status: Mapped[str] = mapped_column(String(20), default="draft", nullable=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, nullable=False
    )
    created_by: Mapped[str | None] = mapped_column(String(200), nullable=True)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<WorkflowVersion {self.version} {self.status}>"


class WorkflowRun(Base, TimestampMixin, TenantScopedMixin):
    """One execution of a workflow, with the trace the studio replays.

    ``version_id`` is null for a test run from the canvas and set for a call to a
    deployed agent. Keeping both in one table is deliberate: the question a
    reader actually asks is "what did this workflow do", and splitting test runs
    from production runs would make that two queries and invite the assumption
    that only one of them counts.
    """

    __tablename__ = "workflow_run"
    __table_args__ = (
        Index("ix_workflow_run_tenant_started", "tenant_id", "started_at"),
        Index("ix_workflow_run_tenant_workflow", "tenant_id", "workflow_id"),
        Index("ix_workflow_run_tenant_status", "tenant_id", "status"),
    )

    id: Mapped[UUID] = _uuid_pk()
    workflow_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("workflow.id", ondelete="CASCADE"), nullable=False
    )
    version_id: Mapped[UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("workflow_version.id", ondelete="SET NULL"), nullable=True
    )

    #: completed | failed | awaiting_approval. A halt at an approval gate is a
    #: designed outcome, not a failure, and the status says so.
    status: Mapped[str] = mapped_column(String(30), default="completed", nullable=False)

    inputs: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    output: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)

    #: Per-node timeline, plus the state the nodes built and the warnings the run
    #: raised. An object rather than a bare list because a node list on its own
    #: cannot answer "where did that fact come from", which is the question the
    #: trace exists to answer.
    trace: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)

    duration_ms: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    input_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    cost_inr: Mapped[Decimal] = mapped_column(Numeric(18, 4), default=Decimal("0"), nullable=False)

    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, nullable=False
    )
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


#: Tables that carry a tenant_id and therefore get row-level security.
TENANT_SCOPED_TABLES: tuple[str, ...] = (
    "app_user",
    "user_role",
    "api_key",
    "application",
    "document",
    "audit_log",
    "agent_run",
    "agent_step",
    "cost_ledger",
    "task",
    "consent",
    "workflow",
    "workflow_version",
    "workflow_run",
)
