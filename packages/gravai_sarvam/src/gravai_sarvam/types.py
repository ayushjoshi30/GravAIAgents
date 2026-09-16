"""Transport-neutral types for the Sarvam layer.

These are the shapes agents work with. They deliberately do not mirror any
vendor's JSON: the adapter translates, so swapping a provider (or a Sarvam API
revision) changes one module rather than every agent.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from enum import StrEnum
from typing import Any, Literal

Role = Literal["system", "user", "assistant"]


# --- Chat -----------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ChatMessage:
    role: Role
    content: str


@dataclass(frozen=True, slots=True)
class ChatRequest:
    messages: tuple[ChatMessage, ...]
    model: str | None = None
    #: Low by default: extraction and decisioning are not creative tasks.
    temperature: float = 0.1
    top_p: float = 0.9
    max_tokens: int | None = None
    #: Ask the provider for JSON where it supports it; the repair loop covers
    #: providers and models that do not honour it.
    json_mode: bool = False
    stop: tuple[str, ...] = field(default=())


@dataclass(frozen=True, slots=True)
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0

    @property
    def total(self) -> int:
        return self.input_tokens + self.output_tokens


@dataclass(frozen=True, slots=True)
class ChatResponse:
    text: str
    usage: Usage
    model: str
    latency_ms: int = 0
    #: True when token counts were estimated rather than reported.
    estimated_usage: bool = False


# --- Speech ---------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class TranscriptSegment:
    text: str
    start_seconds: float
    end_seconds: float
    speaker: str | None = None


@dataclass(frozen=True, slots=True)
class Transcript:
    text: str
    language: str
    duration_seconds: float
    segments: tuple[TranscriptSegment, ...] = field(default=())


@dataclass(frozen=True, slots=True)
class Audio:
    data: bytes
    audio_format: str = "wav"
    sample_rate: int = 22050
    characters: int = 0
    duration_seconds: float = 0.0


# --- Documents ------------------------------------------------------------


class DocumentMode(StrEnum):
    """How a document is read.

    ``EXTRACT`` returns structured fields. ``DIGITISE`` returns text, which then
    needs a model to read it — one extra LLM call that extract never incurs.
    Both draw on the same 10 req/min quota.
    """

    EXTRACT = "extract"
    DIGITISE = "digitise"


class JobState(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


@dataclass(frozen=True, slots=True)
class DocumentRef:
    """A document to be read.

    Submission is ``multipart/form-data``: the provider takes file bytes or an
    upload id, and has no URL-fetch mode. ``uri`` is therefore a reference the
    platform resolves itself (blob storage, or a sandbox fixture) — it is never
    sent to the provider.
    """

    document_id: str
    uri: str
    mime_type: str = "application/pdf"
    pages: int | None = None
    doc_type: str | None = None
    #: The bytes to submit. Resolved from ``uri`` by the storage layer.
    content: bytes | None = None
    filename: str = ""

    def upload_name(self) -> str:
        """Filename sent in the multipart part."""
        if self.filename:
            return self.filename
        suffix = {"application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png"}.get(
            self.mime_type, "bin"
        )
        return f"{self.document_id}.{suffix}"


@dataclass(frozen=True, slots=True)
class DocOptions:
    """Per-job options.

    There is no page-range parameter: the provider caps a job at ten pages and
    expects the client to split larger documents. Splitting is handled by
    ``gravai_sarvam.batching`` before submission, not by a wire field.
    """

    #: A JSON Schema describing the fields to extract. Serialised to a string on
    #: the wire; the provider rejects free prose here.
    extraction_schema: dict[str, Any] | None = None
    #: Ask the provider to classify the document type as well as extract.
    classify: bool = False


@dataclass(frozen=True, slots=True)
class JobStatus:
    job_id: str
    state: JobState
    error: str | None = None

    @property
    def done(self) -> bool:
        return self.state is JobState.SUCCEEDED

    @property
    def failed(self) -> bool:
        return self.state is JobState.FAILED


@dataclass(slots=True)
class CallBreakdown:
    """How many API calls one document actually cost.

    Recorded per document because counting documents instead of requests is
    exactly what hides the fact that polling dominates the traffic.
    """

    submit: int = 0
    polls: int = 0
    results: int = 0
    llm_reads: int = 0

    @property
    def total(self) -> int:
        return self.submit + self.polls + self.results + self.llm_reads

    def as_dict(self) -> dict[str, int]:
        return {
            "submit": self.submit,
            "polls": self.polls,
            "results": self.results,
            "llm_reads": self.llm_reads,
            "total": self.total,
        }


@dataclass(slots=True)
class DocumentResult:
    document_id: str
    mode: DocumentMode
    pages: int
    #: Structured fields, present for extract and for digitise after the read step.
    fields: dict[str, Any] = field(default_factory=dict)
    #: Raw text, present for digitise.
    text: str | None = None
    calls: CallBreakdown = field(default_factory=CallBreakdown)
    job_seconds: float = 0.0


# --- Cost -----------------------------------------------------------------


class Product(StrEnum):
    """Billable Sarvam products. Values match rate-card rows."""

    DOCAI_EXTRACT = "docai_extract"
    DOCAI_DIGITISE = "docai_digitise"
    LLM_INPUT = "llm_input"
    LLM_OUTPUT = "llm_output"
    STT = "stt"
    TTS = "tts"
    TRANSLATE = "translate"


@dataclass(frozen=True, slots=True)
class CallRecord:
    """One billable interaction, for the cost and volume ledger."""

    product: Product
    endpoint: str
    model: str | None = None
    input_tokens: int = 0
    output_tokens: int = 0
    pages: int = 0
    audio_seconds: float = 0.0
    characters: int = 0
    latency_ms: int = 0
    status: str = "ok"
    sandbox: bool = True
    agent_id: str | None = None
    run_id: str | None = None
    cost_inr: Decimal = Decimal("0")
