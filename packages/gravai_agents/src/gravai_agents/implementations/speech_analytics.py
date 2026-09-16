"""Speech Analytics Agent (P1).

Scores every call — human or automated — for quality and compliance.

Conduct violations are detected deterministically from the transcript, not
judged by a model: whether a caller threatened arrest is a matter of fact, and
a fact worth a regulatory finding should not depend on a model's mood. The model
scores the softer rubric dimensions and writes coaching notes.

Every quote must appear verbatim in the transcript. A quality report that
paraphrases what an agent "essentially said" is useless in a dispute, so quotes
are verified against the source after generation and dropped if they do not match.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from ..base import Agent, AgentContext, AgentResult
from ..conduct import check_transcript
from ..guardrails import run_all
from ..prompting import document_block
from ..schemas import AgentOutput, Flag, FlagType


class RubricScores(BaseModel):
    """Five-point scale on each dimension."""

    model_config = ConfigDict(extra="forbid")

    disclosure: int = Field(ge=0, le=5, description="Identified lender, automation, recording")
    identity_verification: int = Field(ge=0, le=5)
    courtesy: int = Field(ge=0, le=5)
    accuracy_of_information: int = Field(ge=0, le=5)
    objection_handling: int = Field(ge=0, le=5)
    closure: int = Field(ge=0, le=5)

    @property
    def total(self) -> int:
        return (
            self.disclosure
            + self.identity_verification
            + self.courtesy
            + self.accuracy_of_information
            + self.objection_handling
            + self.closure
        )


class ComplianceViolation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    rule: str
    description: str
    quote: str
    speaker: str | None = None


class SpeechAnalyticsOutput(AgentOutput):
    model_config = ConfigDict(extra="forbid")

    call_id: str
    language: str
    scores: RubricScores
    score_percent: float = Field(ge=0.0, le=100.0)
    compliance_violations: list[ComplianceViolation] = Field(default_factory=list)
    missing_disclosures: list[str] = Field(default_factory=list)
    borrower_intent: str = ""
    coaching_notes: list[str] = Field(default_factory=list)
    unverified_quotes_dropped: int = 0


class QualityAssessment(BaseModel):
    """What the model contributes: rubric judgement and coaching."""

    model_config = ConfigDict(extra="forbid")

    scores: RubricScores
    borrower_intent: str = Field(description="What the borrower wanted, in one sentence")
    coaching_notes: list[str] = Field(
        default_factory=list, description="Two to four specific, actionable notes"
    )


class SpeechAnalyticsAgent(Agent[SpeechAnalyticsOutput]):
    """Quality and compliance scoring for collections calls."""

    id = "speech_analytics"
    name = "Speech Analytics Agent"
    task = "Score a collections call for quality and write coaching notes."
    output_model = SpeechAnalyticsOutput
    tools = ("collections.get_case", "speech.stt")
    agent_rules = """
8. Score only what the transcript shows. Do not infer tone, intent or attitude
   that the words do not support.
9. Compliance breaches are detected separately and automatically; do not try to
   find them yourself, and do not soften the scores to compensate for one.
10. Coaching notes must be specific and actionable — name what to say instead,
   not "be more empathetic".
"""

    MAX_SCORE = 30

    async def run(
        self,
        ctx: AgentContext,
        *,
        call_id: str,
        transcript: list[tuple[str, str]],
        language: str = "en-IN",
        **_: Any,
    ) -> AgentResult[SpeechAnalyticsOutput]:
        # --- compliance, deterministically ------------------------------
        conduct = check_transcript(transcript)
        violations = [
            ComplianceViolation(
                rule=v.rule,
                description=v.description,
                quote=v.evidence,
                speaker=v.speaker,
            )
            for v in conduct.violations
        ]

        rendered = "\n".join(f"{speaker}: {text}" for speaker, text in transcript)
        assessment, step, calls = await self.ask(
            ctx,
            "Score this collections call against the rubric and write coaching notes.\n\n"
            + document_block(call_id, rendered),
            QualityAssessment,
            step_name="score_call",
        )

        # --- verify every quote is real ---------------------------------
        haystack = rendered.lower()
        verified: list[ComplianceViolation] = []
        dropped = 0
        for violation in violations:
            if violation.quote.lower() in haystack:
                verified.append(violation)
            else:  # pragma: no cover - defensive; conduct quotes come from the text
                dropped += 1

        flags: list[Flag] = []
        if verified:
            flags.append(
                Flag(
                    type=FlagType.FRAUD_SIGNAL,
                    detail=f"{len(verified)} conduct breach(es) detected in this call",
                    evidence="; ".join(v.rule for v in verified),
                    severity="high",
                )
            )
        if conduct.missing_disclosures:
            flags.append(
                Flag(
                    type=FlagType.QUALITY,
                    detail=(
                        "Required disclosure missing: " + ", ".join(conduct.missing_disclosures)
                    ),
                    severity="high",
                )
            )

        percent = round(assessment.scores.total / self.MAX_SCORE * 100, 1)

        output = SpeechAnalyticsOutput(
            call_id=call_id,
            language=language,
            scores=assessment.scores,
            score_percent=percent,
            compliance_violations=verified,
            missing_disclosures=conduct.missing_disclosures,
            borrower_intent=assessment.borrower_intent,
            coaching_notes=assessment.coaching_notes,
            unverified_quotes_dropped=dropped,
            flags=flags,
            # Any conduct breach is reviewed by a human, whatever the score.
            escalate=bool(verified or conduct.missing_disclosures),
            escalation_reason=(
                "Conduct breach or missing disclosure requires manager review"
                if verified or conduct.missing_disclosures
                else None
            ),
            reasoning_summary=(
                f"Scored call {call_id} at {percent}% ({assessment.scores.total}/"
                f"{self.MAX_SCORE}). {len(verified)} conduct breach(es), "
                f"{len(conduct.missing_disclosures)} missing disclosure(s)."
            ),
        )

        report = run_all(output)
        return AgentResult(
            agent_id=self.id, output=output, steps=[step], validation=report, calls=calls
        )
