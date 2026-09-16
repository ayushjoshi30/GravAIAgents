"""What each node type actually does.

Every entry in this table performs real work: an agent runs, a model is called,
an endpoint is fetched, an expression is evaluated, a rule engine decides. There
is no node here that draws a box and reports success — `validate_registry`
refuses to let the library offer one that has no entry in this table, and the
test suite asserts it.

Where a capability is genuinely not available in this build, the node says so in
its output rather than inventing a result. The document reader is the standing
example: it is sandboxed, so a node that depends on extraction reports that the
extraction was sandboxed instead of presenting canned fields as findings.
"""

from __future__ import annotations

import json
from decimal import Decimal, InvalidOperation
from typing import Any

from gravai_connectors import GravitonApplication, SandboxBre
from gravai_connectors.document_source import SourceUnusable, fetch_source
from gravai_core.netguard import UnsafeUrl
from gravai_core.settings import get_settings
from gravai_runner import run_agent
from gravai_runner.inputs import inputs_for
from gravai_sarvam.types import CallRecord, ChatMessage, ChatRequest, Product

from .expressions import ExpressionError, evaluate, lookup, render
from .graph import NodeInstance
from .runtime import ExecutionContext, NodeOutcome
from .state import Artifact, Decision

# --- helpers ----------------------------------------------------------------


def _setting(node: NodeInstance, name: str, fallback: Any = None) -> Any:
    spec_default = next(
        (field.default for field in node.spec.config if field.name == name), fallback
    )
    value = node.config.get(name, spec_default)
    return spec_default if value is None else value


def _templated(node: NodeInstance, name: str, ctx: ExecutionContext, fallback: str = "") -> str:
    raw = _setting(node, name, fallback)
    text = raw if isinstance(raw, str) else json.dumps(raw, default=str)
    return render(text, ctx.scope(), strict=False)


def _names(raw: Any) -> list[str]:
    if not raw:
        return []
    if isinstance(raw, list):
        return [str(item).strip() for item in raw if str(item).strip()]
    return [part.strip() for part in str(raw).split(",") if part.strip()]


def _publish(node: NodeInstance, ctx: ExecutionContext, source: dict[str, Any]) -> list[str]:
    """Copy named keys of a node's output into the shared facts."""
    published: list[str] = []
    for name in _names(_setting(node, "publish_facts", "")):
        if name in source:
            ctx.state.set_fact(name, source[name], node_id=node.id)
            published.append(name)
    return published


def _credential(node: NodeInstance, ctx: ExecutionContext) -> str:
    """Resolve a named credential server-side.

    The canvas stores a name, never a token. A workflow definition is saved,
    versioned, exported and read by anyone who can open the studio, so a token
    written into it would be a token published.
    """
    name = str(_setting(node, "credential", "") or "")
    if not name:
        return str(_setting(node, "auth_header", "") or "")
    return ctx.credentials.get(name, "")


async def _fetch(url: str, header: str) -> Any:
    settings = get_settings()
    return await fetch_source(
        url,
        headers={"Authorization": header} if header else None,
        allow_private=settings.document_source_allow_private,
        timeout=settings.document_source_timeout_seconds,
        max_bytes=settings.document_source_max_bytes,
        max_redirects=settings.document_source_max_redirects,
    )


# --- entry and exit ---------------------------------------------------------


async def _input(node: NodeInstance, ctx: ExecutionContext) -> NodeOutcome:
    payload = ctx.state.outputs.get("input", {})
    return NodeOutcome(
        outputs={"payload": payload},
        summary=f"{len(payload) if isinstance(payload, dict) else 0} input fields",
    )


async def _output(node: NodeInstance, ctx: ExecutionContext) -> NodeOutcome:
    mapping = _setting(node, "mapping", {})
    if not isinstance(mapping, dict):
        return NodeOutcome(error="The output mapping must be an object of name to expression")

    scope = ctx.scope()
    answer: dict[str, Any] = {}
    missing: list[str] = []
    for key, expression in mapping.items():
        text = str(expression)
        try:
            answer[key] = render(text, scope, strict=True)
        except ExpressionError as exc:
            # Reported rather than silently omitted: a final answer missing a
            # field it promised is worse than one that says why.
            missing.append(f"{key}: {exc}")
            answer[key] = None

    for problem in missing:
        ctx.state.warnings.append(f"output mapping — {problem}")

    return NodeOutcome(
        outputs=answer,
        summary=f"{len(answer)} fields",
        detail={"unresolved": missing},
    )


# --- intelligence -----------------------------------------------------------


