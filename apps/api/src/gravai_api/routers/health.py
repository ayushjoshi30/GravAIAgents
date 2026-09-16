"""Health and readiness.

``/healthz`` is liveness and never touches the database, so a database blip does
not get the container killed. ``/readyz`` reports dependencies and returns 503
when the database is unreachable, which is what a load balancer should act on.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Response
from gravai_core.db import healthcheck
from gravai_core.settings import Settings

from ..deps import get_config

router = APIRouter(tags=["health"])


@router.get("/healthz", summary="Liveness")
async def healthz() -> dict[str, str]:
    """Is the process up?"""
    return {"status": "ok", "service": "gravai-api", "version": "0.1.0"}


@router.get("/readyz", summary="Readiness")
async def readyz(
    response: Response,
    settings: Annotated[Settings, Depends(get_config)],
) -> dict[str, Any]:
    """Are dependencies reachable?"""
    database_ok = await healthcheck(settings)
    ready = database_ok
    if not ready:
        response.status_code = 503
    return {
        "status": "ready" if ready else "degraded",
        "checks": {
            "database": {
                "ok": database_ok,
                "dialect": "postgresql" if settings.is_postgres else "sqlite",
                "row_level_security": settings.rls_available,
            },
        },
        "mode": {
            "environment": settings.app_env,
            "sarvam_sandbox": settings.sarvam_sandbox,
            "auth": "dev-hs256" if settings.use_dev_auth else "oidc-rs256",
        },
    }


@router.get("/", include_in_schema=False)
async def root() -> dict[str, str]:
    return {
        "service": "GravAI",
        "docs": "/docs",
        "health": "/healthz",
        "readiness": "/readyz",
    }
