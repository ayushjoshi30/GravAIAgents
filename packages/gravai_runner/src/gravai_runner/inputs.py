"""What you are allowed to change about a run, declared once.

The console renders a form from this, the API validates against it, and the
runner reads the values back out. One definition, so a field cannot appear in
the UI that the runner ignores — which is the failure mode of describing the
same inputs in three places.

**A field here is an override, not an input.** That distinction is the whole
design. Most of these values have a real source: the bank statement states its
own opening balance, the application record holds the loan terms and the bureau
score, the statement's transactions imply the bounce count. Those fields are
marked `sourced`, and leaving one blank means *use what the source says* — the
declared `default` is a hint for the form and is never applied.

Filling one in means *pretend the source said this instead*, which is a
legitimate way to test a decision rule and a dishonest way to present a result,
so the runner reports which values were overridden and which were read.

The fields that are not `sourced` are the ones no document contains: a proposed
loan term has no source until someone proposes it, a call has no hour until
someone schedules it, a capacity model has no assumptions until someone assumes
them. For those, blank genuinely means the default.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any, Literal

FieldKind = Literal["number", "money", "text", "textarea", "select"]


@dataclass(frozen=True, slots=True)
class InputField:
    """One overridable value."""

    name: str
    label: str
    kind: FieldKind
    default: Any
    #: Shown under the field. Say what the number means, not what type it is.
    help: str = ""
    minimum: float | None = None
    maximum: float | None = None
    choices: tuple[str, ...] = ()
    #: True when a real source supplies this value, so an omitted field reads
    #: from that source rather than from `default`.
    sourced: bool = False
    #: Where a sourced value comes from, in words a reader recognises.
    source_label: str = ""

    def coerce(self, raw: Any) -> Any:
        """Turn a form value into what the agent expects, or raise ValueError.

        Only ever called with a value someone actually supplied: `resolve`
        drops blanks before reaching here, because turning a blank into a
        default at this level is what made an omitted field overwrite the very
        document it was supposed to be read from.
        """
        if self.kind == "number":
            try:
                value = float(raw)
            except (TypeError, ValueError) as exc:
                raise ValueError(f"{self.label} must be a number") from exc
            if self.minimum is not None and value < self.minimum:
                raise ValueError(f"{self.label} must be at least {self.minimum:g}")
            if self.maximum is not None and value > self.maximum:
                raise ValueError(f"{self.label} must be at most {self.maximum:g}")
            return int(value) if float(value).is_integer() else value
        if self.kind == "money":
            try:
                value = Decimal(str(raw))
            except (InvalidOperation, TypeError) as exc:
                raise ValueError(f"{self.label} must be an amount") from exc
            if value < 0:
                raise ValueError(f"{self.label} cannot be negative")
            return value
        if self.kind == "select":
            text = str(raw)
            if self.choices and text not in self.choices:
                raise ValueError(f"{self.label} must be one of {', '.join(self.choices)}")
            return text
        return str(raw)

    @property
    def blank_means(self) -> str:
        """What leaving this field alone does, for the form to say out loud."""
        if self.sourced:
            return (
                f"read from the {self.source_label}" if self.source_label else "read from the source"
            )
        return f"use {self.default}"


def _is_blank(raw: Any) -> bool:
    return raw is None or (isinstance(raw, str) and not raw.strip())


@dataclass(frozen=True, slots=True)
class AgentInputs:
    """The overridable surface of one agent."""

    fields: tuple[InputField, ...] = ()
    #: Why some of this agent's values are not overridable, where that is true.
    caveat: str = ""

    def defaults(self) -> dict[str, Any]:
        """The declared defaults, for display only.

        Deliberately not fed into a run: for a `sourced` field the default is a
        hint about the shape of the value, not a value anyone chose.
        """
        return {f.name: f.default for f in self.fields}

    def unsourced_defaults(self) -> dict[str, Any]:
        """The defaults that genuinely apply when a field is left blank."""
        return {f.name: f.coerce(f.default) for f in self.fields if not f.sourced}

    def resolve(self, supplied: dict[str, Any] | None) -> dict[str, Any]:
        """Validate what the caller actually supplied, and only that.

        Filling the gaps with declared defaults here is the obvious move and it
        is the wrong one: it makes "the caller said nothing" indistinguishable
        from "the caller asked for 712", and the runner then overwrites whatever
        the documents and the application record actually said with a constant.
        A blank field must stay absent so that the source keeps it.
        """
        supplied = supplied or {}
        by_name = {f.name: f for f in self.fields}
        unknown = set(supplied) - set(by_name)
        if unknown:
            raise ValueError(f"Unknown input(s): {', '.join(sorted(unknown))}")

        return {
            name: by_name[name].coerce(raw)
            for name, raw in supplied.items()
            if not _is_blank(raw)
        }


#: Why a document upload changes nothing while the reader is sandboxed.
SANDBOX_DOCUMENT_CAVEAT = (
    "Document reading is sandboxed: the fake reader returns a fixed extraction "
    "for each declared document type and never looks at the file. Configure a "
    "document-AI key, or point the run at a document source that returns "
    "already-extracted facts, and this becomes real."
)

_LLM_CAVEAT = (
    "The figures are computed in code and are real for the values in play. The "
    "prose is written by the language model, which is sandboxed here, so the "
    "wording is canned even when the numbers are not."
)

_OVERRIDE_CAVEAT = (
    "Every field here has a real source, so leaving one blank reads the value "
    "from the documents and the application record. Filling one in overrides "
    "that source for this run — useful for testing a rule, but the result is "
    "then partly your assumption rather than a reading of the file, and the run "
    "reports which values were overridden."
)

_LOS = "application record"
_STATEMENT = "bank statement"
_BUREAU = "bureau report"


AGENT_INPUTS: dict[str, AgentInputs] = {
    "risk_scoring": AgentInputs(
        fields=(
            InputField(
                "bureau_score", "Bureau score", "number", 712, "CIBIL or equivalent", 300, 900,
                sourced=True, source_label=_BUREAU,
            ),
            InputField(
                "loan_amount", "Loan amount", "money", "1000000",
                "Drives the instalment, and so the FOIR",
                sourced=True, source_label=_LOS,
            ),
            InputField(
                "tenure_months", "Tenure", "number", 60, "Months", 1, 480,
                sourced=True, source_label=_LOS,
            ),
            InputField(
                "interest_rate_pct", "Interest rate", "number", 11.0, "Annual %", 0, 60,
                sourced=True, source_label=_LOS,
            ),
            InputField(
                "bounces_6m", "Bounces in 6 months", "number", 1, "Returned mandates", 0, 50,
                sourced=True, source_label=_STATEMENT,
            ),
            InputField(
                "income_stability", "Income stability", "number", 0.989,
                "1.0 is a perfectly regular salary", 0, 1,
                sourced=True, source_label=_STATEMENT,
            ),
            InputField(
                "enquiries_3m", "Enquiries in 3 months", "number", 3, "Bureau enquiries", 0, 50,
                sourced=True, source_label=_BUREAU,
            ),
            InputField(
                "employment_vintage_months", "Employment vintage", "number", 28,
                "Months with the current employer", 0, 600,
                sourced=True, source_label=_LOS,
            ),
        ),
        caveat=(
            "The probability and the driver contributions come from a versioned "
            "scorecard in code, so these are real answers to the values in play. "
            "FOIR is not a field because the scorecard derives it: the instalment "
            "implied by the loan terms, measured against the income and "
            "obligations read from the bank statement. " + _OVERRIDE_CAVEAT
        ),
    ),
    "credit_appraisal": AgentInputs(
        fields=(
            InputField(
                "loan_amount", "Loan amount", "money", "1000000", "Principal requested",
                sourced=True, source_label=_LOS,
            ),
            InputField(
                "tenure_months", "Tenure", "number", 60, "Months", 1, 480,
                sourced=True, source_label=_LOS,
            ),
            InputField(
                "interest_rate_pct", "Interest rate", "number", 11.0, "Annual %", 0, 60,
                sourced=True, source_label=_LOS,
            ),
            InputField(
                "net_monthly_income", "Declared monthly income", "money", "85000",
                "The figure on the application, which the statement is checked against",
                sourced=True, source_label=_LOS,
            ),
            InputField(
                "existing_monthly_emi", "Existing EMI", "money", "12000", "Current obligations",
                sourced=True, source_label=_LOS,
            ),
            InputField(
                "bureau_score", "Bureau score", "number", 712, "Feeds the policy rules", 300, 900,
                sourced=True, source_label=_BUREAU,
            ),
        ),
        caveat=_OVERRIDE_CAVEAT + " " + _LLM_CAVEAT,
    ),
    "bank_statement_analytics": AgentInputs(
        fields=(
            InputField(
                "opening_balance", "Opening balance", "money", "52000", "",
                sourced=True, source_label=_STATEMENT,
            ),
            InputField(
                "closing_balance", "Closing balance", "money", "514000", "",
                sourced=True, source_label=_STATEMENT,
            ),
            InputField(
                "bank", "Bank", "text", "HDFC Bank", "Lender detection reads real lender names",
                sourced=True, source_label=_STATEMENT,
            ),
            InputField(
                "account_last4", "Account (last 4)", "text", "9012", "",
                sourced=True, source_label=_STATEMENT,
            ),
        ),
        caveat=(
            "Reconciliation is genuine arithmetic: the agent adds up the "
            "statement's own lines and checks them against the statement's stated "
            "opening and closing balance. Override a balance and you are asking "
            "whether the lines add up to a figure the statement does not claim, "
            "which is how you make reconciliation fail on purpose. All four of "
            "these also appear in the agent's output, so an overridden one is "
            "your own value echoed back — the run labels it as such."
        ),
    ),
    "msme_underwriting": AgentInputs(
        fields=(
            InputField("gstin", "GSTIN", "text", "27AAPFU0939F1ZV", "Checksum is genuinely validated"),
            InputField(
                "monthly_taxable_value", "GST taxable value per month", "money", "500000",
                "Applied to twelve filings",
            ),
            InputField("bank_credits_annual", "Bank credits (annual)", "money", "6000000", ""),
            InputField("itr_declared", "ITR declared", "money", "5800000", ""),
            InputField(
                "top_counterparty_share", "Largest buyer share", "number", 0.5,
                "0 to 1; drives the concentration flag", 0, 1,
            ),
        ),
        caveat=(
            "Every ratio, the seasonality measure and the concentration flag are "
            "arithmetic over these values, so the answers are real. These are "
            "typed rather than read because this build has no GST or ITR "
            "connector: nothing fetches a filing, so a blank field has no source "
            "to fall back to."
        ),
    ),
    "ops_research": AgentInputs(
        fields=(
            InputField(
                "applications_per_month", "Applications per month", "number", 3533, "", 1, 10_000_000
            ),
            InputField(
                "documents_per_month", "Documents per month", "number", 68976,
                "Asked for directly: a per-application figure cannot express the calibrated 19.52",
                1, 500_000_000,
            ),
            InputField("pages_per_document", "Pages per document", "number", 3.0, "", 0.1, 500),
            InputField(
                "rate_limit_per_minute", "Rate ceiling", "number", 10, "Requests per minute", 1, 10_000
            ),
            InputField("job_seconds", "Job duration", "number", 30.0, "Seconds per document job", 1, 600),
        ),
        caveat=(
            "A capacity model, so every field is an assumption by definition — "
            "there is nothing to read these from. The defaults are the calibrated "
            "production book, and the arithmetic over whatever you put in is exact."
        ),
    ),
    "onboarding_assistant": AgentInputs(
        fields=(
            InputField(
                "question",
                "Applicant question",
                "textarea",
                "What is happening with my loan application?",
                "Answered only from what the file contains",
            ),
        ),
        caveat=_LLM_CAVEAT,
    ),
    "voice_collections": AgentInputs(
        fields=(
            InputField(
                "hour_ist", "Call time", "number", 11,
                "Hour of day, IST. Outside 08:00-19:00 the call is refused", 0, 23,
            ),
            InputField(
                "language", "Language", "select", "en-IN", "",
                choices=("en-IN", "hi-IN", "ta-IN", "te-IN", "mr-IN"),
                sourced=True, source_label="collections case",
            ),
            InputField("lender_name", "Lender name", "text", "Acme Finance", "Disclosed on the call"),
        ),
        caveat=(
            "The calling-window and conduct checks are real: set the hour to 21 "
            "and the agent refuses to place the call. The hour and the lender name "
            "are operational settings rather than facts on file, so they have no "
            "source to read from."
        ),
    ),
    "customer_data_intelligence": AgentInputs(
        fields=(
            InputField("population", "Customers", "number", 9, "Size of the book to segment", 1, 5000),
            InputField(
                "purpose", "Purpose", "select", "marketing", "Consent is checked against this",
                choices=("marketing", "underwriting", "collections"),
            ),
            InputField("months_on_book", "Months on book", "number", 18, "", 0, 600),
            InputField(
                "risk_band", "Risk band", "select", "GREEN", "", choices=("GREEN", "AMBER", "RED")
            ),
        ),
        caveat=(
            "Consent filtering and every segment rule are applied in code. The "
            "customer book itself is generated from these parameters rather than "
            "read from a CRM, so this shows the rules working rather than a real "
            "portfolio."
        ),
    ),
    # Agents whose values are wholly source-shaped are listed with no fields
    # rather than omitted, so the console can say why instead of showing nothing.
    "doc_intelligence": AgentInputs(caveat=SANDBOX_DOCUMENT_CAVEAT),
    "kyc_verification": AgentInputs(
        caveat=(
            "Identity is checked against the sandbox DigiLocker record, which is "
            "generated from the application rather than fetched. A real connector "
            "is what makes this overridable."
        )
    ),
    "aa_data": AgentInputs(
        caveat=(
            "Account Aggregator data requires a licensed AA or TSP. The consent "
            "artefact and the fetch are simulated, so there is nothing real to vary."
        )
    ),
    "case_allocation": AgentInputs(
        caveat="Cases come from the sandbox collections system; a real LOS connector makes these overridable."
    ),
    "smart_mandate": AgentInputs(caveat="As above: the case book is fixture-shaped."),
    "speech_analytics": AgentInputs(
        caveat="Scores the transcript produced by the voice agent, so vary that run instead."
    ),
}


def inputs_for(agent_id: str) -> AgentInputs:
    return AGENT_INPUTS.get(agent_id, AgentInputs())


def editable_agents() -> list[str]:
    return sorted(k for k, v in AGENT_INPUTS.items() if v.fields)