async def _call_model(
    ctx: ExecutionContext, system: str, prompt: str, *, temperature: float, max_tokens: int
) -> tuple[str, int, int, Decimal]:
    messages = []
    if system.strip():
        messages.append(ChatMessage(role="system", content=system))
    messages.append(ChatMessage(role="user", content=prompt))

    response = await ctx.sarvam.chat.complete(
        ChatRequest(
            messages=tuple(messages),
            temperature=float(temperature),
            max_tokens=int(max_tokens),
        )
    )
    cost = _price(ctx, response)
    return response.text, response.usage.input_tokens, response.usage.output_tokens, cost


def _price(ctx: ExecutionContext, response: Any) -> Decimal:
    """Rupee cost of one chat response, through the same card as everything else.

    The rate card prices call records, so a record is what has to be assembled
    here. Reaching for a method that takes a response directly is the obvious
    shape and there is no such method — a node priced down a second path would
    be a second set of figures to reconcile against the agent ledger, which is
    the one number a tenant will actually be invoiced against.

    Input and output tokens are two records because their rates differ; summing
    them is the node's cost. Latency is attributed once, to the input leg, so a
    later ledger built from these does not double-count time.
    """
    card = getattr(ctx.sarvam, "rate_card", None)
    if card is None:
        # Said out loud rather than returned as zero: a run whose rates are
        # unknown must not be readable as a run that cost nothing.
        ctx.state.warnings.append("No rate card is configured, so this call could not be priced")
        return Decimal("0")

    legs = (
        (Product.LLM_INPUT, response.usage.input_tokens, 0, getattr(response, "latency_ms", 0)),
        (Product.LLM_OUTPUT, 0, response.usage.output_tokens, 0),
    )
    total = Decimal("0")
    for product, input_tokens, output_tokens, latency in legs:
        try:
            total += card.price(
                CallRecord(
                    product=product,
                    endpoint="/v1/chat/completions",
                    model=getattr(response, "model", None),
                    input_tokens=input_tokens,
                    output_tokens=output_tokens,
                    latency_ms=latency,
                    sandbox=ctx.sandbox,
                )
            )
        except KeyError:
            # Pricing is reporting, not correctness: a missing rate must not
            # fail a run, but it must not silently read as free either.
            ctx.state.warnings.append(f"No rate card entry for {product}")
            return Decimal("0")
    return total


async def _llm(node: NodeInstance, ctx: ExecutionContext) -> NodeOutcome:
    prompt = _templated(node, "prompt", ctx)
    if not prompt.strip():
        return NodeOutcome(error="The prompt is empty")

    schema = _setting(node, "output_schema", {})
    system = _templated(node, "system_prompt", ctx)
    if isinstance(schema, dict) and schema:
        system = (
            f"{system}\n\nAnswer with JSON only, with exactly these keys: "
            f"{', '.join(schema)}. No prose, no code fences."
        ).strip()

    text, input_tokens, output_tokens, cost = await _call_model(
        ctx,
        system,
        prompt,
        temperature=float(_setting(node, "temperature", 0.2)),
        max_tokens=int(_setting(node, "max_tokens", 800)),
    )

    data: dict[str, Any] = {}
    if isinstance(schema, dict) and schema:
        data = {key: value for key, value in _json_object(text).items() if key in schema}
        missing = [key for key in schema if key not in data]
        if missing:
            # Named rather than silently absent: a downstream node reading a
            # key the model never returned would fail far from the cause.
            ctx.state.warnings.append(
                f"{node.title}: the model did not return {', '.join(missing)}"
            )

    outputs = {"text": text, "data": data}
    published = _publish(node, ctx, data)

    if ctx.sandbox:
        ctx.state.warnings.append(
            f"{node.title}: the language model is sandboxed, so this wording is canned"
        )

    return NodeOutcome(
        outputs=outputs,
        summary=(text[:120] + "…") if len(text) > 120 else text,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cost_inr=cost,
        detail={"published_facts": published},
    )


def _json_object(text: str) -> dict[str, Any]:
    """Pull the first JSON object out of a reply, tolerating fences and prose."""
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("```")[1] if "```" in cleaned[3:] else cleaned[3:]
        cleaned = cleaned.removeprefix("json").strip()
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start == -1 or end <= start:
        return {}
    try:
        parsed = json.loads(cleaned[start : end + 1])
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


async def _summarizer(node: NodeInstance, ctx: ExecutionContext) -> NodeOutcome:
    path = str(_setting(node, "source", "workflow.facts"))
    try:
        subject = lookup(path, ctx.scope())
    except ExpressionError as exc:
        return NodeOutcome(error=str(exc))

    sentences = int(_setting(node, "sentences", 3))
    text, input_tokens, output_tokens, cost = await _call_model(
        ctx,
        "You summarise underwriting material for a credit officer. Be precise and brief.",
        f"In at most {sentences} sentences, summarise:\n\n"
        f"{json.dumps(subject, indent=2, default=str)}",
        temperature=0.1,
        max_tokens=300,
    )
    ctx.state.summaries.append(text)
    return NodeOutcome(
        outputs={"summary": text},
        summary=text[:120],
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cost_inr=cost,
    )


