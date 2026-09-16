"""PII handling: masking, validation and redaction.

Rule 5 of the platform: minimise what leaves the process, and never store or
transmit a full Aadhaar number. Redaction runs *before* any Sarvam call, on an
allowlist basis — a field is sent only if the agent declares it needs it.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from typing import Any

# --- Patterns -------------------------------------------------------------

AADHAAR_RE = re.compile(r"\b(\d{4})[ -]?(\d{4})[ -]?(\d{4})\b")
PAN_RE = re.compile(r"\b([A-Z]{5}[0-9]{4}[A-Z])\b")
GSTIN_RE = re.compile(r"\b(\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9][Zz][A-Z0-9])\b")
IFSC_RE = re.compile(r"\b([A-Z]{4}0[A-Z0-9]{6})\b")
ACCOUNT_RE = re.compile(r"\b(\d{9,18})\b")
MOBILE_RE = re.compile(r"\b(?:\+?91[ -]?)?([6-9]\d{9})\b")
EMAIL_RE = re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.]+\b")

PAN_FOURTH_CHAR_ENTITY = {
    "P": "individual",
    "C": "company",
    "H": "hindu_undivided_family",
    "F": "firm",
    "A": "association_of_persons",
    "T": "trust",
    "B": "body_of_individuals",
    "L": "local_authority",
    "J": "artificial_juridical_person",
    "G": "government",
}


# --- Masking --------------------------------------------------------------


def mask_aadhaar(value: str) -> str:
    """Mask to the last four digits: ``XXXX-XXXX-1234``.

    UIDAI permits displaying only the last four digits. The platform never
    stores or transmits the full number.
    """
    match = AADHAAR_RE.search(value or "")
    if not match:
        return "XXXX-XXXX-XXXX"
    return f"XXXX-XXXX-{match.group(3)}"


def aadhaar_last4(value: str) -> str | None:
    """Extract just the last four digits, or None if no Aadhaar is present."""
    match = AADHAAR_RE.search(value or "")
    return match.group(3) if match else None


def mask_account(value: str) -> str:
    """Bank account: keep the last four digits."""
    digits = re.sub(r"\D", "", value or "")
    if len(digits) < 4:
        return "XXXX"
    return f"{'X' * (len(digits) - 4)}{digits[-4:]}"


def mask_mobile(value: str) -> str:
    """Mobile: keep the last four digits."""
    match = MOBILE_RE.search(value or "")
    if not match:
        return "XXXXXXXXXX"
    return f"XXXXXX{match.group(1)[-4:]}"


def mask_email(value: str) -> str:
    """``ramesh.kumar@example.com`` -> ``r***@example.com``."""
    if not value or "@" not in value:
        return "***"
    local, _, domain = value.partition("@")
    head = local[0] if local else "*"
    return f"{head}***@{domain}"


# --- Validation -----------------------------------------------------------


def is_valid_pan(value: str) -> bool:
    """Structural PAN check (AAAAA9999A)."""
    return bool(PAN_RE.fullmatch((value or "").strip().upper()))


def pan_entity_type(value: str) -> str | None:
    """The entity type encoded in PAN's fourth character."""
    pan = (value or "").strip().upper()
    if not is_valid_pan(pan):
        return None
    return PAN_FOURTH_CHAR_ENTITY.get(pan[3])


def is_valid_ifsc(value: str) -> bool:
    """Structural IFSC check (AAAA0XXXXXX; fifth character is always zero)."""
    return bool(IFSC_RE.fullmatch((value or "").strip().upper()))


def is_valid_gstin(value: str) -> bool:
    """GSTIN structure plus its Luhn-mod-36 checksum digit."""
    gstin = (value or "").strip().upper()
    if not GSTIN_RE.fullmatch(gstin):
        return False
    alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    total = 0
    for index, char in enumerate(gstin[:14]):
        value_at = alphabet.index(char)
        factor = 1 if index % 2 == 0 else 2
        product = value_at * factor
        total += product // 36 + product % 36
    checksum = alphabet[(36 - total % 36) % 36]
    return checksum == gstin[14]


def verhoeff_valid(number: str) -> bool:
    """Verhoeff checksum, the algorithm Aadhaar numbers use.

    Used only to reject obviously fabricated numbers during document parsing;
    it is never a substitute for an actual UIDAI verification.
    """
    d_table = [
        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
        [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
        [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
        [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
        [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
        [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
        [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
        [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
        [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
        [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
    ]
    p_table = [
        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
        [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
        [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
        [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
        [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
        [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
        [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
        [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
    ]
    digits = re.sub(r"\D", "", number or "")
    if not digits:
        return False
    checksum = 0
    for index, digit in enumerate(reversed(digits)):
        checksum = d_table[checksum][p_table[index % 8][int(digit)]]
    return checksum == 0


# --- Redaction ------------------------------------------------------------


def redact_text(text: str) -> str:
    """Replace every recognised identifier in free text with a masked token.

    Applied to document text and transcripts before they reach a model, unless
    the agent's allowlist explicitly requires the raw value.
    """
    if not text:
        return text
    out = AADHAAR_RE.sub(lambda m: f"XXXX-XXXX-{m.group(3)}", text)
    out = PAN_RE.sub(lambda m: f"{m.group(1)[:3]}XX{m.group(1)[-1]}", out)
    out = MOBILE_RE.sub(lambda m: f"XXXXXX{m.group(1)[-4:]}", out)
    out = EMAIL_RE.sub(lambda m: mask_email(m.group(0)), out)
    return out


def redact_mapping(
    data: Mapping[str, Any],
    *,
    allow: Iterable[str] = (),
) -> dict[str, Any]:
    """Redact a payload, keeping only allowlisted keys in the clear.

    Allowlisting is per agent: an agent declares the fields its task genuinely
    needs, and everything else is masked before the call leaves the process.
    """
    allowed = set(allow)
    result: dict[str, Any] = {}
    for key, value in data.items():
        if key in allowed:
            result[key] = value
        elif isinstance(value, Mapping):
            result[key] = redact_mapping(value, allow=allowed)
        elif isinstance(value, str):
            result[key] = redact_text(value)
        elif isinstance(value, list):
            result[key] = [
                redact_mapping(item, allow=allowed)
                if isinstance(item, Mapping)
                else redact_text(item)
                if isinstance(item, str)
                else item
                for item in value
            ]
        else:
            result[key] = value
    return result


def contains_unmasked_pii(text: str) -> list[str]:
    """Identify PII still present in text. Used as a post-call output validator."""
    found: list[str] = []
    if AADHAAR_RE.search(text or ""):
        found.append("aadhaar")
    if PAN_RE.search(text or ""):
        found.append("pan")
    if MOBILE_RE.search(text or ""):
        found.append("mobile")
    if EMAIL_RE.search(text or ""):
        found.append("email")
    return found
