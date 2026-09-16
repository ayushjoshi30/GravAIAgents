"""Graviton LOS connector.

Graviton stays the system of record: GravAI reads a projection and writes back
status transitions and pendencies. The sandbox adapter carries fixtures that
mirror the seeded applications, so an end-to-end run works with no LOS present.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Protocol

from gravai_core.errors import NotFound

from .models import GravitonApplication, GravitonDocument, KycResult, Pendency


class GravitonConnector(Protocol):
    async def get_application(self, application_id: str) -> GravitonApplication: ...
    async def list_documents(self, application_id: str) -> list[GravitonDocument]: ...
    async def list_pendencies(self, application_id: str) -> list[Pendency]: ...
    async def update_status(self, application_id: str, status: str, note: str = "") -> None: ...


def _documents_for(application_id: str, count: int) -> list[GravitonDocument]:
    """A realistic document set for an Indian lending file."""
    kinds = [
        ("kyc.aadhaar", "aadhaar.pdf", 1),
        ("kyc.pan", "pan.pdf", 1),
        ("income.bank_statement", "bank-statement-6m.pdf", 12),
        ("income.salary_slip", "salary-slips.pdf", 3),
        ("income.form16", "form16.pdf", 4),
        ("property.sale_deed", "sale-deed.pdf", 18),
        ("property.valuation", "valuation-report.pdf", 6),
        ("other.letter", "employer-letter.pdf", 1),
    ]
    documents: list[GravitonDocument] = []
    for index in range(count):
        declared, name, pages = kinds[index % len(kinds)]
        documents.append(
            GravitonDocument(
                document_id=f"{application_id}-doc-{index + 1:03d}",
                application_id=application_id,
                uri=f"sandbox://documents/{application_id}/{index + 1:03d}/{name}",
                pages=pages,
                declared_type=declared,
                uploaded_at=date(2026, 9, 8),
            )
        )
    return documents


class SandboxGraviton:
    """In-memory Graviton with fixtures matching the seeded applications."""

    def __init__(self) -> None:
        self._applications: dict[str, GravitonApplication] = {}
        self._pendencies: dict[str, list[Pendency]] = {}
        self.status_updates: list[tuple[str, str, str]] = []
        self._load_fixtures()

    def _load_fixtures(self) -> None:
        fixtures = [
            GravitonApplication(
                application_id="18301",
                external_id="18301",
                product="home_loan",
                status="under_review",
                applicant_name="Uday Singh",
                aadhaar_last4="4821",
                pan="ABCPS1234K",
                loan_amount=Decimal("4000000.00"),
                tenure_months=240,
                interest_rate_pct=Decimal("8.750"),
                collateral_value=Decimal("5500000.00"),
                net_monthly_income=Decimal("145000.00"),
                existing_monthly_emi=Decimal("18500.00"),
                bureau_score=764,
                enquiries_3m=2,
                employment_vintage_months=54,
                # The instrumented production run carried 197 documents; the
                # fixture keeps a workable subset.
                documents=_documents_for("18301", 16),
            ),
            GravitonApplication(
                application_id="18302",
                external_id="18302",
                product="personal_loan",
                status="received",
                applicant_name="Ayush Joshi",
                aadhaar_last4="9017",
                pan="AXKPJ8891L",
                loan_amount=Decimal("1000000.00"),
                tenure_months=60,
                interest_rate_pct=Decimal("11.000"),
                collateral_value=None,
                net_monthly_income=Decimal("85000.00"),
                existing_monthly_emi=Decimal("12000.00"),
                bureau_score=712,
                enquiries_3m=3,
                employment_vintage_months=28,
                documents=_documents_for("18302", 8),
            ),
            GravitonApplication(
                application_id="18303",
                external_id="18303",
                product="lap",
                status="pending_documents",
                applicant_name="Farhan Qureshi",
                aadhaar_last4="3345",
                pan="BNZPQ4456M",
                loan_amount=Decimal("2500000.00"),
                tenure_months=120,
                interest_rate_pct=Decimal("10.250"),
                collateral_value=Decimal("4000000.00"),
                net_monthly_income=Decimal("98000.00"),
                existing_monthly_emi=Decimal("0.00"),
                # Deliberately weak, so the BRE produces real failures to explain.
                bureau_score=648,
                enquiries_3m=9,
                employment_vintage_months=4,
                documents=_documents_for("18303", 6),
            ),
        ]
        for application in fixtures:
            self._applications[application.application_id] = application

        self._pendencies["18303"] = [
            Pendency(
                pendency_id="18303-p1",
                application_id="18303",
                requirement="Latest 6 months bank statement",
                assigned_to="customer",
                raised_on=date(2026, 9, 10),
            ),
            Pendency(
                pendency_id="18303-p2",
                application_id="18303",
                requirement="Property valuation report",
                assigned_to="valuer",
                raised_on=date(2026, 9, 11),
            ),
        ]

    async def get_application(self, application_id: str) -> GravitonApplication:
        try:
            return self._applications[application_id]
        except KeyError as exc:
            raise NotFound(
                "Application not found in Graviton", application_id=application_id
            ) from exc

    async def list_documents(self, application_id: str) -> list[GravitonDocument]:
        application = await self.get_application(application_id)
        return list(application.documents)

    async def list_pendencies(self, application_id: str) -> list[Pendency]:
        await self.get_application(application_id)
        return list(self._pendencies.get(application_id, []))

    def set_documents(self, application_id: str, documents: list[GravitonDocument]) -> None:
        """Replace an application's documents.

        For exercising files that are missing something — a case with no bank
        statement has to fall back to declared income, and that path needs to be
        testable without inventing a whole fixture.
        """
        application = self._applications[application_id]
        self._applications[application_id] = application.model_copy(
            update={"documents": list(documents)}
        )

    async def update_status(self, application_id: str, status: str, note: str = "") -> None:
        application = await self.get_application(application_id)
        self._applications[application_id] = application.model_copy(update={"status": status})
        self.status_updates.append((application_id, status, note))


class SandboxDigilocker:
    """Issued-document KYC. Returns verified data with Aadhaar already masked."""

    def __init__(self, graviton: SandboxGraviton | None = None) -> None:
        self.graviton = graviton or SandboxGraviton()

    async def verify(self, application_id: str) -> KycResult:
        application = await self.graviton.get_application(application_id)
        dates = {
            "18301": date(1985, 3, 14),
            "18302": date(1991, 11, 2),
            "18303": date(1994, 7, 23),
        }
        return KycResult(
            application_id=application_id,
            source="digilocker",
            name=application.applicant_name,
            date_of_birth=dates.get(application_id),
            address="Sandbox address, Pune, Maharashtra 411001",
            aadhaar_last4=application.aadhaar_last4,
            pan=application.pan,
            verified=True,
        )