async def _classifier(node: NodeInstance, ctx: ExecutionContext) -> NodeOutcome:
    labels = _names(_setting(node, "labels", ""))
    if len(labels) < 2:
        return NodeOutcome(error="A classifier needs at least two labels")

    path = str(_setting(node, "source", "workflow.facts"))
    try:
        subject = lookup(path, ctx.scope())
    except ExpressionError as exc:
        return NodeOutcome(error=str(exc))

    text, input_tokens, output_tokens, cost = await _call_model(
        ctx,
        f"Answer with exactly one of these words and nothing else: {', '.join(labels)}.",
        json.dumps(subject, indent=2, default=str),
        temperature=0.0,
        max_tokens=16,
    )

    answer = text.strip().strip(".").lower()
    match = next((label for label in labels if label.lower() == answer), "")
    if not match:
        match = next((label for label in labels if label.lower() in answer), "")
    if not match:
        # Refusing beats picking the first label: a wrong class silently chosen
        # would route the whole workflow down the wrong branch.
        return NodeOutcome(
            error=f"The model answered {text.strip()!r}, which is not one of {', '.join(labels)}",
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cost_inr=cost,
        )

    fact_name = str(_setting(node, "fact_name", "classification"))
    if fact_name:
        ctx.state.set_fact(fact_name, match, node_id=node.id)

    return NodeOutcome(
        outputs={"label": match, "confidence": 1.0 if answer == match.lower() else 0.6},
        branch=match,
        summary=match,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cost_inr=cost,
    )


async def _extractor(node: NodeInstance, ctx: ExecutionContext) -> NodeOutcome:
    fields = _setting(node, "fields", {})
    if not isinstance(fields, dict) or not fields:
        return NodeOutcome(error="No fields to extract")

    subject = _templated(node, "source", ctx)
    if not subject.strip():
        subject = json.dumps(ctx.state.facts, indent=2, default=str)

    text, input_tokens, output_tokens, cost = await _call_model(
        ctx,
        "Extract the named fields. Answer with JSON only. Use null where the text "
        "does not say — never guess a value.",
        f"Fields: {json.dumps(fields)}\n\nText:\n{subject}",
        temperature=0.0,
        max_tokens=600,
    )
    found = {key: value for key, value in _json_object(text).items() if key in fields}
    ctx.state.set_facts(found, node_id=node.id)

    return NodeOutcome(
        outputs={"fields": found},
        summary=f"{len(found)} of {len(fields)} fields",
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cost_inr=cost,
    )


# --- data and tools ---------------------------------------------------------


async def _document_source(node: NodeInstance, ctx: ExecutionContext) -> NodeOutcome:
    url = _templated(node, "url", ctx)
    if not url.strip():
        return NodeOutcome(error="No URL")

    try:
        parsed = await _fetch(url, _credential(node, ctx))
    except (UnsafeUrl, SourceUnusable) as exc:
        return NodeOutcome(error=str(exc))

    ctx.state.set_facts(parsed.application, node_id=node.id)
    ctx.state.set_facts(parsed.account, node_id=node.id)
    if parsed.transactions:
        ctx.state.set_fact("transaction_count", len(parsed.transactions), node_id=node.id)

    for document in parsed.documents:
        ctx.state.artifacts.append(
            Artifact(
                node_id=node.id,
                name=document.filename,
                kind=document.declared_type or document.mime_type,
                ref=document.document_id,
                size_bytes=document.size_bytes,
            )
        )

    for note in parsed.notes:
        ctx.state.note(f"{node.title}: {note}")

    if parsed.has_content and not parsed.has_facts:
        ctx.state.warnings.append(
            f"{node.title}: the endpoint returned documents but no extracted facts, and "
            "reading a document needs the document-AI layer configured"
        )

    return NodeOutcome(
        outputs={
            "documents": [doc.document_id for doc in parsed.documents],
            "transactions": list(parsed.transactions),
            "application": parsed.application,
            "account": parsed.account,
        },
        summary=(
            f"{len(parsed.transactions)} lines, {len(parsed.documents)} documents, "
            f"{len(parsed.application)} application fields"
        ),
        detail={"notes": list(parsed.notes), "bytes": parsed.bytes_fetched},
    )


async def _http(node: NodeInstance, ctx: ExecutionContext) -> NodeOutcome:
    url = _templated(node, "url", ctx)
    if not url.strip():
        return NodeOutcome(error="No URL")
    try:
        parsed = await _fetch(url, _credential(node, ctx))
    except (UnsafeUrl, SourceUnusable) as exc:
        return NodeOutcome(error=str(exc))

    body = {
        "application": parsed.application,
        "account": parsed.account,
        "transactions": list(parsed.transactions),
    }
    flat = {**parsed.application, **parsed.account}
    published = _publish(node, ctx, flat)
    return NodeOutcome(
        outputs={"body": body, "status": 200},
        summary=f"{parsed.bytes_fetched} bytes",
        detail={"published_facts": published},
    )


