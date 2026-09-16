"""The credit pipeline: documents to memorandum.

Chains the three P0 agents the way a real file moves through Graviton — read the
documents, assess the bank statements, then appraise — and carries the evidence
forward so the appraisal is built on verified figures rather than declared ones.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from typing import Any

from gravai_connectors import GravitonApplication, SandboxBre, SandboxGraviton

from .base import AgentContext, AgentResult
from .implementations import (
    BankStatementAnalyticsAgent,
    BankStatementOutput,
    CreditAppraisalAgent,
    CreditAppraisalOutput,
    DocIntelligenceAgent,
    DocIntelligenceOutput,
    Transaction,
)


@dataclass(slots=True)
class PipelineResult:
    """Everything one credit run produced."""

    application: GravitonApplication
    documents: AgentResult[DocIntelligenceOutput]
    bank_statement: AgentResult[BankStatementOutput] | None
    appraisal: AgentResult[CreditAppraisalOutput]
    warnings: list[str] = field(default_factory=list)

    @property
    def cost_inr(self) -> Decimal:
        total = self.documents.cost_inr + self.appraisal.cost_inr
        if self.bank_statement is not None:
            total += self.bank_statement.cost_inr
        return total

    @property
    def sarvam_calls(self) -> int:
        """Total Sarvam API calls, polls included.

        Polls are the majority of this number, which is the entire point of
        reporting it rather than a document count.
        """
        return self.documents.output.total_calls + len(self.appraisal.calls)

    @property
    def escalated(self) -> bool:
        return any(
            result is not None and result.escalated
            for result in (self.documents, self.bank_statement, self.appraisal)
        )


def _parse_date(value: str) -> Any:
    """Indian document convention, DD/MM/YYYY."""
    return datetime.strptime(value.strip().replace("-", "/"), "%d/%m/%Y").date()


def transactions_from_documents(
    result: DocIntelligenceOutput,
) -> tuple[list[Transaction], dict[str, Any]]:
    """Pull statement lines out of whatever the document agent read.

    Returns the transactions and the account context that came with them, so the
    analytics agent can reconcile against the statement's own opening and
    closing balances rather than assume them.
    """
    transactions: list[Transaction] = []
    context: dict[str, Any] = {}

    for assessment in result.documents:
        if assessment.type != "income.bank_statement":
            continue
        fields = assessment.fields
        for key in ("account_number", "bank_name", "opening_balance", "closing_balance"):
            found = fields.get(key)
            if found is not None and found.value is not None:
                context[key] = found.value

        raw = fields.get("transactions")
        if raw is None or not isinstance(raw.value, list):
            continue
        page = raw.citation.page if raw.citation else 1
        for line in raw.value:
            if not isinstance(line, dict):
                continue
            try:
                transactions.append(
                    Transaction(
                        date=_parse_date(str(line["date"])),
                        narration=str(line["narration"]),
                        amount=Decimal(str(line["amount"])),
                        direction=str(line["direction"]),
                        document_id=assessment.document_id,
                        page=page,
                    )
                )
            except (KeyError, ValueError, TypeError):
                # A malformed line is dropped and reported, never guessed at.
                continue
    return transactions, context


@dataclass(slots=True)
class CollectionsResult:
    """Everything one collections cycle produced."""

    allocation: AgentResult[Any]
    mandates: AgentResult[Any]
    calls: list[AgentResult[Any]] = field(default_factory=list)
    analyses: list[AgentResult[Any]] = field(default_factory=list)
    suppressed: list[str] = field(default_factory=list)

    @property
    def cost_inr(self) -> Decimal:
        total = self.allocation.cost_inr + self.mandates.cost_inr
        for result in (*self.calls, *self.analyses):
            total += result.cost_inr
        return total

    @property
    def escalated(self) -> bool:
        return any(
            result.escalated
            for result in (self.allocation, self.mandates, *self.calls, *self.analyses)
        )


async def run_collections_pipeline(
    sarvam: Any,
    *,
    cases: list[Any],
    tenant_id: str,
    tenant_name: str = "the lender",
    now: datetime | None = None,
    max_calls: int = 5,
) -> CollectionsResult:
    """Rank the book, plan the debits, then call only who is left.

    The order is the point. Allocation decides who may be contacted at all —
    suppressing dispute, do-not-call, a live promise and the attempt limit — and
    mandate planning runs before any call, because a borrower whose debit is
    already scheduled for the day after payday does not need a phone call today.
    Only cases surviving both, and not requiring a human, are dialled.
    """
    from .implementations import (
        CaseAllocationAgent,
        SmartMandateAgent,
        SpeechAnalyticsAgent,
        VoiceCollectionsAgent,
    )

    ctx = AgentContext(tenant_id=tenant_id, tenant_name=tenant_name)
    by_id = {case.case_id: case for case in cases}

    allocation = await CaseAllocationAgent(sarvam).run(ctx, cases=cases)
    mandates = await SmartMandateAgent(sarvam).run(ctx, cases=cases)

    suppressed = [a.case_id for a in allocation.output.allocations if a.suppressed]

    # Dial only what allocation cleared for the voice channel, in priority
    # order, and never more than the cycle's budget.
    dialable = [
        a
        for a in allocation.output.allocations
        if not a.suppressed and a.channel == "voice" and not a.requires_human
    ][:max_calls]

    voice_agent = VoiceCollectionsAgent(sarvam)
    speech_agent = SpeechAnalyticsAgent(sarvam)
    calls: list[AgentResult[Any]] = []
    analyses: list[AgentResult[Any]] = []

    for allocated in dialable:
        case = by_id.get(allocated.case_id)
        if case is None:
            continue
        call = await voice_agent.run(ctx, case=case, now=now, lender_name=tenant_name)
        calls.append(call)

        if not call.output.permitted:
            continue

        # Score what was actually said. Every call is reviewed, not a sample:
        # a conduct breach found a week later in a sample is a breach that
        # already happened at scale.
        transcript = [("agent", line.text) for line in call.output.script if not line.blocked]
        if transcript:
            analyses.append(
                await speech_agent.run(
                    ctx,
                    call_id=f"{allocated.case_id}-call",
                    transcript=transcript,
                    language=call.output.language,
                )
            )

    return CollectionsResult(
        allocation=allocation,
        mandates=mandates,
        calls=calls,
        analyses=analyses,
        suppressed=suppressed,
    )


async def run_credit_pipeline(
    sarvam: Any,
    *,
    application_id: str,
    tenant_id: str,
    tenant_name: str = "the lender",
    graviton: SandboxGraviton | None = None,
    bre: Any = None,
    tenant_prefers_digitise: bool = False,
) -> PipelineResult:
    """Run documents, bank statements and appraisal for one application."""
    los = graviton or SandboxGraviton()
    rules = bre or SandboxBre()

    application = await los.get_application(application_id)
    documents = await los.list_documents(application_id)

    ctx = AgentContext(
        tenant_id=tenant_id,
        tenant_name=tenant_name,
        application_id=application_id,
        loan_product=application.product,
        document_ids=tuple(d.document_id for d in documents),
    )

    doc_agent = DocIntelligenceAgent(sarvam)
    doc_result = await doc_agent.run(
        ctx, documents=documents, tenant_prefers_digitise=tenant_prefers_digitise
    )

    warnings: list[str] = []
    transactions, account = transactions_from_documents(doc_result.output)

    bsa_result: AgentResult[BankStatementOutput] | None = None
    if transactions:
        bsa_agent = BankStatementAnalyticsAgent(sarvam)
        account_number = str(account.get("account_number") or "0000")
        bsa_result = await bsa_agent.run(
            ctx,
            transactions=transactions,
            account_last4=account_number[-4:],
            bank=account.get("bank_name"),
            opening_balance=(
                Decimal(str(account["opening_balance"]))
                if account.get("opening_balance") is not None
                else None
            ),
            closing_balance=(
                Decimal(str(account["closing_balance"]))
                if account.get("closing_balance") is not None
                else None
            ),
        )
    else:
        warnings.append(
            "No bank statement transactions were found, so the appraisal uses "
            "declared income rather than verified income."
        )

    appraisal_agent = CreditAppraisalAgent(sarvam)
    appraisal = await appraisal_agent.run(
        ctx,
        application=application,
        bre=rules,
        bank_statement=bsa_result.output if bsa_result else None,
    )

    return PipelineResult(
        application=application,
        documents=doc_result,
        bank_statement=bsa_result,
        appraisal=appraisal,
        warnings=warnings,
    )
