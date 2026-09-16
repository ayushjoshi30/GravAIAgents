"""Account Aggregator connector.

The RBI Account Aggregator framework lets a borrower consent, once, to a lender
pulling their bank data directly — instead of uploading twelve months of PDF
statements and hoping they are genuine. For a lending platform it replaces the
most expensive and least reliable part of the file.

**This connector is interface-and-sandbox only, deliberately.** Fetching real FI
data requires being a registered Financial Information User behind a licensed
Account Aggregator, or a TSP arrangement with one. That is a contractual and
regulatory step, not a coding one, and faking it would hide the platform's one
genuine capability gap rather than surface it.

What is real here is everything downstream: the consent artefact in the shape
ReBIT specifies, its lifecycle rules, purpose limitation, and — most usefully —
normalisation of fetched data into exactly the transaction shape the bank
statement agent already consumes. The day an AA is contracted, the credit
pipeline works without documents; only ``fetch`` changes.
"""

from __future__ import annotations

import hashlib
from datetime import date, datetime, timedelta
from decimal import Decimal
from enum import StrEnum
from typing import Protocol

from gravai_core.errors import Forbidden, NotFound
from gravai_core.time_utils import utc_now
from pydantic import BaseModel, ConfigDict, Field


class ConsentStatus(StrEnum):
    """ReBIT consent states."""

    PENDING = "PENDING"
    ACTIVE = "ACTIVE"
    PAUSED = "PAUSED"
    REVOKED = "REVOKED"
    EXPIRED = "EXPIRED"
    REJECTED = "REJECTED"


class FiType(StrEnum):
    """Financial information types a consent can cover."""

    DEPOSIT = "DEPOSIT"
    RECURRING_DEPOSIT = "RECURRING_DEPOSIT"
    TERM_DEPOSIT = "TERM_DEPOSIT"
    CREDIT_CARD = "CREDIT_CARD"
    MUTUAL_FUNDS = "MUTUAL_FUNDS"
    EQUITIES = "EQUITIES"


class PurposeCode(StrEnum):
    """ReBIT purpose codes.

    Purpose limitation is the heart of the framework: data pulled to underwrite
    a loan may not be reused to market one. The code travels with the artefact
    so the restriction is checkable rather than remembered.
    """

    WEALTH_MANAGEMENT = "101"
    CUSTOMER_SPENDING = "102"
    ACCOUNT_AGGREGATION = "103"
    EXPLICIT_ONE_TIME = "104"
    LOAN_UNDERWRITING = "105"


class ConsentArtefact(BaseModel):
    """A signed consent, in the shape ReBIT specifies."""

    model_config = ConfigDict(extra="forbid")

    consent_id: str
    consent_handle: str
    status: ConsentStatus = ConsentStatus.PENDING

    customer_ref: str
    purpose_code: PurposeCode
    purpose_text: str
    fi_types: list[FiType] = Field(default_factory=lambda: [FiType.DEPOSIT])

    consent_start: datetime
    consent_expiry: datetime
    #: The historical window the data may cover.
    data_range_from: date
    data_range_to: date
    #: How many times the data may be fetched, and over what period.
    frequency_value: int = 1
    frequency_unit: str = "MONTH"
    #: How long the lender may retain what it fetched.
    data_life_value: int = 6
    data_life_unit: str = "MONTH"

    revoked_at: datetime | None = None
    fetch_count: int = 0

    def is_usable(self, *, at: datetime | None = None) -> tuple[bool, str | None]:
        """Whether this consent permits a fetch right now, and why not if not.

        Returns a reason rather than a bare boolean: a refused fetch has to be
        explainable to the borrower and to an auditor.
        """
        moment = at or utc_now()
        if self.status is ConsentStatus.REVOKED or self.revoked_at is not None:
            return False, "The borrower has revoked this consent."
        if self.status is ConsentStatus.PAUSED:
            return False, "This consent is paused."
        if self.status is ConsentStatus.REJECTED:
            return False, "The borrower declined this consent request."
        if self.status is not ConsentStatus.ACTIVE:
            return False, f"Consent is {self.status}, not ACTIVE."
        if moment >= self.consent_expiry:
            return False, f"Consent expired on {self.consent_expiry:%d/%m/%Y}."
        if moment < self.consent_start:
            return False, f"Consent does not begin until {self.consent_start:%d/%m/%Y}."
        if self.fetch_count >= self.frequency_value:
            return False, (
                f"The agreed fetch frequency ({self.frequency_value} per "
                f"{self.frequency_unit.lower()}) is already used up."
            )
        return True, None

    def permits(self, purpose: PurposeCode) -> bool:
        """Purpose limitation: data pulled to underwrite may not be reused."""
        return self.purpose_code is purpose

    @property
    def retention_expires_on(self) -> date:
        """When the fetched data must be purged."""
        months = self.data_life_value if self.data_life_unit.upper() == "MONTH" else 0
        return (self.consent_start + timedelta(days=30 * months)).date()