async def _mcp(node: NodeInstance, ctx: ExecutionContext) -> NodeOutcome:
    """Call a tool on an MCP server.

    Runs the tool in-process when the server named is this platform's own,
    because going out over HTTP to call a tool that dispatches to the very
    runner already imported here would add a network hop, a second set of
    credentials and a way for the two paths to disagree.
    """
    server = str(_setting(node, "server", "")).strip()
    tool = str(_setting(node, "tool", "")).strip()
    if not tool:
        return NodeOutcome(error="No tool named")

    arguments = _setting(node, "arguments", {})
    if isinstance(arguments, dict):
        resolved = {
            key: render(str(value), ctx.scope(), strict=False) if isinstance(value, str) else value
            for key, value in arguments.items()
        }
    else:
        resolved = {}

    from gravai_mcp.tools import TOOL_CATALOG

    spec = TOOL_CATALOG.get(tool)
    if spec is None:
        return NodeOutcome(
            error=f"{tool!r} is not a tool this platform serves. "
            f"Known: {', '.join(sorted(TOOL_CATALOG)[:8])}…"
        )
    if spec.family != "agent":
        return NodeOutcome(
            error=f"{tool!r} is a system tool; the MCP servers do not serve those yet"
        )

    agent_id = next(
        (aid for aid, entry in _agent_tool_names().items() if entry == tool),
        "",
    )
    if not agent_id:
        return NodeOutcome(error=f"No agent behind {tool!r}")

    try:
        result = await run_agent(agent_id, ctx.sarvam, inputs=resolved or None)
    except ValueError as exc:
        return NodeOutcome(error=f"{tool}: {exc}")

    payload = result.output.model_dump(mode="json")
    ctx.state.record_output(node.id, payload)
    return NodeOutcome(
        outputs={"result": payload},
        summary=f"{tool} via {server or 'in-process'}",
        cost_inr=result.cost_inr,
        detail={"escalated": result.escalated, "arguments": resolved},
    )


def _agent_tool_names() -> dict[str, str]:
    from gravai_agents import AGENT_CATALOG

    return {agent_id: spec.tool_name for agent_id, spec in AGENT_CATALOG.items()}


# --- business logic ---------------------------------------------------------


async def _bre(node: NodeInstance, ctx: ExecutionContext) -> NodeOutcome:
    mapping = _setting(node, "input_mapping", {})
    scope = ctx.scope()
    facts: dict[str, Any] = {}
    if isinstance(mapping, dict):
        for key, expression in mapping.items():
            rendered = render(str(expression), scope, strict=False)
            # An expression that resolved to nothing comes back as its own
            # template text, because the mapping is rendered leniently: a figure
            # the workflow has not established must not take the whole run down
            # before the rule that needs it has had its say. Dropping it here is
            # what lets that rule report that it could not be applied, rather
            # than seeing it applied to the characters "{{workflow.facts.…}}".
            if "{{" in rendered:
                continue
            facts[key] = _number_if_possible(rendered)

    evaluation = await SandboxBre().evaluate(_policy_record(facts))
    rules = [
        {
            "rule_id": rule.rule_id,
            "description": rule.plain_language or rule.name,
            "result": str(rule.outcome),
            "detail": _observed(rule),
        }
        for rule in evaluation.rules
    ]
    # A referral is not a pass. The policy pack's own words for a file with too
    # many recent enquiries are that it "is reviewed manually", so counting only
    # outright failures here would send it down the automated branch — the one
    # outcome the referral exists to prevent. `failed_rules` therefore carries
    # everything that stood in the way, which is also what the name means to
    # whoever reads the trace afterwards.
    failed = [rule for rule in rules if rule["result"] in {"fail", "refer"}]
    #: The rules that reached a verdict. A rule reports `na` when the file did
    #: not carry what it needed, and an abstention says nothing either way.
    applied = [rule for rule in rules if rule["result"] != "na"]
    # "Nothing objected" is not the finding "policy was met". With none of the
    # figures mapped every rule abstains, and the obvious `not failed` would then
    # report a clean policy check on a file that was never checked — the one
    # wrong answer this node must not give. So an evaluation in which no rule
    # applied is not a pass, and the reason recorded below says which case it was.
    passed = bool(applied) and not failed

    name = str(_setting(node, "decision_name", "bre_result"))
    if not applied:
        reason = "no rule could be applied to the figures supplied"
    elif passed:
        reason = f"{len(applied)} rule(s) applied, all met"
    else:
        reason = f"{len(failed)} rule(s) not met: " + ", ".join(rule["rule_id"] for rule in failed)

    ctx.state.add_decision(
        Decision(
            node_id=node.id,
            name=name,
            value="PASS" if passed else "FAIL",
            deterministic=True,
            reason=reason,
        )
    )
    ctx.state.set_fact(name, "PASS" if passed else "FAIL", node_id=node.id)

    return NodeOutcome(
        outputs={"passed": passed, "rules": rules, "failed_rules": failed},
        branch="pass" if passed else "fail",
        summary=f"{len(applied)} of {len(rules)} rules applied, {'PASS' if passed else 'FAIL'}",
        detail={"policy_version": getattr(evaluation, "policy_version", ""), "reason": reason},
    )


