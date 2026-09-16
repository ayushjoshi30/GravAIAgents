"""Indian currency formatting and EMI arithmetic.

Rupee amounts are stored as ``Decimal`` and formatted in Indian digit grouping
(last three digits, then pairs): 1234567.5 renders as ``12,34,567.50``.
"""

from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal

PAISE = Decimal("0.01")


def to_decimal(amount: Decimal | float | int | str) -> Decimal:
    """Coerce to Decimal without float noise."""
    if isinstance(amount, Decimal):
        return amount
    return Decimal(str(amount))


def quantize_inr(amount: Decimal | float | int | str) -> Decimal:
    """Round to paise, half-up (the convention Indian lenders use)."""
    return to_decimal(amount).quantize(PAISE, rounding=ROUND_HALF_UP)


def group_indian(digits: str) -> str:
    """Group a digit string Indian-style: 1234567 -> 12,34,567."""
    if len(digits) <= 3:
        return digits
    head, tail = digits[:-3], digits[-3:]
    parts: list[str] = []
    while len(head) > 2:
        parts.insert(0, head[-2:])
        head = head[:-2]
    if head:
        parts.insert(0, head)
    return ",".join([*parts, tail])


def format_inr(
    amount: Decimal | float | int | str,
    *,
    symbol: bool = True,
    paise: bool = True,
) -> str:
    """Format a rupee amount.

    >>> format_inr(1234567.5)
    '₹12,34,567.50'
    >>> format_inr(-2500, paise=False)
    '-₹2,500'
    """
    value = quantize_inr(amount)
    negative = value < 0
    value = abs(value)

    whole = int(value)
    text = group_indian(str(whole))
    if paise:
        fraction = (value - whole).quantize(PAISE, rounding=ROUND_HALF_UP)
        text = f"{text}.{str(fraction)[2:].ljust(2, '0')}"
    if symbol:
        text = f"₹{text}"
    return f"-{text}" if negative else text


def format_lakh_crore(amount: Decimal | float | int | str) -> str:
    """Render large amounts the way credit notes do: ₹1.25 crore, ₹45.00 lakh."""
    value = quantize_inr(amount)
    negative = value < 0
    value = abs(value)
    crore = Decimal("10000000")
    lakh = Decimal("100000")

    if value >= crore:
        text = f"₹{(value / crore).quantize(PAISE, rounding=ROUND_HALF_UP)} crore"
    elif value >= lakh:
        text = f"₹{(value / lakh).quantize(PAISE, rounding=ROUND_HALF_UP)} lakh"
    else:
        text = format_inr(value)
    return f"-{text}" if negative else text


def emi(principal: Decimal | float | int, annual_rate_pct: Decimal | float, months: int) -> Decimal:
    """Equated monthly instalment.

    ``EMI = P * r * (1+r)^n / ((1+r)^n - 1)`` with ``r`` the monthly rate.
    A zero rate degrades to straight-line repayment.

    >>> emi(1000000, 11, 60)
    Decimal('21742.42')
    """
    if months <= 0:
        raise ValueError("months must be positive")
    p = to_decimal(principal)
    rate = to_decimal(annual_rate_pct) / Decimal(1200)
    if rate == 0:
        return quantize_inr(p / months)
    growth = (Decimal(1) + rate) ** months
    return quantize_inr(p * rate * growth / (growth - Decimal(1)))


def foir(
    net_monthly_income: Decimal | float | int,
    existing_monthly_emi: Decimal | float | int,
    proposed_emi: Decimal | float | int,
) -> Decimal:
    """Fixed Obligation to Income Ratio, as a fraction (0.397 = 39.7%).

    Raises on non-positive income rather than returning a misleading ratio.
    """
    income = to_decimal(net_monthly_income)
    if income <= 0:
        raise ValueError("net_monthly_income must be positive to compute FOIR")
    obligations = to_decimal(existing_monthly_emi) + to_decimal(proposed_emi)
    return (obligations / income).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)


def ltv(loan_amount: Decimal | float | int, collateral_value: Decimal | float | int) -> Decimal:
    """Loan to Value, as a fraction (0.727 = 72.7%)."""
    value = to_decimal(collateral_value)
    if value <= 0:
        raise ValueError("collateral_value must be positive to compute LTV")
    return (to_decimal(loan_amount) / value).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)


def as_percent(fraction: Decimal | float, places: int = 1) -> str:
    """0.3969 -> '39.7%'."""
    quant = Decimal(1).scaleb(-places)
    return f"{(to_decimal(fraction) * 100).quantize(quant, rounding=ROUND_HALF_UP)}%"
