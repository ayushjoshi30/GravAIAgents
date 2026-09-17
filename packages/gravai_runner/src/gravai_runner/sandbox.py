"""Run a catalog agent by id.

The tool catalog in `tools.py` says which agents exist. This says how to
actually run one: it assembles whatever inputs the agent needs and returns the
`AgentResult`.

Both the MCP server and `scripts/run_agent.py` call this, so there is one
dispatcher rather than two that can drift apart.

Inputs come from the sandbox connectors. That is the honest position today:
every connector in `gravai_connectors` is sandbox-only or blocked on a
licensing step, so there is no production adapter to read from. When one
exists, `SandboxFixtures` is the seam to replace — the dispatch below does not
change.
"""

from __future__ import annotations

import math
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

from gravai_agents import (
    AaDataAgent,
    BankStatementAnalyticsAgent,
    CaseAllocationAgent,
    Counterparty,
    CreditAppraisalAgent,
    CustomerDataIntelligenceAgent,
    CustomerSignal,
    DocIntelligenceAgent,
    GstReturn,
    KycVerificationAgent,
    MsmeUnderwritingAgent,
    OnboardingAssistantAgent,
    OpsResearchAgent,
    RiskScoringAgent,
    SmartMandateAgent,
    SpeechAnalyticsAgent,
    VoiceCollectionsAgent,
    transactions_from_documents,
)
from gravai_agents.implementations.bank_statement_analytics import Transaction
from gravai_agents.volume_model import VolumeAssumptions
from gravai_agents.base import AgentContext
from gravai_connectors import (
    SandboxBre,
    SandboxCollections,
    SandboxDigilocker,
    SandboxGraviton,
)
from gravai_connectors.account_aggregator import SandboxAccountAggregator
from gravai_connectors.document_source import ParsedSource
from gravai_connectors.models import GravitonDocument

from .inputs import inputs_for

#: The call is placed at a fixed moment so a voice run is reproducible: the
#: conduct check depends on the local time of day.
CALL_TIME = datetime(2026, 9, 14, 6, 0, tzinfo=UTC)

DEFAULT_APPLICATION = "18302"
#: The application with outstanding documents, used by the support agent.
PENDING_APPLICATION = "18303"


def _amount(supplied: Any, from_document: Any) -> Decimal | None:
    """Prefer an explicit override, else what the document stated."""
    chosen = supplied if supplied is not None else from_document
    if chosen is None:
        return None
    return chosen if isinstance(chosen, Decimal) else Decimal(str(chosen))


def _text(supplied: Any, from_document: Any) -> str | None:
    chosen = supplied if supplied is not None else from_document
    return None if chosen is None else str(chosen)


