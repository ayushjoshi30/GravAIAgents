"""What node types exist, and what each one promises.

A node's contract is its input ports, its output ports and its configuration.
The canvas renders from this, the validator checks a graph against it, and the
engine dispatches on it — one declaration, so a node cannot appear in the
library that the engine has no executor for. `validate_registry` asserts
exactly that and the test suite runs it.

The fourteen GravAI agent nodes are **derived** rather than written out: their
labels come from the agent catalog and their output ports from the agent's own
Pydantic output model. Transcribing them would guarantee a day where the canvas
offers a field the agent stopped returning.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from gravai_agents import AGENT_CATALOG
from gravai_agents.base import Agent
from gravai_runner import RUNNABLE

#: Families, in the order the node library shows them.
FAMILIES: tuple[tuple[str, str], ...] = (
    ("intelligence", "Intelligence"),
    ("gravai", "GravAI Agents"),
    ("data", "Data & Tools"),
    ("business", "Business Logic"),
    ("control", "Control Flow"),
    ("memory", "Memory & Context"),
)

PortType = str  # "string" | "number" | "boolean" | "object" | "array" | "any"


@dataclass(frozen=True, slots=True)
class Port:
    """One named value a node consumes or produces."""

    name: str
    type: PortType = "any"
    required: bool = False
    description: str = ""


@dataclass(frozen=True, slots=True)
class ConfigField:
    """One configurable setting, rendered in the node's panel."""

    name: str
    label: str
    kind: str  # text | textarea | number | select | boolean | expression | json
    default: Any = ""
    help: str = ""
    choices: tuple[str, ...] = ()
    required: bool = False
    #: True when the value may contain `{{ ... }}` references to the state.
    templated: bool = False


@dataclass(frozen=True, slots=True)
class NodeSpec:
    """One node type."""

    type: str
    family: str
    label: str
    summary: str
    inputs: tuple[Port, ...] = ()
    outputs: tuple[Port, ...] = ()
    config: tuple[ConfigField, ...] = ()
    #: True when running this node calls the language model. Drives the cost
    #: estimate and the "this is reasoning, not arithmetic" marking in the UI.
    uses_llm: bool = False
    #: True when the same inputs always give the same output. A deterministic
    #: node's decision cannot be overruled by a model's.
    deterministic: bool = True
    #: Control-flow nodes choose which edge to follow; everything else runs all
    #: of its outgoing edges.
    branching: bool = False
    icon: str = "bolt"
    #: Stated plainly where a node cannot do the whole of what its name implies.
    caveat: str = ""


def _implementations() -> dict[str, type[Agent]]:
    import gravai_agents.implementations as implementations

    found: dict[str, type[Agent]] = {}
    for name in dir(implementations):
        obj = getattr(implementations, name)
        if isinstance(obj, type) and issubclass(obj, Agent) and getattr(obj, "id", None):
            found[obj.id] = obj
    return found


#: Fields every agent output carries. Listed once rather than on all fourteen.
_COMMON_AGENT_FIELDS = ("flags", "escalate", "escalation_reason", "reasoning_summary")


def _agent_nodes() -> dict[str, NodeSpec]:
    """One node per runnable agent, with ports taken from its output model."""
    implementations = _implementations()
    nodes: dict[str, NodeSpec] = {}

    for agent_id, spec in AGENT_CATALOG.items():
        if agent_id not in RUNNABLE:
            # The catalog is allowed to list an agent the runner cannot yet
            # assemble inputs for; the canvas is not allowed to offer it.
            continue

        implementation = implementations.get(agent_id)
        outputs: list[Port] = []
        if implementation is not None:
            for name, model_field in implementation.output_model.model_fields.items():
                outputs.append(
                    Port(
                        name=name,
                        type=_port_type(model_field.annotation),
                        description=(model_field.description or "").strip(),
                    )
                )

        nodes[f"agent.{agent_id}"] = NodeSpec(
            type=f"agent.{agent_id}",
            family="gravai",
            label=spec.name,
            summary=spec.summary,
            inputs=(Port("state", "object", description="Reads the shared workflow state"),),
            outputs=tuple(outputs),
            config=(
                ConfigField(
                    "overrides",
                    "Input overrides",
                    "json",
                    default={},
                    help="Values to override for this run. Blank fields read from the source.",
                ),
                ConfigField(
                    "publish_facts",
                    "Publish as facts",
                    "text",
                    default="",
                    help="Comma-separated output fields to write into workflow facts",
                ),
            ),
            uses_llm=True,
            deterministic=False,
            icon=agent_id,
        )
    return nodes


