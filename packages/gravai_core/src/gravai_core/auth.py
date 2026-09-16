"""Authentication and authorisation.

Local development validates HS256 tokens signed with ``AUTH_DEV_SECRET`` so no
identity provider is needed. Setting ``OIDC_JWKS_URL`` switches validation to
RS256 against the provider's keys, and the dev path is refused outright in
production (DECISIONS.md D-003).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from enum import StrEnum
from typing import Any
from uuid import UUID

import jwt
from jwt import PyJWKClient

from .errors import Forbidden, Unauthenticated
from .settings import Settings, get_settings
from .time_utils import utc_now


class Role(StrEnum):
    """Platform roles. A principal may hold several."""

    TENANT_ADMIN = "tenant_admin"
    UNDERWRITER = "underwriter"
    CREDIT_HEAD = "credit_head"
    COLLECTIONS_AGENT = "collections_agent"
    COLLECTIONS_MANAGER = "collections_manager"
    AUDITOR = "auditor"
    DEVELOPER = "developer"
    PLATFORM_ADMIN = "platform_admin"


class Scope(StrEnum):
    """Coarse capability scopes, used to shape MCP tool sets and API access."""

    APPLICATIONS_READ = "applications:read"
    APPLICATIONS_WRITE = "applications:write"
    DOCUMENTS_READ = "documents:read"
    DOCUMENTS_WRITE = "documents:write"
    AGENTS_RUN = "agents:run"
    DECISIONS_APPROVE = "decisions:approve"
    COLLECTIONS_READ = "collections:read"
    COLLECTIONS_WRITE = "collections:write"
    AUDIT_READ = "audit:read"
    USAGE_READ = "usage:read"
    ADMIN = "admin"


#: Scopes implied by each role. Decisions and approvals are deliberately narrow:
#: only an underwriter or credit head may approve, never a collections role.
ROLE_SCOPES: dict[Role, frozenset[Scope]] = {
    Role.TENANT_ADMIN: frozenset(Scope),
    Role.UNDERWRITER: frozenset(
        {
            Scope.APPLICATIONS_READ,
            Scope.APPLICATIONS_WRITE,
            Scope.DOCUMENTS_READ,
            Scope.DOCUMENTS_WRITE,
            Scope.AGENTS_RUN,
            Scope.DECISIONS_APPROVE,
            Scope.USAGE_READ,
        }
    ),
    Role.CREDIT_HEAD: frozenset(
        {
            Scope.APPLICATIONS_READ,
            Scope.DOCUMENTS_READ,
            Scope.AGENTS_RUN,
            Scope.DECISIONS_APPROVE,
            Scope.AUDIT_READ,
            Scope.USAGE_READ,
        }
    ),
    Role.COLLECTIONS_AGENT: frozenset({Scope.COLLECTIONS_READ, Scope.COLLECTIONS_WRITE}),
    Role.COLLECTIONS_MANAGER: frozenset(
        {
            Scope.COLLECTIONS_READ,
            Scope.COLLECTIONS_WRITE,
            Scope.AGENTS_RUN,
            Scope.USAGE_READ,
        }
    ),
    Role.AUDITOR: frozenset(
        {
            Scope.APPLICATIONS_READ,
            Scope.DOCUMENTS_READ,
            Scope.COLLECTIONS_READ,
            Scope.AUDIT_READ,
            Scope.USAGE_READ,
        }
    ),
    Role.DEVELOPER: frozenset({Scope.APPLICATIONS_READ, Scope.DOCUMENTS_READ, Scope.USAGE_READ}),
    Role.PLATFORM_ADMIN: frozenset(Scope),
}


def scopes_for_roles(roles: frozenset[Role] | set[Role] | list[Role]) -> frozenset[Scope]:
    """Union of the scopes implied by a set of roles."""
    result: set[Scope] = set()
    for role in roles:
        result |= ROLE_SCOPES.get(role, frozenset())
    return frozenset(result)


@dataclass(frozen=True, slots=True)
class Principal:
    """Who is acting, and on behalf of which tenant."""

    subject: str
    tenant_id: UUID
    roles: frozenset[Role]
    scopes: frozenset[Scope]
    token_id: str | None = None
    client_id: str | None = None
    is_service: bool = False

    def has_role(self, *roles: Role) -> bool:
        return any(role in self.roles for role in roles)

    def has_scope(self, *scopes: Scope) -> bool:
        return any(scope in self.scopes for scope in scopes)

    def require_scope(self, *scopes: Scope) -> None:
        """Raise unless the principal holds at least one of these scopes."""
        if not self.has_scope(*scopes):
            raise Forbidden(
                "Principal lacks the required scope",
                required=[s.value for s in scopes],
                held=sorted(s.value for s in self.scopes),
            )

    def require_role(self, *roles: Role) -> None:
        if not self.has_role(*roles):
            raise Forbidden(
                "Principal lacks the required role",
                required=[r.value for r in roles],
                held=sorted(r.value for r in self.roles),
            )


def _coerce_roles(raw: Any) -> frozenset[Role]:
    """Accept roles as a list or space-delimited string; ignore unknown names."""
    if raw is None:
        return frozenset()
    values = raw.split() if isinstance(raw, str) else list(raw)
    roles: set[Role] = set()
    for value in values:
        try:
            roles.add(Role(str(value)))
        except ValueError:
            continue
    return frozenset(roles)


def _coerce_scopes(raw: Any, roles: frozenset[Role]) -> frozenset[Scope]:
    """Explicit scopes narrow the role-implied set; they can never widen it."""
    implied = scopes_for_roles(roles)
    if raw is None:
        return implied
    values = raw.split() if isinstance(raw, str) else list(raw)
    explicit: set[Scope] = set()
    for value in values:
        try:
            explicit.add(Scope(str(value)))
        except ValueError:
            continue
    return frozenset(explicit & implied) if explicit else implied


def issue_dev_token(
    *,
    tenant_id: UUID | str,
    subject: str,
    roles: list[Role] | list[str],
    settings: Settings | None = None,
    ttl: timedelta | None = None,
    scopes: set[Scope] | frozenset[Scope] | None = None,
) -> str:
    """Mint an HS256 token for local development.

    Refuses to run in production, where a real identity provider must issue tokens.
    """
    cfg = settings or get_settings()
    if cfg.app_env == "prod":
        raise Forbidden("Dev tokens cannot be issued in production")

    resolved_roles = _coerce_roles([str(r) for r in roles])
    # An explicit set narrows; it can never widen, because decode_token
    # intersects it with what the roles imply. This is how a token can be
    # issued for one purpose — running agents — without also carrying every
    # other authority those roles happen to hold.
    granted = scopes_for_roles(resolved_roles)
    if scopes is not None:
        granted = frozenset(scopes) & granted
    now = utc_now()
    expiry = now + (ttl or timedelta(seconds=cfg.token_ttl_seconds))
    payload = {
        "sub": subject,
        "tenant_id": str(tenant_id),
        "roles": sorted(r.value for r in resolved_roles),
        "scope": " ".join(sorted(s.value for s in granted)),
        "aud": cfg.oidc_audience,
        "iss": cfg.oidc_issuer or "gravai-local",
        "iat": int(now.timestamp()),
        "exp": int(expiry.timestamp()),
    }
    return jwt.encode(payload, cfg.auth_dev_secret, algorithm="HS256")


def decode_token(token: str, settings: Settings | None = None) -> Principal:
    """Validate a bearer token and build the principal.

    A token without a ``tenant_id`` claim is rejected: there is no such thing as
    a tenant-less request in GravAI.
    """
    cfg = settings or get_settings()
    try:
        if cfg.use_dev_auth:
            claims = jwt.decode(
                token,
                cfg.auth_dev_secret,
                algorithms=["HS256"],
                audience=cfg.oidc_audience,
                options={"require": ["exp", "sub"]},
            )
        else:
            signing_key = PyJWKClient(cfg.oidc_jwks_url).get_signing_key_from_jwt(token)
            claims = jwt.decode(
                token,
                signing_key.key,
                algorithms=["RS256", "ES256"],
                audience=cfg.oidc_audience,
                issuer=cfg.oidc_issuer or None,
                options={"require": ["exp", "sub"]},
            )
    except jwt.ExpiredSignatureError as exc:
        raise Unauthenticated("Token has expired") from exc
    except jwt.InvalidTokenError as exc:
        raise Unauthenticated(f"Invalid token: {exc}") from exc

    raw_tenant = claims.get("tenant_id")
    if not raw_tenant:
        raise Unauthenticated("Token carries no tenant_id claim")
    try:
        tenant_id = UUID(str(raw_tenant))
    except ValueError as exc:
        raise Unauthenticated("tenant_id claim is not a valid UUID") from exc

    roles = _coerce_roles(claims.get("roles"))
    return Principal(
        subject=str(claims["sub"]),
        tenant_id=tenant_id,
        roles=roles,
        scopes=_coerce_scopes(claims.get("scope"), roles),
        token_id=claims.get("jti"),
        client_id=claims.get("client_id"),
        is_service=bool(claims.get("client_id")),
    )
