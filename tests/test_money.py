"""Indian currency formatting and credit arithmetic."""

from __future__ import annotations

from decimal import Decimal

import pytest
from gravai_core.money import (
    as_percent,
    emi,
    foir,
    format_inr,
    format_lakh_crore,
    group_indian,
    ltv,
)


@pytest.mark.parametrize(
    ("digits", "expected"),
    [
        ("1", "1"),
        ("123", "123"),
        ("1234", "1,234"),
        ("12345", "12,345"),
        ("123456", "1,23,456"),
        ("1234567", "12,34,567"),
        ("12345678", "1,23,45,678"),
        ("1234567890", "1,23,45,67,890"),
    ],
)
def test_indian_digit_grouping(digits: str, expected: str) -> None:
    """Last three digits, then pairs - not the Western three-by-three."""
    assert group_indian(digits) == expected


def test_format_inr_renders_symbol_and_paise() -> None:
    assert format_inr(1234567.5) == "₹12,34,567.50"


def test_format_inr_handles_negatives_and_suppressed_paise() -> None:
    assert format_inr(-2500, paise=False) == "-₹2,500"


def test_format_inr_pads_paise() -> None:
    assert format_inr(Decimal("100.5")) == "₹100.50"


def test_lakh_and_crore_rendering() -> None:
    """Credit notes talk in lakh and crore, not in digits."""
    assert format_lakh_crore(4500000) == "₹45.00 lakh"
    assert format_lakh_crore(12500000) == "₹1.25 crore"
    assert format_lakh_crore(5000) == "₹5,000.00"


def test_emi_matches_the_standard_formula() -> None:
    """₹10,00,000 at 11% for 60 months is ₹21,742.42."""
    assert emi(1000000, 11, 60) == Decimal("21742.42")


def test_emi_with_zero_rate_is_straight_line() -> None:
    assert emi(120000, 0, 12) == Decimal("10000.00")


def test_emi_rejects_non_positive_tenure() -> None:
    with pytest.raises(ValueError, match="months must be positive"):
        emi(100000, 10, 0)


def test_foir_worked_example() -> None:
    """Income ₹85,000, existing EMI ₹12,000, proposed ₹21,742.42 -> 39.70%."""
    instalment = emi(1000000, 11, 60)
    ratio = foir(85000, 12000, instalment)
    assert ratio == Decimal("0.3970")
    assert as_percent(ratio) == "39.7%"


def test_foir_refuses_zero_income() -> None:
    """A zero denominator must fail loudly, not produce a misleading ratio."""
    with pytest.raises(ValueError, match="net_monthly_income must be positive"):
        foir(0, 1000, 5000)


def test_ltv_worked_example() -> None:
    """₹40,00,000 against ₹55,00,000 collateral is 72.73%."""
    ratio = ltv(4000000, 5500000)
    assert ratio == Decimal("0.7273")
    assert as_percent(ratio) == "72.7%"


def test_ltv_refuses_zero_collateral() -> None:
    with pytest.raises(ValueError, match="collateral_value must be positive"):
        ltv(1000000, 0)