#: The application fields the policy pack actually reads, by the type each has
#: on the record. Listed rather than inferred because the mapping on the canvas
#: is free-form: a tenant may map anything they like, and only these names mean
#: something to a rule.
_POLICY_DECIMALS = (
    "loan_amount",
    "interest_rate_pct",
    "collateral_value",
    "net_monthly_income",
    "existing_monthly_emi",
)
_POLICY_INTEGERS = (
    "tenure_months",
    "bureau_score",
    "enquiries_3m",
    "employment_vintage_months",
)


def _policy_input(value: Any) -> Decimal | None:
    """A mapped value as a number, or None when it is not one.

    None leaves the field unset on the record rather than defaulting it to zero,
    and the difference is the whole point: coercing an absent figure to zero
    would turn "nobody supplied an income" into "the applicant earns nothing",
    which is a policy failure the file did not earn. Unset lets the rule report
    that it could not be applied, which is what actually happened.
    """
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, Decimal):
        return value
    try:
        return Decimal(str(value).strip())
    except (InvalidOperation, ArithmeticError, ValueError):
        return None


def _policy_record(facts: dict[str, Any]) -> GravitonApplication:
    """Shape the mapped facts into the record the rule engine evaluates.

    The connector takes an application, not a bag of names, and that is the
    right contract rather than an inconvenience: policy is written against a
    record whose fields have types, so a tenure arriving as the string "60"
    from a JSON source is converted once here instead of being compared as text
    somewhere inside a threshold. Passing the dictionary straight through is
    the obvious implementation and it does not work at all — every rule reads
    its input as an attribute.
    """
    record: dict[str, Any] = {
        # Identity is carried where the workflow happens to know it. No rule
        # reads these, but the evaluation is recorded against them, and an
        # evaluation that cannot say which application it judged is not
        # evidence of anything.
        "application_id": str(facts.get("application_id") or "unidentified"),
        "external_id": str(
            facts.get("external_id") or facts.get("application_id") or "unidentified"
        ),
        "product": str(facts.get("product") or "loan"),
        "status": str(facts.get("status") or "under_assessment"),
        "applicant_name": str(facts.get("applicant_name") or ""),
    }
    for name in _POLICY_DECIMALS:
        number = _policy_input(facts.get(name))
        if number is not None:
            record[name] = number
    for name in _POLICY_INTEGERS:
        number = _policy_input(facts.get(name))
        if number is not None:
            record[name] = int(number)
    return GravitonApplication.model_validate(record)


def _observed(rule: Any) -> str:
    """What the rule saw against what it required, for the trace."""
    observed = getattr(rule, "observed", None)
    threshold = getattr(rule, "threshold", None)
    if observed and threshold:
        return f"{observed} against {threshold}"
    return str(observed or threshold or "")


def _number_if_possible(text: str) -> Any:
    stripped = text.strip()
    if stripped.lower() in {"true", "false"}:
        return stripped.lower() == "true"
    try:
        return Decimal(stripped)
    except Exception:
        return stripped


async def _calculator(node: NodeInstance, ctx: ExecutionContext) -> NodeOutcome:
    expression = str(_setting(node, "expression", ""))
    try:
        value = lookup(expression, ctx.scope())
    except ExpressionError as exc:
        return NodeOutcome(error=str(exc))

    name = str(_setting(node, "fact_name", "computed"))
    ctx.state.set_fact(name, value, node_id=node.id)
    return NodeOutcome(outputs={"value": value}, summary=f"{name} = {value}")


async def _validator(node: NodeInstance, ctx: ExecutionContext) -> NodeOutcome:
    condition = str(_setting(node, "condition", ""))
    try:
        valid = evaluate(condition, ctx.scope())
    except ExpressionError as exc:
        return NodeOutcome(error=str(exc))

    message = str(_setting(node, "message", "Validation failed"))
    if not valid:
        ctx.state.warnings.append(f"{node.title}: {message}")
        if bool(_setting(node, "stop_on_failure", False)):
            return NodeOutcome(
                outputs={"valid": False}, error=message, summary="failed", branch="false"
            )

    return NodeOutcome(
        outputs={"valid": valid},
        branch="true" if valid else "false",
        summary="passed" if valid else message,
    )


