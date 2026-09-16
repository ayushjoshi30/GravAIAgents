"""The Studio's starter templates must only use nodes the engine really has.

`apps/web/src/lib/studioTemplates.ts` gives the Agent Studio something to open
other than an empty canvas. Each one is a real workflow shape built from real
node types.

That is worth a test because the failure is delayed and confusing. A template
naming a type this build does not have looks completely fine in the picker,
renders on the canvas, and only fails when the person tries to save it — with
"'x' is not a node type this build knows", about a node they did not choose,
in a workflow they did not write. Catching it here instead means the person who
removed the node from the registry finds out, rather than a tenant.

Since the templates carry a narration prompt, the file is also where the
product's central claim is held on the one screen most people open first:
arithmetic comes from code and language comes from the model. Several of the
tests below exist only for that, and each says so.
"""

from __future__ import annotations

import re
from pathlib import Path

from gravai_workflow import NODE_REGISTRY

TEMPLATES = Path("apps/web/src/lib/studioTemplates.ts")


# --- reading the template module --------------------------------------------
#
# Read with a scanner rather than by executing TypeScript: the file is data in
# the shape of code, and the alternative is a Node toolchain in the Python test
# run. A regex was enough while every `node(...)` call fitted on one line; it
# stopped being enough once a call could carry an inline config object across
# several, and a check that silently matches fewer nodes than the file contains
# is worse than no check. So the argument list is scanned for real.


def _balanced(source: str, start: int) -> tuple[str, int]:
    """The text up to the bracket that closes the one just opened at `start`.

    Returns the inside of the brackets and the index just past the closer.
    Strings are skipped over, so a brace or a parenthesis inside a prompt does
    not end the scan early.
    """
    depth = 1
    index = start
    quote = ""
    while index < len(source) and depth:
        char = source[index]
        if quote:
            if char == "\\":
                index += 2
                continue
            if char == quote:
                quote = ""
        elif char in "\"'`":
            quote = char
        elif char in "([{":
            depth += 1
        elif char in ")]}":
            depth -= 1
            if not depth:
                return source[start:index], index + 1
        index += 1
    raise AssertionError(f"unbalanced brackets from offset {start} — has the file changed shape?")


def _split_args(body: str) -> list[str]:
    """Split a call's argument list on its top-level commas."""
    args: list[str] = []
    depth = 0
    quote = ""
    current: list[str] = []
    index = 0
    while index < len(body):
        char = body[index]
        if quote:
            if char == "\\":
                current.append(body[index : index + 2])
                index += 2
                continue
            if char == quote:
                quote = ""
        elif char in "\"'`":
            quote = char
        elif char in "([{":
            depth += 1
        elif char in ")]}":
            depth -= 1
        elif char == "," and not depth:
            args.append("".join(current).strip())
            current = []
            index += 1
            continue
        current.append(char)
        index += 1
    if "".join(current).strip():
        args.append("".join(current).strip())
    return args


def _const_blocks() -> dict[str, str]:
    """Every `const NAME: Record<string, unknown> = { ... }` body, by name.

    The templates hoist a shared config into a named constant, so a test that
    wants to know what a node is configured with has to be able to follow the
    name to the object.
    """
    source = TEMPLATES.read_text(encoding="utf-8")
    blocks: dict[str, str] = {}
    for match in re.finditer(r"\bconst\s+([A-Z][A-Z0-9_]*)\s*:[^=]*=\s*\{", source):
        body, _ = _balanced(source, match.end())
        blocks[match.group(1)] = body
    return blocks


