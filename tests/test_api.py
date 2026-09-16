"""End-to-end API tests over the ASGI app.

These exercise the real dependency chain: bearer token -> principal -> tenant
binding -> tenant-scoped query -> audit write.
"""

from __future__ import annotations

from uuid import UUID, uuid4

import pytest
from gravai_api.main import app
from gravai_core.auth import Role, issue_dev_token
from gravai_core.settings import get_settings
from httpx import ASGITransport, AsyncClient


def _token(tenant_id: UUID, roles: list[Role] | None = None, subject: str = "tester") -> str:
    return issue_dev_token(
        tenant_id=tenant_id,
        subject=subject,
        roles=roles or [Role.UNDERWRITER],
        settings=get_settings(),
    )


def _auth(tenant_id: UUID, roles: list[Role] | None = None) -> dict[str, str]:
    return {"Authorization": f"Bearer {_token(tenant_id, roles)}"}


@pytest.fixture
async def client(_schema: None):  # type: ignore[no-untyped-def]
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as http:
        yield http


async def test_liveness_needs_no_token(client) -> None:  # type: ignore[no-untyped-def]
    response = await client.get("/healthz")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


async def test_readiness_reports_the_running_mode(client) -> None:  # type: ignore[no-untyped-def]
    response = await client.get("/readyz")
    assert response.status_code == 200
    body = response.json()
    assert body["checks"]["database"]["ok"] is True
    assert body["mode"]["sarvam_sandbox"] is True
    assert body["mode"]["auth"] == "dev-hs256"


async def test_protected_route_rejects_a_missing_token(client) -> None:  # type: ignore[no-untyped-def]
    response = await client.get("/v1/agents")
    assert response.status_code == 401
    assert response.json()["type"].endswith("unauthenticated")


async def test_protected_route_rejects_a_bad_token(client) -> None:  # type: ignore[no-untyped-def]
    response = await client.get("/v1/agents", headers={"Authorization": "Bearer nonsense"})
    assert response.status_code == 401


async def test_agent_catalog_is_served(client, tenant_a: UUID) -> None:  # type: ignore[no-untyped-def]
    response = await client.get("/v1/agents", headers=_auth(tenant_a))
    assert response.status_code == 200
    agents = response.json()
    assert len(agents) == 14
    assert {a["id"] for a in agents} >= {"credit_appraisal", "voice_collections"}


async def test_unknown_agent_returns_a_problem_document(  # type: ignore[no-untyped-def]
    client, tenant_a: UUID
) -> None:
    response = await client.get("/v1/agents/nope", headers=_auth(tenant_a))
    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.json()["correlation_id"]


async def test_create_and_read_an_application(  # type: ignore[no-untyped-def]
    client, make_tenant, tenant_a: UUID
) -> None:
    await make_tenant(tenant_a)
    payload = {
        "external_id": f"APP-{uuid4().hex[:6]}",
        "product": "personal_loan",
        "applicant_name": "Ayush Joshi",
        "loan_amount": "1000000.00",
        "tenure_months": 60,
        "interest_rate_pct": "11.000",
        "net_monthly_income": "85000.00",
        "existing_monthly_emi": "12000.00",
    }
    created = await client.post("/v1/applications", json=payload, headers=_auth(tenant_a))
    assert created.status_code == 201
    application_id = created.json()["id"]

    listed = await client.get("/v1/applications", headers=_auth(tenant_a))
    assert listed.status_code == 200
    assert application_id in [row["id"] for row in listed.json()]


async def test_duplicate_external_id_is_refused(  # type: ignore[no-untyped-def]
    client, make_tenant, tenant_a: UUID
) -> None:
    await make_tenant(tenant_a)
    payload = {
        "external_id": f"DUP-{uuid4().hex[:6]}",
        "product": "home_loan",
        "applicant_name": "Uday Singh",
    }
    first = await client.post("/v1/applications", json=payload, headers=_auth(tenant_a))
    assert first.status_code == 201
    second = await client.post("/v1/applications", json=payload, headers=_auth(tenant_a))
    assert second.status_code == 422