class SandboxFixtures:
    """Assembles agent inputs, building each one at most once.

    Several agents consume another agent's output: risk scoring and credit
    appraisal both need the bank statement, which needs the documents read
    first. Asking for the statement twice must not read the documents twice.
    """

    def __init__(
        self,
        sarvam: Any,
        *,
        tenant_id: str,
        tenant_name: str,
        inputs: dict[str, Any] | None = None,
        agent_id: str = "",
        source: ParsedSource | None = None,
    ) -> None:
        self.sarvam = sarvam
        #: Real data fetched from an endpoint the tenant supplied. When it
        #: carries facts they replace the fixtures outright; the agents cannot
        #: tell the difference, which is the point of the seam.
        self.source = source
        #: ONLY what the caller actually supplied, validated. A field absent
        #: here means the source keeps it — that is the whole contract.
        self.inputs: dict[str, Any] = inputs or {}
        #: Which agent is running, so a declared default can be looked up
        #: rather than repeated as a constant in each runner below.
        self.agent_id = agent_id
        self.ctx = AgentContext(tenant_id=tenant_id, tenant_name=tenant_name)
        self.graviton = SandboxGraviton()
        self.collections = SandboxCollections()
        self._documents: Any = None
        self._statement: Any = None
        #: The statement-shaping inputs the cached statement was built from.
        #: Documents never depend on inputs, so they are cached outright; the
        #: statement does, so reusing it blindly across a workflow would hand a
        #: later node an analysis of somebody else's balances.
        self._statement_key: tuple[Any, ...] | None = None

    def value(self, name: str, fallback: Any = None) -> Any:
        """The value in play for a field with no source.

        Reads the declared default rather than repeating it, because a constant
        written here as well as in the declaration is a constant that will
        eventually disagree with itself.
        """
        if name in self.inputs:
            return self.inputs[name]
        if self.agent_id:
            declared = inputs_for(self.agent_id).unsourced_defaults()
            if name in declared:
                return declared[name]
        return fallback

    async def application(self, external_id: str = DEFAULT_APPLICATION) -> Any:
        """The application record, with anything the source supplied laid over it.

        The source is trusted over the fixture and the form is trusted over
        both, because the form is an explicit act and the source is data.
        """
        record = await self.graviton.get_application(external_id)
        if self.source and self.source.application:
            known = set(type(record).model_fields)
            supplied = {
                key: value
                for key, value in self.source.application.items()
                if key in known and value is not None
            }
            record = _rebuilt(record, supplied)
        return record

    async def documents(self) -> Any:
        """Read the documents in play, preferring the ones the caller supplied.

        The source wins over the fixtures for the same reason it does for the
        application record and the transactions above: it is the caller's real
        data, and the fixtures exist only to stand in when there is none.

        This used to list the sandbox application's documents unconditionally,
        which meant a run carrying uploaded files still read the fixtures — the
        uploads were resolved, passed in, and then quietly ignored in favour of
        a demo applicant. A run that reports on documents the caller did not
        send is worse than one that refuses: the output looks like an answer
        about their file.
        """
        if self._documents is None:
            supplied = tuple(self.source.documents) if self.source else ()
            refs = (
                [
                    GravitonDocument(
                        document_id=doc.document_id,
                        application_id=DEFAULT_APPLICATION,
                        # An upload has no Graviton uri. The blob reference it
                        # came from is deliberately not put here: it is resolved
                        # already, and this field is what the reader would fetch
                        # if the bytes were missing.
                        uri=f"upload://{doc.document_id}",
                        mime_type=doc.mime_type,
                        pages=doc.pages,
                        declared_type=doc.declared_type,
                        content=doc.content,
                    )
                    for doc in supplied
                ]
                if supplied
                else await self.graviton.list_documents(DEFAULT_APPLICATION)
            )
            self._documents = await DocIntelligenceAgent(self.sarvam).run(self.ctx, documents=refs)
        return self._documents

    async def statement(self) -> Any:
        """Analyse the statement, reconciling against what the statement says.

        The second return value of `transactions_from_documents` is the account
        context the reader pulled off the statement itself — its account number,
        its bank, its own stated opening and closing balance. Discarding it and
        substituting constants is what made reconciliation compare the form
        against itself and always succeed; the agent was adding up lines and
        checking them against a number nobody had read from the document.
        """
        key = tuple(
            self.inputs.get(name)
            for name in ("opening_balance", "closing_balance", "bank", "account_last4")
        )
        if self._statement is not None and self._statement_key != key:
            self._statement = None

        if self._statement is None:
            self._statement_key = key
            if self.source and self.source.transactions:
                # Real statement lines. Nothing about the analysis changes —
                # the categorisation, the income assessment and the
                # reconciliation are the same code over different numbers.
                transactions = [Transaction(**line) for line in self.source.transactions]
                context = dict(self.source.account)
            else:
                documents = await self.documents()
                transactions, context = transactions_from_documents(documents.output)

            account = str(
                self.inputs.get("account_last4") or context.get("account_number") or "0000"
            )
            self._statement = await BankStatementAnalyticsAgent(self.sarvam).run(
                self.ctx,
                transactions=transactions,
                account_last4=account[-4:],
                bank=_text(self.inputs.get("bank"), context.get("bank_name")),
                opening_balance=_amount(
                    self.inputs.get("opening_balance"), context.get("opening_balance")
                ),
                closing_balance=_amount(
                    self.inputs.get("closing_balance"), context.get("closing_balance")
                ),
            )
        return self._statement

    async def cases(self) -> Any:
        return await self.collections.list_cases()


