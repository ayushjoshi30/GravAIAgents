"""Usage, cost and throughput.

The live version of the spreadsheet volume model. Three questions it answers
that a document count cannot: what did we actually spend, how much of the
10 req/min ceiling are we using, and how long would the backlog take to drain.
"""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from gravai_core.auth import Scope
from gravai_core.models import AgentRun, CostLedger
from gravai_core.repositories import tenant_query
from gravai_core.time_utils import utc_now
from pydantic import BaseModel, Field
from sqlalchemy import func

from ..deps import Config, DbSession, Sarvam, require_scope

router = APIRouter(prefix="/v1/usage", tags=["usage"])


#: Internal product keys to the labels a user sees. The console never names the
#: AI vendor, so the mapping lives here rather than in the ledger.
PRODUCT_LABELS: dict[str, str] = {
    "docai_extract": "Document extraction",
    "docai_digitise": "Document digitisation",
    "llm_input": "Model input tokens",
    "llm_output": "Model output tokens",
    "stt": "Speech to text",
    "tts": "Text to speech",
    "translate": "Translation",
}


class ProductUsage(BaseModel):
    product: str
    label: str = Field(description="Display name; the console shows this, not the key")
    calls: int
    input_tokens: int
    output_tokens: int
    pages: int
    audio_seconds: Decimal
    cost_inr: Decimal


class UsageSummary(BaseModel):
    window_days: int
    sandbox_excluded: bool = Field(description="Sandbox rows are never mixed into a real figure")
    total_calls: int
    total_cost_inr: Decimal
    by_product: list[ProductUsage]
    by_agent: dict[str, Decimal]
    runs: int
    escalated_runs: int
    provisional_rates: list[str] = Field(
        description="Products priced from a placeholder rate; confirm before budgeting"
    )
    provisional_rate_labels: list[str] = Field(
        default_factory=list, description="The same, as the console displays them"
    )


class ThroughputPanel(BaseModel):
    """Live governor state and what it implies for capacity."""

    product: str = "docai"
    configured_limit_per_minute: float = Field(
        description="The vendor ceiling. All capacity arithmetic below uses this."
    )
    active_limit_per_minute: float = Field(
        description="What the governor is enforcing right now. Lower than configured "
        "never happens; higher means enforcement is suspended (sandbox)."
    )
    throttling_enforced: bool = Field(
        description="False in sandbox, where no vendor quota is being consumed"
    )
    available_now: float
    queue_depth: int
    tenants_waiting: int
    estimated_wait_seconds: float
    served_total: int
    served_by_tenant: dict[str, int]

    polls_count_toward_limit: bool = Field(
        description="Unverified with the vendor; the conservative default counts them"
    )
    calls_per_document_extract: int
    calls_per_document_digitise: int
    quota_units_per_document: int
    documents_per_hour: float
    documents_per_business_month: float = Field(
        description="8 hours x 22 working days at the current ceiling"
    )


class BacklogScenario(BaseModel):
    """One assumption about what consumes quota, and what it implies."""

    assumption: str
    quota_units_per_document: int
    total_quota_units: int
    days_continuous: float = Field(description="Running day and night, no pause")
    business_days: float = Field(description="At 8 working hours a day")


class BacklogProjection(BaseModel):
    documents: int
    limit_per_minute: float
    #: The scenario matching the current configuration.
    active: BacklogScenario
    #: Both readings of the open question, side by side.
    scenarios: list[BacklogScenario]
    spread_factor: float = Field(description="How many times longer the conservative reading takes")
    note: str


@router.get("/summary", response_model=UsageSummary, summary="Consumption and cost")
async def summary(
    session: DbSession,
    sarvam: Sarvam,
    _: Annotated[object, Depends(require_scope(Scope.USAGE_READ))],
    days: Annotated[int, Query(ge=1, le=366)] = 30,
    include_sandbox: bool = False,
) -> UsageSummary:
    """Spend and volume for the caller's tenant over a window."""
    since = utc_now() - timedelta(days=days)

    ledger = tenant_query(CostLedger).where(CostLedger.created_at >= since)
    if not include_sandbox:
        ledger = ledger.where(CostLedger.sandbox.is_(False))

    by_product_stmt = ledger.with_only_columns(
        CostLedger.product,
        func.count(CostLedger.id),
        func.coalesce(func.sum(CostLedger.input_tokens), 0),
        func.coalesce(func.sum(CostLedger.output_tokens), 0),
        func.coalesce(func.sum(CostLedger.pages), 0),
        func.coalesce(func.sum(CostLedger.audio_seconds), 0),
        func.coalesce(func.sum(CostLedger.cost_inr), 0),
    ).group_by(CostLedger.product)

    rows = (await session.execute(by_product_stmt)).all()
    by_product = [
        ProductUsage(
            product=row[0],
            label=PRODUCT_LABELS.get(row[0], row[0].replace("_", " ").title()),
            calls=row[1],
            input_tokens=int(row[2]),
            output_tokens=int(row[3]),
            pages=int(row[4]),
            audio_seconds=Decimal(str(row[5])),
            cost_inr=Decimal(str(row[6])),
        )
        for row in rows
    ]

    by_agent_stmt = ledger.with_only_columns(
        CostLedger.agent_id, func.coalesce(func.sum(CostLedger.cost_inr), 0)
    ).group_by(CostLedger.agent_id)
    by_agent = {
        (row[0] or "unattributed"): Decimal(str(row[1]))
        for row in (await session.execute(by_agent_stmt)).all()
    }

    runs_stmt = tenant_query(AgentRun).where(AgentRun.started_at >= since)
    total_runs = (
        await session.execute(runs_stmt.with_only_columns(func.count(AgentRun.id)))
    ).scalar_one()
    escalated = (
        await session.execute(
            runs_stmt.where(AgentRun.escalated.is_(True)).with_only_columns(func.count(AgentRun.id))
        )
    ).scalar_one()

    return UsageSummary(
        window_days=days,
        sandbox_excluded=not include_sandbox,
        total_calls=sum(p.calls for p in by_product),
        total_cost_inr=sum((p.cost_inr for p in by_product), Decimal("0")),
        by_product=sorted(by_product, key=lambda p: p.cost_inr, reverse=True),
        by_agent=by_agent,
        runs=int(total_runs or 0),
        escalated_runs=int(escalated or 0),
        provisional_rates=[p.value for p in sarvam.rate_card.provisional_products()],
        provisional_rate_labels=[
            PRODUCT_LABELS.get(p.value, p.value) for p in sarvam.rate_card.provisional_products()
        ],
    )


