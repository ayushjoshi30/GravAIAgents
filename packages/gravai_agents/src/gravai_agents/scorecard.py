"""The risk scorecard.

The probability of default is produced **here, in code** — never by a language
model. A model that writes a fluent paragraph containing the number "7.4%" has
not computed anything; it has produced a plausible string. Credit risk is a
quantity, and a quantity needs a function with published inputs, published
weights, and a calibration you can audit.

The language model's job is the opposite and complementary one: extract the
features from documents, and explain the result in words a borrower could be
shown. It never chooses the number.

**v1 is a transparent placeholder.** The weights below are hand-set to be
directionally sensible for Indian retail lending, not fitted to anyone's book.
They exist so the whole pipeline — features, bands, explanation, monitoring —
can be built and tested before a trained model exists. Before production, v1
must be replaced by a scorecard refit on the lender's own outcomes, and the
calibration below re-derived. That replacement changes this file only.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from .schemas import Band

SCORECARD_VERSION = "scorecard-v1-illustrative"


@dataclass(frozen=True, slots=True)
class RiskFeatures:
    """Model inputs.

    Every field is optional because real files are incomplete. A missing feature
    contributes its documented neutral value rather than zero, so absence does
    not silently read as "best possible".
    """

    foir: float | None = None
    ltv: float | None = None
    bounces_6m: int | None = None
    income_stability: float | None = None
    bureau_score: int | None = None
    enquiries_3m: int | None = None
    employment_vintage_months: int | None = None

    def missing(self) -> list[str]:
        return [name for name, value in self.as_dict().items() if value is None]

    def as_dict(self) -> dict[str, float | int | None]:
        return {
            "foir": self.foir,
            "ltv": self.ltv,
            "bounces_6m": self.bounces_6m,
            "income_stability": self.income_stability,
            "bureau_score": self.bureau_score,
            "enquiries_3m": self.enquiries_3m,
            "employment_vintage_months": self.employment_vintage_months,
        }


@dataclass(frozen=True, slots=True)
class Term:
    """One scorecard term: how a feature moves the log-odds."""

    name: str
    weight: float
    #: Value used when the feature is absent. Chosen to be mid-population, so a
    #: thin file is neither rewarded nor unfairly punished.
    neutral: float
    #: Human-readable direction, for the explanation.
    higher_is_worse: bool
    #: Applied before weighting, to put the feature on a sane scale.
    offset: float = 0.0
    scale: float = 1.0
    cap: float | None = None

    def contribution(self, raw: float | None) -> float:
        value = self.neutral if raw is None else float(raw)
        if self.cap is not None:
            value = min(value, self.cap)
        return self.weight * ((value - self.offset) / self.scale)


#: The model. Intercept plus seven terms on the log-odds scale.
INTERCEPT = -3.0

TERMS: tuple[Term, ...] = (
    Term("foir", weight=3.0, neutral=0.40, higher_is_worse=True),
    Term("ltv", weight=0.8, neutral=0.0, higher_is_worse=True),
    Term("bounces_6m", weight=0.45, neutral=0.0, higher_is_worse=True, cap=6),
    Term("income_stability", weight=-1.2, neutral=0.5, higher_is_worse=False),
    # Centred on 700: the scorecard cares about distance from a cut-off, not the
    # absolute number.
    Term("bureau_score", weight=-0.004, neutral=700, higher_is_worse=False, offset=700),
    Term("enquiries_3m", weight=0.12, neutral=2, higher_is_worse=True, cap=15),
    Term(
        "employment_vintage_months",
        weight=-0.015,
        neutral=24,
        higher_is_worse=False,
        cap=60,
    ),
)


@dataclass(frozen=True, slots=True)
class Contribution:
    feature: str
    value: float | int | None
    contribution: float
    direction: str
    imputed: bool


@dataclass(frozen=True, slots=True)
class ScoreResult:
    """What the scorecard produced, and why."""

    version: str
    probability_30dpd_6m: float
    band: Band
    log_odds: float
    contributions: list[Contribution] = field(default_factory=list)
    imputed_features: list[str] = field(default_factory=list)

    def top_drivers(self, limit: int = 3) -> list[Contribution]:
        """The terms that moved the result most, largest first.

        The explanation is generated from these, so a stated driver always
        matches an actual contribution — which is the property the faithfulness
        eval gate checks.
        """
        return sorted(self.contributions, key=lambda c: abs(c.contribution), reverse=True)[:limit]


def score(features: RiskFeatures) -> ScoreResult:
    """Probability of 30+ days past due within six months.

    Bands are policy, not model output: GREEN below 6%, AMBER 6-15%, RED above.
    """
    raw = features.as_dict()
    contributions: list[Contribution] = []
    log_odds = INTERCEPT

    for term in TERMS:
        value = raw.get(term.name)
        amount = term.contribution(value if value is None else float(value))
        log_odds += amount
        contributions.append(
            Contribution(
                feature=term.name,
                value=value,
                contribution=round(amount, 4),
                direction="increases risk" if amount > 0 else "reduces risk",
                imputed=value is None,
            )
        )

    probability = 1.0 / (1.0 + math.exp(-log_odds))
    return ScoreResult(
        version=SCORECARD_VERSION,
        probability_30dpd_6m=round(probability, 4),
        band=Band.for_probability(probability),
        log_odds=round(log_odds, 4),
        contributions=contributions,
        imputed_features=features.missing(),
    )


def population_stability_index(
    expected: list[float], actual: list[float], buckets: int = 10
) -> float:
    """PSI between a training distribution and a live one.

    Drift monitoring: above 0.25 conventionally means the population has moved
    far enough that the scorecard should be refit. Shipped now so the monitoring
    exists before the model it monitors does.
    """
    if not expected or not actual:
        return 0.0

    ordered = sorted(expected)
    edges = [
        ordered[min(len(ordered) - 1, int(len(ordered) * i / buckets))] for i in range(1, buckets)
    ]

    def distribute(values: list[float]) -> list[float]:
        counts = [0] * buckets
        for value in values:
            index = 0
            while index < len(edges) and value > edges[index]:
                index += 1
            counts[index] += 1
        total = len(values)
        # Floor at a small epsilon: an empty bucket would otherwise make the
        # logarithm undefined and the whole index infinite.
        return [max(count / total, 1e-6) for count in counts]

    expected_dist = distribute(expected)
    actual_dist = distribute(actual)
    return round(
        sum((a - e) * math.log(a / e) for e, a in zip(expected_dist, actual_dist, strict=True)),
        4,
    )
