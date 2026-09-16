"""PII masking, validation and redaction.

Rule 5 of the platform. The Aadhaar tests are the load-bearing ones: a full
Aadhaar must never survive masking or redaction.
"""

from __future__ import annotations

import pytest
from gravai_core.pii import (
    aadhaar_last4,
    contains_unmasked_pii,
    is_valid_gstin,
    is_valid_ifsc,
    is_valid_pan,
    mask_aadhaar,
    mask_account,
    mask_email,
    mask_mobile,
    pan_entity_type,
    redact_mapping,
    redact_text,
    verhoeff_valid,
)


@pytest.mark.parametrize(
    "raw",
    ["2345 6789 4821", "2345-6789-4821", "234567894821"],
)
def test_aadhaar_masks_to_last_four_in_every_format(raw: str) -> None:
    assert mask_aadhaar(raw) == "XXXX-XXXX-4821"
    assert aadhaar_last4(raw) == "4821"


def test_aadhaar_mask_is_safe_when_absent() -> None:
    assert mask_aadhaar("no number here") == "XXXX-XXXX-XXXX"
    assert aadhaar_last4("no number here") is None


def test_redaction_removes_full_aadhaar_from_free_text() -> None:
    """The critical case: document text reaching a model."""
    text = "Applicant Aadhaar 2345 6789 4821 and PAN ABCPS1234K"
    redacted = redact_text(text)
    assert "2345 6789 4821" not in redacted
    assert "XXXX-XXXX-4821" in redacted
    assert "ABCPS1234K" not in redacted


def test_redaction_masks_mobile_and_email() -> None:
    redacted = redact_text("Call 9876543210 or mail ramesh.kumar@example.in")
    assert "9876543210" not in redacted
    assert "XXXXXX3210" in redacted
    assert "r***@example.in" in redacted


def test_contains_unmasked_pii_flags_leaks() -> None:
    """Used as a post-call output validator."""
    assert contains_unmasked_pii("Aadhaar 2345 6789 4821") == ["aadhaar"]
    assert contains_unmasked_pii("nothing sensitive") == []


def test_redact_mapping_respects_the_allowlist() -> None:
    """An agent declares the fields it genuinely needs; the rest are masked."""
    payload = {
        "applicant_name": "Uday Singh",
        "aadhaar": "2345 6789 4821",
        "notes": "PAN ABCPS1234K on file",
    }
    result = redact_mapping(payload, allow={"applicant_name"})
    assert result["applicant_name"] == "Uday Singh"
    assert "2345 6789 4821" not in result["aadhaar"]
    assert "ABCPS1234K" not in result["notes"]


def test_redact_mapping_recurses_into_nested_structures() -> None:
    payload = {"docs": [{"text": "Aadhaar 2345 6789 4821"}]}
    result = redact_mapping(payload)
    assert "2345 6789 4821" not in result["docs"][0]["text"]


@pytest.mark.parametrize(
    ("pan", "valid"),
    [("ABCPS1234K", True), ("abcps1234k", True), ("ABC1234567", False), ("ABCPS1234", False)],
)
def test_pan_validation(pan: str, valid: bool) -> None:
    assert is_valid_pan(pan) is valid


def test_pan_entity_type_reads_the_fourth_character() -> None:
    assert pan_entity_type("ABCPS1234K") == "individual"
    assert pan_entity_type("ABCCS1234K") == "company"
    assert pan_entity_type("nonsense") is None


@pytest.mark.parametrize(
    ("ifsc", "valid"),
    [("HDFC0001234", True), ("SBIN0000456", True), ("HDFC1001234", False), ("HDF0001234", False)],
)
def test_ifsc_validation(ifsc: str, valid: bool) -> None:
    """The fifth character of an IFSC is always zero."""
    assert is_valid_ifsc(ifsc) is valid


def test_gstin_checksum_accepts_a_valid_number() -> None:
    assert is_valid_gstin("27AAPFU0939F1ZV") is True


def test_gstin_checksum_rejects_a_tampered_number() -> None:
    """Structure alone is not enough; the checksum catches a changed digit."""
    assert is_valid_gstin("27AAPFU0939F1ZA") is False


def test_verhoeff_checksum() -> None:
    """Rejects obviously fabricated Aadhaar numbers during parsing."""
    assert verhoeff_valid("2345678948210") is False
    assert verhoeff_valid("") is False


def test_account_and_mobile_masking_keep_last_four() -> None:
    assert mask_account("123456789012").endswith("9012")
    assert "123456789012" not in mask_account("123456789012")
    assert mask_mobile("+91 9876543210") == "XXXXXX3210"
    assert mask_email("ramesh@example.in") == "r***@example.in"
