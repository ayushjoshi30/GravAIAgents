"""Task queues and retry policy.

Sarvam products get their own queues so a Document Intelligence backlog cannot
block an interactive chat completion, and so worker concurrency can be tuned per
product against each one's rate limit.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum


class TaskQueue(StrEnum):
    """Temporal task queues."""

    #: Document Intelligence: submit, poll, fetch. Low concurrency — the 10/min
    #: ceiling, not worker count, is the constraint.
    SARVAM_DOCAI = "sarvam-docai"
    #: Chat completions for extraction, classification and reasoning.
    SARVAM_LLM = "sarvam-llm"
    #: Speech-to-text, text-to-speech, translate.
    SARVAM_SPEECH = "sarvam-speech"
    #: Graviton, BRE, DigiLocker, notifications.
    CONNECTORS = "connectors"
    #: Agent orchestration workflows.
    AGENTS = "agents"
    #: Live voice turns. Isolated because a turn budget is 1.5s and it must never
    #: queue behind a batch job.
    VOICE_REALTIME = "voice-realtime"


@dataclass(frozen=True, slots=True)
class RetryPolicy:
    """Activity retry configuration."""

    initial_interval_seconds: float
    backoff_coefficient: float
    maximum_interval_seconds: float
    maximum_attempts: int
    non_retryable_errors: tuple[str, ...] = ()


#: Retry policy per activity class. Auth failures and schema violations are not
#: retried: repeating them burns quota and produces the same answer.
RETRY_POLICIES: dict[str, RetryPolicy] = {
    "sarvam": RetryPolicy(
        initial_interval_seconds=2.0,
        backoff_coefficient=2.0,
        maximum_interval_seconds=60.0,
        maximum_attempts=6,
        non_retryable_errors=("SarvamAuthError", "SchemaViolation", "ContentTooLong"),
    ),
    "docai_job": RetryPolicy(
        initial_interval_seconds=5.0,
        backoff_coefficient=2.0,
        maximum_interval_seconds=120.0,
        maximum_attempts=4,
        non_retryable_errors=("DocJobFailed", "SarvamAuthError"),
    ),
    "connector": RetryPolicy(
        initial_interval_seconds=1.0,
        backoff_coefficient=2.0,
        maximum_interval_seconds=30.0,
        maximum_attempts=3,
        non_retryable_errors=("NotFound", "Forbidden", "ValidationFailed"),
    ),
    "persistence": RetryPolicy(
        initial_interval_seconds=0.5,
        backoff_coefficient=2.0,
        maximum_interval_seconds=10.0,
        maximum_attempts=5,
    ),
}
