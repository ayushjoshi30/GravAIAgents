"""Account Aggregator Data Agent (P1).

Fetches consented bank data and normalises it into exactly the shape the bank
statement agent already consumes.

That normalisation is the whole point. A file sourced through AA and one
sourced from uploaded PDFs arrive at the same downstream analytics, so AA is a
drop-in replacement for the document path rather than a second, divergent
pipeline. Today it costs twelve API calls and a poll loop per document to read a
statement; through AA it is one consented fetch, structured at source, with no
extraction risk at all.

**The fetch itself is an external dependency.** Pulling real data requires being
a registered Financial Information User behind a licensed Account Aggregator.
The agent, the consent lifecycle and the normalisation are real; only the
transport is sandboxed, and the output says so on every run.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from gravai_connectors.account_aggregator import (
    ConsentArtefact,
    FiData,
    PurposeCode,
)
from pydantic import BaseModel, ConfigDict, Field

from ..base import Agent, AgentContext, AgentResult, AgentStep
from ..guardrails import run_all
from ..schemas import AgentOutput, Flag, FlagType
from .bank_statement_analytics import Transaction


class ConsentSummary(BaseModel):
    """The consent a fetch was made under, for the audit trail."""

    model_config = ConfigDict(extra="forbid")

    consent_id: str
    status: str
    purpose_code: str
    purpose_text: str
    data_range_from: str
    data_range_to: str
    expires_on: str
    retention_expires_on: str
    fetches_used: int
    fetches_permitted: int


class AccountSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    masked_account_number: str
    fip_name: str
    ifsc: str | None = None
    account_type: str
    transaction_count: int
    opening_balance: Decimal | None = None
    closing_balance: Decimal | None = None


class AaDataOutput(AgentOutput):
    model_config = ConfigDict(extra="forbid")

    customer_ref: str
    #: False whenever the transport was sandboxed, so nothing downstream can
    #: mistake fixture data for a real bank feed.
    live_data: bool = False
    source: str = "sandbox"
    consent: ConsentSummary | None = None
    accounts: list[AccountSummary] = Field(default_factory=list)
    transaction_count: int = 0
    #: Normalised into the same shape the statement agent takes from documents.
    transactions: list[Transaction] = Field(default_factory=list)
    documents_avoided: int = 0
    api_calls_avoided: int = 0


class AaDataAgent(Agent[AaDataOutput]):
    """Pulls consented bank data and hands it to the statement analytics."""

    id = "aa_data"
    name = "Account Aggregator Data Agent"
    task = "Fetch consented bank data and normalise it for credit assessment."
    output_model = AaDataOutput
    tools = ("aa.request_consent", "aa.fetch_statement", "aa.revoke_consent")
    allow_pii_fields = frozenset({"masked_account_number", "ifsc", "narration"})

    #: What the document path would have cost for the same evidence: a twelve
    #: page statement is two jobs, each a submit, ten polls and a results fetch.
    CALLS_PER_STATEMENT_VIA_DOCUMENTS = 24

    async def run(
        self,
        ctx: AgentContext,
        *,
        connector: Any,
        customer_ref: str,
        consent_handle: str | None = None,
        purpose: PurposeCode = PurposeCode.LOAN_UNDERWRITING,
        months: int = 12,
        **_: Any,
    ) -> AgentResult[AaDataOutput]:
        flags: list[Flag] = []

        artefact: ConsentArtefact = (
            await connector.get_consent(consent_handle)
            if consent_handle
            else await connector.request_consent(customer_ref, purpose, months)
        )

        usable, reason = artefact.is_usable()
        if not usable:
            # A refused fetch is a normal outcome, not an error: the borrower is
            # entitled to revoke, and the platform must degrade to the document
            # path rather than fail.
            output = AaDataOutput(
                customer_ref=customer_ref,
                live_data=False,
                source=getattr(connector, "SOURCE", "sandbox"),
                consent=_summarise(artefact),
                flags=[
                    Flag(
                        type=FlagType.QUALITY,
                        detail=f"No data fetched. {reason}",
                        severity="medium",
                    )
                ],
                escalate=True,
                escalation_reason=(
                    f"{reason} Collect statements through the document path instead."
                ),
                reasoning_summary=(
                    f"Consent {artefact.consent_id} did not permit a fetch. {reason}"
                ),
            )
            return AgentResult(
                agent_id=self.id,
                output=output,
                steps=[AgentStep(name="check_consent", kind="connector")],
                validation=run_all(output, allow_pii_fields=self.allow_pii_fields),
            )

        data: FiData = await connector.fetch(artefact.consent_handle, purpose)

        transactions: list[Transaction] = []
        accounts: list[AccountSummary] = []
        for account in data.accounts:
            accounts.append(
                AccountSummary(
                    masked_account_number=account.masked_account_number,
                    fip_name=account.fip_name,
                    ifsc=account.ifsc,
                    account_type=account.account_type,
                    transaction_count=len(account.transactions),
                    opening_balance=account.opening_balance,
                    closing_balance=account.closing_balance,
                )
            )
            for row in account.transactions:
                transactions.append(
                    Transaction(
                        date=row.value_date,
                        narration=row.narration,
                        amount=row.amount,
                        # ReBIT says CREDIT/DEBIT; the analytics agent speaks
                        # lowercase. Translating here keeps one vocabulary
                        # downstream regardless of where the data came from.
                        direction="credit" if row.type == "CREDIT" else "debit",
                        balance=row.current_balance,
                        # No document id: this evidence did not come from one.
                        # The consent artefact is the provenance instead.
                        document_id=None,
                        page=None,
                    )
                )

        live = getattr(connector, "SOURCE", "sandbox") != "sandbox"
        if not live:
            flags.append(
                Flag(
                    type=FlagType.QUALITY,
                    detail=(
                        "Data came from the sandbox Account Aggregator. A licensed AA or "
                        "TSP arrangement is required before this is real bank data."
                    ),
                    severity="high",
                )
            )

        statements = max(1, len(accounts))
        output = AaDataOutput(
            customer_ref=customer_ref,
            live_data=live,
            source=getattr(connector, "SOURCE", "sandbox"),
            consent=_summarise(artefact),
            accounts=accounts,
            transaction_count=len(transactions),
            transactions=transactions,
            documents_avoided=statements,
            api_calls_avoided=statements * self.CALLS_PER_STATEMENT_VIA_DOCUMENTS,
            flags=flags,
            # Sandbox data must never silently underwrite a real decision.
            escalate=not live,
            escalation_reason=(
                None if live else "Sandbox Account Aggregator data must not be underwritten"
            ),
            reasoning_summary=(
                f"Fetched {len(transactions)} transactions across {len(accounts)} "
                f"account(s) under consent {artefact.consent_id} for "
                f"{artefact.purpose_text.lower()}. Structured at source, so no extraction "
                f"was needed — avoiding roughly "
                f"{statements * self.CALLS_PER_STATEMENT_VIA_DOCUMENTS} document API calls."
            ),
        )

        return AgentResult(
            agent_id=self.id,
            output=output,
            steps=[AgentStep(name="fetch_fi_data", kind="connector")],
            validation=run_all(output, allow_pii_fields=self.allow_pii_fields),
        )


def _summarise(artefact: ConsentArtefact) -> ConsentSummary:
    return ConsentSummary(
        consent_id=artefact.consent_id,
        status=str(artefact.status),
        purpose_code=str(artefact.purpose_code),
        purpose_text=artefact.purpose_text,
        data_range_from=artefact.data_range_from.isoformat(),
        data_range_to=artefact.data_range_to.isoformat(),
        expires_on=artefact.consent_expiry.date().isoformat(),
        retention_expires_on=artefact.retention_expires_on.isoformat(),
        fetches_used=artefact.fetch_count,
        fetches_permitted=artefact.frequency_value,
    )
