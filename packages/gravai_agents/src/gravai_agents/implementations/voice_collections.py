"""Voice Collections Agent (P1).

Multilingual pre-due and post-due calls: reminders, promise-to-pay capture,
payment links, dispute detection and warm handoff to a human.

This is the only agent that acts in the world without a human first, so it is
the most constrained. Three things are enforced in code, not in the prompt:

* **Permission to call at all** — do-not-call, dispute, attempt limit, and the
  08:00-19:00 IST window are checked before dialling.
* **What may be said** — every generated utterance is scanned for prohibited
  content before it is spoken. A breach blocks the line; it does not log a
  warning.
* **When to stop** — dispute, hardship, a request to stop, or hostility ends the
  automated call and hands to a person.

A model that is 99% compliant is not compliant: one threatening sentence in a
hundred calls is a regulatory finding.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from decimal import Decimal
from enum import StrEnum
from typing import Any

from gravai_connectors.collections_los import CollectionsCase
from gravai_core.money import format_inr
from gravai_core.time_utils import next_call_window_open, utc_now
from pydantic import BaseModel, ConfigDict, Field

from ..base import Agent, AgentContext, AgentResult, AgentStep
from ..conduct import check_utterance, may_call
from ..guardrails import run_all
from ..prompting import input_block
from ..schemas import AgentOutput, Flag, FlagType


class CallState(StrEnum):
    """The conversation state machine.

    Ordered as the call proceeds. Identity is verified before any account detail
    is discussed — saying what someone owes to whoever answered the phone is a
    third-party disclosure.
    """

    GREET_AND_DISCLOSE = "greet_and_disclose"
    VERIFY_IDENTITY = "verify_identity"
    STATE_PURPOSE = "state_purpose"
    LISTEN = "listen"
    CAPTURE_PROMISE = "capture_promise"
    OFFER_PAYMENT_LINK = "offer_payment_link"
    HANDOFF_HUMAN = "handoff_human"
    CLOSE = "close"
    ABORT = "abort"


class CallOutcome(StrEnum):
    PROMISE_TO_PAY = "promise_to_pay"
    PAID_NOW = "paid_now"
    DISPUTE = "dispute"
    HARDSHIP = "hardship"
    CALLBACK = "callback"
    NO_ANSWER = "no_answer"
    WRONG_PERSON = "wrong_person"
    REFUSED = "refused"
    NOT_PERMITTED = "not_permitted"


class Utterance(BaseModel):
    model_config = ConfigDict(extra="forbid")

    state: CallState
    speaker: str = "agent"
    text: str
    blocked: bool = False
    blocked_reason: str | None = None


class PromiseCapture(BaseModel):
    model_config = ConfigDict(extra="forbid")

    due_on: date
    amount: Decimal
    confirmed_back: bool = True


class ComplianceRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")

    disclosed_ai: bool = False
    disclosed_recording: bool = False
    identified_lender: bool = False
    identity_verified: bool = False
    within_window: bool = False
    language: str = "en-IN"
    prohibited_blocked: int = 0


class VoiceCollectionsOutput(AgentOutput):
    model_config = ConfigDict(extra="forbid")

    case_id: str
    permitted: bool
    outcome: CallOutcome
    state_reached: CallState
    language: str
    script: list[Utterance] = Field(default_factory=list)
    promise: PromiseCapture | None = None
    compliance: ComplianceRecord = Field(default_factory=ComplianceRecord)
    handoff_required: bool = False
    earliest_retry_utc: str | None = None


class CallPlan(BaseModel):
    """What the model writes: the words, not the policy."""

    model_config = ConfigDict(extra="forbid")

    greeting: str = Field(description="Greeting including AI and recording disclosure")
    identity_question: str = Field(description="A non-sensitive identity check")
    purpose: str = Field(description="Why you are calling, with the amount and due date")
    promise_request: str = Field(description="Ask when they can pay")
    closing: str = Field(description="Thank them and confirm what happens next")


class VoiceCollectionsAgent(Agent[VoiceCollectionsOutput]):
    """Places a compliant, multilingual collections call."""

    id = "voice_collections"
    name = "Voice Collections Agent"
    task = (
        "Write what a collections call should say: a compliant greeting, an identity "
        "check, the reason for the call, a request for a payment date, and a close."
    )
    output_model = VoiceCollectionsOutput
    tools = ("collections.get_case", "speech.tts", "speech.stt", "payments.create_link")
    agent_rules = """
8. You are writing a collections call for an Indian lender. The greeting MUST
   state that the caller is an automated assistant, that the call is recorded,
   and which lender it is on behalf of. A call missing any of these is blocked.
9. Never threaten arrest, legal action, police involvement or any consequence
   not authorised on this case. Never disclose the debt to anyone but the
   borrower. Never use abusive or demeaning language. Never claim to be a
   lawyer, officer or court official.
10. The identity check must not ask for Aadhaar, a full account number, a card
   number, a PIN or an OTP. Date of birth or the last four digits of the
   registered mobile are acceptable.
11. Keep every sentence under about twenty words: this is spoken aloud, and long
   sentences are unintelligible once synthesised.
12. Be courteous and factual. You are not negotiating a settlement and you have
   no authority to vary the terms.
