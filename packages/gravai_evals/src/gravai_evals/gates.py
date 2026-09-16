"""Promotion gates.

Each gate is a metric plus the minimum a prompt version must reach before it can
be promoted. Agreeing these up front is what stops "it looked fine in the demo"
from becoming a release criterion.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class EvalGate:
    agent_id: str
    metric: str
    minimum: float
    description: str


EVAL_GATES: tuple[EvalGate, ...] = (
    EvalGate(
        "doc_intelligence",
        "classification_f1",
        0.95,
        "Document-type classification F1 over a 300-document golden set.",
    ),
    EvalGate(
        "doc_intelligence",
        "field_exact_match",
        0.92,
        "Extracted field values matching the labelled value exactly.",
    ),
    EvalGate(
        "doc_intelligence",
        "citation_validity",
        1.0,
        "Every citation resolves to a document and page that exist in the run. "
        "Anything below 1.0 means the agent invented a source.",
    ),
    EvalGate(
        "bank_statement_analytics",
        "narration_accuracy",
        0.93,
        "Transaction narration classification accuracy (salary, EMI, bounce, cash).",
    ),
    EvalGate(
        "bank_statement_analytics",
        "income_within_5pct",
        0.95,
        "Median monthly income within 5% of the labelled figure.",
    ),
    EvalGate(
        "credit_appraisal",
        "foir_ltv_exact",
        1.0,
        "FOIR and LTV computed exactly. These are arithmetic, not judgement.",
    ),
    EvalGate(
        "credit_appraisal",
        "no_protected_attributes",
        1.0,
        "No output references religion, caste, gender or other protected attributes.",
    ),
    EvalGate(
        "risk_scoring",
        "band_agreement",
        0.90,
        "Predicted band agreeing with the labelled outcome band.",
    ),
    EvalGate(
        "risk_scoring",
        "explanation_faithfulness",
        0.95,
        "Stated drivers matching the scorecard's actual feature contributions. "
        "An explanation that does not match the model is worse than none.",
    ),
    EvalGate(
        "voice_collections",
        "compliance_phrase_adherence",
        1.0,
        "AI disclosure, recording notice and calling-window checks present on every "
        "call. This gate is absolute.",
    ),
    EvalGate(
        "voice_collections",
        "ptp_slot_accuracy",
        0.95,
        "Promise-to-pay date and amount captured correctly.",
    ),
    EvalGate(
        "speech_analytics",
        "quote_verbatim",
        1.0,
        "Every quoted line appears verbatim in the transcript at the stated timestamp.",
    ),
)


def gates_for(agent_id: str) -> tuple[EvalGate, ...]:
    """The gates one agent must clear before promotion."""
    return tuple(gate for gate in EVAL_GATES if gate.agent_id == agent_id)
