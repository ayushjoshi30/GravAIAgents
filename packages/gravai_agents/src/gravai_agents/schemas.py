"""Shared output schema pieces.

Every agent's output is a Pydantic model built from these, which is what makes
"cite the source or return null with a reason" a validated contract rather than
a hopeful instruction in a prompt.
"""

from __future__ import annotations

from decimal import Decimal
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class Citation(BaseModel):
    """Where a value came from.

    A value with no citation and no reason is the single most common way an
    agent fabricates. The validators reject it.
    """

    model_config = ConfigDict(extra="forbid")

    document_id: str | None = None
    page: int | None = Field(default=None, ge=1)
    system: str | None = Field(default=None, description="e.g. graviton, bre, bureau")
    field: str | None = None

    def is_resolvable(self) -> bool:
        """Can a reviewer find the source from this?

        A document id alone is enough. When a document is digitised, the model
        reads the whole text at once and genuinely does not know which page a
        value came from — and inventing a page number to satisfy a validator
        would be exactly the fabrication the validator exists to catch.
        """
        return bool(self.document_id) or bool(self.system and self.field)


class FieldValue(BaseModel):
    """One extracted value, with provenance or an explanation for its absence."""

    model_config = ConfigDict(extra="forbid")

    value: Any | None = None
    citation: Citation | None = None
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    reason: str | None = Field(
        default=None, description="Required when value is null: why it could not be found"
    )


class FlagType(StrEnum):
    TAMPER = "tamper"
    MISMATCH = "mismatch"
    DUPLICATE = "duplicate"
    EXPIRED = "expired"
    RECONCILIATION_FAILED = "reconciliation_failed"
    FRAUD_SIGNAL = "fraud_signal"
    QUALITY = "quality"


class Flag(BaseModel):
    """Something a human must look at."""

    model_config = ConfigDict(extra="forbid")

    type: FlagType
    detail: str
    evidence: str | None = None
    citation: Citation | None = None
    severity: str = Field(default="medium", pattern="^(low|medium|high)$")


class AgentOutput(BaseModel):
    """Base every agent output extends."""

    model_config = ConfigDict(extra="forbid")

    flags: list[Flag] = Field(default_factory=list)
    escalate: bool = False
    escalation_reason: str | None = None
    reasoning_summary: str = Field(
        default="",
        description="Auditor-facing explanation citing document ids. Not private reasoning.",
    )


class Band(StrEnum):
    """Risk bands. Thresholds are policy, not model output."""

    GREEN = "GREEN"
    AMBER = "AMBER"
    RED = "RED"

    @classmethod
    def for_probability(cls, probability: float) -> Band:
        """GREEN below 6%, AMBER 6-15%, RED above 15%."""
        if probability < 0.06:
            return cls.GREEN
        if probability <= 0.15:
            return cls.AMBER
        return cls.RED


class Money(BaseModel):
    """A rupee amount that always carries its unit."""

    model_config = ConfigDict(extra="forbid")

    amount_inr: Decimal
    citation: Citation | None = None