# --- control flow -----------------------------------------------------------


async def _router(node: NodeInstance, ctx: ExecutionContext) -> NodeOutcome:
    branches = _setting(node, "branches", [])
    if not isinstance(branches, list) or not branches:
        return NodeOutcome(error="No branches")

    scope = ctx.scope()
    for entry in branches:
        if not isinstance(entry, dict):
            continue
        label = str(entry.get("label", ""))
        condition = str(entry.get("condition", ""))
        try:
            if evaluate(condition, scope):
                ctx.state.note(f"{node.title} took {label!r}")
                return NodeOutcome(
                    outputs={"branch": label},
                    branch=label,
                    summary=label,
                    detail={"condition": condition},
                )
        except ExpressionError as exc:
            return NodeOutcome(error=f"branch {label!r}: {exc}")

    return NodeOutcome(
        outputs={"branch": ""},
        summary="no branch matched",
        detail={"note": "The run ends here because no branch condition was true"},
    )


async def _condition(node: NodeInstance, ctx: ExecutionContext) -> NodeOutcome:
    expression = str(_setting(node, "condition", ""))
    try:
        result = evaluate(expression, ctx.scope())
    except ExpressionError as exc:
        return NodeOutcome(error=str(exc))
    return NodeOutcome(
        outputs={"result": result},
        branch="true" if result else "false",
        summary="true" if result else "false",
    )


async def _human_approval(node: NodeInstance, ctx: ExecutionContext) -> NodeOutcome:
    reason = _templated(node, "reason", ctx) or "A person must review this case"
    assignee = str(_setting(node, "assign_to", "credit_ops"))
    ctx.state.add_decision(
        Decision(
            node_id=node.id,
            name="human_approval",
            value="PENDING",
            deterministic=True,
            reason=reason,
        )
    )
    ctx.state.note(f"{node.title} raised a review task for {assignee}")
    return NodeOutcome(
        outputs={"pending": True},
        halt=True,
        halt_reason=reason,
        summary=f"awaiting {assignee}",
    )


# --- memory and context -----------------------------------------------------


async def _context_compiler(node: NodeInstance, ctx: ExecutionContext) -> NodeOutcome:
    """Decide what the next node needs to know.

    Selection, counting and carrying forward are ordinary data work, so this
    does them in code. The model is used only when asked for, and only to
    compress prose — calling one between every pair of nodes is the usual way a
    workflow becomes slow and expensive without becoming better.
    """
    keep = _names(_setting(node, "keep_facts", ""))
    facts = (
        {name: ctx.state.facts[name] for name in keep if name in ctx.state.facts}
        if keep
        else dict(ctx.state.facts)
    )
    missing = [name for name in keep if name not in ctx.state.facts]
    for name in missing:
        ctx.state.warnings.append(f"{node.title}: asked to carry {name!r}, which nothing has set")

    input_tokens = output_tokens = 0
    cost = Decimal("0")

    if bool(_setting(node, "use_model", False)):
        summary, input_tokens, output_tokens, cost = await _call_model(
            ctx,
            "You brief the next stage of an underwriting workflow. State only what the "
            "material says. Two or three sentences.",
            "What has happened so far:\n"
            + json.dumps(
                {
                    "facts": facts,
                    "summaries": ctx.state.summaries[-3:],
                    "decisions": [d.name + "=" + str(d.value) for d in ctx.state.decisions],
                    "warnings": ctx.state.warnings[-5:],
                },
                indent=2,
                default=str,
            ),
            temperature=0.1,
            max_tokens=250,
        )
    else:
        parts = [f"{len(facts)} facts established"]
        if ctx.state.decisions:
            parts.append(", ".join(f"{d.name} = {d.value}" for d in ctx.state.decisions[-3:]))
        if ctx.state.warnings:
            parts.append(f"{len(ctx.state.warnings)} warnings raised")
        summary = "; ".join(parts) + "."

    ctx.state.summaries.append(summary)
    recommended = str(_setting(node, "recommended_next_action", ""))

    return NodeOutcome(
        outputs={
            "summary": summary,
            "facts": facts,
            "warnings": list(ctx.state.warnings),
            "recommended_next_action": recommended,
        },
        summary=f"{len(facts)} relevant facts",
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cost_inr=cost,
        detail={"dropped": max(0, len(ctx.state.facts) - len(facts)), "missing": missing},
    )


async def _set_state(node: NodeInstance, ctx: ExecutionContext) -> NodeOutcome:
    values = _setting(node, "facts", {})
    if not isinstance(values, dict):
        return NodeOutcome(error="Facts must be an object")
    scope = ctx.scope()
    written = {
        key: render(str(value), scope, strict=False) if isinstance(value, str) else value
        for key, value in values.items()
    }
    ctx.state.set_facts(written, node_id=node.id)
    return NodeOutcome(outputs={"facts": written}, summary=f"{len(written)} facts set")


