"""Request dependencies: authentication, tenant binding, database sessions."""

from __future__ import annotations

from collections.abc import AsyncIterator, Callable
from functools import lru_cache
from typing import Annotated

from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from gravai_connectors import SandboxBre, SandboxGraviton
from gravai_core.auth import Principal, Role, Scope, decode_token
from gravai_core.db import session_scope
from gravai_core.errors import Unauthenticated
from gravai_core.settings import Settings, get_settings
from gravai_core.tenancy import tenant_scope
from gravai_sarvam import SarvamBundle, build_sarvam
from sqlalchemy.ext.asyncio import AsyncSession

#: auto_error=False so a missing header surfaces as our own 401 problem
#: document rather than FastAPI's default body.
bearer_scheme = HTTPBearer(auto_error=False, description="GravAI bearer token")


def get_config() -> Settings:
    return get_settings()


async def get_principal(
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
    settings: Annotated[Settings, Depends(get_config)],
) -> Principal:
    """Resolve and validate the caller.

    Every request carries a tenant; there is no tenant-less request in GravAI.
    """
    if credentials is None or not credentials.credentials:
        raise Unauthenticated("Missing bearer token")
    principal = decode_token(credentials.credentials, settings)
    request.state.principal = principal
    return principal


async def get_session(
    request: Request,
    principal: Annotated[Principal, Depends(get_principal)],
) -> AsyncIterator[AsyncSession]:
    """A database session bound to the caller's tenant.

    The tenant is bound both in the process context (service-layer guard) and,
    on PostgreSQL, in the database session (row-level security).
    """
    correlation_id = getattr(request.state, "correlation_id", None)
    with tenant_scope(
        principal.tenant_id,
        actor_id=principal.subject,
        correlation_id=correlation_id,
    ):
        async with session_scope(principal.tenant_id) as session:
            yield session


def require_scope(*scopes: Scope) -> Callable[[Principal], Principal]:
    """Dependency factory: the caller must hold at least one of these scopes."""

    async def _check(principal: Annotated[Principal, Depends(get_principal)]) -> Principal:
        principal.require_scope(*scopes)
        return principal

    return _check


def require_role(*roles: Role) -> Callable[[Principal], Principal]:
    """Dependency factory: the caller must hold at least one of these roles."""

    async def _check(principal: Annotated[Principal, Depends(get_principal)]) -> Principal:
        principal.require_role(*roles)
        return principal

    return _check


@lru_cache(maxsize=1)
def get_sarvam() -> SarvamBundle:
    """The process-wide AI layer.

    One bundle per process, because the rate governor is only a ceiling if every
    caller shares it. Building one per request would let N workers each believe
    they had the full 10 requests a minute.
    """
    return build_sarvam()


@lru_cache(maxsize=1)
def get_graviton() -> SandboxGraviton:
    """The LOS connector. Sandbox until a tenant's endpoint is configured."""
    return SandboxGraviton()


@lru_cache(maxsize=1)
def get_bre() -> SandboxBre:
    """The rules engine connector."""
    return SandboxBre()


CurrentPrincipal = Annotated[Principal, Depends(get_principal)]
DbSession = Annotated[AsyncSession, Depends(get_session)]
Config = Annotated[Settings, Depends(get_config)]
Sarvam = Annotated[SarvamBundle, Depends(get_sarvam)]
Graviton = Annotated[SandboxGraviton, Depends(get_graviton)]
Bre = Annotated[SandboxBre, Depends(get_bre)]
