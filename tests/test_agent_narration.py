"""Narrating what an agent found, without ever becoming part of it.

An agent node can be given a prompt and a shape to answer in, so that a model
can put what the agent produced into the words a lender actually wants to read.
The risk in offering that sits one line away from the implementation: merge the
model's reply into the agent's output and a generated probability stands exactly
where a scored one did, indistinguishable to every node downstream and to
whoever reads the decision months later.

So most of what is asserted here is what a narration does *not* do. It does not
run when nobody asked for one, it does not alter a single scored field, it
cannot be published as a fact, and it cannot overrule the agent even when it is
asked for a name the agent already uses.

Everything runs in sandbox. The agents are the real code paths; the model is the
suite's own fake, keyed on a marker that only a narration prompt carries, so an
agent's own calls answer exactly as they always would.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from gravai_agents import AgentOutput, AgentResult, ValidationReport
from gravai_runner import RUNNABLE, run_agent
from gravai_sarvam import build_sarvam
from gravai_workflow import (
    EXECUTORS,
    NODE_REGISTRY,
    ExecutionContext,
    NodeInstance,
    NodeOutcome,
    WorkflowState,
    executors,
    render,
)

#: Carried by every narration prompt in this file and by nothing else, so the
#: fake model can answer a narration without touching the calls an agent makes
#: on its own account.
MARKER = "NARRATE-A7"


async def _nosleep(_: float) -> None:
    """The document runner's back-off, with the waiting taken out.

    The back-off is asserted in test_governor.py; re-imposing it here would only
    make every test in this file sit for seconds while proving nothing new.
    """
    return None


@pytest.fixture
async def sarvam():  # type: ignore[no-untyped-def]
    bundle = build_sarvam(polls_before_done=1, sleep=_nosleep)
    yield bundle
    await bundle.aclose()


class _RefusesToBeCalled:
    """Stands in for the chat model where reaching it at all is the failure."""

    async def complete(self, request: Any) -> Any:
        raise AssertionError("the model was called for a node that asked for no narration")


class _Unreachable:
    """A chat model that is down, which is a thing chat models are."""

    async def complete(self, request: Any) -> Any:
        raise RuntimeError("the model is unreachable")


class _Scored(AgentOutput):
    """An output whose figures came from a scorecard rather than from prose."""

    probability_30dpd_6m: float = 0.0658
    band: str = "AMBER"


class _ScoredWithNarration(_Scored):
    """The same, from an agent that has taken the name `narration` for itself."""

    narration: str = "what the scorecard itself said"


def _result(output: AgentOutput, *, violations: list[str] | None = None) -> AgentResult:
    return AgentResult(
        agent_id="risk_scoring",
        output=output,
        validation=ValidationReport(violations=list(violations or [])),
    )


def _always(result: AgentResult):  # type: ignore[no-untyped-def]
    """Replace the runner with one that hands back a result built by hand.

    Every sandbox agent passes its own validators and most of them do not
    escalate, so the failures worth asserting against cannot be produced by
    running one. This is the seam the executor reaches through, and nothing
    about the narration path can tell the difference.
    """

    async def _run_agent(*_args: Any, **_kwargs: Any) -> AgentResult:
        return result

    return _run_agent


def _agent_node(agent_id: str, **config: Any) -> NodeInstance:
    """An agent node as the canvas would place it."""
    return NodeInstance(id=agent_id.split("_")[0], type=f"agent.{agent_id}", config=config)


def _context(sarvam: Any) -> ExecutionContext:
    return ExecutionContext(state=WorkflowState(), sarvam=sarvam)


async def _run(node: NodeInstance, ctx: ExecutionContext) -> NodeOutcome:
    return await EXECUTORS[node.type](node, ctx)


def _reply(sarvam: Any, text: str) -> None:
    """Answer any narration with `text`, leaving every other call alone."""
    sarvam.chat.responses[MARKER] = text


def _narrations(sarvam: Any) -> list[str]:
    """Everything the model was asked, narrowed to the narration calls."""
    said = ["\n".join(message.content for message in call.messages) for call in sarvam.chat.calls]
    return [prompt for prompt in said if MARKER in prompt]


def _scored_part(outcome: NodeOutcome) -> dict[str, Any]:
    return {name: value for name, value in outcome.outputs.items() if name != "narration"}


# --- the settings themselves -------------------------------------------------


@pytest.mark.parametrize("agent_id", sorted(RUNNABLE))
def test_every_agent_node_offers_both_settings_and_neither_is_required(agent_id: str) -> None:
    """Optional in the sense that matters: a blank one is the default state."""
    fields = {field.name: field for field in NODE_REGISTRY[f"agent.{agent_id}"].config}

    assert {"prompt", "output_schema"} <= set(fields)
    assert fields["prompt"].required is False
    assert fields["output_schema"].required is False
    assert fields["prompt"].default == ""
    assert fields["output_schema"].default == {}
    # The prompt is rendered against the state, so the canvas must mark it as
    # templated or the panel will not say that `{{ ... }}` means anything here.
    assert fields["prompt"].templated is True


def test_the_settings_say_in_the_panel_that_they_cannot_change_the_result() -> None:
    """The help text is the only place most people will learn the rule.

    Someone typing into "Narration prompt" is one reasonable assumption away
    from believing they are improving the agent's answer. The panel has to say
    otherwise before they press run, not afterwards in a warning.
    """
    fields = {field.name: field for field in NODE_REGISTRY["agent.risk_scoring"].config}

    assert "narration" in fields["prompt"].help
    assert "cannot change" in fields["prompt"].help
    assert "narration" in fields["output_schema"].help


@pytest.mark.parametrize("agent_id", sorted(RUNNABLE))
def test_no_agent_declares_an_output_that_the_narration_would_stand_on(agent_id: str) -> None:
    """`narration` has to be a name no agent has taken, and stay one.

    The executor holds the line anyway — a collision leaves the agent's field
    alone and puts the narration in the trace — but that branch exists to catch
    a mistake, not to make room for one. An agent that starts returning a field
    by this name should fail here, where it is a five-minute rename, rather than
    quietly costing every canvas an addressable narration.
    """
    ports = {port.name for port in NODE_REGISTRY[f"agent.{agent_id}"].outputs}

    assert "narration" not in ports


# --- the no-op ---------------------------------------------------------------


async def test_a_node_without_a_prompt_does_not_reach_the_model_at_all(sarvam) -> None:  # type: ignore[no-untyped-def]
    """The overwhelming majority of nodes, and they must not pay for this.

    Asserted with a chat client that fails on contact rather than by counting
    calls afterwards, because "it cost nothing" and "it was never called" are
    different claims and only the second one is the promise being made.

    The state has to be silent too. A narration that fails is turned into a
    warning rather than into a failed node, which would otherwise let a node
    that reached the model and was refused still look exactly like a node that
    never went near it.
    """
    sarvam.chat = _RefusesToBeCalled()
    node = _agent_node("kyc_verification")
    ctx = _context(sarvam)

    outcome = await _run(node, ctx)
    alone = await run_agent("kyc_verification", sarvam)

    assert outcome.outputs == alone.output.model_dump(mode="json")
    assert "narration" not in outcome.outputs
    assert outcome.detail["narrated"] is False
    assert outcome.cost_inr == alone.cost_inr
    assert outcome.input_tokens == 0
    assert outcome.output_tokens == 0
    assert ctx.state.warnings == []


# --- what a narration may and may not touch ----------------------------------


async def test_every_field_the_agent_scored_is_carried_through_byte_for_byte(sarvam) -> None:  # type: ignore[no-untyped-def]
    """The claim the whole product rests on, at the one place it could break.

    Compared as serialised text rather than field by field: a dictionary
    comparison would pass a narration that had rounded a figure to a value that
    still compares equal, and "0.0658 became 0.07" is exactly the class of
    change this must catch.
    """
    _reply(sarvam, "The file sits in the middle band, driven by committed income.")
    node = _agent_node("risk_scoring", prompt=f"{MARKER} Say what this score means.")

    outcome = await _run(node, _context(sarvam))
    alone = await run_agent("risk_scoring", sarvam)

    scored = alone.output.model_dump(mode="json")
    assert json.dumps(_scored_part(outcome), sort_keys=True) == json.dumps(scored, sort_keys=True)
    assert outcome.outputs["probability_30dpd_6m"] == scored["probability_30dpd_6m"]
    assert outcome.outputs["narration"].startswith("The file sits")


async def test_a_scored_field_and_a_narrated_one_are_never_the_same_expression(sarvam) -> None:  # type: ignore[no-untyped-def]
    """The safety property, stated as the reader of a canvas experiences it.

    Someone reading `{{nodes.risk.probability_30dpd_6m}}` has to be able to know
    it came from the scorecard without opening the node and checking what its
    narration was asked for. So the two values are resolved here the way the
    engine resolves them, against the state it would have recorded, and the
    addresses are shown to be different addresses.
    """
    _reply(
        sarvam,
        json.dumps({"probability_30dpd_6m": 0.99, "headline": "Comfortably inside appetite."}),
    )
    node = _agent_node(
        "risk_scoring",
        prompt=f"{MARKER} Describe the score.",
        output_schema={
            "probability_30dpd_6m": "the chance of a 30+ day delinquency",
            "headline": "one line a credit officer can read",
        },
    )
    ctx = _context(sarvam)

    outcome = await _run(node, ctx)
    ctx.state.record_output(node.id, outcome.outputs)  # what the engine does next
    scope = ctx.state.resolution_scope()

    assert render("{{nodes.risk.probability_30dpd_6m}}", scope) == "0.0658"
    assert render("{{nodes.risk.narration.probability_30dpd_6m}}", scope) == "0.99"


async def test_a_narration_cannot_overwrite_a_field_the_agent_produced(sarvam) -> None:  # type: ignore[no-untyped-def]
    """Asked for a name the agent already uses, and it still does not win.

    Nor is it silently dropped: dropping it would leave someone staring at an
    empty field with nothing to explain it. It is kept where it belongs and the
    collision is named, because asking the model for a figure the scorecard
    already produced is a misunderstanding worth correcting.
    """
    _reply(sarvam, json.dumps({"probability_30dpd_6m": 0.99}))
    node = _agent_node(
        "risk_scoring",
        prompt=f"{MARKER} Describe the score.",
        output_schema={"probability_30dpd_6m": "the chance of a 30+ day delinquency"},
    )
    ctx = _context(sarvam)

    outcome = await _run(node, ctx)
    alone = await run_agent("risk_scoring", sarvam)

    assert outcome.outputs["probability_30dpd_6m"] == alone.output.probability_30dpd_6m
    assert outcome.outputs["narration"]["probability_30dpd_6m"] == 0.99
    named = [warning for warning in ctx.state.warnings if "probability_30dpd_6m" in warning]
    assert named, f"the collision went unmentioned: {ctx.state.warnings}"


async def test_an_agent_that_uses_the_name_itself_keeps_its_own_field(  # type: ignore[no-untyped-def]
    sarvam,
    monkeypatch,
) -> None:
    """No agent does this today, which is why it is worth proving here.

    If one ever did, the narration would land on top of a value the agent
    computed — the single failure this design exists to prevent. The agent's
    field stands, the narration is reported in the trace where no expression can
    reach it, and the run says what it did rather than appearing to have worked.
    """
    monkeypatch.setattr(executors, "run_agent", _always(_result(_ScoredWithNarration())))
    _reply(sarvam, "wording that must not land on a scored field")
    node = _agent_node("risk_scoring", prompt=f"{MARKER} Describe the score.")
    ctx = _context(sarvam)

    outcome = await _run(node, ctx)

    assert outcome.outputs["narration"] == "what the scorecard itself said"
    assert outcome.detail["narration"] == "wording that must not land on a scored field"
    assert any("narration" in warning for warning in ctx.state.warnings)


async def test_a_narrated_field_cannot_be_published_as_a_fact(sarvam) -> None:  # type: ignore[no-untyped-def]
    """Facts are the workflow's shared truth, so nothing written lands in them.

    Publishing reads the agent's own output and only that. A narration key
    named in "Publish as facts" therefore publishes nothing, which is the right
    answer: a fact is what the workflow has established, not what it was told.
    """
    _reply(sarvam, json.dumps({"headline": "Approve with conditions."}))
    node = _agent_node(
        "kyc_verification",
        prompt=f"{MARKER} Summarise the verification.",
        output_schema={"headline": "one line for the file"},
        publish_facts="headline",
    )
    ctx = _context(sarvam)

    outcome = await _run(node, ctx)

    assert outcome.outputs["narration"]["headline"] == "Approve with conditions."
    assert "headline" not in ctx.state.facts
    assert outcome.detail["published_facts"] == []


async def test_publishing_the_narration_itself_publishes_nothing(sarvam) -> None:  # type: ignore[no-untyped-def]
    """The one name that would get through if publishing ran a line later.

    The test above proves a *nested* key cannot be published, which it cannot —
    but only because `headline` is not a key of the node's outputs at all. That
    says nothing about `narration`, which is. If `_publish` ever read the
    outputs instead of the agent's own payload, this config alone would write
    the model's whole reply into `facts["narration"]`, where it is addressable
    as `{{narration}}` at the top of every later scope and a `condition` node
    can branch a lending decision on it.

    What keeps it out is ordering, not naming: publishing happens against
    `payload` before the model is called, so at the moment the facts are written
    there is no narration in existence to write. Asserting the name most likely
    to slip through is the only way that ordering is held in place.
    """
    _reply(sarvam, json.dumps({"headline": "Approve with conditions."}))
    node = _agent_node(
        "kyc_verification",
        prompt=f"{MARKER} Summarise the verification.",
        output_schema={"headline": "one line for the file"},
        publish_facts="narration",
    )
    ctx = _context(sarvam)

    outcome = await _run(node, ctx)

    assert outcome.outputs["narration"] == {"headline": "Approve with conditions."}
    assert ctx.state.facts == {}
    assert outcome.detail["published_facts"] == []


async def test_a_shaped_narration_adds_no_field_beside_the_agent_s_own(sarvam) -> None:  # type: ignore[no-untyped-def]
    """The merge that looks safe, and is the one that would actually ship.

    Nobody writes `outputs.update(narration)` outright — it collides with a
    scored field on the first run and someone notices. The change that survives
    review is the considerate one: merge only the keys the agent did not
    produce, so nothing is ever overwritten. It is just as bad. `headline` and
    `next_step` then sit at `{{nodes.kyc.headline}}`, the same shape of address
    as `{{nodes.kyc.overall_score}}`, and neither the trace nor the person
    reading it a year later can tell which of the two a model wrote.

    So this asserts the top level of the outputs exhaustively rather than
    field by field: the agent's own names, plus `narration`, and nothing else.
    A schema whose keys deliberately collide with nothing is used, because that
    is precisely the case every other test in this file lets through.
    """
    _reply(
        sarvam,
        json.dumps({"headline": "Identity confirmed.", "next_step": "Release to credit."}),
    )
    node = _agent_node(
        "kyc_verification",
        prompt=f"{MARKER} Summarise the verification.",
        output_schema={"headline": "one line for the file", "next_step": "what ops should do"},
    )

    outcome = await _run(node, _context(sarvam))
    alone = await run_agent("kyc_verification", sarvam)

    scored = alone.output.model_dump(mode="json")
    assert sorted(outcome.outputs) == sorted([*scored, "narration"])
    assert json.dumps(_scored_part(outcome), sort_keys=True) == json.dumps(scored, sort_keys=True)
    assert set(outcome.outputs["narration"]) == {"headline", "next_step"}


async def test_the_narration_s_words_reach_no_part_of_the_shared_state(sarvam) -> None:  # type: ignore[no-untyped-def]
    """Outputs are one namespace; the run's own record is another, and narration
    belongs to neither but the first.

    `state.as_dict()` is what `{{workflow.*}}` resolves against and what the
    trace and the summariser node read — facts, summaries, decisions, artifacts
    and all. A narration appended to `summaries` would be model prose entering
    the workflow's account of itself, quotable by every later node as something
    the run established rather than something it was told, and no assertion
    elsewhere in this file would notice.

    A sentence nothing else could produce is used so that finding it anywhere in
    that record is unambiguous. It must be readable at exactly one address and
    no other.
    """
    sentinel = "Pemberton-97 is the only place these words belong."
    _reply(sarvam, sentinel)
    node = _agent_node("risk_scoring", prompt=f"{MARKER} Describe the score.")
    ctx = _context(sarvam)

    outcome = await _run(node, ctx)

    assert outcome.outputs["narration"] == sentinel
    assert sentinel not in json.dumps(ctx.state.as_dict(), default=str)
    assert sentinel not in outcome.summary
    assert sentinel not in json.dumps(_scored_part(outcome), default=str)


# --- the shape asked for -----------------------------------------------------


async def test_only_the_narration_fields_that_were_asked_for_come_back(sarvam) -> None:  # type: ignore[no-untyped-def]
    """Keys the schema does not name are dropped; keys it names and the model
    misses are said out loud, because a downstream node reading one of those
    would fail a long way from the cause."""
    _reply(
        sarvam,
        json.dumps(
            {
                "headline": "Identity confirmed against the source.",
                "tone": "confident",
                "recommendation": "proceed",
            }
        ),
    )
    node = _agent_node(
        "kyc_verification",
        prompt=f"{MARKER} Summarise the verification.",
        output_schema={"headline": "one line for the file", "next_step": "what ops should do"},
    )
    ctx = _context(sarvam)

    outcome = await _run(node, ctx)

    assert set(outcome.outputs["narration"]) == {"headline"}
    assert any("next_step" in warning for warning in ctx.state.warnings)


async def test_a_narration_that_answers_in_prose_when_asked_for_json_still_pays(sarvam) -> None:  # type: ignore[no-untyped-def]
    """Malformed is the ordinary case, not the exotic one.

    A model asked for JSON returns a sentence often enough that this has to be a
    designed path rather than an accident. The node must not fail — the score is
    the valuable part and it is already correct — but nothing about the failure
    may be hidden either. In particular the call was made and billed, so a run
    that shows it as free would understate what the canvas costs on exactly the
    runs where the narration is worthless.

    The prose is deliberately a sentence containing a figure of its own. Nothing
    may lift it out: what comes back is an empty object, not a guess.
    """
    _reply(sarvam, "Honestly I would put the chance of default nearer 42 percent.")
    node = _agent_node(
        "risk_scoring",
        prompt=f"{MARKER} Describe the score.",
        output_schema={"headline": "one line a credit officer can read"},
    )
    ctx = _context(sarvam)

    outcome = await _run(node, ctx)
    alone = await run_agent("risk_scoring", sarvam)

    scored = alone.output.model_dump(mode="json")
    assert outcome.error == ""
    assert json.dumps(_scored_part(outcome), sort_keys=True) == json.dumps(scored, sort_keys=True)
    assert outcome.outputs["narration"] == {}
    assert any("headline" in warning for warning in ctx.state.warnings)
    assert outcome.cost_inr > alone.cost_inr


async def test_narration_fields_given_as_a_list_are_refused_out_loud(sarvam) -> None:  # type: ignore[no-untyped-def]
    """The panel takes free JSON, so the wrong shape has to be answered for.

    `["headline", "next_step"]` is what someone types when the label says
    "Narration fields", and it is not what the setting means. Ignored quietly it
    would take the collision check down with it — the check that tells a person
    they have asked a model for a figure the scorecard already produces — and
    they would have no way of knowing the check never ran. So the node says the
    setting did nothing and says what that cost them.
    """
    _reply(sarvam, json.dumps({"probability_30dpd_6m": 0.99}))
    node = _agent_node(
        "risk_scoring",
        prompt=f"{MARKER} Describe the score.",
        output_schema=["probability_30dpd_6m"],
    )
    ctx = _context(sarvam)

    outcome = await _run(node, ctx)
    alone = await run_agent("risk_scoring", sarvam)

    assert outcome.outputs["probability_30dpd_6m"] == alone.output.probability_30dpd_6m
    # Prose, because no shape was legible — and a string can shadow nothing.
    assert isinstance(outcome.outputs["narration"], str)
    assert any("object of name to description" in warning for warning in ctx.state.warnings)


async def test_without_a_schema_a_narration_is_a_single_piece_of_prose(sarvam) -> None:  # type: ignore[no-untyped-def]
    _reply(sarvam, "Identity is confirmed and nothing on the file needs a person.")
    node = _agent_node("kyc_verification", prompt=f"{MARKER} Summarise the verification.")

    outcome = await _run(node, _context(sarvam))

    assert (
        outcome.outputs["narration"]
        == "Identity is confirmed and nothing on the file needs a person."
    )


async def test_the_prompt_can_refer_to_what_the_agent_found(sarvam) -> None:  # type: ignore[no-untyped-def]
    """The point of narrating at all: the prose is about this result.

    The band is asserted in the rendered sentence rather than merely somewhere
    in the request, because the agent's output is also attached to the call —
    searching the whole prompt for "AMBER" would pass against a template that
    never resolved.
    """
    _reply(sarvam, "noted")
    node = _agent_node(
        "risk_scoring", prompt=f"{MARKER} The band came back as {{{{result.band}}}}."
    )

    await _run(node, _context(sarvam))

    said = _narrations(sarvam)
    assert len(said) == 1, "a narration is one call, not none and not several"
    assert "The band came back as AMBER." in said[0]
    assert "{{result.band}}" not in said[0]


async def test_a_sandboxed_narration_says_that_the_wording_is_canned(sarvam) -> None:  # type: ignore[no-untyped-def]
    """The same thing the LLM node says, for the same reason.

    A sandbox run produces fluent prose about a real result. Presenting that as
    analysis, in a product whose whole claim is that it does not invent, would
    be the worst possible place to stay quiet.
    """
    _reply(sarvam, "Identity is confirmed.")
    node = _agent_node("kyc_verification", prompt=f"{MARKER} Summarise the verification.")
    ctx = _context(sarvam)

    await _run(node, ctx)

    assert any("sandbox" in warning for warning in ctx.state.warnings)


# --- what a narration must leave alone ---------------------------------------


async def test_neither_the_escalation_nor_the_guardrail_findings_move(  # type: ignore[no-untyped-def]
    sarvam,
    monkeypatch,
) -> None:
    """Run the same node twice, narrated and not, and compare the record.

    Every sandbox agent passes its own validators, so a result that failed one
    is built by hand here: comparing two clean runs would agree with itself and
    prove nothing. What must match is everything an auditor would read — the
    determination, its reason, the violations and the facts published.
    """
    violation = "fields.income cites doc-nowhere, which is not a document on this file"
    fixed = _result(_Scored(escalate=True), violations=[violation])
    monkeypatch.setattr(executors, "run_agent", _always(fixed))
    _reply(sarvam, "Nothing said here changes the finding above.")

    quiet_ctx = _context(sarvam)
    quiet = await _run(_agent_node("risk_scoring", publish_facts="probability_30dpd_6m"), quiet_ctx)

    loud_ctx = _context(sarvam)
    loud = await _run(
        _agent_node(
            "risk_scoring",
            publish_facts="probability_30dpd_6m",
            prompt=f"{MARKER} Describe the score.",
        ),
        loud_ctx,
    )

    assert loud.detail["escalated"] is True
    assert quiet.detail["escalated"] is True
    assert loud.detail["guardrails_passed"] is False
    assert quiet.detail["guardrails_passed"] is False
    assert _decisions(loud_ctx) == _decisions(quiet_ctx)
    assert loud_ctx.state.facts == quiet_ctx.state.facts == {"probability_30dpd_6m": 0.0658}
    assert loud.detail["published_facts"] == quiet.detail["published_facts"]
    assert any(violation in warning for warning in loud_ctx.state.warnings)


def _decisions(ctx: ExecutionContext) -> list[tuple[Any, ...]]:
    return [
        (entry.name, entry.value, entry.deterministic, entry.reason)
        for entry in ctx.state.decisions
    ]


async def test_a_narration_that_fails_does_not_take_the_result_with_it(sarvam) -> None:  # type: ignore[no-untyped-def]
    """A model being down is not a reason to throw away a verified identity.

    Left to reach the engine, the exception would fail the node, discard an
    output that was produced correctly and skip everything downstream of it —
    over the wording.
    """
    sarvam.chat = _Unreachable()
    node = _agent_node("kyc_verification", prompt=f"{MARKER} Summarise the verification.")
    ctx = _context(sarvam)

    outcome = await _run(node, ctx)
    alone = await run_agent("kyc_verification", sarvam)

    assert outcome.error == ""
    assert outcome.outputs == alone.output.model_dump(mode="json")
    assert outcome.detail["narrated"] is False
    assert any("narration" in warning for warning in ctx.state.warnings)


async def test_a_narration_is_charged_for_and_nothing_else_moves(sarvam) -> None:  # type: ignore[no-untyped-def]
    """Its own model call, and only that, added to what the agent cost."""
    quiet = await _run(_agent_node("risk_scoring"), _context(sarvam))

    _reply(sarvam, "A short line about the score.")
    loud = await _run(
        _agent_node("risk_scoring", prompt=f"{MARKER} Describe the score."), _context(sarvam)
    )
    alone = await run_agent("risk_scoring", sarvam)

    assert quiet.cost_inr == alone.cost_inr
    assert loud.cost_inr > quiet.cost_inr
    assert quiet.input_tokens == 0
    assert loud.input_tokens > 0
    assert loud.output_tokens > 0
