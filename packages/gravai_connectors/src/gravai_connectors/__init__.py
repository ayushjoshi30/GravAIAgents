"""Connectors to the systems GravAI reads from and writes to.

Each connector is an interface plus a sandbox adapter, so the platform runs end
to end with no external dependency while a production adapter is wired to a
tenant's actual endpoints.

One connector is deliberately sandbox-only and says so: **Account Aggregator**.
Fetching consented bank data requires a licensed AA or a TSP arrangement, and
faking it would hide the platform's one genuine capability gap rather than
surface it.
"""

from __future__ import annotations

from .account_aggregator import (
    AaAccount,
    AaConnector,
    AaTransaction,
    ConsentArtefact,
    ConsentStatus,
    FiData,
    FiType,
    PurposeCode,
    SandboxAccountAggregator,
)
from .bre import SANDBOX_POLICY_VERSION, BreConnector, SandboxBre
from .collections_los import (
    CollectionsCase,
    ContactAttempt,
    ContactOutcome,
    PromiseToPay,
    SandboxCollections,
)
from .graviton import GravitonConnector, SandboxDigilocker, SandboxGraviton
from .models import (
    BreEvaluation,
    BreRule,
    GravitonApplication,
    GravitonDocument,
    KycResult,
    Pendency,
    RuleOutcome,
)
from .registry import CONNECTOR_REGISTRY, ConnectorSpec, ConnectorStatus

__version__ = "0.1.0"

__all__ = [
    "CONNECTOR_REGISTRY",
    "SANDBOX_POLICY_VERSION",
    "AaAccount",
    "AaConnector",
    "AaTransaction",
    "BreConnector",
    "BreEvaluation",
    "BreRule",
    "CollectionsCase",
    "ConnectorSpec",
    "ConnectorStatus",
    "ConsentArtefact",
    "ConsentStatus",
    "ContactAttempt",
    "ContactOutcome",
    "FiData",
    "FiType",
    "GravitonApplication",
    "GravitonConnector",
    "GravitonDocument",
    "KycResult",
    "Pendency",
    "PromiseToPay",
    "PurposeCode",
    "RuleOutcome",
    "SandboxAccountAggregator",
    "SandboxBre",
    "SandboxCollections",
    "SandboxDigilocker",
    "SandboxGraviton",
    "__version__",
]
