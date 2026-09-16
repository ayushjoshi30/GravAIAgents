"""Token validation, roles and scopes."""

from __future__ import annotations

from datetime import timedelta
from uuid import uuid4

import jwt
import pytest
from gravai_core.auth import (
    Principal,
    Role,
    Scope,
    decode_token,
    issue_dev_token,
    scopes_for_roles,
)
from gravai_core.errors import Forbidden, Unauthenticated
from gravai_core.settings import Settings

TENANT = uuid4()


def _settings() -> Settings:
    return Settings(
        app_env="local",
        auth_dev_secret="gravai-test-secret-not-for-production-32b",
        oidc_jwks_url="",
        oidc_audience="gravai",
        sarvam_api_key="",
    )


def test_token_round_trip_preserves_identity() -> None:
    settings = _settings()
    token = issue_dev_token(
        tenant_id=TENANT, subject="priya", roles=[Role.UNDERWRITER], settings=settings
    )
    principal = decode_token(token, settings)
    assert principal.subject == "priya"
    assert principal.tenant_id == TENANT
    assert Role.UNDERWRITER in principal.roles


def test_underwriter_may_approve_decisions() -> None:
    settings = _settings()
    token = issue_dev_token(
        tenant_id=TENANT, subject="priya", roles=[Role.UNDERWRITER], settings=settings
    )
    principal = decode_token(token, settings)
    assert principal.has_scope(Scope.DECISIONS_APPROVE)


def test_collections_agent_may_not_approve_decisions() -> None:
    """Credit approval is deliberately out of reach of a collections role."""
    settings = _settings()
    token = issue_dev_token(
        tenant_id=TENANT, subject="vikram", roles=[Role.COLLECTIONS_AGENT], settings=settings
    )
    principal = decode_token(token, settings)
    assert not principal.has_scope(Scope.DECISIONS_APPROVE)
    with pytest.raises(Forbidden):
        principal.require_scope(Scope.DECISIONS_APPROVE)


def test_auditor_is_read_only() -> None:
    settings = _settings()
    token = issue_dev_token(
        tenant_id=TENANT, subject="meera", roles=[Role.AUDITOR], settings=settings
    )
    principal = decode_token(token, settings)
    assert principal.has_scope(Scope.AUDIT_READ)
    assert not principal.has_scope(Scope.APPLICATIONS_WRITE)
    assert not principal.has_scope(Scope.DECISIONS_APPROVE)


def test_explicit_scopes_cannot_widen_a_role() -> None:
    """A forged scope claim must not grant more than the role allows."""
    settings = _settings()
    payload = {
        "sub": "attacker",
        "tenant_id": str(TENANT),
        "roles": [Role.COLLECTIONS_AGENT.value],
        "scope": f"{Scope.ADMIN.value} {Scope.DECISIONS_APPROVE.value}",
        "aud": "gravai",
        "iss": "gravai-local",
        "exp": 9999999999,
    }
    token = jwt.encode(payload, settings.auth_dev_secret, algorithm="HS256")
    principal = decode_token(token, settings)
    assert not principal.has_scope(Scope.ADMIN)
    assert not principal.has_scope(Scope.DECISIONS_APPROVE)


def test_token_without_tenant_claim_is_rejected() -> None:
    """There is no such thing as a tenant-less request."""
    settings = _settings()
    token = jwt.encode(
        {"sub": "nobody", "aud": "gravai", "exp": 9999999999},
        settings.auth_dev_secret,
        algorithm="HS256",
    )
    with pytest.raises(Unauthenticated, match="tenant_id"):
        decode_token(token, settings)


def test_expired_token_is_rejected() -> None:
    settings = _settings()
    token = issue_dev_token(
        tenant_id=TENANT,
        subject="priya",
        roles=[Role.UNDERWRITER],
        settings=settings,
        ttl=timedelta(seconds=-10),
    )
    with pytest.raises(Unauthenticated, match="expired"):
        decode_token(token, settings)


def test_token_signed_with_the_wrong_key_is_rejected() -> None:
    settings = _settings()
    token = jwt.encode(
        {"sub": "x", "tenant_id": str(TENANT), "aud": "gravai", "exp": 9999999999},
        "a-completely-different-secret-of-adequate-length",
        algorithm="HS256",
    )
    with pytest.raises(Unauthenticated):
        decode_token(token, settings)


def test_dev_tokens_cannot_be_issued_in_production() -> None:
    settings = Settings(
        app_env="prod", oidc_jwks_url="https://idp.example.in/jwks", sarvam_api_key=""
    )
    with pytest.raises(Forbidden, match="production"):
        issue_dev_token(tenant_id=TENANT, subject="x", roles=[Role.UNDERWRITER], settings=settings)


def test_tenant_admin_holds_every_scope() -> None:
    assert scopes_for_roles(frozenset({Role.TENANT_ADMIN})) == frozenset(Scope)


def test_principal_require_role() -> None:
    principal = Principal(
        subject="x",
        tenant_id=TENANT,
        roles=frozenset({Role.AUDITOR}),
        scopes=frozenset({Scope.AUDIT_READ}),
    )
    principal.require_role(Role.AUDITOR)
    with pytest.raises(Forbidden):
        principal.require_role(Role.UNDERWRITER)