async def test_eligibility_computes_foir(  # type: ignore[no-untyped-def]
    client, make_tenant, tenant_a: UUID
) -> None:
    """The worked example: ₹10,00,000 at 11% over 60 months on ₹85,000 income."""
    await make_tenant(tenant_a)
    created = await client.post(
        "/v1/applications",
        json={
            "external_id": f"ELIG-{uuid4().hex[:6]}",
            "product": "personal_loan",
            "applicant_name": "Ayush Joshi",
            "loan_amount": "1000000.00",
            "tenure_months": 60,
            "interest_rate_pct": "11.000",
            "net_monthly_income": "85000.00",
            "existing_monthly_emi": "12000.00",
        },
        headers=_auth(tenant_a),
    )
    application_id = created.json()["id"]

    response = await client.get(
        f"/v1/applications/{application_id}/eligibility", headers=_auth(tenant_a)
    )
    assert response.status_code == 200
    body = response.json()
    assert body["proposed_emi_display"] == "₹21,742.42"
    assert body["foir_display"] == "39.7%"
    assert body["ltv"] is None
    assert "collateral_value" in body["missing_inputs"]


async def test_eligibility_refuses_to_guess_missing_inputs(  # type: ignore[no-untyped-def]
    client, make_tenant, tenant_a: UUID
) -> None:
    """No amount, tenure or rate means no instalment - not an estimate."""
    await make_tenant(tenant_a)
    created = await client.post(
        "/v1/applications",
        json={
            "external_id": f"BARE-{uuid4().hex[:6]}",
            "product": "personal_loan",
            "applicant_name": "Anon Applicant",
        },
        headers=_auth(tenant_a),
    )
    response = await client.get(
        f"/v1/applications/{created.json()['id']}/eligibility", headers=_auth(tenant_a)
    )
    assert response.status_code == 422
    assert "loan_amount" in response.json()["context"]["missing_inputs"]


async def test_a_tenant_cannot_read_another_tenants_application(  # type: ignore[no-untyped-def]
    client, make_tenant, tenant_a: UUID, tenant_b: UUID
) -> None:
    """The isolation test that matters most, end to end through the API."""
    await make_tenant(tenant_a)
    await make_tenant(tenant_b)

    created = await client.post(
        "/v1/applications",
        json={
            "external_id": f"SECRET-{uuid4().hex[:6]}",
            "product": "home_loan",
            "applicant_name": "Tenant A Applicant",
        },
        headers=_auth(tenant_a),
    )
    application_id = created.json()["id"]

    intruder = await client.get(f"/v1/applications/{application_id}", headers=_auth(tenant_b))
    assert intruder.status_code == 404

    listing = await client.get("/v1/applications", headers=_auth(tenant_b))
    assert application_id not in [row["id"] for row in listing.json()]


async def test_creating_an_application_writes_a_verifiable_audit_entry(  # type: ignore[no-untyped-def]
    client, make_tenant, tenant_a: UUID
) -> None:
    await make_tenant(tenant_a)
    headers = _auth(tenant_a, [Role.TENANT_ADMIN])
    created = await client.post(
        "/v1/applications",
        json={
            "external_id": f"AUD-{uuid4().hex[:6]}",
            "product": "home_loan",
            "applicant_name": "Uday Singh",
        },
        headers=headers,
    )
    application_id = created.json()["id"]

    entries = await client.get("/v1/audit", params={"entity_type": "application"}, headers=headers)
    assert entries.status_code == 200
    assert application_id in [row["entity_id"] for row in entries.json()]

    verification = await client.post("/v1/audit/verify", headers=headers)
    assert verification.status_code == 200
    assert verification.json()["ok"] is True


async def test_collections_role_cannot_reach_credit_endpoints(  # type: ignore[no-untyped-def]
    client, make_tenant, tenant_a: UUID
) -> None:
    """Scope enforcement through the real dependency chain."""
    await make_tenant(tenant_a)
    response = await client.post(
        "/v1/applications",
        json={
            "external_id": f"NOPE-{uuid4().hex[:6]}",
            "product": "home_loan",
            "applicant_name": "Should Not Insert",
        },
        headers=_auth(tenant_a, [Role.COLLECTIONS_AGENT]),
    )
    assert response.status_code == 403