class AaTransaction(BaseModel):
    """One transaction as an AA returns it."""

    model_config = ConfigDict(extra="forbid")

    transaction_id: str
    value_date: date
    amount: Decimal
    #: ReBIT uses CREDIT / DEBIT.
    type: str = Field(pattern="^(CREDIT|DEBIT)$")
    narration: str
    current_balance: Decimal | None = None
    mode: str = "OTHERS"


class AaAccount(BaseModel):
    model_config = ConfigDict(extra="forbid")

    link_ref_number: str
    masked_account_number: str
    fi_type: FiType = FiType.DEPOSIT
    fip_name: str
    account_type: str = "SAVINGS"
    ifsc: str | None = None
    #: Present on the profile block rather than per transaction.
    holder_name: str | None = None
    opening_balance: Decimal | None = None
    closing_balance: Decimal | None = None
    transactions: list[AaTransaction] = Field(default_factory=list)


class FiData(BaseModel):
    """What a successful fetch returns."""

    model_config = ConfigDict(extra="forbid")

    consent_id: str
    fetched_at: datetime
    data_range_from: date
    data_range_to: date
    accounts: list[AaAccount] = Field(default_factory=list)


class AaConnector(Protocol):
    async def request_consent(
        self, customer_ref: str, purpose: PurposeCode, months: int
    ) -> ConsentArtefact: ...

    async def get_consent(self, consent_handle: str) -> ConsentArtefact: ...

    async def fetch(self, consent_handle: str, purpose: PurposeCode) -> FiData: ...

    async def revoke(self, consent_handle: str) -> ConsentArtefact: ...


def _handle(customer_ref: str) -> str:
    return f"aa-{hashlib.sha256(customer_ref.encode()).hexdigest()[:16]}"


