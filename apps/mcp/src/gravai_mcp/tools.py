"""The MCP tool contract.

Two families:

* **systems-as-tools** — one capability each (`bre.evaluate`, `docai.extract`),
  the primitives an agent composes.
* **agents-as-tools** — a whole agent behind one call (`underwrite_application`),
  for hosts that want the outcome rather than the steps.

Annotations matter for safety: a host may auto-approve a `read_only` tool but
should always confirm a `destructive` one. `mandate.present` moves money and is
marked accordingly.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from gravai_agents import AGENT_CATALOG
from gravai_core.auth import Scope
from gravai_runner.inputs import InputField, inputs_for

ToolFamily = Literal["system", "agent"]


@dataclass(frozen=True, slots=True)
class ToolSpec:
    """One MCP tool."""

    name: str
    family: ToolFamily
    description: str
    input_schema: dict[str, Any]
    scopes: frozenset[Scope]
    read_only: bool = True
    destructive: bool = False
    #: Long-running tools return a run_id and report progress instead of blocking.
    long_running: bool = False
    tags: tuple[str, ...] = field(default=())


def _obj(properties: dict[str, Any], required: list[str]) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": False,
    }


_STR = {"type": "string"}
_APPLICATION_ID = _obj({"application_id": _STR}, ["application_id"])


SYSTEM_TOOLS: tuple[ToolSpec, ...] = (
    ToolSpec(
        "graviton.get_application",
        "system",
        "Fetch one loan application from Graviton by id.",
        _APPLICATION_ID,
        frozenset({Scope.APPLICATIONS_READ}),
    ),
    ToolSpec(
        "graviton.list_documents",
        "system",
        "List the documents attached to an application, with type and page count.",
        _APPLICATION_ID,
        frozenset({Scope.DOCUMENTS_READ}),
    ),
    ToolSpec(
        "graviton.list_pendencies",
        "system",
        "List outstanding requirements on an application and who each is assigned to.",
        _APPLICATION_ID,
        frozenset({Scope.APPLICATIONS_READ}),
    ),
    ToolSpec(
        "graviton.update_status",
        "system",
        "Move an application to a new status. Graviton remains the system of record.",
        _obj({"application_id": _STR, "status": _STR, "note": _STR}, ["application_id", "status"]),
        frozenset({Scope.APPLICATIONS_WRITE}),
        read_only=False,
    ),
    ToolSpec(
        "bre.evaluate",
        "system",
        "Evaluate an application against the tenant's policy pack and return every "
        "rule outcome, pass and fail.",
        _obj({"application_id": _STR, "policy_version": _STR}, ["application_id"]),
        frozenset({Scope.APPLICATIONS_READ}),
    ),
    ToolSpec(
        "bre.explain",
        "system",
        "Explain a BRE evaluation in plain language, suitable for an adverse-action "
        "note. Contains no protected attributes.",
        _obj({"evaluation_id": _STR}, ["evaluation_id"]),
        frozenset({Scope.APPLICATIONS_READ}),
    ),
    ToolSpec(
        "docai.extract",
        "system",
        "Submit a document to Sarvam Document Intelligence for structured field "
        "extraction. Asynchronous: returns a job id. Costs roughly 12 API calls per "
        "document including status polls.",
        _obj({"document_id": _STR, "page_range": _STR}, ["document_id"]),
        frozenset({Scope.DOCUMENTS_WRITE}),
        read_only=False,
        long_running=True,
    ),
    ToolSpec(
        "docai.digitise",
        "system",
        "Submit a document for full-text digitisation. Returns text, which then needs "
        "a model to read it, so it costs about 13 API calls per document plus one LLM "
        "read. Draws on the same 10/min quota as extract.",
        _obj({"document_id": _STR}, ["document_id"]),
        frozenset({Scope.DOCUMENTS_WRITE}),
        read_only=False,
        long_running=True,
    ),
    ToolSpec(
        "docai.job_status",
        "system",
        "Check a Document Intelligence job. Polling is governed centrally; do not "
        "call this in a tight loop.",
        _obj({"job_id": _STR}, ["job_id"]),
        frozenset({Scope.DOCUMENTS_READ}),
    ),
    ToolSpec(
        "risk.score_dpd",
        "system",
        "Probability of 30+ DPD within 6 months, with band. Produced by a versioned "
        "scorecard, not by a language model.",
        _obj({"application_id": _STR, "case_id": _STR}, []),
        frozenset({Scope.APPLICATIONS_READ}),
    ),
    ToolSpec(
        "kyc.verify",
        "system",
        "Cross-check identity across DigiLocker, CKYC and uploaded documents. Aadhaar "
        "is returned masked to the last four digits.",
        _APPLICATION_ID,
        frozenset({Scope.APPLICATIONS_READ}),
    ),
    ToolSpec(
        "aa.fetch_statement",
        "system",
        "Fetch consented bank data through the Account Aggregator framework. Sandbox "
        "only until a licensed AA or TSP is contracted.",
        _obj({"consent_handle": _STR}, ["consent_handle"]),
        frozenset({Scope.DOCUMENTS_READ}),
        tags=("sandbox_only",),
    ),
    ToolSpec(
        "collections.list_cases",
        "system",
        "List delinquent cases with DPD, outstanding principal and contactability.",
        _obj({"portfolio_id": _STR, "min_dpd": {"type": "integer"}}, []),
        frozenset({Scope.COLLECTIONS_READ}),
    ),
    ToolSpec(
        "collections.get_case",
        "system",
        "One collections case with its promise and contact history.",
        _obj({"case_id": _STR}, ["case_id"]),
        frozenset({Scope.COLLECTIONS_READ}),
    ),
    ToolSpec(
        "mandate.present",
        "system",
        "Present an e-NACH or UPI AutoPay mandate for debit. This moves money and "
        "cannot be undone; a pre-debit notice must already have been sent.",
        _obj({"plan_id": _STR}, ["plan_id"]),
        frozenset({Scope.COLLECTIONS_WRITE}),
        read_only=False,
        destructive=True,
    ),
    ToolSpec(
        "ledger.query",
        "system",
        "Query the cost and volume ledger through a named, parameterised template. "
        "Raw SQL is not accepted.",
        _obj(
            {"template": _STR, "params": {"type": "object", "additionalProperties": True}},
            ["template"],
        ),
        frozenset({Scope.USAGE_READ}),
    ),
    ToolSpec(
        "audit.verify_chain",
        "system",
        "Recompute the tenant's audit hash chain and report the first row that does not follow.",
        _obj({}, []),
        frozenset({Scope.AUDIT_READ}),
    ),
)


def _field_schema(field_: InputField) -> dict[str, Any]:
    """One editable input as JSON Schema."""
    if field_.kind == "number":
        schema: dict[str, Any] = {"type": "number"}
        if field_.minimum is not None:
            schema["minimum"] = field_.minimum
        if field_.maximum is not None:
            schema["maximum"] = field_.maximum
    elif field_.kind == "money":
        # Amounts travel as strings so a large rupee figure cannot be rounded
        # by a host's float handling on the way in.
        schema = {"type": ["string", "number"]}
    elif field_.kind == "select":
        schema = {"type": "string", "enum": list(field_.choices)}
    else:
        schema = {"type": "string"}

    sentences = [field_.label]
    if field_.help:
        sentences.append(field_.help)
    # Not "defaults to X": for a sourced field an omitted value is read from the
    # application record or the statement, and promising a constant here would
    # describe behaviour the runner deliberately no longer has.
    sentences.append(f"Omit to {field_.blank_means}")
    schema["description"] = ". ".join(sentences) + "."
    return schema


def _agent_schema(agent_id: str) -> dict[str, Any]:
    """What a host may actually send this agent.

    The previous schema here offered `application_id`, `case_id` and a free-form
    `options` object, none of which the runner reads. A host filling those in
    got the fixture run back and no indication that its arguments went nowhere,
    which is the same failure as a form field wired to nothing.
    """
    spec = inputs_for(agent_id)
    schema = _obj({f.name: _field_schema(f) for f in spec.fields}, [])
    if spec.caveat:
        schema["description"] = spec.caveat
    return schema


def _agent_tool(agent_id: str) -> ToolSpec:
    """Derive the agents-as-tool entry from the agent catalog."""
    spec = AGENT_CATALOG[agent_id]
    return ToolSpec(
        name=spec.tool_name,
        family="agent",
        description=spec.summary,
        input_schema=_agent_schema(agent_id),
        scopes=spec.scopes,
        read_only=spec.advisory_only,
        destructive=not spec.advisory_only,
        long_running=True,
        tags=(str(spec.tier),),
    )


AGENT_TOOLS: tuple[ToolSpec, ...] = tuple(_agent_tool(agent_id) for agent_id in AGENT_CATALOG)

TOOL_CATALOG: dict[str, ToolSpec] = {tool.name: tool for tool in (*SYSTEM_TOOLS, *AGENT_TOOLS)}


def system_tools() -> tuple[ToolSpec, ...]:
    """Tools that wrap one system capability."""
    return SYSTEM_TOOLS


def agent_tools() -> tuple[ToolSpec, ...]:
    """Tools that run a whole agent."""
    return AGENT_TOOLS


def tools_for_scopes(scopes: frozenset[Scope] | set[Scope]) -> list[ToolSpec]:
    """The tool set a principal may see.

    Hosts are given only the tools their token actually permits, so an
    over-broad tool list cannot tempt a model into a call that will 403.

    Every scope a tool declares must be held, not merely one of them. An
    auditor holds `applications:read` but not `agents:run`; an any-match would
    offer them all fourteen agent tools and every call would be refused, which
    is precisely the temptation this function exists to remove.
    """
    held = frozenset(scopes)
    return [tool for tool in TOOL_CATALOG.values() if tool.scopes <= held]
