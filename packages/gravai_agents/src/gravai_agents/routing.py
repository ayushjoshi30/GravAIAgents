"""Document-type taxonomy and extract-vs-digitise routing.

Routing is a cost and volume decision, not a preference. Extract returns fields
directly (12 API calls a document). Digitise returns text that a model must then
read (13 calls, one of them an LLM call), and it draws on the same 10 req/min
quota — so it buys no throughput relief. It is chosen only where a document has
no stable field structure to extract.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Any

from gravai_sarvam import DocumentMode


class DocumentType(StrEnum):
    """Document taxonomy for Indian lending."""

    KYC_AADHAAR = "kyc.aadhaar"
    KYC_PAN = "kyc.pan"
    KYC_PASSPORT = "kyc.passport"
    KYC_VOTER_ID = "kyc.voter_id"
    KYC_DRIVING_LICENCE = "kyc.driving_licence"
    KYC_PHOTO = "kyc.photo"
    INCOME_SALARY_SLIP = "income.salary_slip"
    INCOME_FORM16 = "income.form16"
    INCOME_ITR = "income.itr"
    INCOME_BANK_STATEMENT = "income.bank_statement"
    BUSINESS_GST_RETURN = "business.gst_return"
    BUSINESS_GST_CERTIFICATE = "business.gst_certificate"
    BUSINESS_UDYAM = "business.udyam"
    BUSINESS_FINANCIALS = "business.financials"
    BUSINESS_INVOICE = "business.invoice"
    PROPERTY_SALE_DEED = "property.sale_deed"
    PROPERTY_VALUATION = "property.valuation"
    PROPERTY_EC = "property.ec"
    PROPERTY_TAX_RECEIPT = "property.tax_receipt"
    LOAN_SANCTION_LETTER = "loan.sanction_letter"
    LOAN_CHEQUE = "loan.cheque"
    OTHER_LETTER = "other.letter"
    OTHER_UNKNOWN = "other.unknown"


#: Documents with no reliable field structure. These are prose, so a model has
#: to read them; extracting fixed fields from a sale deed does not work.
DIGITISE_TYPES: frozenset[DocumentType] = frozenset(
    {
        DocumentType.PROPERTY_SALE_DEED,
        DocumentType.PROPERTY_EC,
        DocumentType.OTHER_LETTER,
        DocumentType.OTHER_UNKNOWN,
    }
)

#: Fields worth asking for per type, passed to the provider as a schema hint and
#: to the reader as instructions.
SCHEMA_HINTS: dict[DocumentType, str] = {
    DocumentType.KYC_AADHAAR: "name, date_of_birth, aadhaar_last4, address",
    DocumentType.KYC_PAN: "name, father_name, date_of_birth, pan",
    DocumentType.INCOME_BANK_STATEMENT: (
        "account_holder_name, account_number, ifsc, bank_name, statement_period, "
        "opening_balance, closing_balance, transactions"
    ),
    DocumentType.INCOME_SALARY_SLIP: (
        "employee_name, employer_name, month, gross_salary, net_salary, deductions"
    ),
    DocumentType.INCOME_FORM16: (
        "employee_name, employer_name, assessment_year, gross_salary, tax_deducted"
    ),
    DocumentType.INCOME_ITR: "assessee_name, pan, assessment_year, gross_total_income, tax_paid",
    DocumentType.BUSINESS_GST_RETURN: "gstin, period, total_taxable_value, total_tax",
    DocumentType.PROPERTY_VALUATION: (
        "property_address, valuer_name, market_value, valuation_date"
    ),
    DocumentType.PROPERTY_SALE_DEED: (
        "property_address, seller_name, buyer_name, consideration_amount, registration_date"
    ),
    DocumentType.PROPERTY_TAX_RECEIPT: "property_id, owner_name, amount_paid, period",
}


def route_for(
    document_type: DocumentType, *, tenant_prefers_digitise: bool = False
) -> DocumentMode:
    """Choose extract or digitise for a document type.

    A tenant may force digitise (it is cheaper per page: ₹0.50 against ₹1.00),
    but the caller should understand the trade: it costs an extra model call per
    document and competes for the same quota, so it lowers the per-page rate
    while raising request volume against a ceiling that is already binding.
    """
    if document_type in DIGITISE_TYPES:
        return DocumentMode.DIGITISE
    if tenant_prefers_digitise:
        return DocumentMode.DIGITISE
    return DocumentMode.EXTRACT


def schema_hint_for(document_type: DocumentType) -> str | None:
    """Prose field list, used to instruct the model that reads digitised text."""
    return SCHEMA_HINTS.get(document_type)


def extraction_schema_for(document_type: DocumentType) -> dict[str, Any] | None:
    """A JSON Schema for the extraction endpoint.

    The provider takes a serialised JSON Schema, not prose — passing the hint
    string straight through is rejected. The same field list therefore serves
    two audiences in two shapes: a schema for the extractor, and a sentence for
    the model that reads digitised text.
    """
    hint = SCHEMA_HINTS.get(document_type)
    if not hint:
        return None
    fields = [field.strip() for field in hint.split(",") if field.strip()]
    if not fields:
        return None
    return {
        "type": "object",
        "properties": {field: {"type": "string"} for field in fields},
    }


def classify_declared(declared: str | None) -> DocumentType:
    """Map a declared type to the taxonomy, falling back to unknown."""
    if not declared:
        return DocumentType.OTHER_UNKNOWN
    try:
        return DocumentType(declared)
    except ValueError:
        return DocumentType.OTHER_UNKNOWN