def _node_calls() -> list[tuple[str, str, str]]:
    """Every `node(...)` call as (id, type, the text of its config argument).

    The config text is the body of the sixth argument, with a named constant
    already followed to the object it stands for and an inline literal's outer
    braces removed, so both forms read the same to a caller. Nodes that pass no
    config get an empty string, which is the case a config test most needs to
    see.

    The helper's own declaration is skipped: `function node(` matches the same
    shape as a call to it, and its parameter list would otherwise be read as a
    node whose type is `type: string`.
    """
    source = TEMPLATES.read_text(encoding="utf-8")
    consts = _const_blocks()
    calls: list[tuple[str, str, str]] = []
    for match in re.finditer(r"(?<!function )\bnode\(", source):
        body, _ = _balanced(source, match.end())
        args = _split_args(body)
        assert len(args) >= 5, f"node() called with {len(args)} arguments: {body[:80]!r}"
        node_id = args[0].strip('"')
        node_type = args[1].strip('"')
        config = args[5] if len(args) > 5 else ""
        if config in consts:
            config = consts[config]
        elif config.startswith("{"):
            config = config[1:-1]
        calls.append((node_id, node_type, config))
    assert calls, "found no node() calls — has the helper's shape changed?"
    return calls


def _template_nodes() -> list[tuple[str, str]]:
    """Every node the templates declare, as the (id, type) pair it is.

    The id matters as much as the type once a template carries an expression:
    `{{nodes.<id>.<field>}}` is resolved against the id, so a test that wants to
    know whether a referenced field is real has to get from the id to the type
    first.
    """
    return [(node_id, node_type) for node_id, node_type, _ in _node_calls()]


def _template_node_types() -> set[str]:
    return {node_type for _, node_type in _template_nodes()}


def _template_edges() -> list[tuple[str, str]]:
    """Every `edge(source, target, ...)` call, as the pair it connects."""
    source = TEMPLATES.read_text(encoding="utf-8")
    return re.findall(r'\bedge\(\s*"([^"]+)"\s*,\s*"([^"]+)"', source)


def _types_by_id() -> dict[str, set[str]]:
    """Node id to the type or types the templates give it.

    A set rather than a single type because ids are only unique within a
    template — four of them open with a node called `input` — and the ids that
    repeat are used for the same type every time. If that ever stops being true,
    the tests below accept a field that any of the types declares rather than
    failing on an ambiguity the templates do not actually have.
    """
    by_id: dict[str, set[str]] = {}
    for node_id, node_type in _template_nodes():
        by_id.setdefault(node_id, set()).add(node_type)
    return by_id


def _config_source() -> str:
    """The template module with its prose stripped out.

    The file argues for its own choices at length, so a test that searches for a
    setting by name finds the comment explaining why that setting is absent.
    Block comments go entirely; line comments go only when the `//` opens the
    line, which leaves the `https://` inside any string alone.
    """
    source = TEMPLATES.read_text(encoding="utf-8")
    source = re.sub(r"/\*.*?\*/", "", source, flags=re.S)
    return re.sub(r"(?m)^\s*//.*$", "", source)


def _top_level_keys(block: str) -> list[str]:
    """The keys an object literal declares at its own level.

    Depth-aware, because a narration's `output_schema` is an object inside the
    config object and its keys must not be mistaken for settings of the node.
    """
    keys: list[str] = []
    depth = 0
    quote = ""
    index = 0
    while index < len(block):
        char = block[index]
        if quote:
            if char == "\\":
                index += 2
                continue
            if char == quote:
                quote = ""
        elif char in "\"'`":
            quote = char
        elif char in "([{":
            depth += 1
        elif char in ")]}":
            depth -= 1
        elif not depth:
            match = re.match(r'\s*"?([A-Za-z_][A-Za-z0-9_]*)"?\s*:', block[index:])
            if match and (index == 0 or block[index - 1] in "{,\n"):
                keys.append(match.group(1))
                index += match.end()
                continue
        index += 1
    return keys


def _nested_block(block: str, key: str) -> str | None:
    """The object literal a config assigns to `key`, if it assigns one."""
    match = re.search(rf'(?m)^\s*"?{re.escape(key)}"?\s*:\s*\{{', block)
    if not match:
        return None
    body, _ = _balanced(block, match.end())
    return body


def _output_ports(node_type: str) -> set[str]:
    spec = NODE_REGISTRY.get(node_type)
    return {port.name for port in (spec.outputs or ())} if spec else set()


