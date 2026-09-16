"""Evaluation harness.

A prompt version cannot be promoted until its agent's gates pass. Phase 0 ships
the gate definitions so the thresholds are agreed before any prompt exists to
argue about; the runners and golden sets land with each agent.
"""

from __future__ import annotations

from .gates import EVAL_GATES, EvalGate

__version__ = "0.1.0"

__all__ = ["EVAL_GATES", "EvalGate", "__version__"]