async def test_connector_readiness_is_reported_honestly(  # type: ignore[no-untyped-def]
    client, tenant_a: UUID
) -> None:
    response = await client.get("/v1/connectors", headers=_auth(tenant_a))
    assert response.status_code == 200
    statuses = {row["id"]: row["status"] for row in response.json()}
    assert statuses["aa"] == "external_dependency"


def test_a_requested_token_lifetime_is_actually_applied() -> None:
    """--ttl was accepted, printed, and silently dropped.

    A token that says it lasts thirty days and expires in an hour is worse
    than one that never offered the option.
    """
    from datetime import timedelta

    import jwt
    from gravai_core.auth import Role, issue_dev_token
    from gravai_core.settings import Settings

    settings = Settings(auth_dev_secret="ttl-regression-secret-0123456789abcdef")
    token = issue_dev_token(
        tenant_id="11111111-2222-3333-4444-555555555555",
        subject="ttl-check",
        roles=[Role("underwriter")],
        settings=settings,
        ttl=timedelta(days=30),
    )
    claims = jwt.decode(
        token, settings.auth_dev_secret, algorithms=["HS256"], audience=settings.oidc_audience
    )
    assert claims["exp"] - claims["iat"] == 30 * 24 * 3600


def test_an_explicitly_scoped_token_cannot_approve_decisions() -> None:
    """A token minted to run agents must not also be able to approve credit.

    The underwriter role carries decisions:approve. An OAuth connector is
    granted that role so it can run agents, so without narrowing, the same
    token would be a valid credential for the endpoint that signs off lending
    decisions.
    """
    from gravai_core.auth import Role, Scope, decode_token, issue_dev_token
    from gravai_core.settings import Settings

    settings = Settings(auth_dev_secret="scope-narrowing-secret-0123456789abcdef")
    token = issue_dev_token(
        tenant_id="11111111-2222-3333-4444-555555555555",
        subject="oauth:test",
        roles=[Role.UNDERWRITER, Role.COLLECTIONS_MANAGER],
        settings=settings,
        scopes={Scope.AGENTS_RUN},
    )
    principal = decode_token(token, settings)
    assert principal.has_scope(Scope.AGENTS_RUN)
    assert not principal.has_scope(Scope.DECISIONS_APPROVE)
    assert not principal.has_scope(Scope.APPLICATIONS_WRITE)


def test_narrowing_cannot_widen_beyond_the_roles() -> None:
    """Asking for admin while holding underwriter must not grant admin."""
    from gravai_core.auth import Role, Scope, decode_token, issue_dev_token
    from gravai_core.settings import Settings

    settings = Settings(auth_dev_secret="scope-narrowing-secret-0123456789abcdef")
    token = issue_dev_token(
        tenant_id="11111111-2222-3333-4444-555555555555",
        subject="greedy",
        roles=[Role.UNDERWRITER],
        settings=settings,
        scopes={Scope.ADMIN, Scope.AGENTS_RUN},
    )
    principal = decode_token(token, settings)
    assert principal.has_scope(Scope.AGENTS_RUN)
    assert not principal.has_scope(Scope.ADMIN)


def test_cors_origins_cover_the_dev_console_ports() -> None:
    """A single hardcoded origin breaks whenever the console moves port.

    It did: the preview server serves on 3100 and every agent run from the
    console failed with 'the API is not reachable from this browser'.
    """
    from gravai_core.settings import Settings

    local = Settings(app_env="local")
    assert "http://localhost:3000" in local.allowed_origins
    assert "http://localhost:3100" in local.allowed_origins


def test_production_grants_no_cross_origin_access() -> None:
    """Same-origin in production, so a CORS grant would only widen exposure."""
    from gravai_core.settings import Settings

    assert Settings(app_env="prod", oidc_jwks_url="https://idp.example/jwks").allowed_origins == []