# --- the GravAI agents ------------------------------------------------------

#: The one key an agent node's narration is allowed to occupy. Everything the
#: agent scored stays at the top level and everything the model wrote sits
#: under this name, so `{{nodes.risk.probability_30dpd_6m}}` can only ever be
#: the scorecard's figure and `{{nodes.risk.narration.probability_30dpd_6m}}`
#: can only ever be prose about it. Nobody reading a workflow should have to
#: know which fields an agent declares in order to tell the two apart.
NARRATION_KEY = "narration"

#: Said to the model every time a narration is asked for. The agent has already
#: decided; this call is here to put what it decided into words, and a model
#: that recomputes a figure it was shown is the one failure that would make the
#: whole feature unsafe to offer.
_NARRATION_SYSTEM = (
    "You describe a result that has already been produced by a versioned model "
    "and by code. Every figure and every finding you are shown was computed "
    "before you were called: state what it says, quote it exactly, and never "
    "recompute, re-round, re-rank or invent one."
)


async def _narrate(
    node: NodeInstance, ctx: ExecutionContext, payload: dict[str, Any]
) -> tuple[Any, int, int, Decimal]:
    """Put an agent's result into the words the canvas asked for.

    `payload` is read and never written. What comes back is the narration —
    prose, or an object holding exactly the keys the node asked for — and it is
    the caller's job to keep it in its own namespace.

    `None` is returned when the node asked for no narration, which is the case
    for nearly every node on nearly every canvas. That is the whole reason for
    the early return below: a node that did not ask for prose must not reach
    the model, must not wait for it and must not be charged for it.
    """
    raw = _setting(node, "prompt", "")
    instruction = raw if isinstance(raw, str) else json.dumps(raw, default=str)
    if not instruction.strip():
        return None, 0, 0, Decimal("0")

    schema = _setting(node, "output_schema", {})
    if schema and not isinstance(schema, dict):
        # The panel takes free JSON here and `["headline", "next_step"]` is the
        # shape most people reach for first. Read past in silence it would
        # withdraw both of the setting's promises at once: the reply is not
        # shaped, and — the one that matters — the check below that refuses a
        # key the agent has already scored never runs. A setting that quietly
        # does nothing is worse than one that is refused, so the node says what
        # it ignored and what that costs the person who wrote it.
        ctx.state.warnings.append(
            f"{node.title}: the narration fields must be an object of name to description, "
            f"not {type(schema).__name__}, so the narration comes back as prose and no key "
            "was checked against the fields this agent produces"
        )
        schema = {}

    if isinstance(schema, dict):
        for name in schema:
            if name not in payload:
                continue
            # Named rather than quietly namespaced away. Asking the model for a
            # field the agent itself produces is someone expecting a scored
            # value to be improved upon, and the answer is that it cannot be:
            # the agent's value stands untouched and the model's opinion is
            # readable only at an address that says what it is.
            address = "{{nodes." + f"{node.id}.{NARRATION_KEY}.{name}" + "}}"
            ctx.state.warnings.append(
                f"{node.title}: the narration asks for {name!r}, which this agent already "
                f"produces. The agent's value stands; the narration's is at {address}."
            )

    # The agent's own result is addressable as `result` because it is not in the
    # shared state yet — the engine records a node's output only once this
    # executor has returned. Without it a prompt could not refer to the very
    # thing it is being asked to describe.
    prompt = render(instruction, {**ctx.scope(), "result": payload}, strict=False)

    system = _NARRATION_SYSTEM
    if isinstance(schema, dict) and schema:
        system = (
            f"{system}\n\nAnswer with JSON only, with exactly these keys: "
            f"{', '.join(schema)}. No prose, no code fences."
        )

    text, input_tokens, output_tokens, cost = await _call_model(
        ctx,
        system,
        f"{prompt}\n\nWhat the agent produced:\n{json.dumps(payload, indent=2, default=str)}",
        temperature=0.2,
        max_tokens=600,
    )

    if ctx.sandbox:
        ctx.state.warnings.append(
            f"{node.title}: the language model is sandboxed, so this narration is canned"
        )

    if not (isinstance(schema, dict) and schema):
        return text, input_tokens, output_tokens, cost

    data = {key: value for key, value in _json_object(text).items() if key in schema}
    missing = [key for key in schema if key not in data]
    if missing:
        # Named rather than silently absent, for the same reason the LLM node
        # names them: a downstream node reading a key the model never returned
        # would fail a long way from the cause.
        ctx.state.warnings.append(
            f"{node.title}: the narration did not return {', '.join(missing)}"
        )
    return data, input_tokens, output_tokens, cost