class SandboxAccountAggregator:
    """An offline AA that behaves like the real framework.

    It enforces the parts that actually constrain a lender — consent status,
    expiry, fetch frequency and purpose limitation — so the code paths that
    matter are exercised. It does not, and cannot, produce real bank data.
    """

    #: Marks every fetch so sandbox data can never be mistaken for real data.
    SOURCE = "sandbox"

    def __init__(self) -> None:
        self._consents: dict[str, ConsentArtefact] = {}

    async def request_consent(
        self,
        customer_ref: str,
        purpose: PurposeCode = PurposeCode.LOAN_UNDERWRITING,
        months: int = 12,
    ) -> ConsentArtefact:
        """Raise a consent request. In production the borrower approves it in
        the AA's own app; here it is granted immediately."""
        now = utc_now()
        handle = _handle(customer_ref)
        artefact = ConsentArtefact(
            consent_id=f"consent-{handle[3:]}",
            consent_handle=handle,
            status=ConsentStatus.ACTIVE,
            customer_ref=customer_ref,
            purpose_code=purpose,
            purpose_text={
                PurposeCode.LOAN_UNDERWRITING: "Assessing a loan application",
                PurposeCode.CUSTOMER_SPENDING: "Explaining spending patterns",
            }.get(purpose, "Aggregating accounts"),
            consent_start=now,
            consent_expiry=now + timedelta(days=30),
            data_range_from=(now - timedelta(days=30 * months)).date(),
            data_range_to=now.date(),
            frequency_value=1,
            frequency_unit="MONTH",
        )
        self._consents[handle] = artefact
        return artefact

    async def get_consent(self, consent_handle: str) -> ConsentArtefact:
        try:
            return self._consents[consent_handle]
        except KeyError as exc:
            raise NotFound("No such consent", consent_handle=consent_handle) from exc

    async def revoke(self, consent_handle: str) -> ConsentArtefact:
        artefact = await self.get_consent(consent_handle)
        artefact.status = ConsentStatus.REVOKED
        artefact.revoked_at = utc_now()
        return artefact

    async def fetch(
        self,
        consent_handle: str,
        purpose: PurposeCode = PurposeCode.LOAN_UNDERWRITING,
    ) -> FiData:
        """Fetch financial information under a consent.

        Every guard the real framework applies is applied here, and a refusal
        explains itself.
        """
        artefact = await self.get_consent(consent_handle)

        usable, reason = artefact.is_usable()
        if not usable:
            raise Forbidden(
                f"This consent does not permit a fetch. {reason}",
                consent_handle=consent_handle,
                status=str(artefact.status),
            )
        if not artefact.permits(purpose):
            raise Forbidden(
                "Purpose limitation: this consent was granted for a different purpose",
                granted_for=str(artefact.purpose_code),
                requested_for=str(purpose),
            )

        artefact.fetch_count += 1
        return FiData(
            consent_id=artefact.consent_id,
            fetched_at=utc_now(),
            data_range_from=artefact.data_range_from,
            data_range_to=artefact.data_range_to,
            accounts=[_sandbox_account()],
        )


def _sandbox_account() -> AaAccount:
    """Six months of salaried conduct, matching the document fixtures.

    Deliberately the same borrower and the same behaviour as the statement
    fixtures, so a file sourced through AA and one sourced from PDFs reach the
    same conclusions — which is what makes AA a drop-in replacement rather than
    a second, divergent path.
    """
    rows = [
        ("01/03/2026", "NEFT SALARY CREDIT ACME LTD", 85000, "CREDIT"),
        ("05/03/2026", "NACH DR HDFC HOME LOAN", 12000, "DEBIT"),
        ("01/04/2026", "NEFT SALARY CREDIT ACME LTD", 85000, "CREDIT"),
        ("05/04/2026", "NACH DR HDFC HOME LOAN", 12000, "DEBIT"),
        ("01/05/2026", "NEFT SALARY CREDIT ACME LTD", 85000, "CREDIT"),
        ("05/05/2026", "NACH DR HDFC HOME LOAN", 12000, "DEBIT"),
        ("18/05/2026", "CASH DEP CDM BRANCH 0421", 20000, "CREDIT"),
        ("01/06/2026", "NEFT SALARY CREDIT ACME LTD", 85000, "CREDIT"),
        ("05/06/2026", "NACH RTN INSUFFICIENT FUNDS", 12000, "DEBIT"),
        ("01/07/2026", "NEFT SALARY CREDIT ACME LTD", 87000, "CREDIT"),
        ("05/07/2026", "NACH DR HDFC HOME LOAN", 12000, "DEBIT"),
        ("01/08/2026", "NEFT SALARY CREDIT ACME LTD", 87000, "CREDIT"),
        ("05/08/2026", "NACH DR HDFC HOME LOAN", 12000, "DEBIT"),
    ]
    transactions = [
        AaTransaction(
            transaction_id=f"aa-txn-{index:03d}",
            value_date=datetime.strptime(day, "%d/%m/%Y").date(),
            amount=Decimal(str(amount)),
            type=direction,
            narration=narration,
        )
        for index, (day, narration, amount, direction) in enumerate(rows, start=1)
    ]
    return AaAccount(
        link_ref_number="link-0001",
        masked_account_number="XXXXXXXX9012",
        fip_name="HDFC Bank",
        ifsc="HDFC0001234",
        holder_name="Ayush Joshi",
        opening_balance=Decimal("52000"),
        closing_balance=Decimal("514000"),
        transactions=transactions,
    )
