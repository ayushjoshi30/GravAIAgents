"""Catalog-to-implementation registry.

The catalog says which agents exist; this says which of them can actually run.
Keeping the two separate — and testable against each other — means a half-built
agent cannot quietly appear in the API, the MCP tool list and the docs as though
it were finished.
"""

from __future__ import annotations

from typing import Any

from gravai_core.errors import NotFound
from gravai_sarvam import SarvamBundle

from .base import Agent
from .catalog import AGENT_CATALOG
from .implementations import (
    AaDataAgent,
    BankStatementAnalyticsAgent,
    CaseAllocationAgent,
    CreditAppraisalAgent,
    CustomerDataIntelligenceAgent,
    DocIntelligenceAgent,
    KycVerificationAgent,
    MsmeUnderwritingAgent,
    OnboardingAssistantAgent,
    OpsResearchAgent,
    RiskScoringAgent,
    SmartMandateAgent,
    SpeechAnalyticsAgent,
    VoiceCollectionsAgent,
)

#: Agents with a working implementation.
IMPLEMENTATIONS: dict[str, type[Agent[Any]]] = {
    # P0 - the credit core
    DocIntelligenceAgent.id: DocIntelligenceAgent,
    BankStatementAnalyticsAgent.id: BankStatementAnalyticsAgent,
    CreditAppraisalAgent.id: CreditAppraisalAgent,
    # P1 - risk, collections, voice, CX
    AaDataAgent.id: AaDataAgent,
    RiskScoringAgent.id: RiskScoringAgent,
    KycVerificationAgent.id: KycVerificationAgent,
    CaseAllocationAgent.id: CaseAllocationAgent,
    SmartMandateAgent.id: SmartMandateAgent,
    VoiceCollectionsAgent.id: VoiceCollectionsAgent,
    SpeechAnalyticsAgent.id: SpeechAnalyticsAgent,
    OnboardingAssistantAgent.id: OnboardingAssistantAgent,
    # P2 - intelligence and ops
    MsmeUnderwritingAgent.id: MsmeUnderwritingAgent,
    CustomerDataIntelligenceAgent.id: CustomerDataIntelligenceAgent,
    OpsResearchAgent.id: OpsResearchAgent,
}


def is_implemented(agent_id: str) -> bool:
    """Can this catalog entry actually run?"""
    return agent_id in IMPLEMENTATIONS


def implemented_ids() -> tuple[str, ...]:
    return tuple(IMPLEMENTATIONS)


def pending_ids() -> tuple[str, ...]:
    """Catalog entries still awaiting an implementation."""
    return tuple(agent_id for agent_id in AGENT_CATALOG if agent_id not in IMPLEMENTATIONS)


def build_agent(agent_id: str, sarvam: SarvamBundle) -> Agent[Any]:
    """Instantiate an agent, or say plainly that it is not built yet."""
    if agent_id not in AGENT_CATALOG:
        raise NotFound("Unknown agent", agent_id=agent_id)
    try:
        return IMPLEMENTATIONS[agent_id](sarvam)
    except KeyError as exc:
        raise NotFound(
            "Agent is in the catalog but has no implementation yet",
            agent_id=agent_id,
            implemented=list(IMPLEMENTATIONS),
        ) from exc