def _agent_executor(agent_id: str):
    async def run(node: NodeInstance, ctx: ExecutionContext) -> NodeOutcome:
        overrides = _setting(node, "overrides", {})
        if not isinstance(overrides, dict):
            overrides = {}

        scope = ctx.scope()
        resolved: dict[str, Any] = {}
        for key, value in overrides.items():
            resolved[key] = (
                render(str(value), scope, strict=False) if isinstance(value, str) else value
            )

        # A fact the workflow already established is used where the agent
        # declares a matching field and the canvas has not overridden it. This
        # is what makes a chain of agents share one view of the applicant
        # instead of each starting from the fixtures.
        declared = {field.name for field in inputs_for(agent_id).fields}
        for name in declared - set(resolved):
            if name in ctx.state.facts:
                resolved[name] = ctx.state.facts[name]

        try:
            result = await run_agent(
                agent_id,
                ctx.sarvam,
                inputs=resolved or None,
                fixtures=ctx.fixtures,
            )
        except ValueError as exc:
            return NodeOutcome(error=str(exc))

        payload = result.output.model_dump(mode="json")
        published = _publish(node, ctx, payload)

        if result.escalated:
            ctx.state.add_decision(
                Decision(
                    node_id=node.id,
                    name=f"{agent_id}_escalated",
                    value=True,
                    deterministic=False,
                    reason=result.escalation_reason or "",
                )
            )
        if not result.validation.ok:
            for violation in result.validation.violations:
                ctx.state.warnings.append(f"{node.title}: {violation}")

        summary = getattr(result.output, "reasoning_summary", "") or f"{agent_id} completed"
        ctx.state.summaries.append(summary)

        # Last, and deliberately so. The escalation, the guardrail violations
        # and the published facts are the record of what the agent decided;
        # they are all in the state before a single token is spent describing
        # them, so nothing about that record can turn on whether the model
        # answered.
        narration: Any = None
        input_tokens = output_tokens = 0
        narration_cost = Decimal("0")
        try:
            narration, input_tokens, output_tokens, narration_cost = await _narrate(
                node, ctx, payload
            )
        except Exception as exc:
            # A narration is commentary on a result that already exists, so a
            # model that cannot produce one must not take the result down with
            # it. Letting this reach the engine would fail the node, discard a
            # score that was computed correctly and skip everything downstream
            # of it — over the wording.
            ctx.state.warnings.append(
                f"{node.title}: the narration could not be produced — {type(exc).__name__}: {exc}"
            )

        # A new dictionary, never `payload` itself, and the narration lands on
        # one key of it. This is the line the product's central claim rests on:
        # what the agent scored is copied through verbatim, and the model's
        # wording is reachable only through a name that says it is wording.
        outputs: dict[str, Any] = dict(payload)
        if narration is not None:
            if NARRATION_KEY in outputs:
                # No agent declares a field by this name today and the suite
                # asserts it, so this is unreachable — but a generated value
                # standing where a scored one was expected is the single
                # failure this design exists to prevent, and "unreachable"
                # is not a guarantee. The agent's field wins and the narration
                # stays in the trace, where nothing can address it.
                ctx.state.warnings.append(
                    f"{node.title}: {agent_id} produces a field named {NARRATION_KEY!r} of its "
                    "own, so the narration is recorded in the trace only and cannot be "
                    "referenced downstream"
                )
            else:
                outputs[NARRATION_KEY] = narration

        return NodeOutcome(
            outputs=outputs,
            summary=summary[:120],
            # The agent's cost plus the narration's own, and nothing else moves:
            # describing a result does not change what producing it cost. The
            # token counts are the narration's alone, because an agent's
            # internal calls are priced into `result.cost_inr` rather than
            # broken out.
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cost_inr=result.cost_inr + narration_cost,
            detail={
                "escalated": result.escalated,
                "guardrails_passed": result.validation.ok,
                "published_facts": published,
                "overrides": resolved,
                "narrated": narration is not None,
                **(
                    {NARRATION_KEY: narration}
                    if narration is not None and NARRATION_KEY in payload
                    else {}
                ),
            },
        )

    return run


EXECUTORS: dict[str, Any] = {
    "input": _input,
    "output": _output,
    "llm": _llm,
    "summarizer": _summarizer,
    "classifier": _classifier,
    "extractor": _extractor,
    "document_source": _document_source,
    "http": _http,
    "mcp": _mcp,
    "bre": _bre,
    "calculator": _calculator,
    "validator": _validator,
    "router": _router,
    "condition": _condition,
    "human_approval": _human_approval,
    "context_compiler": _context_compiler,
    "set_state": _set_state,
}

from gravai_runner import RUNNABLE  # noqa: E402  (after EXECUTORS, to build agent entries)

for _agent_id in RUNNABLE:
    EXECUTORS[f"agent.{_agent_id}"] = _agent_executor(_agent_id)
