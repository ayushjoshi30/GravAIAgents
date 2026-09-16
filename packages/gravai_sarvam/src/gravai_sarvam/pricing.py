"""Cost computation against a versioned rate card.

Rates are never hardcoded at a call site. A call records which rate-card version
priced it, so a price change re-prices future calls without rewriting history —
and so a figure in a board pack can be traced to the contract it came from.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from .types import CallRecord, Product

#: The tenant's contracted rates as of 19 Aug 2026. Entries marked
#: ``provisional`` are placeholders to be confirmed with Sarvam before any
#: figure derived from them is used for budgeting (DECISIONS.md D-007).
DEFAULT_RATE_CARD_VERSION = "tenant-contract-2026-08-19"


@dataclass(frozen=True, slots=True)
class Rate:
    product: Product
    unit: str
    inr: Decimal
    source: str
    provisional: bool = False


DEFAULT_RATES: dict[Product, Rate] = {
    Product.DOCAI_EXTRACT: Rate(
        Product.DOCAI_EXTRACT, "page", Decimal("1.00"), "Tenant contract, 19 Aug 2026"
    ),
    Product.DOCAI_DIGITISE: Rate(
        Product.DOCAI_DIGITISE, "page", Decimal("0.50"), "Sarvam public price page, 19 Aug 2026"
    ),
    Product.LLM_INPUT: Rate(
        Product.LLM_INPUT, "1k_tokens", Decimal("0.30"), "Provisional", provisional=True
    ),
    Product.LLM_OUTPUT: Rate(
        Product.LLM_OUTPUT, "1k_tokens", Decimal("0.90"), "Provisional", provisional=True
    ),
    Product.STT: Rate(
        Product.STT, "audio_second", Decimal("0.01"), "Provisional", provisional=True
    ),
    Product.TTS: Rate(
        Product.TTS, "1k_characters", Decimal("0.15"), "Provisional", provisional=True
    ),
    Product.TRANSLATE: Rate(
        Product.TRANSLATE, "1k_characters", Decimal("0.10"), "Provisional", provisional=True
    ),
}


@dataclass(frozen=True, slots=True)
class RateCard:
    """A priced, versioned, effective-dated set of rates."""

    version: str = DEFAULT_RATE_CARD_VERSION
    rates: dict[Product, Rate] | None = None
    effective_from: date = date(2026, 8, 19)

    def rate_for(self, product: Product) -> Rate:
        table = self.rates or DEFAULT_RATES
        try:
            return table[product]
        except KeyError as exc:  # pragma: no cover - defensive
            raise KeyError(f"No rate for product {product}") from exc

    def price(self, record: CallRecord) -> Decimal:
        """Rupee cost of one call.

        Deliberately explicit per product rather than a generic quantity, so a
        unit mix-up (per-page vs per-thousand-characters) is a compile-time
        shaped mistake rather than a silent factor-of-1000 error in a report.
        """
        rate = self.rate_for(record.product).inr
        match record.product:
            case Product.DOCAI_EXTRACT | Product.DOCAI_DIGITISE:
                return (rate * Decimal(record.pages)).quantize(Decimal("0.0001"))
            case Product.LLM_INPUT:
                return (rate * Decimal(record.input_tokens) / Decimal(1000)).quantize(
                    Decimal("0.0001")
                )
            case Product.LLM_OUTPUT:
                return (rate * Decimal(record.output_tokens) / Decimal(1000)).quantize(
                    Decimal("0.0001")
                )
            case Product.STT:
                return (rate * Decimal(str(record.audio_seconds))).quantize(Decimal("0.0001"))
            case Product.TTS | Product.TRANSLATE:
                return (rate * Decimal(record.characters) / Decimal(1000)).quantize(
                    Decimal("0.0001")
                )
        return Decimal("0")  # pragma: no cover - exhaustive above

    def provisional_products(self) -> list[Product]:
        """Products whose rate is a placeholder, for the console to flag."""
        table = self.rates or DEFAULT_RATES
        return [product for product, rate in table.items() if rate.provisional]


def price_call(record: CallRecord, card: RateCard | None = None) -> CallRecord:
    """Return the record with its rupee cost filled in."""
    from dataclasses import replace

    return replace(record, cost_inr=(card or RateCard()).price(record))