def _agent_output_fields() -> set[str]:
    """Every field name the agent nodes in these templates return."""
    fields: set[str] = set()
    for node_type in _template_node_types():
        if node_type.startswith("agent."):
            fields |= _output_ports(node_type)
    return fields


def _narrating_nodes() -> list[tuple[str, str, str]]:
    """Every template node that asks a model for words about its own result."""
    return [
        (node_id, node_type, config)
        for node_id, node_type, config in _node_calls()
        if config and "prompt" in _top_level_keys(config)
    ]


def test_template_module_exists() -> None:
    assert TEMPLATES.exists(), f"{TEMPLATES} is missing"


def test_every_template_node_exists_in_the_registry() -> None:
    unknown = sorted(_template_node_types() - set(NODE_REGISTRY))
    assert not unknown, (
        f"Studio templates reference {len(unknown)} node type(s) the engine does "
        f"not have: {unknown}. Either restore them or edit the templates."
    )


def test_branching_templates_label_their_edges() -> None:
    """A branch's outgoing edges must name a branch the node declares.

    `graph.py` makes this an error, not a warning, so a template that got it
    wrong would be unsavable. The templates use `condition`, which declares
    true and false.
    """
    source = TEMPLATES.read_text(encoding="utf-8")
    branches = set(re.findall(r'\bedge\(\s*"[^"]+"\s*,\s*"[^"]+"\s*,\s*"([^"]+)"', source))
    assert branches, "no branch-labelled edges found, but templates use condition nodes"
    assert branches <= {"true", "false"}, (
        f"templates use branch labels {sorted(branches)}; `condition` declares true/false"
    )


def test_input_nodes_declare_no_schema() -> None:
    """The starter templates must not imply that typing the input is required.

    `input.schema` is optional in the registry and the node's only output is
    `payload: object` — whatever the caller sent. Every agent node downstream
    takes one optional `state: object`. A template that shipped a schema would
    teach a shape the platform does not require, and the person copying it would
    carry that into their own workflow.
    """
    spec = NODE_REGISTRY["input"]
    schema_field = next(
        (f for f in (spec.config or []) if getattr(f, "name", "") == "schema"), None
    )
    assert schema_field is not None, "input node no longer has a schema field"
    assert not getattr(schema_field, "required", False), (
        "input.schema has become required in the engine — the templates and the "
        "Studio's Inputs panel both assume it is optional and need revisiting"
    )

    source = TEMPLATES.read_text(encoding="utf-8")
    assert "const INPUT_CONFIG: Record<string, unknown> = {};" in source, (
        "templates should seed the Input node with an empty config; a starter "
        "that declares a schema implies one is needed"
    )


def test_agent_nodes_take_shared_state_not_typed_inputs() -> None:
    """The premise the templates are built on, asserted rather than assumed.

    If agent nodes ever gain required, typed input ports, the templates' habit
    of wiring any output into any agent stops being valid and this test is where
    that should surface.
    """
    offenders = []
    for node_type, spec in NODE_REGISTRY.items():
        if not node_type.startswith("agent."):
            continue
        for port in spec.inputs or ():
            if getattr(port, "required", False):
                offenders.append(f"{node_type}.{port.name}")
    assert not offenders, (
        "agent nodes now have required input ports, so inputs are no longer "
        f"free-form shared state: {sorted(offenders)}"
    )


def test_template_expressions_name_fields_that_exist() -> None:
    """A `{{nodes.<id>.<field>}}` in a template must name a real port.

    The value of a narration prompt is entirely in the fields it reads: a prompt
    that quotes `probability_30dpd_6m` is showing someone how to narrate a
    scored figure, while a prompt quoting a field nobody returns is showing them
    how to write a plausible sentence about nothing. The engine renders prompts
    leniently — an unresolved `{{...}}` is left standing in the text rather than
    raising — so a typo here would reach the model as literal braces and come
    back as invented prose, which is the one failure mode this product cannot
    ship in a starter.

    The whole file is scanned, comments included. That is deliberate: a comment
    that cites a field name is making the same promise the prompt is.
    """
    source = TEMPLATES.read_text(encoding="utf-8")
    by_id = _types_by_id()
    problems: list[str] = []

    for node_id, field in re.findall(r"\{\{\s*nodes\.([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)", source):
        reference = f"{{{{nodes.{node_id}.{field}}}}}"
        types = by_id.get(node_id)
        if not types:
            problems.append(f"{reference} — no template node has id {node_id!r}")
            continue
        known = set().union(*(_output_ports(node_type) for node_type in types))
        if field not in known:
            problems.append(f"{reference} — {sorted(types)} declares {sorted(known)}")

    assert not problems, "templates reference outputs that do not exist:\n  " + "\n  ".join(
        problems
    )