async def _doc_intelligence(fx: SandboxFixtures) -> Any:
    return await fx.documents()


async def _bank_statement(fx: SandboxFixtures) -> Any:
    return await fx.statement()


async def _credit_appraisal(fx: SandboxFixtures) -> Any:
    application = _apply_application_inputs(await fx.application(), fx.inputs)
    return await CreditAppraisalAgent(fx.sarvam).run(
        fx.ctx,
        application=application,
        bre=SandboxBre(),
        bank_statement=(await fx.statement()).output,
    )


def _rebuilt(model: Any, overrides: dict[str, Any]) -> Any:
    """Return a copy of a record with fields replaced, re-validated.

    `model_copy(update=...)` is the obvious call here and it is the wrong one:
    it assigns without validating, so a rate typed as 11.0 lands in a Decimal
    field as a float and the run dies several layers down in the instalment
    maths, pointing at the arithmetic rather than at the form. Rebuilding
    through the model puts the failure at the boundary where the bad value
    entered, and `extra="forbid"` turns a field name that no longer exists into
    an error instead of an attribute nothing reads.
    """
    if not overrides:
        return model
    data = model.model_dump()
    data.update(overrides)
    return type(model).model_validate(data)


#: Inputs that belong to the application record, by the name they carry there.
APPLICATION_FIELDS = (
    "loan_amount",
    "tenure_months",
    "interest_rate_pct",
    "net_monthly_income",
    "existing_monthly_emi",
    "bureau_score",
    "enquiries_3m",
    "employment_vintage_months",
)


def _apply_application_inputs(application: Any, inputs: dict[str, Any]) -> Any:
    """Return the application with any supplied terms replaced.

    Inputs belonging to other parts of the run are ignored rather than
    rejected, because several agents share one input dictionary.
    """
    overrides = {
        field: inputs[field]
        for field in APPLICATION_FIELDS
        if inputs.get(field) is not None
    }
    return _rebuilt(application, overrides)


async def _risk_scoring(fx: SandboxFixtures) -> Any:
    """Score the supplied features.

    The agent derives its features from an application and a statement, so the
    supplied values are pushed onto those rather than handed over directly —
    which also means an unsupplied feature still comes from somewhere real, and
    that a derived feature like FOIR moves only through its real causes.
    """
    application = await fx.application()
    statement = (await fx.statement()).output

    if fx.inputs:
        application = _apply_application_inputs(application, fx.inputs)
        statement = _apply_statement_inputs(statement, fx.inputs)

    return await RiskScoringAgent(fx.sarvam).run(
        fx.ctx, application=application, bank_statement=statement
    )


def _apply_statement_inputs(statement: Any, inputs: dict[str, Any]) -> Any:
    """Push FOIR, stability and bounce count onto the statement the scorer reads."""
    updates: dict[str, Any] = {}

    stability = inputs.get("income_stability")
    if stability is not None:
        updates["income"] = _rebuilt(
            statement.income, {"income_stability_score": float(stability)}
        )

    bounces = inputs.get("bounces_6m")
    if bounces is not None:
        want = int(bounces)
        have = list(statement.bounces)
        if want <= len(have):
            updates["bounces"] = have[:want]
        elif have:
            updates["bounces"] = have + [have[-1]] * (want - len(have))

    return _rebuilt(statement, updates)


async def _kyc(fx: SandboxFixtures) -> Any:
    record = await SandboxDigilocker(fx.graviton).verify(DEFAULT_APPLICATION)
    return await KycVerificationAgent(fx.sarvam).run(
        fx.ctx,
        application=await fx.application(),
        kyc=record,
        declared_date_of_birth=record.date_of_birth,
    )


async def _aa_data(fx: SandboxFixtures) -> Any:
    return await AaDataAgent(fx.sarvam).run(
        fx.ctx, connector=SandboxAccountAggregator(), customer_ref="cust-18302"
    )


