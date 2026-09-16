"""Seed a local database.

Creates two tenants so tenant isolation is visible immediately, the platform
roles, a user per role, the rate card, and a handful of applications whose
numbers are realistic for Indian lending.

Idempotent: safe to run repeatedly.
"""

from __future__ import annotations

import asyncio
from datetime import datetime
from decimal import Decimal
from uuid import UUID, uuid5

from gravai_core.auth import Role as RoleName
from gravai_core.db import admin_session_scope, dispose_engine, get_engine
from gravai_core.models import Application, AppUser, Base, RateCard, Tenant, UserRole
from gravai_core.models import Role as RoleModel
from gravai_core.tenancy import tenant_scope
from gravai_core.time_utils import utc_now
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

#: Fixed namespace so repeated seeding produces the same ids, which makes the
#: seeded dev tokens stable across runs.
NAMESPACE = UUID("6f1e4a8c-9b2d-4c7e-8a15-3d6b7c9e0f24")

RATE_CARD_VERSION = "tenant-contract-2026-08-19"


def _tenant_id(slug: str) -> UUID:
    return uuid5(NAMESPACE, f"tenant:{slug}")


TENANTS = [
    {
        "slug": "acme",
        "name": "Acme Finance Limited",
        "config": {
            "languages": ["en-IN", "hi-IN", "mr-IN"],
            "call_window": {"start": "08:00", "end": "19:00"},
            "monthly_budget_inr": 250000,
            "automation": {"doc_classification": "auto_low_risk", "credit_decision": "advisory"},
            "rate_card_version": RATE_CARD_VERSION,
        },
    },
    {
        "slug": "lodestar",
        "name": "Lodestar Housing Finance",
        "config": {
            # The large tenant in the modelled fleet: 48% of applications and 62%
            # of documents. That skew is the reason the rate governor shares fairly
            # rather than serving in arrival order.
            "languages": ["en-IN", "hi-IN", "ta-IN", "te-IN"],
            "call_window": {"start": "09:00", "end": "18:00"},
            "monthly_budget_inr": 900000,
            "automation": {"doc_classification": "auto_low_risk", "credit_decision": "advisory"},
            "rate_card_version": RATE_CARD_VERSION,
        },
    },
]

USERS = [
    ("priya.sharma", "Priya Sharma", RoleName.UNDERWRITER),
    ("rahul.verma", "Rahul Verma", RoleName.CREDIT_HEAD),
    ("anita.desai", "Anita Desai", RoleName.COLLECTIONS_MANAGER),
    ("vikram.rao", "Vikram Rao", RoleName.COLLECTIONS_AGENT),
    ("meera.iyer", "Meera Iyer", RoleName.AUDITOR),
    ("admin", "Tenant Administrator", RoleName.TENANT_ADMIN),
]

RATE_CARD = [
    ("docai_extract", "page", Decimal("1.000000"), "Tenant contract, 19 Aug 2026"),
    ("docai_digitise", "page", Decimal("0.500000"), "Sarvam public price page, 19 Aug 2026"),
    ("llm_input", "1k_tokens", Decimal("0.300000"), "Placeholder - confirm with Sarvam"),
    ("llm_output", "1k_tokens", Decimal("0.900000"), "Placeholder - confirm with Sarvam"),
    ("stt", "audio_second", Decimal("0.010000"), "Placeholder - confirm with Sarvam"),
    ("tts", "1k_characters", Decimal("0.150000"), "Placeholder - confirm with Sarvam"),
    ("translate", "1k_characters", Decimal("0.100000"), "Placeholder - confirm with Sarvam"),
]

APPLICATIONS = [
    {
        "external_id": "18301",
        "product": "home_loan",
        "status": "under_review",
        "applicant_name": "Uday Singh",
        "aadhaar_last4": "4821",
        "pan": "ABCPS1234K",
        "loan_amount": Decimal("4000000.00"),
        "tenure_months": 240,
        "interest_rate_pct": Decimal("8.750"),
        "collateral_value": Decimal("5500000.00"),
        "net_monthly_income": Decimal("145000.00"),
        "existing_monthly_emi": Decimal("18500.00"),
        "document_count": 197,
    },
    {
        "external_id": "18302",
        "product": "personal_loan",
        "status": "received",
        "applicant_name": "Ayush Joshi",
        "aadhaar_last4": "9017",
        "pan": "AXKPJ8891L",
        "loan_amount": Decimal("1000000.00"),
        "tenure_months": 60,
        "interest_rate_pct": Decimal("11.000"),
        "collateral_value": None,
        "net_monthly_income": Decimal("85000.00"),
        "existing_monthly_emi": Decimal("12000.00"),
        "document_count": 22,
    },
    {
        "external_id": "18303",
        "product": "lap",
        "status": "pending_documents",
        "applicant_name": "Farhan Qureshi",
        "aadhaar_last4": "3345",
        "pan": "BNZPQ4456M",
        "loan_amount": Decimal("2500000.00"),
        "tenure_months": 120,
        "interest_rate_pct": Decimal("10.250"),
        "collateral_value": Decimal("4000000.00"),
        "net_monthly_income": Decimal("98000.00"),
        "existing_monthly_emi": Decimal("0.00"),
        "document_count": 14,
    },
]