def test_result_expressions_resolve_against_the_node_that_carries_them() -> None:
    """`{{result.<field>}}` is only addressable inside an agent's own narration.

    `_narrate` renders the prompt against `{**ctx.scope(), "result": payload}`,
    where `payload` is that node's own agent output and nothing else. So the
    reference means something different on every node, and checking it
    file-wide would not be checking it at all: a field belonging to the risk
    agent, written into a prompt on a different agent's node, is exactly the
    kind of mistake that renders leniently and comes back as confident prose
    about a value that was never there.

    Two things are asserted, therefore. Only an `agent.*` node may use the form
    at all — on any other node type there is no `result` in scope — and the
    field must be one that that node's own agent declares.
    """
    problems: list[str] = []
    seen = 0

    for node_id, node_type, config in _node_calls():
        for field in re.findall(r"\{\{\s*result\.([A-Za-z0-9_]+)", config):
            seen += 1
            reference = f"{{{{result.{field}}}}}"
            if not node_type.startswith("agent."):
                problems.append(
                    f"{node_id} is a {node_type!r} node, which has no `result` in scope, "
                    f"but its config uses {reference}"
                )
                continue
            known = _output_ports(node_type)
            if field not in known:
                problems.append(
                    f"{node_id} ({node_type}) uses {reference}; it returns {sorted(known)}"
                )

    assert seen, (
        "no {{result.<field>}} reference in any template — the starters are "
        "where the narration addressing form is meant to be shown"
    )
    assert not problems, (
        "narration prompts reference a result that is not theirs:\n  " + "\n  ".join(problems)
    )


def test_narration_sits_on_the_agent_whose_result_it_describes() -> None:
    """The prompt belongs on the agent node, not on a model node placed after it.

    This is a structural claim, not a stylistic one. A narration configured on
    an `agent.*` node runs inside `_agent_executor` after the score exists: the
    scored payload is copied through verbatim, the answer is put beside it under
    `narration`, a key that collides with one the agent produces is refused with
    a warning, and `publish_facts` has already been applied to the scored
    payload before the model is called — so no configuration of that node can
    put generated text into the facts a `condition` branches on.

    A standalone `llm` node reading the same figures through
    `{{nodes.<id>.<field>}}` produces similar words and has none of those
    properties: its output object is whatever the model returned, and its own
    `publish_facts` writes those keys straight into the facts. In a starter
    whose next node is the branch that decides the loan, that is one config
    field away from a decision that turns on generated text. Starters get
    copied, so the starter has to be the shape that cannot go wrong.
    """
    narrating = _narrating_nodes()
    assert narrating, (
        "no template node carries a narration prompt — the starters are where "
        "the prompt and output-shape pattern is meant to be demonstrated"
    )

    offenders = [
        f"{node_id} ({node_type})"
        for node_id, node_type, _ in narrating
        if not node_type.startswith("agent.")
    ]
    assert not offenders, (
        f"a narration prompt sits on a non-agent node: {offenders}. Put it on the "
        "agent whose result it describes, where the engine keeps the scored "
        "fields and the generated words apart for you."
    )

    model_nodes = sorted(
        node_id for node_id, node_type in _template_nodes() if node_type == "llm"
    )
    assert not model_nodes, (
        f"the templates place a standalone llm node ({model_nodes}). Narration in "
        "a starter belongs on the agent node: an llm node's publish_facts can put "
        "generated text into the facts a branch reads, and an agent node's cannot."
    )


