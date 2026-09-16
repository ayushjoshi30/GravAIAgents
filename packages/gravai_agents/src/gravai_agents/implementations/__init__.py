"""Agent implementations.

One module per agent. The registry in ``gravai_agents.registry`` maps catalog ids
to these classes, so a catalog entry without an implementation is a detectable
error rather than a silent gap.
"""

from __future__ import annotations

from .aa_data import AaDataAgent, AaDataOutput
from .bank_statement_analytics import (
    BankStatementAnalyticsAgent,
    BankStatementOutput,
    Transaction,
)
from .case_allocation import CaseAllocationAgent, CaseAllocationOutput
from .credit_appraisal import CreditAppraisalAgent, CreditAppraisalOutput
from .customer_data_intelligence import (
    CdiOutput,
    CustomerDataIntelligenceAgent,
    CustomerSignal,
)
from .doc_intelligence import DocIntelligenceAgent, DocIntelligenceOutput
from .kyc_verification import KycOutput, KycVerificationAgent
from .msme_underwriting import Counterparty, GstReturn, MsmeOutput, MsmeUnderwritingAgent
from .onboarding_assistant import OnboardingAssistantAgent, OnboardingOutput
from .ops_research import OpsReportOutput, OpsResearchAgent
from .risk_scoring import RiskOutput, RiskScoringAgent
from .smart_mandate import SmartMandateAgent, SmartMandateOutput
from .speech_analytics import SpeechAnalyticsAgent, SpeechAnalyticsOutput
from .voice_collections import (
    CallOutcome,
    CallState,
    VoiceCollectionsAgent,
    VoiceCollectionsOutput,
)

__all__ = [
    "AaDataAgent",
    "AaDataOutput",
    "BankStatementAnalyticsAgent",
    "BankStatementOutput",
    "CallOutcome",
    "CallState",
    "CaseAllocationAgent",
    "CaseAllocationOutput",
    "CdiOutput",
    "Counterparty",
    "CreditAppraisalAgent",
    "CreditAppraisalOutput",
    "CustomerDataIntelligenceAgent",
    "CustomerSignal",
    "DocIntelligenceAgent",
    "DocIntelligenceOutput",
    "GstReturn",
    "KycOutput",
    "KycVerificationAgent",
    "MsmeOutput",
    "MsmeUnderwritingAgent",
    "OnboardingAssistantAgent",
    "OnboardingOutput",
    "OpsReportOutput",
    "OpsResearchAgent",
    "RiskOutput",
    "RiskScoringAgent",
    "SmartMandateAgent",
    "SmartMandateOutput",
    "SpeechAnalyticsAgent",
    "SpeechAnalyticsOutput",
    "Transaction",
    "VoiceCollectionsAgent",
    "VoiceCollectionsOutput",
]
