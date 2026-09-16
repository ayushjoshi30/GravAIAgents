"""Output validators.

Prompt instructions are necessary but not sufficient: these run in code, after
every model call, and they are what turn "the prompt says cite your sources"
into a property the platform actually holds.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any

from gravai_core.pii import contains_unmasked_pii
from pydantic import BaseModel

from .prompting import PROTECTED_ATTRIBUTES
from .schemas import Citation, FieldValue

#: Phrases that indicate a document's text was echoed as an instruction — the
#: signature of a successful prompt injection.
_INJECTION_MARKERS = (
    "ignore previous instructions",
    "ignore the above",
    "disregard your instructions",
    "you are now",
    "system prompt",
    "new instructions:",
)

_PROTECTED_RE = re.compile(
    r"\b(" + "|".join(re.escape(word) for word in PROTECTED_ATTRIBUTES) + r")\b",
    re.IGNORECASE,
)


@dataclass(slots=True)
class ValidationReport:
    """What the validators found. Empty means the output may be trusted."""

    violations: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.violations

    def __bool__(self) -> bool:
        return self.ok

    def merge(self, other: ValidationReport) -> ValidationReport:
        return ValidationReport(
            violations=[*self.violations, *other.violations],
            warnings=[*self.warnings, *other.warnings],
        )


def _walk(value: Any) -> Iterable[tuple[str, Any]]:
    """Depth-first walk over a nested structure, yielding (path, value)."""

    def inner(node: Any, path: str) -> Iterable[tuple[str, Any]]:
        if isinstance(node, BaseModel):
            yield from inner(node.model_dump(), path)
        elif isinstance(node, dict):
            yield path, node
            for key, child in node.items():
                yield from inner(child, f"{path}.{key}" if path else str(key))
        elif isinstance(node, list):
            for index, child in enumerate(node):
                yield from inner(child, f"{path}[{index}]")
        else:
            yield path, node

    return inner(value, "")


#: The complete set of keys a Citation can carry.
_CITATION_KEYS = frozenset({"document_id", "page", "system", "field"})


def _looks_like_citation(node: dict[str, Any]) -> bool:
    """Is this dict actually a citation, or does it merely share a field name?

    Carrying `document_id` is not enough. A bank transaction also has
    `document_id` and `page` — pointing at the statement it was read from — and
    treating one as a citation made every transaction sourced from Account
    Aggregator (where there is no document at all, only a consent artefact) a
    malformed-citation violation, escalating runs that were entirely correct.

    A citation is a dict whose keys are *only* citation keys.
    """
    keys = set(node.keys())
    if not keys or not keys <= _CITATION_KEYS:
        return False
    return bool(keys & {"document_id", "page"}) or bool(keys & {"system", "field"})


def validate_citations(output: BaseModel, known_document_ids: Iterable[str]) -> ValidationReport:
    """Every citation must point at a document that was actually in the run.

    A citation to a document id the agent never received is a fabricated source,
    which is worse than an uncited value because it looks verified.
    """
    known = set(known_document_ids)
    report = ValidationReport()

    for path, node in _walk(output):
        if not isinstance(node, dict):
            continue
        if _looks_like_citation(node):
            try:
                citation = Citation.model_validate(node)
            except Exception:
                report.violations.append(f"{path}: citation is malformed")
                continue
            if citation.document_id and citation.document_id not in known:
                report.violations.append(f"{path}: cites unknown document '{citation.document_id}'")
            elif not citation.is_resolvable():
                report.warnings.append(f"{path}: citation is incomplete")
    return report


def validate_grounding(output: BaseModel) -> ValidationReport:
    """A present value needs a citation; an absent one needs a reason."""
    report = ValidationReport()
    for path, node in _walk(output):
        if not isinstance(node, dict):
            continue
        if not {"value", "confidence"} <= node.keys():
            continue
        try:
            field_value = FieldValue.model_validate(node)
        except Exception:
            continue
        if field_value.value is None and not field_value.reason:
            report.violations.append(f"{path}: null value with no reason given")
        if field_value.value is not None and field_value.citation is None:
            report.violations.append(f"{path}: value present with no citation")
    return report


def scan_protected_attributes(output: BaseModel) -> ValidationReport:
    """No protected attribute may appear anywhere in an output."""
    report = ValidationReport()
    for path, node in _walk(output):
        if isinstance(node, str):
            match = _PROTECTED_RE.search(node)
            if match:
                report.violations.append(
                    f"{path}: references protected attribute '{match.group(1)}'"
                )
    return report


def scan_pii_leak(
    output: BaseModel, *, allow_fields: frozenset[str] = frozenset()
) -> ValidationReport:
    """Catch unmasked identifiers in an output before it is stored or displayed."""
    report = ValidationReport()
    for path, node in _walk(output):
        if not isinstance(node, str):
            continue
        leaf = path.rsplit(".", 1)[-1]
        if leaf in allow_fields:
            continue
        found = contains_unmasked_pii(node)
        if found:
            report.violations.append(f"{path}: unmasked {', '.join(found)}")
    return report


def detect_injection_echo(output: BaseModel) -> ValidationReport:
    """Flag output that reads like it absorbed an instruction from a document."""
    report = ValidationReport()
    for path, node in _walk(output):
        if not isinstance(node, str):
            continue
        lowered = node.lower()
        for marker in _INJECTION_MARKERS:
            if marker in lowered:
                report.violations.append(f"{path}: echoes an injection marker ('{marker}')")
                break
    return report


def run_all(
    output: BaseModel,
    *,
    known_document_ids: Iterable[str] = (),
    allow_pii_fields: frozenset[str] = frozenset(),
) -> ValidationReport:
    """Every validator, in one pass."""
    return (
        validate_citations(output, known_document_ids)
        .merge(validate_grounding(output))
        .merge(scan_protected_attributes(output))
        .merge(scan_pii_leak(output, allow_fields=allow_pii_fields))
        .merge(detect_injection_echo(output))
    )
