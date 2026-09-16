"""Application endpoints.

Every query is tenant-scoped through ``tenant_query``, so a missing filter is
impossible rather than merely unlikely, and every write is audited.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, status
from gravai_core.audit import AuditActions
from gravai_core.auth import Scope
from gravai_core.errors import ValidationFailed
from gravai_core.models import Application
from gravai_core.money import as_percent, emi, foir, format_inr, ltv
from gravai_core.repositories import AuditRepository, get_or_404, tenant_query
from pydantic import BaseModel, Field
from sqlalchemy import func

from ..deps import CurrentPrincipal, DbSession, require_scope

router = APIRouter(prefix="/v1/applications", tags=["applications"])


class ApplicationOut(BaseModel):
    id: UUID
    external_id: str
    product: str
    status: str
    applicant_name: str
    aadhaar_last4: str | None = Field(
        default=None, description="Aadhaar is only ever held as the last four digits"
    )
    loan_amount: Decimal | None = None
    tenure_months: int | None = None
    interest_rate_pct: Decimal | None = None
    collateral_value: Decimal | None = None
    net_monthly_income: Decimal | None = None
    existing_monthly_emi: Decimal | None = None
    document_count: int

    model_config = {"from_attributes": True}


class ApplicationCreate(BaseModel):
    external_id: str = Field(min_length=1, max_length=64)
    product: str = Field(min_length=1, max_length=60)
    applicant_name: str = Field(min_length=1, max_length=200)
    loan_amount: Decimal | None = Field(default=None, gt=0)
    tenure_months: int | None = Field(default=None, gt=0, le=480)
    interest_rate_pct: Decimal | None = Field(default=None, ge=0, le=100)
    collateral_value: Decimal | None = Field(default=None, gt=0)
    net_monthly_income: Decimal | None = Field(default=None, gt=0)
    existing_monthly_emi: Decimal | None = Field(default=None, ge=0)


class EligibilityOut(BaseModel):
    """Eligibility arithmetic, shown with its inputs.

    These are computed in code, never by a language model: they are arithmetic,
    not judgement, and the Credit Appraisal Agent explains them rather than
    producing them.
    """

    application_id: UUID
    proposed_emi: Decimal
    proposed_emi_display: str
    foir: Decimal | None = None
    foir_display: str | None = None
    ltv: Decimal | None = None
    ltv_display: str | None = None
    formula: dict[str, str]
    missing_inputs: list[str]


@router.get("", response_model=list[ApplicationOut], summary="List applications")
async def list_applications(
    session: DbSession,
    _: Annotated[object, Depends(require_scope(Scope.APPLICATIONS_READ))],
    status_filter: Annotated[str | None, Query(alias="status")] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> list[Application]:
    """Applications for the caller's tenant, newest first."""
    statement = tenant_query(Application).order_by(Application.created_at.desc())
    if status_filter:
        statement = statement.where(Application.status == status_filter)
    result = await session.execute(statement.limit(limit).offset(offset))
    return list(result.scalars().all())


@router.get("/summary", summary="Counts by status")
async def summary(
    session: DbSession,
    _: Annotated[object, Depends(require_scope(Scope.APPLICATIONS_READ))],
) -> dict[str, int]:
    """Application counts by status, for the console's header tiles."""
    statement = (
        tenant_query(Application)
        .with_only_columns(Application.status, func.count(Application.id))
        .group_by(Application.status)
    )
    result = await session.execute(statement)
    return {row[0]: row[1] for row in result.all()}


@router.get("/{application_id}", response_model=ApplicationOut, summary="Get an application")
async def get_application(
    application_id: UUID,
    session: DbSession,
    _: Annotated[object, Depends(require_scope(Scope.APPLICATIONS_READ))],
) -> Application:
    """One application. Another tenant's id reports as missing, never forbidden."""
    return await get_or_404(session, Application, application_id)


@router.post(
    "",
    response_model=ApplicationOut,
    status_code=status.HTTP_201_CREATED,
    summary="Create an application",
)
async def create_application(
    body: ApplicationCreate,
    session: DbSession,
    principal: CurrentPrincipal,
    _: Annotated[object, Depends(require_scope(Scope.APPLICATIONS_WRITE))],
) -> Application:
    """Register an application and audit its arrival."""
    existing = await session.execute(
        tenant_query(Application).where(Application.external_id == body.external_id)
    )
    if existing.scalar_one_or_none() is not None:
        raise ValidationFailed(
            "An application with this external_id already exists",
            external_id=body.external_id,
        )

    application = Application(
        tenant_id=principal.tenant_id,
        **body.model_dump(),
    )
    session.add(application)
    await session.flush()

    await AuditRepository(session).append(
        action=AuditActions.APPLICATION_RECEIVED,
        entity_type="application",
        entity_id=str(application.id),
        payload={"external_id": application.external_id, "product": application.product},
        actor_type="service" if principal.is_service else "user",
        actor_id=principal.subject,
    )
    return application


@router.get(
    "/{application_id}/eligibility",
    response_model=EligibilityOut,
    summary="Compute FOIR and LTV",
)
async def eligibility(
    application_id: UUID,
    session: DbSession,
    _: Annotated[object, Depends(require_scope(Scope.APPLICATIONS_READ))],
) -> EligibilityOut:
    """FOIR and LTV with the inputs that produced them.

    Anything that cannot be computed is reported in ``missing_inputs`` rather
    than estimated: an invented denominator is worse than a blank field.
    """
    application = await get_or_404(session, Application, application_id)

    missing: list[str] = []
    for field_name in ("loan_amount", "tenure_months", "interest_rate_pct"):
        if getattr(application, field_name) is None:
            missing.append(field_name)

    if missing:
        raise ValidationFailed(
            "Cannot compute an instalment without amount, tenure and rate",
            missing_inputs=missing,
        )

    instalment = emi(
        application.loan_amount,  # type: ignore[arg-type]
        application.interest_rate_pct,  # type: ignore[arg-type]
        application.tenure_months,  # type: ignore[arg-type]
    )

    ratio: Decimal | None = None
    ratio_display: str | None = None
    if application.net_monthly_income:
        ratio = foir(
            application.net_monthly_income,
            application.existing_monthly_emi or Decimal(0),
            instalment,
        )
        ratio_display = as_percent(ratio)
    else:
        missing.append("net_monthly_income")

    loan_to_value: Decimal | None = None
    loan_to_value_display: str | None = None
    if application.collateral_value:
        loan_to_value = ltv(application.loan_amount, application.collateral_value)  # type: ignore[arg-type]
        loan_to_value_display = as_percent(loan_to_value)
    else:
        missing.append("collateral_value")

    return EligibilityOut(
        application_id=application.id,
        proposed_emi=instalment,
        proposed_emi_display=format_inr(instalment),
        foir=ratio,
        foir_display=ratio_display,
        ltv=loan_to_value,
        ltv_display=loan_to_value_display,
        formula={
            "emi": "P * r * (1+r)^n / ((1+r)^n - 1), r = annual rate / 1200",
            "foir": "(existing_monthly_emi + proposed_emi) / net_monthly_income",
            "ltv": "loan_amount / collateral_value",
        },
        missing_inputs=missing,
    )