def test_the_narration_never_asks_for_a_figure_or_a_verdict() -> None:
    """The one test that is really about the product's central claim.

    A narration's `output_schema` keys are the machine-readable statement of
    what the node asks a model to produce — the model is told to answer with
    exactly those keys and nothing else is kept. So a starter that asked a model
    for a number or a decision would have to name it here, and naming it here is
    what this refuses. Checking the keys rather than only the prose is the point:
    a prompt can be reworded into asking for a probability without any single
    word tripping a search, but the key it comes back under cannot be hidden.

    The prose half is asserted too, because the keys alone do not stop a prompt
    from inviting a figure inside a field called `plain_english`. Every prompt
    has to carry the refusal in so many words.
    """
    forbidden = re.compile(
        r"probabilit|score|scoring|band|rating|grade|tier|decision|decide|recommend|"
        r"approv|declin|reject|sanction|verdict|limit|amount|rate|percent|pd\b|dpd|"
        r"eligib|risk",
        re.I,
    )
    narrating = _narrating_nodes()
    assert narrating, "no narration prompt found to check"

    problems: list[str] = []
    for node_id, _, config in narrating:
        schema = _nested_block(config, "output_schema")
        assert schema is not None, (
            f"{node_id} asks for a narration but declares no output_schema. The "
            "shape of the reply is half the feature, and an unshaped reply is "
            "prose nobody can tell apart from a scored field in a trace."
        )
        for key in _top_level_keys(schema):
            if forbidden.search(key):
                problems.append(
                    f"{node_id}.output_schema asks the model for {key!r}. Arithmetic "
                    "comes from code: a starter must not teach anyone to ask a model "
                    "for a figure, a band or a call."
                )

        prompt = re.search(r"(?m)^\s*prompt:\s*(.*?)(?=^\s{2}[a-z_]+:)", config, re.S)
        text = prompt.group(1) if prompt else config
        assert re.search(r"do not offer a probability", text, re.I), (
            f"{node_id}'s prompt no longer tells the model in plain words that a "
            "probability, a band, a score and a recommendation are not its to "
            "give. That sentence is load-bearing, not decoration."
        )

    assert not problems, "\n  ".join(problems)


def test_structured_output_keys_do_not_shadow_an_agent_field() -> None:
    """A narration's `output_schema` must not reuse an agent's field name.

    This is the line the product is sold on. An agent's output is scored by
    versioned code; a narration is written by a language model. When both are in
    one run and both carry a key called `explanation`, the person reading the
    trace — or the auditor reading it a year later — has to work out which is
    which from context, and the answer to "where did this number come from"
    stops being immediate.

    The engine already refuses such a key and says so in a warning, so a
    template that asked for one would not corrupt a run. It would do something
    slightly worse in the long run: ship a starter whose first act is to earn a
    warning, and teach the person copying it that the warning is normal.

    Checked against every agent in the templates rather than only the node the
    schema sits on. A template is a few nodes long and someone will rewire it;
    a name that is safe today only because of the current edge is not worth the
    argument later.
    """
    source = _config_source()
    blocks = re.findall(r"output_schema:\s*\{", source)
    assert blocks, (
        "no output_schema found — the starter templates are meant to show both "
        "halves of a narration, the prompt and the shape it answers in"
    )

    keys: set[str] = set()
    for _, _, config in _narrating_nodes():
        schema = _nested_block(config, "output_schema")
        if schema:
            keys |= set(_top_level_keys(schema))
    assert keys, "an output_schema was found but no keys could be read out of it"

    collisions = sorted(keys & _agent_output_fields())
    assert not collisions, (
        f"a narration's output_schema reuses {collisions}, which the agent nodes "
        "in these templates already return. Rename the narration's keys: generated "
        "language and scored fields must stay tellable apart in a run."
    )


