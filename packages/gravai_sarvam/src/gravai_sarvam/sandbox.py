"""SANDBOX mode: deterministic fakes with no network and no spend.

These are not "mocks that always succeed". They reproduce the behaviour that
actually shapes the platform — asynchronous jobs that take time, quota that runs
out, models that occasionally return not-quite-valid JSON — so the governor, the
back-off and the repair loop are all genuinely exercised by the test suite.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any

from gravai_core.settings import Settings, get_settings

from .chat import ChatClient
from .types import (
    Audio,
    ChatRequest,
    ChatResponse,
    DocOptions,
    DocumentMode,
    DocumentRef,
    JobState,
    JobStatus,
    Transcript,
    Usage,
)


def _seeded(value: str) -> int:
    """Stable pseudo-randomness from a string, so fixtures never flap."""
    return int(hashlib.sha256(value.encode()).hexdigest()[:8], 16)


@dataclass(slots=True)
class FakeJob:
    job_id: str
    mode: DocumentMode
    document_id: str
    polls_before_done: int
    polls_seen: int = 0
    fail: bool = False
    doc_type: str | None = None


#: Six months of statement lines for the seeded personal-loan applicant:
#: a steady salary credit, one recurring home-loan NACH, a cash deposit and a
#: single returned mandate. Enough structure for the analytics agent to do real
#: work (median income, recurring obligation, bounce) rather than echo a fixture.
_STATEMENT_LINES: list[dict[str, Any]] = [
    {
        "date": "01/03/2026",
        "narration": "NEFT SALARY CREDIT ACME LTD",
        "amount": 85000,
        "direction": "credit",
    },
    {
        "date": "05/03/2026",
        "narration": "NACH DR HDFC HOME LOAN",
        "amount": 12000,
        "direction": "debit",
    },
    {
        "date": "01/04/2026",
        "narration": "NEFT SALARY CREDIT ACME LTD",
        "amount": 85000,
        "direction": "credit",
    },
    {
        "date": "05/04/2026",
        "narration": "NACH DR HDFC HOME LOAN",
        "amount": 12000,
        "direction": "debit",
    },
    {
        "date": "01/05/2026",
        "narration": "NEFT SALARY CREDIT ACME LTD",
        "amount": 85000,
        "direction": "credit",
    },
    {
        "date": "05/05/2026",
        "narration": "NACH DR HDFC HOME LOAN",
        "amount": 12000,
        "direction": "debit",
    },
    {
        "date": "18/05/2026",
        "narration": "CASH DEP CDM BRANCH 0421",
        "amount": 20000,
        "direction": "credit",
    },
    {
        "date": "01/06/2026",
        "narration": "NEFT SALARY CREDIT ACME LTD",
        "amount": 85000,
        "direction": "credit",
    },
    {
        "date": "05/06/2026",
        "narration": "NACH RTN INSUFFICIENT FUNDS",
        "amount": 12000,
        "direction": "debit",
    },
    {
        "date": "01/07/2026",
        "narration": "NEFT SALARY CREDIT ACME LTD",
        "amount": 87000,
        "direction": "credit",
    },
    {
        "date": "05/07/2026",
        "narration": "NACH DR HDFC HOME LOAN",
        "amount": 12000,
        "direction": "debit",
    },
    {
        "date": "01/08/2026",
        "narration": "NEFT SALARY CREDIT ACME LTD",
        "amount": 87000,
        "direction": "credit",
    },
    {
        "date": "05/08/2026",
        "narration": "NACH DR HDFC HOME LOAN",
        "amount": 12000,
        "direction": "debit",
    },
]


class FakeSarvamDocuments:
    """An asynchronous document service that takes a realistic number of polls."""

    def __init__(
        self,
        *,
        polls_before_done: int = 10,
        pages_per_document: int = 3,
        fail_documents: frozenset[str] = frozenset(),
    ) -> None:
        self.polls_before_done = polls_before_done
        self.pages_per_document = pages_per_document
        self.fail_documents = fail_documents
        self.jobs: dict[str, FakeJob] = {}
        self.submissions: list[tuple[str, DocumentMode]] = []

    async def upload(self, content: bytes, filename: str, mime_type: str) -> str:
        """Mirror the two-step path so callers can exercise it offline."""
        return f"upload-{_seeded(filename):08x}"

    async def submit(
        self,
        document: DocumentRef,
        mode: DocumentMode,
        options: DocOptions | None = None,
        *,
        content: bytes | None = None,
        upload_id: str | None = None,
    ) -> str:
        job_id = f"job-{_seeded(document.document_id + str(mode)):08x}"
        self.jobs[job_id] = FakeJob(
            job_id=job_id,
            mode=mode,
            document_id=document.document_id,
            polls_before_done=self.polls_before_done,
            fail=document.document_id in self.fail_documents,
            doc_type=document.doc_type,
        )
        self.submissions.append((document.document_id, mode))
        return job_id

    async def status(self, job_id: str) -> JobStatus:
        job = self.jobs[job_id]
        job.polls_seen += 1
        if job.fail and job.polls_seen >= 2:
            return JobStatus(job_id, JobState.FAILED, error="sandbox: simulated failure")
        if job.polls_seen >= job.polls_before_done:
            return JobStatus(job_id, JobState.SUCCEEDED)
        return JobStatus(job_id, JobState.RUNNING)

    async def results(self, job_id: str) -> dict[str, Any]:
        job = self.jobs[job_id]
        if job.mode is DocumentMode.EXTRACT:
            if job.doc_type == "income.bank_statement":
                return {
                    "page_count": 12,
                    "fields": {
                        "account_holder_name": {"value": "Ayush Joshi", "page": 1},
                        "account_number": {"value": "XXXXXXXX9012", "page": 1},
                        "ifsc": {"value": "HDFC0001234", "page": 1},
                        "bank_name": {"value": "HDFC Bank", "page": 1},
                        "statement_period": {"value": "01/03/2026 - 31/08/2026", "page": 1},
                        # Opening + credits - debits must equal closing, or the
                        # analytics agent is right to refuse to reconcile it.
                        "opening_balance": {"value": 52000.0, "page": 1},
                        "closing_balance": {"value": 514000.0, "page": 12},
                        "transactions": {"value": _STATEMENT_LINES, "page": 2},
                    },
                }
            if job.doc_type == "kyc.pan":
                return {
                    "page_count": 1,
                    "fields": {
                        "name": {"value": "Ayush Joshi", "page": 1},
                        "pan": {"value": "AXKPJ8891L", "page": 1},
                        "date_of_birth": {"value": "02/11/1991", "page": 1},
                    },
                }
            if job.doc_type == "kyc.aadhaar":
                return {
                    "page_count": 1,
                    "fields": {
                        "name": {"value": "Ayush Joshi", "page": 1},
                        # Never a full Aadhaar, even in a fixture.
                        "aadhaar_last4": {"value": "9017", "page": 1},
                        "date_of_birth": {"value": "02/11/1991", "page": 1},
                    },
                }
            return {
                "page_count": self.pages_per_document,
                "fields": {
                    "document_reference": {"value": job.document_id, "page": 1},
                    "issued_on": {"value": "08/09/2026", "page": 1},
                },
            }
        return {
            "page_count": self.pages_per_document,
            "text": (
                "HDFC BANK STATEMENT\n"
                "Account Holder: Ayush Joshi\n"
                "Account: XXXXXXXX9012   IFSC: HDFC0001234\n"
                "Period: 01/03/2026 to 31/08/2026\n"
                "01/08/2026  SALARY CREDIT ACME LTD   85,000.00 CR\n"
                "05/08/2026  NACH DR HDFC HOME LOAN   12,000.00 DR\n"
                "31/08/2026  CLOSING BALANCE         1,84,320.50\n"
            ),
        }


class FakeSarvamChat(ChatClient):
    """A chat model that answers from canned fixtures.

    Inherits the real ``complete_json`` repair loop, so ``malformed_first``
    genuinely exercises it rather than simulating success.

    ``malformed_first`` makes the first response invalid JSON so the repair loop
    is exercised rather than assumed to work.
    """

    def __init__(
        self,
        *,
        responses: dict[str, str] | None = None,
        default: str | None = None,
        malformed_first: bool = False,
        settings: Settings | None = None,
    ) -> None:
        self.responses = responses or {}
        self.default = default
        self.malformed_first = malformed_first
        self.settings = settings or get_settings()
        self.calls: list[ChatRequest] = []

    def _pick(self, request: ChatRequest) -> str:
        prompt = "\n".join(m.content for m in request.messages)
        for key, value in self.responses.items():
            if key in prompt:
                return value
        if self.default is not None:
            return self.default

        # Infer the expected shape from the JSON schema carried in the prompt,
        # so one fake serves every agent without per-agent wiring.
        if '"identity_question"' in prompt:
            # A collections call script. Deliberately compliant: the conduct
            # checker must have something valid to pass, and a separate test
            # feeds it a non-compliant script to prove it fails.
            return json.dumps(
                {
                    "greeting": (
                        "Good morning. This is an automated assistant calling on behalf of "
                        "your lender. This call is recorded."
                    ),
                    "identity_question": (
                        "For security, could you confirm your date of birth please?"
                    ),
                    "purpose": (
                        "Your instalment is overdue. I am calling to help you arrange payment."
                    ),
                    "promise_request": "When would you be able to make the payment?",
                    "closing": (
                        "Thank you. I have noted that, and you will receive a confirmation "
                        "message shortly."
                    ),
                }
            )
        if '"headline"' in prompt:
            return json.dumps(
                {
                    "headline": (
                        "Throughput is the binding constraint, not price: the month's "
                        "document volume needs far more capacity than the rate ceiling "
                        "provides in business hours."
                    ),
                    "summary": (
                        "Status polling is about three quarters of all request volume, so "
                        "measuring documents rather than requests understates the load by "
                        "roughly a factor of twelve. The reasoning model is a small and "
                        "fixed share, independent of how many documents a file contains. "
                        "The backlog estimate turns entirely on whether status polls count "
                        "against the rate limit, which is not documented and should be "
                        "confirmed with the vendor before any capacity commitment."
                    ),
                }
            )
        if '"coaching_notes"' in prompt:
            return json.dumps(
                {
                    "scores": {
                        "disclosure": 5,
                        "identity_verification": 4,
                        "courtesy": 5,
                        "accuracy_of_information": 4,
                        "objection_handling": 3,
                        "closure": 4,
                    },
                    "borrower_intent": "The borrower wanted more time to pay.",
                    "coaching_notes": [
                        "Confirm the promised date back to the borrower before closing.",
                        "Offer the payment link explicitly rather than waiting to be asked.",
                    ],
                }
            )
        if '"requires_human"' in prompt:
            return json.dumps(
                {
                    "answer": (
                        "Your application is with our credit team. Two documents are still "
                        "outstanding, and once we receive them the review continues. You can "
                        "upload them from the link in your application email."
                    ),
                    "status_explained": (
                        "It is being reviewed, and we are waiting on documents from you."
                    ),
                    "suggested_actions": [
                        {
                            "label": "Upload the outstanding documents",
                            "detail": "Your latest bank statement and the valuation report.",
                        }
                    ],
                    "requires_human": False,
                    "human_topic": None,
                }
            )
        if '"explanation"' in prompt and '"applicant_explanation"' not in prompt:
            return json.dumps(
                {
                    "explanation": (
                        "The score is driven mainly by the share of income already committed "
                        "to loan repayments, together with a returned mandate in the last six "
                        "months. The credit bureau score and length of employment both reduce "
                        "the risk."
                    )
                }
            )
        if '"applicant_explanation"' in prompt:
            return json.dumps(
                {
                    "summary": (
                        "Income of Rs 85,000 a month is evidenced by six consecutive "
                        "salary credits from the same employer. One recurring home-loan "
                        "mandate of Rs 12,000 is visible, and one mandate was returned "
                        "for insufficient funds in June 2026. FOIR and LTV were computed "
                        "from the verified figures rather than the declared ones."
                    ),
                    "applicant_explanation": (
                        "We looked at your salary credits and your existing monthly loan "
                        "repayments to work out how much of your income is already "
                        "committed. One of your loan instalments was returned unpaid in "
                        "June, which we have noted. An underwriter will review your "
                        "application and contact you with the decision."
                    ),
                    "conditions": [
                        "Latest month salary slip to be collected before disbursal",
                    ],
                }
            )
        return json.dumps(
            {
                "fields": {
                    "account_holder_name": {"value": "Ayush Joshi", "reason": None},
                    "closing_balance": {"value": 349000.0, "reason": None},
                },
                "document_type": "income.bank_statement",
                "confidence": 0.94,
            }
        )

    async def complete(self, request: ChatRequest) -> ChatResponse:
        self.calls.append(request)
        # A repair turn is any request that already carries an assistant reply.
        is_repair = any(m.role == "assistant" for m in request.messages)
        if self.malformed_first and not is_repair:
            text = "Sure! Here is the data: {not valid json,,,"
        else:
            text = self._pick(request)
        prompt_chars = sum(len(m.content) for m in request.messages)
        return ChatResponse(
            text=text,
            usage=Usage(input_tokens=prompt_chars // 4, output_tokens=len(text) // 4),
            model=request.model or self.settings.sarvam_model_reasoning,
            latency_ms=12,
        )


class FakeSarvamSpeech:
    """Speech services that return fixed, plausible output."""

    def __init__(self, *, transcript: str | None = None) -> None:
        self.transcript = transcript or (
            "Haan ji, main kal tak payment kar dunga. Amount hai baarah hazaar rupaye."
        )
        self.synthesized: list[str] = []

    async def transcribe(
        self, audio: bytes, *, language: str | None = None, **_: Any
    ) -> Transcript:
        return Transcript(
            text=self.transcript,
            language=language or "hi-IN",
            duration_seconds=max(1.0, len(audio) / 32000),
        )

    async def transcribe_translate(self, audio: bytes, **_: Any) -> Transcript:
        return Transcript(
            text="Yes, I will make the payment by tomorrow. The amount is twelve thousand rupees.",
            language="en-IN",
            duration_seconds=max(1.0, len(audio) / 32000),
        )

    async def synthesize(self, text: str, *, language: str, **_: Any) -> Audio:
        self.synthesized.append(text)
        # A plausible WAV header so downstream code handling bytes is exercised.
        return Audio(
            data=b"RIFF" + len(text).to_bytes(4, "little") + b"WAVEfmt ",
            characters=len(text),
            duration_seconds=len(text) / 15.0,
        )

    async def translate(self, text: str, *, source: str, target: str, **_: Any) -> str:
        return f"[{target}] {text}"

    async def transliterate(self, text: str, **_: Any) -> str:
        return text

    async def identify_language(self, text: str) -> str:
        return "hi-IN" if any(ord(c) > 2304 for c in text) else "en-IN"


@dataclass(slots=True)
class SandboxBundle:
    """Everything the platform needs, with nothing reaching the network."""

    documents: FakeSarvamDocuments = field(default_factory=FakeSarvamDocuments)
    chat: FakeSarvamChat = field(default_factory=FakeSarvamChat)
    speech: FakeSarvamSpeech = field(default_factory=FakeSarvamSpeech)
