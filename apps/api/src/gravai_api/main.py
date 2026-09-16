"""FastAPI application factory."""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from gravai_core.db import dispose_engine
from gravai_core.errors import GravAIError
from gravai_core.settings import get_settings
from gravai_core.telemetry import configure_logging, configure_tracing, get_logger

from .routers import (
    agents,
    applications,
    audit,
    connectors,
    health,
    mcp,
    runs,
    studio,
    tasks,
    usage,
)

log = get_logger("gravai.api")

DESCRIPTION = """
The AI agent layer for the Graviton lending platform.

Every AI capability is served by **Sarvam AI**. Every request is tenant-scoped
and audited into an append-only, hash-chained log. Agents are advisory by
default: credit decisions, deviations and adverse actions require a human.
"""


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """Start-up and shut-down."""
    settings = get_settings()
    configure_logging(settings)
    tracing = configure_tracing(settings)
    log.info(
        "api_starting",
        env=settings.app_env,
        database="postgresql" if settings.is_postgres else "sqlite",
        rls=settings.rls_available,
        sarvam_sandbox=settings.sarvam_sandbox,
        tracing=tracing,
    )
    try:
        yield
    finally:
        await dispose_engine()
        log.info("api_stopped")


def create_app() -> FastAPI:
    """Build the application."""
    settings = get_settings()

    app = FastAPI(
        title="GravAI API",
        version="0.1.0",
        description=DESCRIPTION,
        lifespan=lifespan,
        docs_url="/docs",
        openapi_url="/openapi.json",
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def correlation_id_middleware(request: Request, call_next):  # type: ignore[no-untyped-def]
        """Give every request an id, echoed in errors so support can trace it."""
        correlation_id = request.headers.get("X-Correlation-Id") or uuid.uuid4().hex[:16]
        request.state.correlation_id = correlation_id
        response = await call_next(request)
        response.headers["X-Correlation-Id"] = correlation_id
        return response

    @app.exception_handler(GravAIError)
    async def gravai_error_handler(request: Request, exc: GravAIError) -> JSONResponse:
        """Render our error taxonomy as RFC 9457 problem details."""
        body = exc.to_problem()
        body["correlation_id"] = getattr(request.state, "correlation_id", None)
        if exc.status_code >= 500:
            log.error("request_failed", code=exc.code, detail=exc.message, path=request.url.path)
        return JSONResponse(
            status_code=exc.status_code,
            content=body,
            media_type="application/problem+json",
        )

    app.include_router(health.router)
    app.include_router(agents.router)
    app.include_router(applications.router)
    # Mounted before the generic /v1/applications routes so the appraise path
    # is matched as a route rather than as an application id.
    app.include_router(runs.appraise_router)
    app.include_router(runs.router)
    app.include_router(tasks.router)
    app.include_router(usage.router)
    app.include_router(audit.router)
    app.include_router(connectors.router)
    app.include_router(studio.router)
    app.include_router(mcp.router)
    return app


app = create_app()
