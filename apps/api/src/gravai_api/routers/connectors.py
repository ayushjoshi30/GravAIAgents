"""Connector status.

Reports honestly how ready each integration is, including the one that is an
external dependency rather than a build task: the Account Aggregator rail.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from gravai_connectors import CONNECTOR_REGISTRY
from gravai_core.auth import Scope
from pydantic import BaseModel

from ..deps import require_scope

router = APIRouter(prefix="/v1/connectors", tags=["connectors"])


class ConnectorOut(BaseModel):
    id: str
    name: str
    status: str
    summary: str
    onboarding_requirement: str


@router.get(
    "",
    response_model=list[ConnectorOut],
    summary="List connectors and their readiness",
    dependencies=[Depends(require_scope(Scope.APPLICATIONS_READ, Scope.USAGE_READ))],
)
async def list_connectors() -> list[ConnectorOut]:
    """Every connector, with what a tenant must supply to make it live."""
    return [
        ConnectorOut(
            id=spec.id,
            name=spec.name,
            status=str(spec.status),
            summary=spec.summary,
            onboarding_requirement=spec.onboarding_requirement,
        )
        for spec in CONNECTOR_REGISTRY.values()
    ]
