"""Canonical shapes exchanged with external systems.

Agents work against these, not against a tenant's particular JSON, so onboarding
a lender is a mapping exercise rather than an agent rewrite.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field


class RuleOutcome(StrEnum):
    PASS = "pass"
    FAIL = "fail"
    REFER = "refer"
    NOT_APPLICABLE = "na"


class BreRule(BaseModel):
    """One rule from the tenant's policy pack, with its evaluation."""

    model_config = ConfigDict(extra="forbid")

    rule_id: str
    name: str
    category: str = Field(description="eligibility | risk | policy | compliance")
    outcome: RuleOutcome
    observed: str | None = None
    threshold: str | None = None
    #: Plain-language sentence suitable for an adverse-action note. Must contain
    #: no protected attributes and no internal jargon.
    plain_language: str = ""
    severity: str = Field(default="L2", pattern="^(L1|L2|L3)$")


class BreEvaluation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    evaluation_id: str
    application_id: str
    policy_version: str
    outcome: RuleOutcome
    rules: list[BreRule] = Field(default_factory=list)

    @property
    def failures(self) -> list[BreRule]:
        return [rule for rule in self.rules if rule.outcome is RuleOutcome.FAIL]

    @property
    def referrals(self) -> list[BreRule]:
        return [rule for rule in self.rules if rule.outcome is RuleOutcome.REFER]


class GravitonDocument(BaseModel):
    model_config = ConfigDict(extra="forbid")

    document_id: str
    application_id: str
    uri: str
    mime_type: str = "application/pdf"
    pages: int | None = None
    declared_type: str | None = None
    uploaded_at: date | None = None

    #: The file itself, when the platform already has it.
    #:
    #: Graviton hands over a `uri` and nothing else, because its documents live
    #: in its own storage — that is why this was uri-only. An upload is
    #: different: by the time a run starts, the bytes have been scanned, stored
    #: and read back out of the blob store, and they are right here.
    #:
    #: Without this field they had nowhere to go. `extra="forbid"` above means
    #: they could not even be smuggled through, so a resolved upload arrived at
    #: the document reader as a uri with no content, and the provider client
    #: refused it: "Exactly one of file content and upload_id must be supplied".
    #: The upload worked, the resolution worked, and the file still could not be
    #: read.
    #:
    #: Optional because the Graviton path genuinely has no bytes to give.
    content: bytes | None = None


class GravitonApplication(BaseModel):
    """A loan application as Graviton holds it."""

    model_config = ConfigDict(extra="forbid")

    application_id: str
    external_id: str
    product: str
    status: str
    applicant_name: str
    aadhaar_last4: str | None = None
    pan: str | None = None
    loan_amount: Decimal | None = None
    tenure_months: int | None = None
    interest_rate_pct: Decimal | None = None
    collateral_value: Decimal | None = None
    net_monthly_income: Decimal | None = None
    existing_monthly_emi: Decimal | None = None
    bureau_score: int | None = None
    enquiries_3m: int | None = None
    employment_vintage_months: int | None = None
    documents: list[GravitonDocument] = Field(default_factory=list)


class Pendency(BaseModel):
    model_config = ConfigDict(extra="forbid")

    pendency_id: str
    application_id: str
    requirement: str
    assigned_to: str
    raised_on: date | None = None
    status: str = "open"


class KycResult(BaseModel):
    """Verified identity data, always with Aadhaar masked."""

    model_config = ConfigDict(extra="forbid")

    application_id: str
    source: str = "digilocker"
    name: str | None = None
    date_of_birth: date | None = None
    address: str | None = None
    aadhaar_last4: str | None = None
    pan: str | None = None
    verified: bool = False
