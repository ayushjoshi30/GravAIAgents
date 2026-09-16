"""KYC & Identity Agent (P1).

Cross-checks identity across DigiLocker, CKYC and uploaded documents.

Aadhaar is handled masked to the last four digits throughout — it is never
requested in full, never stored in full, and never sent to a model. The matching
itself is deterministic (see ``namematch``), because whether two names refer to
the same person is a question with a defensible answer, not a judgement call to
delegate.
"""

from __future__ import annotations

from datetime import date
from typing import Any

from gravai_connectors import GravitonApplication, KycResult
from gravai_core.pii import is_valid_pan, pan_entity_type
from pydantic import BaseModel, ConfigDict, Field

from ..base import Agent, AgentContext, AgentResult, AgentStep
from ..guardrails import run_all
from ..namematch import match_names
from ..schemas import AgentOutput, Flag, FlagType


class FieldMatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    field: str
    matched: bool
    score: float | None = None
    method: str | None = None
    detail: str = ""


class KycOutput(AgentOutput):
    model_config = ConfigDict(extra="forbid")

    application_id: str
    source: str
    verified: bool = False
    matches: list[FieldMatch] = Field(default_factory=list)
    #: Only ever the last four digits. The full number is not held anywhere.
    aadhaar_last4: str | None = None
    pan: str | None = None
    pan_entity_type: str | None = None
    overall_score: float = Field(default=0.0, ge=0.0, le=1.0)


class KycVerificationAgent(Agent[KycOutput]):
    """Verifies that the applicant is who the documents say."""

    id = "kyc_verification"
    name = "KYC & Identity Agent"
    task = "Cross-check applicant identity across issued and uploaded documents."
    output_model = KycOutput
    tools = ("kyc.verify", "graviton.get_application", "docai.extract")
    allow_pii_fields = frozenset({"pan", "aadhaar_last4"})

    #: Below this, a human checks the identity.
    NAME_MATCH_FLOOR = 0.85

    async def run(
        self,
        ctx: AgentContext,
        *,
        application: GravitonApplication,
        kyc: KycResult,
        declared_date_of_birth: date | None = None,
        **_: Any,
    ) -> AgentResult[KycOutput]:
        matches: list[FieldMatch] = []
        flags: list[Flag] = []

        # --- name -------------------------------------------------------
        name_match = match_names(application.applicant_name, kyc.name or "")
        matches.append(
            FieldMatch(
                field="name",
                matched=name_match.score >= self.NAME_MATCH_FLOOR,
                score=name_match.score,
                method=name_match.method,
                detail=name_match.explanation,
            )
        )
        if name_match.score < self.NAME_MATCH_FLOOR:
            flags.append(
                Flag(
                    type=FlagType.MISMATCH,
                    detail=(
                        f"Name on the application does not match the issued document "
                        f"(score {name_match.score})"
                    ),
                    evidence=name_match.explanation,
                    severity="high",
                )
            )

        # --- date of birth ----------------------------------------------
        # Exact or nothing. An approximate date of birth is not an identity match.
        expected = declared_date_of_birth
        if kyc.date_of_birth is not None:
            if expected is None:
                matches.append(
                    FieldMatch(
                        field="date_of_birth",
                        matched=False,
                        detail="No declared date of birth to compare against.",
                    )
                )
            else:
                same = expected == kyc.date_of_birth
                matches.append(
                    FieldMatch(
                        field="date_of_birth",
                        matched=same,
                        score=1.0 if same else 0.0,
                        method="exact",
                        detail=(
                            "Dates of birth agree."
                            if same
                            else "Declared date of birth differs from the issued document."
                        ),
                    )
                )
                if not same:
                    flags.append(
                        Flag(
                            type=FlagType.MISMATCH,
                            detail="Date of birth does not match the issued document",
                            severity="high",
                        )
                    )

        # --- PAN --------------------------------------------------------
        pan = (application.pan or kyc.pan or "").strip().upper() or None
        entity = None
        if pan:
            structurally_valid = is_valid_pan(pan)
            entity = pan_entity_type(pan)
            agrees = (
                application.pan is None
                or kyc.pan is None
                or application.pan.upper() == kyc.pan.upper()
            )
            matches.append(
                FieldMatch(
                    field="pan",
                    matched=structurally_valid and agrees,
                    score=1.0 if (structurally_valid and agrees) else 0.0,
                    method="structural",
                    detail=(
                        f"PAN is well-formed ({entity})."
                        if structurally_valid and agrees
                        else "PAN is malformed or disagrees between sources."
                    ),
                )
            )
            if not structurally_valid:
                flags.append(
                    Flag(
                        type=FlagType.MISMATCH,
                        detail="PAN does not have a valid structure",
                        severity="high",
                    )
                )

        # --- Aadhaar ----------------------------------------------------
        last4 = kyc.aadhaar_last4 or application.aadhaar_last4
        if application.aadhaar_last4 and kyc.aadhaar_last4:
            agrees = application.aadhaar_last4 == kyc.aadhaar_last4
            matches.append(
                FieldMatch(
                    field="aadhaar_last4",
                    matched=agrees,
                    score=1.0 if agrees else 0.0,
                    method="last4",
                    detail=(
                        "Last four digits agree."
                        if agrees
                        else "Last four digits differ between sources."
                    ),
                )
            )
            if not agrees:
                flags.append(
                    Flag(
                        type=FlagType.MISMATCH,
                        detail="Aadhaar last four digits differ between sources",
                        severity="high",
                    )
                )

        scored = [m for m in matches if m.score is not None]
        overall = sum(m.score or 0.0 for m in scored) / len(scored) if scored else 0.0
        verified = kyc.verified and all(m.matched for m in matches)

        output = KycOutput(
            application_id=application.application_id,
            source=kyc.source,
            verified=verified,
            matches=matches,
            aadhaar_last4=last4,
            pan=pan,
            pan_entity_type=entity,
            overall_score=round(overall, 3),
            flags=flags,
            escalate=not verified,
            escalation_reason=(
                None
                if verified
                else "; ".join(m.detail for m in matches if not m.matched) or "KYC incomplete"
            ),
            reasoning_summary=(
                f"Compared the application against the {kyc.source} record. "
                f"{sum(1 for m in matches if m.matched)} of {len(matches)} checks agree "
                f"(overall {overall:.0%}). Aadhaar was handled as last four digits only."
            ),
        )

        step = AgentStep(name="cross_check_identity", kind="deterministic")
        report = run_all(
            output, known_document_ids=ctx.document_ids, allow_pii_fields=self.allow_pii_fields
        )
        return AgentResult(agent_id=self.id, output=output, steps=[step], validation=report)
