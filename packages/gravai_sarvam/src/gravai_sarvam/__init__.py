"""Sarvam AI integration — the only AI provider in GravAI runtime code.

Everything the platform is shaped around lives here: the 10 req/min Document
Intelligence ceiling and its fair-share governor, the back-off that both the
extract and digitise paths obey, the JSON repair loop that makes strict agent
output contracts workable, and the rate card that prices every call.
"""

from __future__ import annotations

from .batching import MAX_PAGES_PER_JOB, Batch, count_pages, page_ranges, split_document
from .chat import ChatClient, SarvamChat, estimate_tokens, extract_json_object
from .documents import DocumentReader, DocumentRunner, SarvamDocuments
from .factory import SarvamBundle, build_governor, build_sarvam
from .governor import GovernorStats, RateGovernor, TokenBucket
from .http import CircuitBreaker, RetryPolicy, SarvamHTTP
from .pricing import DEFAULT_RATE_CARD_VERSION, DEFAULT_RATES, Rate, RateCard, price_call
from .sandbox import FakeSarvamChat, FakeSarvamDocuments, FakeSarvamSpeech, SandboxBundle
from .speech import SUPPORTED_LANGUAGES, SarvamSpeech, chunk_text
from .types import (
    Audio,
    CallBreakdown,
    CallRecord,
    ChatMessage,
    ChatRequest,
    ChatResponse,
    DocOptions,
    DocumentMode,
    DocumentRef,
    DocumentResult,
    JobState,
    JobStatus,
    Product,
    Transcript,
    TranscriptSegment,
    Usage,
)

__version__ = "0.1.0"

__all__ = [
    "DEFAULT_RATES",
    "DEFAULT_RATE_CARD_VERSION",
    "MAX_PAGES_PER_JOB",
    "SUPPORTED_LANGUAGES",
    "Audio",
    "Batch",
    "CallBreakdown",
    "CallRecord",
    "ChatClient",
    "ChatMessage",
    "ChatRequest",
    "ChatResponse",
    "CircuitBreaker",
    "DocOptions",
    "DocumentMode",
    "DocumentReader",
    "DocumentRef",
    "DocumentResult",
    "DocumentRunner",
    "FakeSarvamChat",
    "FakeSarvamDocuments",
    "FakeSarvamSpeech",
    "GovernorStats",
    "JobState",
    "JobStatus",
    "Product",
    "Rate",
    "RateCard",
    "RateGovernor",
    "RetryPolicy",
    "SandboxBundle",
    "SarvamBundle",
    "SarvamChat",
    "SarvamDocuments",
    "SarvamHTTP",
    "SarvamSpeech",
    "TokenBucket",
    "Transcript",
    "TranscriptSegment",
    "Usage",
    "__version__",
    "build_governor",
    "build_sarvam",
    "chunk_text",
    "count_pages",
    "estimate_tokens",
    "extract_json_object",
    "page_ranges",
    "price_call",
    "split_document",
]