async def _case_allocation(fx: SandboxFixtures) -> Any:
    return await CaseAllocationAgent(fx.sarvam).run(fx.ctx, cases=await fx.cases())


async def _smart_mandate(fx: SandboxFixtures) -> Any:
    return await SmartMandateAgent(fx.sarvam).run(fx.ctx, cases=await fx.cases())


async def _voice(fx: SandboxFixtures) -> Any:
    """Place the call at the requested local time.

    CALL_TIME is UTC and the conduct rule is stated in IST, so the hour from
    the form is converted rather than substituted — setting 21 has to actually
    fall outside 08:00-19:00 IST for the refusal to mean anything.
    """
    cases = await fx.cases()
    case = cases[0]

    when = CALL_TIME
    hour = fx.value("hour_ist")
    if hour is not None:
        when = CALL_TIME.replace(hour=0, minute=0) + timedelta(
            hours=int(hour) - 5, minutes=-30
        )

    language = fx.inputs.get("language")
    if language:
        case = _rebuilt(case, {"language": str(language)})

    return await VoiceCollectionsAgent(fx.sarvam).run(
        fx.ctx,
        case=case,
        now=when,
        lender_name=str(fx.value("lender_name")),
    )


async def _speech(fx: SandboxFixtures) -> Any:
    call = await _voice(fx)
    transcript = [("agent", line.text) for line in call.output.script if not line.blocked]
    return await SpeechAnalyticsAgent(fx.sarvam).run(
        fx.ctx, call_id="C-1001-call", transcript=transcript
    )


async def _onboarding(fx: SandboxFixtures) -> Any:
    return await OnboardingAssistantAgent(fx.sarvam).run(
        fx.ctx,
        application=await fx.application(PENDING_APPLICATION),
        question=str(fx.value("question")),
        pendencies=await fx.graviton.list_pendencies(PENDING_APPLICATION),
    )


async def _msme(fx: SandboxFixtures) -> Any:
    gstin = str(fx.value("gstin"))
    monthly = Decimal(str(fx.value("monthly_taxable_value")))
    bank_credits = Decimal(str(fx.value("bank_credits_annual")))
    itr = Decimal(str(fx.value("itr_declared")))

    returns = [
        GstReturn(gstin=gstin, period=f"2026-{month:02d}", taxable_value=monthly)
        for month in range(1, 13)
    ]

    # Concentration is what the flag is computed from, so the split has to move
    # with the supplied share. Two buyers is not enough: the agent sorts by size
    # and takes the top one, so a share below half would describe the *other*
    # buyer and 0.3 would come back as 0.7. The remainder is therefore spread
    # across as many buyers as it takes for each to stay under the top one.
    annual = monthly * 12
    share = Decimal(str(fx.value("top_counterparty_share")))
    largest = (annual * share).quantize(Decimal("1"))
    remainder = annual - largest

    others = 1 if share >= 1 else max(1, math.ceil(float((1 - share) / share)))
    each = (remainder / others).quantize(Decimal("1"))

    counterparties = [Counterparty(name="Bharat Retail", inbound=largest)]
    counterparties += [
        Counterparty(name=f"Buyer {index + 2}", inbound=each) for index in range(others)
    ]

    return await MsmeUnderwritingAgent(fx.sarvam).run(
        fx.ctx,
        application_id="M-1",
        gst_returns=returns,
        bank_credits_annual=bank_credits,
        itr_declared=itr,
        counterparties=counterparties,
    )


async def _segments(fx: SandboxFixtures) -> Any:
    population = int(fx.value("population"))
    purpose = str(fx.value("purpose"))
    months = int(fx.value("months_on_book"))
    band = str(fx.value("risk_band"))

    # Every third customer lacks the consent being tested, which is what makes
    # the purpose-limitation exclusion visible rather than theoretical.
    signals = [
        CustomerSignal(
            customer_ref=f"C{index}",
            consent_purposes=[purpose] if index % 3 else ["underwriting"],
            months_on_book=months,
            original_principal=Decimal("1000000"),
            outstanding_principal=Decimal("400000"),
            emi_amount=Decimal("20000"),
            monthly_income=Decimal("100000"),
            risk_band=band,
        )
        for index in range(1, population + 1)
    ]
    return await CustomerDataIntelligenceAgent(fx.sarvam).run(
        fx.ctx, signals=signals, purpose=purpose
    )