async def _ensure_roles(session: AsyncSession) -> dict[str, RoleModel]:
    existing = {row.name: row for row in (await session.execute(select(RoleModel))).scalars().all()}
    for role_name in RoleName:
        if role_name.value not in existing:
            row = RoleModel(
                id=uuid5(NAMESPACE, f"role:{role_name.value}"),
                name=role_name.value,
                description=role_name.value.replace("_", " ").title(),
            )
            session.add(row)
            existing[role_name.value] = row
    await session.flush()
    return existing


async def _ensure_rate_card(session: AsyncSession) -> int:
    present = {
        (row.version, row.product, row.unit)
        for row in (await session.execute(select(RateCard))).scalars().all()
    }
    added = 0
    for product, unit, rate, source in RATE_CARD:
        if (RATE_CARD_VERSION, product, unit) in present:
            continue
        session.add(
            RateCard(
                id=uuid5(NAMESPACE, f"rate:{product}:{unit}"),
                version=RATE_CARD_VERSION,
                product=product,
                unit=unit,
                rate_inr=rate,
                effective_from=datetime(2026, 8, 19, tzinfo=utc_now().tzinfo),
                source=source,
                notes="Placeholder rates are marked; confirm before any budgeting.",
            )
        )
        added += 1
    return added


async def _ensure_tenant(session: AsyncSession, spec: dict[str, object]) -> tuple[Tenant, bool]:
    slug = str(spec["slug"])
    tenant_id = _tenant_id(slug)
    found = (
        await session.execute(select(Tenant).where(Tenant.id == tenant_id))
    ).scalar_one_or_none()
    if found is not None:
        return found, False
    tenant = Tenant(
        id=tenant_id,
        slug=slug,
        name=str(spec["name"]),
        config=spec["config"],  # type: ignore[arg-type]
    )
    session.add(tenant)
    await session.flush()
    return tenant, True


async def _ensure_users(session: AsyncSession, tenant: Tenant, roles: dict[str, RoleModel]) -> int:
    added = 0
    for handle, full_name, role_name in USERS:
        email = f"{handle}@{tenant.slug}.example.in"
        user_id = uuid5(NAMESPACE, f"user:{tenant.slug}:{handle}")
        found = (
            await session.execute(select(AppUser).where(AppUser.id == user_id))
        ).scalar_one_or_none()
        if found is not None:
            continue
        user = AppUser(
            id=user_id,
            tenant_id=tenant.id,
            email=email,
            full_name=full_name,
            subject=f"{tenant.slug}:{handle}",
        )
        session.add(user)
        await session.flush()
        session.add(
            UserRole(
                id=uuid5(NAMESPACE, f"userrole:{tenant.slug}:{handle}"),
                tenant_id=tenant.id,
                user_id=user.id,
                role_id=roles[role_name.value].id,
            )
        )
        added += 1
    return added


async def _ensure_applications(session: AsyncSession, tenant: Tenant) -> int:
    added = 0
    # The large tenant carries the fuller book; the small one gets the first two.
    specs = APPLICATIONS if tenant.slug == "lodestar" else APPLICATIONS[:2]
    for spec in specs:
        app_id = uuid5(NAMESPACE, f"app:{tenant.slug}:{spec['external_id']}")
        found = (
            await session.execute(select(Application).where(Application.id == app_id))
        ).scalar_one_or_none()
        if found is not None:
            continue
        session.add(Application(id=app_id, tenant_id=tenant.id, **spec))
        added += 1
    return added


async def seed() -> None:
    """Create the schema if needed, then insert the demo data."""
    engine = get_engine()
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    summary: list[str] = []

    async with admin_session_scope() as session:
        roles = await _ensure_roles(session)
        rates = await _ensure_rate_card(session)
        summary.append(f"roles: {len(roles)} present, rate card: +{rates} rows")

    for spec in TENANTS:
        async with admin_session_scope() as session:
            tenant, created = await _ensure_tenant(session, spec)
            with tenant_scope(tenant.id):
                users = await _ensure_users(session, tenant, await _ensure_roles(session))
                apps = await _ensure_applications(session, tenant)
            summary.append(
                f"tenant {tenant.slug}: {'created' if created else 'existing'}, "
                f"+{users} users, +{apps} applications, id={tenant.id}"
            )

    print("GravAI seed complete")
    for line in summary:
        print(f"  {line}")
    print("\nMint a token for the console or API:")
    print("  uv run python scripts/dev_token.py --tenant acme --role underwriter")

    await dispose_engine()


if __name__ == "__main__":
    asyncio.run(seed())