def test_model_output_is_published_into_no_facts() -> None:
    """Nothing a model writes may become a workflow fact in a starter.

    `publish_facts` copies keys into the shared state, and the shared state is
    what conditions branch on and what later nodes read. On an agent node the
    engine applies it to the scored payload only, so it cannot reach the
    narration even if someone names a narration key — but the starters set it
    nowhere at all, which keeps the demonstrated shape simple: the words stay on
    the node, addressable as `{{nodes.<id>.narration}}`, and the facts hold only
    what code decided.
    """
    source = _config_source()
    assert not re.search(r'"?publish_facts"?\s*:', source), (
        "a template sets publish_facts. The starters keep narration on its own "
        "node under `narration`, so that nothing generated can reach a branch, "
        "and keep the facts to what the scorecard and the rules put there."
    )


#: Nodes that leave a required setting to a non-blank registry default.
#:
#: `_setting()` reads `node.config.get(name, spec_default)`, so a setting a
#: template omits is one the engine supplies from the registry while the config
#: panel shows the box empty. Where that default is not itself blank, the
#: template is shipping a value nobody can see.
#:
#: These two are known and reported, not accepted. Both are `condition` nodes
#: that omit `condition`, whose registry default is
#: `workflow.facts.documents_verified` — a fact no template publishes, so each
#: one fails at run time with an unresolvable path rather than branching on the
#: rule its own label states. Writing the blank out would turn that into a
#: save-time "needs Condition", but choosing what the rule should instead say is
#: a tenant's credit policy and not a reviewer's to invent. The set is frozen so
#: that a third one cannot be added quietly, and so that fixing these two fails
#: this test until the list is shortened.
KNOWN_DEFAULT_LEANERS = frozenset({"band.condition", "clean.condition"})


def test_no_template_leans_on_a_setting_it_does_not_show() -> None:
    """A blank box in the panel must mean a blank value in the run.

    The reason this is a test and not a note is what it caught. The MSME
    template's MCP node omitted `server` and `tool`, whose registry defaults are
    this platform's own MCP endpoint and its `score_risk` tool — so a run of the
    untouched starter would have called the retail scorecard on fixture inputs
    and put a 30+ DPD probability in the trace of a business-lending workflow,
    from two boxes the panel drew empty. A figure nobody asked for, about a
    borrower it was not computed from, is fabricated data however real the code
    that produced it.
    """
    leaning: set[str] = set()
    for node_id, node_type, config in _node_calls():
        spec = NODE_REGISTRY.get(node_type)
        if spec is None:
            continue
        declared = set(_top_level_keys(config)) if config else set()
        for setting in spec.config or ():
            if not getattr(setting, "required", False):
                continue
            default = getattr(setting, "default", "")
            blank = default is None or (hasattr(default, "__len__") and not len(default))
            if not blank and setting.name not in declared:
                leaning.add(f"{node_id}.{setting.name}")

    unexpected = sorted(leaning - KNOWN_DEFAULT_LEANERS)
    assert not unexpected, (
        f"these template nodes omit a required setting whose registry default is "
        f"not blank, so the engine would run a value the panel does not show: "
        f"{unexpected}. Write the blank out explicitly — a starter that fails "
        f"validation naming the field is better than one that quietly acts."
    )

    fixed = sorted(KNOWN_DEFAULT_LEANERS - leaning)
    assert not fixed, (
        f"{fixed} no longer lean on a registry default, which is good — remove "
        f"them from KNOWN_DEFAULT_LEANERS so the list keeps meaning what it says."
    )


def test_narration_is_not_the_last_word_in_its_workflow() -> None:
    """The narrated node sits inside the flow, not on the end of it.

    The reason to narrate the risk agent rather than append a report is that the
    explanation is worth having before the decision is taken. A narration with
    nothing downstream of it is a document nobody waits for, and someone copying
    the shape would learn the wrong place to put it.
    """
    edges = _template_edges()
    for node_id, _, _ in _narrating_nodes():
        assert any(source == node_id for source, _ in edges), (
            f"{node_id} carries a narration but is the last node on its path; a "
            "narration nothing reads teaches the wrong shape"
        )
