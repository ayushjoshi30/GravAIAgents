"""Agent runs.

Executing an agent, and reading back what it did. A run is the unit the console
renders and the auditor follows, so everything an agent produced — output,
steps, cost, validator verdict — is written in one transaction.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Query, status
from gravai_agents import run_credit_pipeline
from gravai_core.auth import Scope
from gravai_core.errors import NotFound, ValidationFailed
from gravai_core.models import AgentRun, AgentStep, Application
from gravai_core.repositories import get_or_404, tenant_query
from gravai_core.runs import persist_run
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..deps import Bre, CurrentPrincipal, DbSession, Graviton, Sarvam, require_scope

router = APIRouter(prefix="/v1/runs", tags=["runs"])
appraise_router = APIRouter(prefix="/v1/applications", tags=["runs"])


class StepOut(BaseModel):
    seq: int
    name: str
    kind: str
    model: str | None
    prompt_version: str | None
    input_tokens: int
    output_tokens: int
    pages: int
    latency_ms: int
    cost_inr: Decimal
    attempts: int
    estimated_usage: bool
    validation: list[str]

    model_config = {"from_attributes": True}


class RunOut(BaseModel):
    id: UUID
    agent_id: str
    application_id: UUID | None
    status: str
    escalated: bool
    escalation_reason: str | None
    cost_inr: Decimal
    #: Vendor-neutral on the wire: the console never names the AI provider.
    api_calls: int = Field(validation_alias="sarvam_calls")
    started_at: datetime
    finished_at: datetime | None

    model_config = {"from_attributes": True, "populate_by_name": True}


class RunDetail(RunOut):
    output: dict[str, Any]
    validation: dict[str, Any]
    steps: list[StepOut] = Field(default_factory=list)


class AppraisalSummary(BaseModel):
    """What one credit pipeline produced, as the console's header renders it."""

    application_id: UUID
    external_id: str
    run_ids: list[UUID]
    documents_read: int
    pages_read: int
    api_calls: int = Field(
        description="Total document-intelligence API calls including status polls, "
        "which are the majority"
    )
    cost_inr: Decimal
    verified_monthly_income: Decimal | None = None
    total_monthly_emi: Decimal | None = None
    bounces: int = 0
    reconciled: bool | None = None
    proposed_emi: Decimal | None = None
    foir_display: str | None = None
    ltv_display: str | None = None
    bre_outcome: str | None = None
    deviations: list[str] = Field(default_factory=list)
    recommendation: str | None = None
    escalated: bool = True
    warnings: list[str] = Field(default_factory=list)


@appraise_router.post(
    "/{application_id}/appraise",
    response_model=AppraisalSummary,
    status_code=status.HTTP_201_CREATED,
    summary="Run the credit pipeline",
)
async def appraise(
    application_id: UUID,
    session: DbSession,
    principal: CurrentPrincipal,
    sarvam: Sarvam,
    graviton: Graviton,
    bre: Bre,
    _: Annotated[object, Depends(require_scope(Scope.AGENTS_RUN))],
) -> AppraisalSummary:
    """Read the documents, assess the statements, and appraise.

    Advisory: the appraisal always escalates to an underwriter, and a task is
    created for them. Nothing here approves a loan.
    """
    application = await get_or_404(session, Application, application_id)

    try:
        result = await run_credit_pipeline(
            sarvam,
            application_id=application.external_id,
            tenant_id=str(principal.tenant_id),
            tenant_name="",
            graviton=graviton,
            bre=bre,
        )
    except NotFound as exc:
        raise ValidationFailed(
            "This application is not available in the connected LOS",
            external_id=application.external_id,
            hint="The Graviton connector is in sandbox mode and carries fixture files only.",
        ) from exc

    run_ids: list[UUID] = []
    for stage in (result.documents, result.bank_statement, result.appraisal):
        if stage is None:
            continue
        run = await persist_run(
            session,
            stage,
            application_id=application.id,
            rate_card_version=sarvam.rate_card.version,
            sandbox=sarvam.sandbox,
        )
        run_ids.append(run.id)

    appraisal = result.appraisal.output
    statement = result.bank_statement.output if result.bank_statement else None

    return AppraisalSummary(
        application_id=application.id,
        external_id=application.external_id,
        run_ids=run_ids,
        documents_read=len(result.documents.output.documents),
        pages_read=result.documents.output.total_pages,
        api_calls=result.documents.output.total_calls,
        cost_inr=result.cost_inr,
        verified_monthly_income=(statement.income.monthly_net_income_median if statement else None),
        total_monthly_emi=statement.obligations.total_monthly_emi if statement else None,
        bounces=len(statement.bounces) if statement else 0,
        reconciled=statement.reconciled if statement else None,
        proposed_emi=appraisal.eligibility.proposed_emi,
        foir_display=appraisal.eligibility.foir_display,
        ltv_display=appraisal.eligibility.ltv_display,
        bre_outcome=appraisal.bre.outcome if appraisal.bre else None,
        deviations=[d.parameter for d in appraisal.deviations],
        recommendation=(appraisal.recommendation.decision if appraisal.recommendation else None),
        escalated=result.escalated,
        warnings=result.warnings,
    )


@router.get("", response_model=list[RunOut], summary="List agent runs")
async def list_runs(
    session: DbSession,
    _: Annotated[object, Depends(require_scope(Scope.APPLICATIONS_READ, Scope.USAGE_READ))],
    agent_id: str | None = None,
    application_id: UUID | None = None,
    escalated: bool | None = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> list[AgentRun]:
    """Runs for the caller's tenant, newest first."""
    statement = tenant_query(AgentRun).order_by(AgentRun.started_at.desc())
    if agent_id:
        statement = statement.where(AgentRun.agent_id == agent_id)
    if application_id:
        statement = statement.where(AgentRun.application_id == application_id)
    if escalated is not None:
        statement = statement.where(AgentRun.escalated == escalated)
    result = await session.execute(statement.limit(limit).offset(offset))
    return list(result.scalars().all())


@router.get("/{run_id}", response_model=RunDetail, summary="Get a run with its steps")
async def get_run(
    run_id: UUID,
    session: DbSession,
    _: Annotated[object, Depends(require_scope(Scope.APPLICATIONS_READ, Scope.USAGE_READ))],
) -> dict[str, Any]:
    """One run, with the step timeline the console draws."""
    run = await get_or_404(session, AgentRun, run_id)
    steps = await session.execute(
        select(AgentStep).where(AgentStep.run_id == run.id).order_by(AgentStep.seq)
    )
    payload = {column.name: getattr(run, column.name) for column in AgentRun.__table__.columns}
    payload["steps"] = [StepOut.model_validate(step) for step in steps.scalars().all()]
    return payload