def _port_type(annotation: Any) -> PortType:
    text = str(annotation)
    if "list" in text or "tuple" in text:
        return "array"
    if "dict" in text:
        return "object"
    if "bool" in text:
        return "boolean"
    if "int" in text or "float" in text or "Decimal" in text:
        return "number"
    if "str" in text:
        return "string"
    return "any"


_CORE: tuple[NodeSpec, ...] = (
    # --- entry and exit ---------------------------------------------------
    NodeSpec(
        type="input",
        family="control",
        label="Input",
        summary="Where the workflow starts. Its fields become the first facts.",
        outputs=(Port("payload", "object", description="Whatever the caller sent"),),
        config=(
            ConfigField(
                "schema",
                "Input schema",
                "json",
                default={"loan_id": "string"},
                help="Field names and types this agent accepts when deployed",
            ),
        ),
        icon="inbox",
    ),
    NodeSpec(
        type="output",
        family="control",
        label="Output",
        summary="The workflow's final answer, assembled from the state.",
        inputs=(Port("state", "object"),),
        config=(
            ConfigField(
                "mapping",
                "Output mapping",
                "json",
                default={"decision": "{{workflow.facts.decision}}"},
                help="Field name to expression. Each value may reference the state.",
                templated=True,
            ),
        ),
        icon="check",
    ),
    # --- intelligence -----------------------------------------------------
    NodeSpec(
        type="llm",
        family="intelligence",
        label="LLM Agent",
        summary="Reasons over the state and returns prose or structured JSON.",
        inputs=(Port("state", "object"),),
        outputs=(Port("text", "string"), Port("data", "object")),
        config=(
            ConfigField("system_prompt", "System prompt", "textarea", default="", templated=True),
            ConfigField(
                "prompt",
                "Prompt",
                "textarea",
                default="Assess the applicant using:\n\n{{workflow.facts}}",
                required=True,
                templated=True,
                help="May reference {{workflow.facts}}, {{workflow.summaries}}, {{nodes.<id>}}",
            ),
            ConfigField(
                "output_schema",
                "Structured output",
                "json",
                default={},
                help="Field name to type. Leave empty for prose.",
            ),
            ConfigField("temperature", "Temperature", "number", default=0.2),
            ConfigField("max_tokens", "Max tokens", "number", default=800),
            ConfigField(
                "publish_facts",
                "Publish as facts",
                "text",
                default="",
                help="Comma-separated keys from the structured output to write into facts",
            ),
        ),
        uses_llm=True,
        deterministic=False,
        icon="bolt",
    ),
    NodeSpec(
        type="summarizer",
        family="intelligence",
        label="Summarizer",
        summary="Compresses part of the state into a few sentences.",
        inputs=(Port("state", "object"),),
        outputs=(Port("summary", "string"),),
        config=(
            ConfigField(
                "source",
                "What to summarise",
                "expression",
                default="workflow.facts",
                required=True,
                help="A path into the state",
            ),
            ConfigField("sentences", "Sentences", "number", default=3),
        ),
        uses_llm=True,
        deterministic=False,
        icon="book",
    ),
    NodeSpec(
        type="classifier",
        family="intelligence",
        label="Classifier",
        summary="Puts the state into one of a fixed set of labels.",
        inputs=(Port("state", "object"),),
        outputs=(Port("label", "string"), Port("confidence", "number")),
        config=(
            ConfigField(
                "source", "What to classify", "expression", default="workflow.facts", required=True
            ),
            ConfigField(
                "labels",
                "Labels",
                "text",
                default="approve,review,decline",
                required=True,
                help="Comma-separated. The model must answer with exactly one.",
            ),
            ConfigField("fact_name", "Write to fact", "text", default="classification"),
        ),
        uses_llm=True,
        deterministic=False,
        icon="grid",
    ),
    NodeSpec(
        type="extractor",
        family="intelligence",
        label="Extractor",
        summary="Pulls named fields out of text into facts.",
        inputs=(Port("state", "object"),),
        outputs=(Port("fields", "object"),),
        config=(
            ConfigField("source", "Text to read", "textarea", default="", templated=True),
            ConfigField(
                "fields",
                "Fields to extract",
                "json",
                default={"applicant_name": "string", "monthly_income": "number"},
                required=True,
            ),
        ),
        uses_llm=True,
        deterministic=False,
        icon="file",
    ),
    # --- data and tools ---------------------------------------------------
    NodeSpec(
        type="document_source",
        family="data",
        label="Document Source",
        summary="Fetches real documents or already-extracted facts from your endpoint.",
        outputs=(
            Port("documents", "array"),
            Port("transactions", "array"),
            Port("application", "object"),
            Port("account", "object"),
        ),
        config=(
            ConfigField("url", "URL", "text", default="", required=True, templated=True),
            ConfigField("auth_header", "Authorization header", "text", default=""),
        ),
        icon="database",
        caveat=(
            "Returns facts usable immediately. Raw documents still need the "
            "document-AI layer configured before anything reads them."
        ),
    ),
    NodeSpec(
        type="http",
        family="data",
        label="API Call",
        summary="A GET against an endpoint you control, with the same guard as the source.",
        outputs=(Port("body", "object"), Port("status", "number")),
        config=(
            ConfigField("url", "URL", "text", default="", required=True, templated=True),
            ConfigField("auth_header", "Authorization header", "text", default=""),
            ConfigField(
                "publish_facts",
                "Publish as facts",
                "text",
                default="",
                help="Comma-separated keys of the JSON body to write into facts",
            ),
        ),
        icon="globe",
    ),
    NodeSpec(
        type="mcp",
        family="data",
        label="MCP Tool",
        summary="Calls a tool on an MCP server over Streamable HTTP.",
        outputs=(Port("result", "object"),),
        config=(
            ConfigField(
                "server",
                "MCP server",
                "text",
                default="https://credit.pilotpod.in/mcp",
                required=True,
            ),
            ConfigField("tool", "Tool", "text", default="score_risk", required=True),
            ConfigField("arguments", "Arguments", "json", default={}, templated=True),
            ConfigField(
                "credential",
                "Credential name",
                "text",
                default="",
                help="Names a token held server-side. The token itself never reaches the browser.",
            ),
        ),
        icon="terminal",
    ),
    # --- business logic ---------------------------------------------------
    NodeSpec(
        type="bre",
        family="business",
        label="Business Rule Engine",
        summary="Evaluates the tenant's policy rules. Deterministic, and final.",
        inputs=(Port("state", "object"),),
        outputs=(
            Port("passed", "boolean"),
            Port("rules", "array"),
            Port("failed_rules", "array"),
        ),
        config=(
            ConfigField(
                "decision_name",
                "Decision name",
                "text",
                default="bre_result",
                required=True,
                help="The name this determination is recorded under",
            ),
            ConfigField(
                "input_mapping",
                "Input mapping",
                "json",
                default={
                    "loan_amount": "{{workflow.facts.loan_amount}}",
                    "bureau_score": "{{workflow.facts.bureau_score}}",
                },
                templated=True,
            ),
        ),
        icon="shield",
        caveat="A model node cannot overturn this; the engine refuses the write.",
    ),
    NodeSpec(
        type="calculator",
        family="business",
        label="Calculator",
        summary="Reads a figure out of the state and records it under a name. No model involved.",
        inputs=(Port("state", "object"),),
        outputs=(Port("value", "number"),),
        config=(
            ConfigField(
                "expression",
                "Expression",
                "expression",
                default="workflow.facts.monthly_income",
                required=True,
            ),
            ConfigField("fact_name", "Write to fact", "text", default="computed", required=True),
        ),
        icon="chart",
        caveat=(
            "This build resolves a path; it does not compute. The expression grammar has no "
            "arithmetic operators, so `monthly_income * 12` is refused on the canvas rather "
            "than failing part way through a run."
        ),
    ),
    NodeSpec(
        type="validator",
        family="business",
        label="Validator",
        summary="Asserts a condition holds, and records a warning when it does not.",
        inputs=(Port("state", "object"),),
        outputs=(Port("valid", "boolean"),),
        config=(
            ConfigField(
                "condition",
                "Condition",
                "expression",
                default="workflow.facts.monthly_income > 0",
                required=True,
            ),
            ConfigField("message", "Message when it fails", "text", default="Validation failed"),
            ConfigField(
                "stop_on_failure", "Stop the workflow on failure", "boolean", default=False
            ),
        ),
        icon="check",
    ),
    # --- control flow -----------------------------------------------------
    NodeSpec(
        type="router",
        family="control",
        label="Router",
        summary="Sends the run down one branch. Conditions are deterministic.",
        inputs=(Port("state", "object"),),
        outputs=(Port("branch", "string"),),
        config=(
            ConfigField(
                "branches",
                "Branches",
                "json",
                default=[
                    {"label": "approve", "condition": "workflow.facts.bureau_score >= 700"},
                    {"label": "review", "condition": "true"},
                ],
                required=True,
                help="Evaluated top to bottom; the first true one wins. End with a fallback.",
            ),
        ),
        branching=True,
        icon="activity",
    ),
    NodeSpec(
        type="condition",
        family="control",
        label="Condition",
        summary="A two-way branch on one expression.",
        inputs=(Port("state", "object"),),
        outputs=(Port("result", "boolean"),),
        config=(
            ConfigField(
                "condition",
                "Condition",
                "expression",
                default="workflow.facts.documents_verified",
                required=True,
            ),
        ),
        branching=True,
        icon="activity",
    ),
    NodeSpec(
        type="human_approval",
        family="control",
        label="Human Approval",
        summary="Stops the run and raises a review task. Nothing past it executes.",
        inputs=(Port("state", "object"),),
        outputs=(Port("pending", "boolean"),),
        config=(
            ConfigField("reason", "Why a person is needed", "text", default="", templated=True),
            ConfigField("assign_to", "Assign to", "text", default="credit_ops"),
        ),
        icon="inbox",
        caveat="A genuine halt: the run ends as `awaiting_approval` rather than continuing.",
    ),
    # --- memory and context -----------------------------------------------
    NodeSpec(
        type="context_compiler",
        family="memory",
        label="Context Compiler",
        summary="Selects what the next node needs to know, instead of passing everything.",
        inputs=(Port("state", "object"),),
        outputs=(
            Port("summary", "string"),
            Port("facts", "object"),
            Port("warnings", "array"),
            Port("recommended_next_action", "string"),
        ),
        config=(
            ConfigField(
                "keep_facts",
                "Facts to carry",
                "text",
                default="",
                help="Comma-separated fact names. Empty carries them all.",
            ),
            ConfigField(
                "use_model",
                "Use the model to summarise",
                "boolean",
                default=False,
                help=(
                    "Off by default: selecting and counting needs no model, and a call "
                    "between every node is the usual way a workflow becomes slow and "
                    "expensive without becoming better."
                ),
            ),
            ConfigField("recommended_next_action", "Recommended next action", "text", default=""),
        ),
        icon="chain",
    ),
    NodeSpec(
        type="set_state",
        family="memory",
        label="Workflow State",
        summary="Writes named facts directly.",
        inputs=(Port("state", "object"),),
        outputs=(Port("facts", "object"),),
        config=(
            ConfigField(
                "facts",
                "Facts to set",
                "json",
                default={"reviewed": True},
                required=True,
                templated=True,
            ),
        ),
        icon="database",
    ),
)


NODE_REGISTRY: dict[str, NodeSpec] = {spec.type: spec for spec in _CORE}
NODE_REGISTRY.update(_agent_nodes())


def node_spec(node_type: str) -> NodeSpec:
    spec = NODE_REGISTRY.get(node_type)
    if spec is None:
        raise KeyError(f"No node type {node_type!r}")
    return spec


def by_family() -> dict[str, list[NodeSpec]]:
    grouped: dict[str, list[NodeSpec]] = {key: [] for key, _ in FAMILIES}
    for spec in NODE_REGISTRY.values():
        grouped.setdefault(spec.family, []).append(spec)
    for specs in grouped.values():
        specs.sort(key=lambda s: s.label)
    return grouped


def validate_registry(executors: dict[str, Any]) -> list[str]:
    """Every declared node must have an executor, and vice versa.

    A node in the library with no executor is a box that pretends to run, which
    is the specific thing this product must not contain.
    """
    problems: list[str] = []
    for node_type in NODE_REGISTRY:
        if node_type not in executors:
            problems.append(f"{node_type} is in the library but has no executor")
    for node_type in executors:
        if node_type not in NODE_REGISTRY:
            problems.append(f"{node_type} has an executor but is not in the library")
    return problems
