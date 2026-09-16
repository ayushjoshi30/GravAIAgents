"""Collections conduct rules.

RBI's Fair Practices Code and the recovery-agent guidelines are not style
preferences — they are the rules a lender is examined against, and an automated
caller can breach them at a scale a human never could. So they are enforced in
code, before an utterance is spoken, and checked again against the transcript
afterwards.

Two obligations are specific to an AI caller and are treated as absolute here:
the borrower must be told they are speaking to an automated system, and they
must be told the call is recorded.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, time

from gravai_core.time_utils import (
    DEFAULT_CALL_WINDOW_END,
    DEFAULT_CALL_WINDOW_START,
    to_ist,
    within_call_window,
)

#: Language a collections call must never contain. Each pattern maps to the
#: conduct rule it breaches, so a violation report names the rule, not just the
#: phrase.
PROHIBITED: tuple[tuple[str, re.Pattern[str], str], ...] = (
    (
        "threat_of_arrest",
        re.compile(r"\b(arrest|jail|police|criminal case|fir\b|warrant)\b", re.I),
        "Implying arrest or criminal action for a civil debt.",
    ),
    (
        "threat_of_violence",
        re.compile(r"\b(consequence[s]? will be|we will come|send someone|deal with you)\b", re.I),
        "Implied intimidation.",
    ),
    (
        "public_shaming",
        re.compile(
            r"\b(tell your (employer|family|neighbou?rs?|friends)|inform your office)\b", re.I
        ),
        "Disclosing the debt to third parties.",
    ),
    (
        "abuse",
        re.compile(r"\b(stupid|idiot|cheat|fraudster|liar|shameless)\b", re.I),
        "Abusive or demeaning language.",
    ),
    (
        "misrepresentation",
        re.compile(
            r"\b(legal notice (has been|is being) (sent|issued)|court case (has )?filed|"
            r"blacklisted forever|you will never get a loan)\b",
            re.I,
        ),
        "Stating consequences that are not authorised on this case.",
    ),
    (
        "false_authority",
        re.compile(r"\b(i am (a|an) (officer|advocate|lawyer|police)|court official)\b", re.I),
        "Claiming an authority the caller does not hold.",
    ),
)

#: Disclosures that must appear, and how to recognise them.
REQUIRED_DISCLOSURES: tuple[tuple[str, re.Pattern[str], str], ...] = (
    (
        "ai_disclosure",
        re.compile(r"\b(automated|ai assistant|virtual assistant|recorded assistant)\b", re.I),
        "The borrower must be told they are speaking to an automated system.",
    ),
    (
        "recording_notice",
        re.compile(r"\b(recorded|recording)\b", re.I),
        "The borrower must be told the call is recorded.",
    ),
    (
        "lender_identification",
        re.compile(r"\bcalling (on behalf of|from)\b", re.I),
        "The caller must identify the lender.",
    ),
)


@dataclass(frozen=True, slots=True)
class ConductViolation:
    rule: str
    description: str
    evidence: str
    speaker: str | None = None
    timestamp: str | None = None


@dataclass(frozen=True, slots=True)
class ConductReport:
    violations: list[ConductViolation] = field(default_factory=list)
    missing_disclosures: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.violations and not self.missing_disclosures


def check_utterance(text: str, *, speaker: str = "agent") -> list[ConductViolation]:
    """Scan one line for prohibited content.

    Run before an utterance is spoken, so a breach is prevented rather than
    discovered in a quality review a week later.
    """
    found: list[ConductViolation] = []
    for rule, pattern, description in PROHIBITED:
        match = pattern.search(text or "")
        if match:
            found.append(
                ConductViolation(
                    rule=rule,
                    description=description,
                    evidence=match.group(0),
                    speaker=speaker,
                )
            )
    return found


def check_transcript(lines: list[tuple[str, str]]) -> ConductReport:
    """Check a whole call: ``lines`` is a list of (speaker, text).

    Disclosures are only credited to the agent — a borrower saying "am I being
    recorded?" does not discharge the lender's obligation to say so.
    """
    violations: list[ConductViolation] = []
    agent_text = " ".join(text for speaker, text in lines if speaker == "agent")

    for speaker, text in lines:
        if speaker == "agent":
            violations.extend(check_utterance(text, speaker=speaker))

    missing = [name for name, pattern, _ in REQUIRED_DISCLOSURES if not pattern.search(agent_text)]
    return ConductReport(violations=violations, missing_disclosures=missing)


@dataclass(frozen=True, slots=True)
class CallPermission:
    """Whether a call may be placed at all."""

    allowed: bool
    reason: str | None = None
    window_start: time = DEFAULT_CALL_WINDOW_START
    window_end: time = DEFAULT_CALL_WINDOW_END


def may_call(
    *,
    at: datetime,
    do_not_call: bool,
    in_dispute: bool,
    attempts_today: int,
    max_attempts: int = 3,
    window_start: time = DEFAULT_CALL_WINDOW_START,
    window_end: time = DEFAULT_CALL_WINDOW_END,
) -> CallPermission:
    """The gate every outbound call passes through.

    Ordered so the most categorical reasons are reported first: a borrower on
    do-not-call should be told that, not that the office is shut.
    """
    if do_not_call:
        return CallPermission(False, "The borrower is registered do-not-call.")
    if in_dispute:
        return CallPermission(False, "The account is in dispute; collections calls stop.")
    if attempts_today >= max_attempts:
        return CallPermission(
            False, f"{attempts_today} attempts already made today (limit {max_attempts})."
        )
    if not within_call_window(at, start=window_start, end=window_end):
        local = to_ist(at)
        return CallPermission(
            False,
            f"{local:%H:%M} IST is outside the permitted window "
            f"({window_start:%H:%M}-{window_end:%H:%M} IST).",
        )
    return CallPermission(True)
