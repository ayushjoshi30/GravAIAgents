"""The agent catalog — one source of truth.

The REST API, the MCP tool list, the console and the generated documentation all
read this, so an agent cannot exist in one surface and be missing from another.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum

from gravai_core.auth import Scope
from gravai_core.errors import NotFound


class AgentTier(StrEnum):
    """Build priority, matching the phase plan in GRAVAI_SPEC.md."""

    P0 = "P0"
    P1 = "P1"
    P2 = "P2"


@dataclass(frozen=True, slots=True)
class AgentSpec:
    """Everything the platform needs to know about an agent without loading it."""

    id: str
    name: str
    tier: AgentTier
    summary: str
    #: The MCP agents-as-tool name that invokes this agent.
    tool_name: str
    scopes: frozenset[Scope]
    #: Advisory agents never take an irreversible action on their own.
    advisory_only: bool = True
    #: Ignosis capability this achieves parity with, where one exists.
    parity_with: str | None = None
    tags: tuple[str, ...] = field(default=())


def _spec(
    id: str,
    name: str,
    tier: AgentTier,
    summary: str,
    tool_name: str,
    scopes: set[Scope],
    *,
    advisory_only: bool = True,
    parity_with: str | None = None,
    tags: tuple[str, ...] = (),
) -> AgentSpec:
    return AgentSpec(
        id=id,
        name=name,
        tier=tier,
        summary=summary,
        tool_name=tool_name,
        scopes=frozenset(scopes),
        advisory_only=advisory_only,
        parity_with=parity_with,
        tags=tags,
    )


AGENT_CATALOG: dict[str, AgentSpec] = {
    spec.id: spec
    for spec in (
        # --- P0: the credit core ---------------------------------------
        _spec(
            "doc_intelligence",
            "Document Intelligence Agent",
            AgentTier.P0,
            "Classifies every uploaded document, routes it to extract or digitise, "
            "and returns structured fields with a citation for each value.",
            "classify_documents",
            {Scope.DOCUMENTS_READ, Scope.DOCUMENTS_WRITE, Scope.AGENTS_RUN},
            parity_with="Document intelligence substrate under Bank Statement Analytics",
            tags=("documents", "extraction"),
        ),
        _spec(
            "bank_statement_analytics",
            "Bank Statement Analytics Agent",
            AgentTier.P0,
            "Turns 6-12 months of statements into income, obligations, bounces and "
            "balance behaviour, reconciled month by month.",
            "analyse_bank_statement",
            {Scope.DOCUMENTS_READ, Scope.AGENTS_RUN},
            parity_with="Bank Statement Analytics",
            tags=("credit", "income"),
        ),
        _spec(
            "credit_appraisal",
            "Credit Appraisal Agent",
            AgentTier.P0,
            "Produces the Credit Appraisal Memorandum: eligibility with FOIR and LTV, "
            "income build-up, cross-checks, deviation matrix, and a plain-language "
            "explanation of every BRE pass and fail.",
            "underwrite_application",
            {Scope.APPLICATIONS_READ, Scope.DOCUMENTS_READ, Scope.AGENTS_RUN},
            parity_with="Underwriting decisioning",
            tags=("credit", "decisioning"),
        ),
        # --- P1: risk, collections, voice, CX --------------------------
        _spec(
            "risk_scoring",
            "Risk Agent",
            AgentTier.P1,
            "Probability of 30+ DPD within 6 months, banded GREEN under 6%, AMBER "
            "6-15%, RED above 15%. The probability comes from a versioned scorecard, "
            "never from the language model.",
            "score_risk",
            {Scope.APPLICATIONS_READ, Scope.AGENTS_RUN},
            parity_with="Risk scoring feeding Case Allocation",
            tags=("risk", "scorecard"),
        ),
        _spec(
            "aa_data",
            "Account Aggregator Data Agent",
            AgentTier.P1,
            "Fetches consented bank data through the RBI Account Aggregator framework "
            "and normalises it into the same shape the statement analytics consumes — "
            "structured at source, with no document extraction at all.",
            "fetch_consented_data",
            {Scope.APPLICATIONS_READ, Scope.DOCUMENTS_READ, Scope.AGENTS_RUN},
            parity_with="AA Orchestration",
            tags=("aa", "data", "external_dependency"),
        ),
        _spec(
            "kyc_verification",
            "KYC & Identity Agent",
            AgentTier.P1,
            "Cross-checks identity across DigiLocker, CKYC and uploaded documents. "
            "Aadhaar is handled masked to the last four digits throughout.",
            "verify_kyc",
            {Scope.APPLICATIONS_READ, Scope.DOCUMENTS_READ, Scope.AGENTS_RUN},
            tags=("kyc", "identity"),
        ),
        _spec(
            "case_allocation",
            "Collections Case Allocation Agent",
            AgentTier.P1,
            "Ranks delinquent cases and routes the next best action to the right "
            "channel and queue, inside permitted calling hours.",
            "allocate_cases",
            {Scope.COLLECTIONS_READ, Scope.COLLECTIONS_WRITE, Scope.AGENTS_RUN},
            parity_with="Case Allocation",
            tags=("collections",),
        ),
        _spec(
            "smart_mandate",
            "Smart Mandate Agent",
            AgentTier.P1,
            "Picks the right customer, amount and date to present an e-NACH or UPI "
            "AutoPay mandate, respecting pre-debit notice and retry limits.",
            "plan_mandates",
            {Scope.COLLECTIONS_READ, Scope.COLLECTIONS_WRITE, Scope.AGENTS_RUN},
            parity_with="Smart Mandate",
            tags=("collections", "payments"),
        ),
        _spec(
            "voice_collections",
            "Voice Collections Agent",
            AgentTier.P1,
            "Multilingual pre-due and post-due calls: reminders, promise-to-pay "
            "capture, payment links, dispute detection and warm human handoff.",
            "run_collections_followup",
            {Scope.COLLECTIONS_READ, Scope.COLLECTIONS_WRITE, Scope.AGENTS_RUN},
            advisory_only=False,
            parity_with="Voice AI / Specialised Agents",
            tags=("voice", "collections"),
        ),
        _spec(
            "speech_analytics",
            "Speech Analytics Agent",
            AgentTier.P1,
            "Scores every call, human or AI, for quality and compliance, quoting the "
            "transcript with timestamps for each finding.",
            "analyse_call",
            {Scope.COLLECTIONS_READ, Scope.AGENTS_RUN},
            parity_with="Speech Analytics",
            tags=("voice", "quality"),
        ),
        _spec(
            "onboarding_assistant",
            "Onboarding & Support Agent",
            AgentTier.P1,
            "Guides applicants through the journey, explains requirements, chases "
            "pendencies and answers status questions in chat or voice.",
            "answer_borrower_query",
            {Scope.APPLICATIONS_READ, Scope.AGENTS_RUN},
            parity_with="Voice AI / Specialised Agents (onboarding, support)",
            tags=("cx", "onboarding"),
        ),
        # --- P2: intelligence and ops ----------------------------------
        _spec(
            "msme_underwriting",
            "MSME Underwriting Agent",
            AgentTier.P2,
            "Cross-verifies GST returns, ITR, bank credits and invoices to underwrite "
            "thin-file MSME borrowers.",
            "underwrite_msme",
            {Scope.APPLICATIONS_READ, Scope.DOCUMENTS_READ, Scope.AGENTS_RUN},
            parity_with="MSME Underwriting",
            tags=("credit", "msme"),
        ),
        _spec(
            "customer_data_intelligence",
            "Customer Data Intelligence Agent",
            AgentTier.P2,
            "Consent-scoped, explainable segments and propensities. Every segment "
            "carries a human-readable rule; no protected attributes are used.",
            "build_segments",
            {Scope.APPLICATIONS_READ, Scope.AGENTS_RUN},
            parity_with="Customer Data Intelligence",
            tags=("analytics",),
        ),
        _spec(
            "ops_research",
            "Ops & Research Agent",
            AgentTier.P2,
            "Answers cost, volume and throughput questions from the ledger: calls per "
            "endpoint, extract versus digitise, utilisation against the 10/min "
            "ceiling, and backlog drain time.",
            "run_ops_report",
            {Scope.USAGE_READ, Scope.AGENTS_RUN},
            tags=("ops", "cost"),
        ),
    )
}


def list_agents(tier: AgentTier | None = None) -> list[AgentSpec]:
    """All agents, optionally filtered to one tier, in catalog order."""
    agents = list(AGENT_CATALOG.values())
    if tier is not None:
        agents = [a for a in agents if a.tier == tier]
    return agents


def get_agent(agent_id: str) -> AgentSpec:
    """One agent by id, or raise NotFound."""
    try:
        return AGENT_CATALOG[agent_id]
    except KeyError as exc:
        raise NotFound("Unknown agent", agent_id=agent_id) from exc