async def _ops(fx: SandboxFixtures) -> Any:
    """Model the supplied volume.

    The agent takes a VolumeAssumptions, not loose keywords — passing them
    individually lands them in its **kwargs sink and they are silently dropped,
    which is a form that looks like it works and does nothing.

    Built by replacing fields on the calibrated assumptions rather than from
    scratch, so a field nobody touched keeps the production figure. Building it
    from scratch is how documents_per_month came to be a product of two integers
    that could not reach the calibrated 68,976, quietly inflating the whole
    model by a quarter.
    """
    if not fx.inputs:
        return await OpsResearchAgent(fx.sarvam).run(fx.ctx)

    base = VolumeAssumptions()
    assumptions = replace(
        base,
        applications_per_month=int(fx.value("applications_per_month", base.applications_per_month)),
        documents_per_month=int(fx.value("documents_per_month", base.documents_per_month)),
        pages_per_document=Decimal(str(fx.value("pages_per_document", base.pages_per_document))),
        job_seconds=float(fx.value("job_seconds", base.job_seconds)),
        rate_limit_per_minute=int(fx.value("rate_limit_per_minute", base.rate_limit_per_minute)),
    )
    return await OpsResearchAgent(fx.sarvam).run(fx.ctx, assumptions=assumptions)


#: agent id -> the callable that assembles its inputs and runs it.
RUNNERS = {
    "doc_intelligence": _doc_intelligence,
    "bank_statement_analytics": _bank_statement,
    "credit_appraisal": _credit_appraisal,
    "risk_scoring": _risk_scoring,
    "kyc_verification": _kyc,
    "aa_data": _aa_data,
    "case_allocation": _case_allocation,
    "smart_mandate": _smart_mandate,
    "voice_collections": _voice,
    "speech_analytics": _speech,
    "onboarding_assistant": _onboarding,
    "msme_underwriting": _msme,
    "customer_data_intelligence": _segments,
    "ops_research": _ops,
}

RUNNABLE: frozenset[str] = frozenset(RUNNERS)


class AgentNotRunnable(LookupError):
    """The catalog knows this agent, but nothing here can assemble its inputs."""


async def run_agent(
    agent_id: str,
    sarvam: Any,
    *,
    tenant_id: str = "acme",
    tenant_name: str = "Acme Finance Limited",
    fixtures: SandboxFixtures | None = None,
    inputs: dict[str, Any] | None = None,
    source: ParsedSource | None = None,
) -> Any:
    """Run one agent and return its `AgentResult`.

    `inputs` are validated against the agent's declared schema first, so a
    field the runner does not read cannot be silently accepted — which is the
    way a form quietly stops meaning anything. Only what the caller actually
    supplied survives validation: an omitted field is left to whatever supplies
    it, which is the source when there is one and the fixtures otherwise.

    `source` is real data fetched from an endpoint the tenant controls. Where
    it carries facts — statement lines, application fields — they replace the
    fixtures entirely, and every calculation downstream is the same code it
    always was.

    Pass `fixtures` to run several agents against one set of inputs, which also
    means the documents are read once rather than per agent.
    """
    runner = RUNNERS.get(agent_id)
    if runner is None:
        raise AgentNotRunnable(agent_id)

    resolved = inputs_for(agent_id).resolve(inputs)
    fx = fixtures or SandboxFixtures(
        sarvam,
        tenant_id=tenant_id,
        tenant_name=tenant_name,
        inputs=resolved,
        agent_id=agent_id,
        source=source,
    )
    # Applied unconditionally. Doing this only when the caller passed something
    # meant a supplied fixture kept an empty input set, so the MCP door and the
    # REST door disagreed about what "no input" means and returned different
    # risk bands for the same application.
    fx.inputs = resolved
    fx.agent_id = agent_id
    if source is not None:
        fx.source = source
    return await runner(fx)