@router.get("/throughput", response_model=ThroughputPanel, summary="Live quota state")
async def throughput(
    sarvam: Sarvam,
    settings: Config,
    _: Annotated[object, Depends(require_scope(Scope.USAGE_READ))],
    job_seconds: Annotated[float, Query(gt=0, le=600)] = 30.0,
) -> ThroughputPanel:
    """What the ceiling allows, and what it is currently doing.

    ``job_seconds`` is how long a document takes on Sarvam's side; it sets the
    poll count and therefore the quota cost of a document.
    """
    stats = sarvam.governor.stats("docai")
    units = settings.docai_quota_units_per_document(job_seconds, digitise=False)
    per_minute = settings.sarvam_docai_rpm
    documents_per_hour = (per_minute * 60) / units if units else 0.0

    return ThroughputPanel(
        # Capacity is always computed from the configured vendor ceiling, never
        # from whatever the governor happens to be enforcing, so a sandbox run
        # cannot report a throughput the account does not actually have.
        configured_limit_per_minute=float(per_minute),
        active_limit_per_minute=stats.capacity,
        throttling_enforced=not sarvam.sandbox,
        available_now=stats.available,
        queue_depth=stats.queue_depth,
        tenants_waiting=stats.tenants_waiting,
        estimated_wait_seconds=stats.estimated_wait_seconds,
        served_total=stats.served,
        served_by_tenant=stats.served_by_tenant,
        polls_count_toward_limit=settings.sarvam_docai_polls_count_toward_limit,
        calls_per_document_extract=settings.docai_calls_per_document(job_seconds, digitise=False),
        calls_per_document_digitise=settings.docai_calls_per_document(job_seconds, digitise=True),
        quota_units_per_document=units,
        documents_per_hour=round(documents_per_hour, 1),
        documents_per_business_month=round(documents_per_hour * 8 * 22, 0),
    )


@router.get("/backlog", response_model=BacklogProjection, summary="Backlog drain time")
async def backlog(
    settings: Config,
    _: Annotated[object, Depends(require_scope(Scope.USAGE_READ))],
    documents: Annotated[int, Query(ge=1)] = 2_644_052,
    job_seconds: Annotated[float, Query(gt=0, le=600)] = 30.0,
    digitise: bool = False,
) -> BacklogProjection:
    """How long a backlog takes against the ceiling.

    The default is the production backlog figure. The answer is usually the
    finding: throughput, not price, is the binding constraint.
    """
    per_minute = float(settings.sarvam_docai_rpm)
    polls = settings.docai_poll_schedule.expected_polls(job_seconds)

    def scenario(label: str, units: int) -> BacklogScenario:
        total = documents * units
        hours = (total / per_minute) / 60
        return BacklogScenario(
            assumption=label,
            quota_units_per_document=units,
            total_quota_units=total,
            days_continuous=round(hours / 24, 1),
            business_days=round(hours / 8, 1),
        )

    counted = scenario(
        f"status polls count against the limit (submit + {polls} polls + results"
        + (" + 1 LLM read)" if digitise else ")"),
        1 + polls + 1,
    )
    free = scenario("status polls are free (submit only)", 1)

    active = counted if settings.sarvam_docai_polls_count_toward_limit else free

    return BacklogProjection(
        documents=documents,
        limit_per_minute=per_minute,
        active=active,
        scenarios=[counted, free],
        spread_factor=round(counted.total_quota_units / max(free.total_quota_units, 1), 1),
        note=(
            "These two answers differ by the factor above, and which one is true is "
            "not documented — it is the single highest-value question to put to "
            "Sarvam (DECISIONS.md D-005). Note also that adding workers changes "
            "neither: the ceiling is per account, not per worker."
        ),
    )
