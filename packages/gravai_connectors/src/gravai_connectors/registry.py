"""Connector registry.

Declares what GravAI can talk to and, honestly, how ready each one is. The
console's system-status panel and the docs both read this, so "we have an AA
integration" can never be claimed by a page that nobody checked.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum


class ConnectorStatus(StrEnum):
    """How real a connector is."""

    #: Production adapter implemented and exercised against a live endpoint.
    LIVE = "live"
    #: Interface and sandbox adapter exist; production adapter pending.
    SANDBOX_ONLY = "sandbox_only"
    #: Interface defined; requires an external commercial or licensing step.
    EXTERNAL_DEPENDENCY = "external_dependency"


@dataclass(frozen=True, slots=True)
class ConnectorSpec:
    id: str
    name: str
    status: ConnectorStatus
    summary: str
    #: What a tenant must supply before this connector can go live.
    onboarding_requirement: str


CONNECTOR_REGISTRY: dict[str, ConnectorSpec] = {
    spec.id: spec
    for spec in (
        ConnectorSpec(
            "graviton",
            "Graviton LOS",
            ConnectorStatus.SANDBOX_ONLY,
            "Applications, documents, pendencies and status transitions. Graviton "
            "stays the system of record; GravAI holds a projection.",
            "Per-tenant base URL and service credentials.",
        ),
        ConnectorSpec(
            "bre",
            "Business Rules Engine",
            ConnectorStatus.SANDBOX_ONLY,
            "Evaluates an application against the tenant's policy pack and returns "
            "every rule outcome, which the Credit Appraisal Agent explains.",
            "BRE endpoint and the policy pack version to pin.",
        ),
        ConnectorSpec(
            "digilocker",
            "DigiLocker",
            ConnectorStatus.SANDBOX_ONLY,
            "Issued-document fetch for KYC, with consent capture.",
            "DigiLocker partner credentials and a registered redirect URI.",
        ),
        ConnectorSpec(
            "aa",
            "Account Aggregator",
            ConnectorStatus.EXTERNAL_DEPENDENCY,
            "Consented, real-time bank data via the RBI Account Aggregator "
            "framework. This is the platform's one genuine capability gap: the "
            "interface and ReBIT consent-artefact shape are defined, but fetching "
            "real data requires a licensed AA or TSP.",
            "An agreement with a Sahamati-certified AA or TSP, plus FIU registration.",
        ),
        ConnectorSpec(
            "telephony",
            "Telephony / CPaaS",
            ConnectorStatus.SANDBOX_ONLY,
            "Places and receives calls, streams audio to the voice agent, and "
            "transfers to a human on dispute.",
            "CPaaS account, outbound caller ID, and DLT registration.",
        ),
        ConnectorSpec(
            "notification",
            "Notifications",
            ConnectorStatus.SANDBOX_ONLY,
            "SMS, WhatsApp and email, through templates approved in advance.",
            "DLT-registered SMS templates and a WhatsApp BSP account.",
        ),
    )
}