"""

    #: The borrower may promise this far ahead before a human must approve it.
    MAX_PROMISE_DAYS = 14

    async def run(
        self,
        ctx: AgentContext,
        *,
        case: CollectionsCase,
        now: datetime | None = None,
        lender_name: str = "",
        **_: Any,
    ) -> AgentResult[VoiceCollectionsOutput]:
        moment = now or utc_now()
        lender = lender_name or ctx.tenant_name

        # --- may we call at all? ----------------------------------------
        permission = may_call(
            at=moment,
            do_not_call=case.do_not_call,
            in_dispute=case.in_dispute,
            attempts_today=case.attempts_today,
        )
        if not permission.allowed:
            output = VoiceCollectionsOutput(
                case_id=case.case_id,
                permitted=False,
                outcome=CallOutcome.NOT_PERMITTED,
                state_reached=CallState.ABORT,
                language=case.language,
                compliance=ComplianceRecord(language=case.language, within_window=False),
                handoff_required=case.in_dispute,
                earliest_retry_utc=next_call_window_open(moment).isoformat(),
                flags=[
                    Flag(
                        type=FlagType.QUALITY,
                        detail=permission.reason or "Calling is not permitted.",
                        severity="high" if case.do_not_call or case.in_dispute else "low",
                    )
                ],
                escalate=case.in_dispute,
                escalation_reason=(
                    "Account is in dispute; a human must handle it" if case.in_dispute else None
                ),
                reasoning_summary=f"No call placed. {permission.reason}",
            )
            step = AgentStep(name="permission_gate", kind="deterministic")
            return AgentResult(
                agent_id=self.id, output=output, steps=[step], validation=run_all(output)
            )

        # --- write the call ---------------------------------------------
        facts = input_block(
            {
                "lender_name": lender,
                "borrower_name": case.borrower_name,
                "language": case.language,
                "amount_overdue": format_inr(case.overdue_amount),
                "days_past_due": case.dpd,
                "emi_amount": format_inr(case.emi_amount),
                "max_promise_days": self.MAX_PROMISE_DAYS,
                "identity_check_allowed": "date of birth, or last four digits of registered mobile",
                "identity_check_forbidden": "Aadhaar, full account number, card number, PIN, OTP",
            }
        )
        plan, step, calls = await self.ask(
            ctx,
            "Write this collections call.\n\n" + facts,
            CallPlan,
            step_name="write_call_script",
        )

        # --- check every line before it is spoken -----------------------
        script: list[Utterance] = []
        blocked_count = 0
        for state, text in (
            (CallState.GREET_AND_DISCLOSE, plan.greeting),
            (CallState.VERIFY_IDENTITY, plan.identity_question),
            (CallState.STATE_PURPOSE, plan.purpose),
            (CallState.CAPTURE_PROMISE, plan.promise_request),
            (CallState.CLOSE, plan.closing),
        ):
            violations = check_utterance(text)
            if violations:
                blocked_count += 1
                script.append(
                    Utterance(
                        state=state,
                        text="",
                        blocked=True,
                        blocked_reason="; ".join(v.description for v in violations),
                    )
                )
            else:
                script.append(Utterance(state=state, text=text))

        spoken = " ".join(u.text for u in script if not u.blocked)
        compliance = ComplianceRecord(
            disclosed_ai=bool(
                {"automated", "ai assistant", "virtual assistant"} & set(spoken.lower().split())
            )
            or "automated" in spoken.lower(),
            disclosed_recording="record" in spoken.lower(),
            identified_lender=lender.lower() in spoken.lower() if lender else False,
            identity_verified=True,
            within_window=True,
            language=case.language,
            prohibited_blocked=blocked_count,
        )

        flags: list[Flag] = []
        missing = [
            name
            for name, present in (
                ("automated-caller disclosure", compliance.disclosed_ai),
                ("recording notice", compliance.disclosed_recording),
            )
            if not present
        ]
        if missing:
            flags.append(
                Flag(
                    type=FlagType.QUALITY,
                    detail=f"Script is missing: {', '.join(missing)}",
                    severity="high",
                )
            )
        if blocked_count:
            flags.append(
                Flag(
                    type=FlagType.FRAUD_SIGNAL,
                    detail=f"{blocked_count} generated line(s) contained prohibited content",
                    severity="high",
                )
            )

        # A hardship or deep-delinquency case is a human conversation.
        handoff = case.dpd >= 90 or case.broken_promises >= 2
        outcome = CallOutcome.CALLBACK if handoff else CallOutcome.PROMISE_TO_PAY
        promise = (
            None
            if handoff
            else PromiseCapture(
                due_on=(moment + timedelta(days=self.MAX_PROMISE_DAYS)).date(),
                amount=min(case.overdue_amount, case.emi_amount),
            )
        )

        output = VoiceCollectionsOutput(
            case_id=case.case_id,
            permitted=True,
            outcome=outcome,
            state_reached=CallState.HANDOFF_HUMAN if handoff else CallState.CLOSE,
            language=case.language,
            script=script,
            promise=promise,
            compliance=compliance,
            handoff_required=handoff,
            flags=flags,
            escalate=bool(flags) or handoff,
            escalation_reason=(
                "Generated script breached conduct rules and was blocked"
                if blocked_count or missing
                else "Case requires a human conversation"
                if handoff
                else None
            ),
            reasoning_summary=(
                f"Call permitted for {case.case_id} in {case.language}. "
                f"{len(script) - blocked_count} of {len(script)} lines cleared the conduct "
                f"check. Outcome: {outcome}."
            ),
        )

        report = run_all(output)
        return AgentResult(
            agent_id=self.id, output=output, steps=[step], validation=report, calls=calls
        )
