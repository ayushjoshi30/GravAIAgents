"""Agent Studio: the registry, the validator, the shared state and the engine.

Everything here runs in sandbox, so no test reaches a vendor and no test spends
anything. What the sandbox does not fake is the engine itself — the ordering,
the branch pruning, the halt and the trace are all the real code paths.

The graph most of these tests use is the shape a canvas actually produces:

    input -> calculator -> router -> (approve | review -> escalate) -> output

which is small enough to read and still exercises a fan-out, a branch that is
not taken, and a join that has to wait for both sides to settle.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

import anyio
import pytest
from gravai_sarvam import CallRecord, Product, RateCard, build_sarvam
from gravai_workflow import (
    EXECUTORS,
    NODE_REGISTRY,
    Decision,
    Problem,
    WorkflowGraph,
    WorkflowState,
    from_dict,
    run_workflow,
    validate_registry,
)

# --- the AI layer, or something standing in for it ---------------------------


async def _nosleep(_: float) -> None:
    """The document runner's back-off, with the waiting taken out.

    The back-off is asserted in test_governor.py; re-imposing it here would only
    make every workflow test sit for seconds while proving nothing new.
    """
    return None


@pytest.fixture
async def sarvam():  # type: ignore[no-untyped-def]
    bundle = build_sarvam(polls_before_done=1, sleep=_nosleep)
    yield bundle
    await bundle.aclose()


class _RefusesToBeCalled:
    """Stands in for the AI layer where reaching it at all is the failure."""

    sandbox = True
    rate_card = None

    class chat:
        @staticmethod
        async def complete(request: Any) -> Any:
            raise AssertionError("the model was called when nothing should have run")


class _SlowChat:
    """A chat client with a deliberate delay, so a duration is measurable.

    A sandbox node finishes well inside a millisecond, which would make an
    assertion about `duration_ms` pass just as happily against a field that was
    never set. Spending fifty milliseconds once is what makes the assertion mean
    something.
    """

    def __init__(self, inner: Any, seconds: float) -> None:
        self.inner = inner
        self.seconds = seconds

    async def complete(self, request: Any) -> Any:
        await anyio.sleep(self.seconds)
        return await self.inner.complete(request)


class _PairedChat:
    """A chat client that answers nobody until two callers have arrived.

    This is how the concurrency claim is proved rather than assumed: if the
    engine ran the two branches one after another, the first would wait for a
    partner that cannot arrive until it returns, and the test would time out
    instead of quietly passing on a serialised run.
    """

    def __init__(self, inner: Any) -> None:
        self.inner = inner
        self.arrived = 0
        self.both_here = anyio.Event()

    async def complete(self, request: Any) -> Any:
        self.arrived += 1
        if self.arrived >= 2:
            self.both_here.set()
        await self.both_here.wait()
        return await self.inner.complete(request)


# --- graphs ------------------------------------------------------------------


def _smoke_graph() -> WorkflowGraph:
    """input -> calculator -> router -> (approve | review -> escalate) -> output."""
    return from_dict(
        {
            "name": "Personal loan triage",
            "nodes": [
                {"id": "in", "type": "input", "config": {"schema": {"bureau_score": "number"}}},
                {
                    "id": "calc",
                    "type": "calculator",
                    "config": {
                        "expression": "workflow.facts.bureau_score",
                        "fact_name": "score",
                    },
                },
                {
                    "id": "gate",
                    "type": "router",
                    "config": {
                        "branches": [
                            {"label": "approve", "condition": "workflow.facts.score >= 700"},
                            {"label": "review", "condition": "true"},
                        ]
                    },
                },
                {
                    "id": "approve",
                    "type": "set_state",
                    "config": {"facts": {"decision": "approve"}},
                },
                {
                    "id": "review",
                    "type": "set_state",
                    "config": {"facts": {"decision": "review"}},
                },
                {
                    "id": "escalate",
                    "type": "set_state",
                    "config": {"facts": {"queue": "manual_underwriting"}},
                },
                {
                    "id": "out",
                    "type": "output",
                    "config": {"mapping": {"decision": "{{workflow.facts.decision}}"}},
                },
            ],
            "edges": [
                {"source": "in", "target": "calc"},
                {"source": "calc", "target": "gate"},
                {"source": "gate", "target": "approve", "branch": "approve"},
                {"source": "gate", "target": "review", "branch": "review"},
                {"source": "review", "target": "escalate"},
                {"source": "approve", "target": "out"},
                {"source": "escalate", "target": "out"},
            ],
        }
    )


def _fan_out_graph(branch_type: str = "set_state") -> WorkflowGraph:
    """One input, two independent branches, one join that reads both."""
    config: dict[str, Any] = (
        {"prompt": "Assess {{workflow.facts}}"}
        if branch_type == "llm"
        else {"facts": {"side": "set"}}
    )
    return from_dict(
        {
            "name": "Two readings of one file",
            "nodes": [
                {"id": "in", "type": "input", "config": {"schema": {"loan_id": "string"}}},
                {"id": "left", "type": branch_type, "config": dict(config)},
                {"id": "right", "type": branch_type, "config": dict(config)},
                {
                    "id": "join",
                    "type": "output",
                    "config": {
                        "mapping": {
                            "left": "{{nodes.left.text}}",
                            "right": "{{nodes.right.text}}",
                        }
                    },
                },
            ],
            "edges": [
                {"source": "in", "target": "left"},
                {"source": "in", "target": "right"},
                {"source": "left", "target": "join"},
                {"source": "right", "target": "join"},
            ],
        }
    )


def _one_model_call_graph() -> WorkflowGraph:
    """The smallest graph that actually reaches the model, for the cost tests."""
    return from_dict(
        {
            "name": "One reading",
            "nodes": [
                {"id": "in", "type": "input", "config": {"schema": {"loan_id": "string"}}},
                {
                    "id": "think",
                    "type": "llm",
                    "config": {"prompt": "Assess the applicant using {{workflow.facts}}"},
                },
            ],
            "edges": [{"source": "in", "target": "think"}],
        }
    )


def _errors(graph: WorkflowGraph) -> list[Problem]:
    return [problem for problem in graph.validate() if problem.blocking]


def _warnings(graph: WorkflowGraph) -> list[Problem]:
    return [problem for problem in graph.validate() if not problem.blocking]


def _said(problems: list[Problem]) -> str:
    return " | ".join(problem.message for problem in problems)


# --- the registry ------------------------------------------------------------


def test_every_node_in_the_library_has_a_real_executor() -> None:
    """The "no fake nodes" guarantee, asserted rather than trusted.

    A node type the canvas offers with nothing behind it is a box that pretends
    to run: it reports success, writes nothing, and the workflow it sits in
    produces a decision that was never actually made. `validate_registry` is the
    only thing standing between the library and that, and this is where it is
    held to it — in both directions, so an orphaned executor is caught too.
    """
    assert validate_registry(EXECUTORS) == []
    assert set(NODE_REGISTRY) == set(EXECUTORS)
    assert len(NODE_REGISTRY) > 20, "the library should not have quietly emptied"


def test_a_node_type_without_an_executor_is_named() -> None:
    """Proves the guarantee above has teeth, by removing one and checking it bites."""
    without_router = {name: run for name, run in EXECUTORS.items() if name != "router"}
    problems = validate_registry(without_router)

    assert any("router" in problem and "no executor" in problem for problem in problems)


def test_an_executor_for_a_node_the_library_does_not_offer_is_named() -> None:
    problems = validate_registry({**EXECUTORS, "teleport": lambda *_: None})

    assert any("teleport" in problem for problem in problems)


def test_a_node_that_cannot_do_all_its_name_suggests_says_so_in_the_library() -> None:
    """Having an executor is not the same as doing what the label implies.

    "Calculator" invites `monthly_income * 12`, and the expression grammar has
    no arithmetic operators at all — that is refused on the canvas, which is the
    right moment, but only if the person was told before they typed it. The
    limitation therefore lives on the spec, where the node library endpoint
    publishes it, rather than in whatever the first failing run happens to say.
    """
    spec = NODE_REGISTRY["calculator"]

    assert "arithmetic" in spec.caveat.lower(), "the one thing it cannot do goes unsaid"
    assert "arithmetic" not in spec.summary.lower(), "the summary promises arithmetic"


# --- graph validation, one failure at a time ---------------------------------


def test_a_cycle_is_refused_before_anything_runs() -> None:
    graph = from_dict(
        {
            "nodes": [
                {"id": "a", "type": "set_state", "config": {"facts": {"x": 1}}},
                {"id": "b", "type": "set_state", "config": {"facts": {"y": 1}}},
            ],
            "edges": [
                {"source": "a", "target": "b"},
                {"source": "b", "target": "a"},
            ],
        }
    )

    assert "form a loop" in _said(_errors(graph))


def test_two_nodes_sharing_an_id_are_refused() -> None:
    """Ids address state and edges, so a duplicate makes both ambiguous."""
    graph = from_dict(
        {
            "nodes": [
                {"id": "step", "type": "set_state", "config": {"facts": {"x": 1}}},
                {"id": "step", "type": "set_state", "config": {"facts": {"y": 1}}},
            ],
            "edges": [],
        }
    )

    assert "share the id 'step'" in _said(_errors(graph))


def test_a_connection_to_a_node_that_is_not_there_is_refused() -> None:
    graph = from_dict(
        {
            "nodes": [{"id": "in", "type": "input"}],
            "edges": [{"source": "in", "target": "ghost"}],
        }
    )

    assert "ends at 'ghost'" in _said(_errors(graph))


def test_a_branching_node_cannot_have_an_edge_for_a_branch_it_does_not_declare() -> None:
    """The canvas can be edited after the wiring, so the two drift apart."""
    graph = from_dict(
        {
            "nodes": [
                {
                    "id": "gate",
                    "type": "router",
                    "config": {
                        "branches": [
                            {"label": "approve", "condition": "workflow.facts.score >= 700"},
                            {"label": "review", "condition": "true"},
                        ]
                    },
                },
                {"id": "later", "type": "set_state", "config": {"facts": {"x": 1}}},
            ],
            "edges": [{"source": "gate", "target": "later", "branch": "decline"}],
        }
    )

    message = _said(_errors(graph))
    assert "branch 'decline'" in message
    assert "approve, review" in message, "the message must say what it does declare"


def test_an_edge_out_of_a_branching_node_must_say_which_branch_it_is() -> None:
    graph = from_dict(
        {
            "nodes": [
                {
                    "id": "gate",
                    "type": "router",
                    "config": {
                        "branches": [{"label": "approve", "condition": "true"}],
                    },
                },
                {"id": "later", "type": "set_state", "config": {"facts": {"x": 1}}},
            ],
            "edges": [{"source": "gate", "target": "later"}],
        }
    )

    assert "which branch it is" in _said(_errors(graph))


def test_a_router_whose_last_branch_is_conditional_is_a_warning_not_an_error() -> None:
    """A graph with no fallback is drawable and runnable; it just has a hole.

    Refusing it would stop someone mid-draw. Saying nothing would let a file
    matching no branch stop dead with no explanation, which is the failure that
    is hardest to attribute afterwards.
    """
    graph = from_dict(
        {
            "nodes": [
                {"id": "in", "type": "input"},
                {
                    "id": "gate",
                    "type": "router",
                    "config": {
                        "branches": [
                            {"label": "approve", "condition": "workflow.facts.score >= 700"},
                            {"label": "decline", "condition": "workflow.facts.score < 500"},
                        ]
                    },
                },
                {"id": "a", "type": "set_state", "config": {"facts": {"decision": "approve"}}},
                {"id": "d", "type": "set_state", "config": {"facts": {"decision": "decline"}}},
                {
                    "id": "out",
                    "type": "output",
                    "config": {"mapping": {"decision": "{{workflow.facts.decision}}"}},
                },
            ],
            "edges": [
                {"source": "in", "target": "gate"},
                {"source": "gate", "target": "a", "branch": "approve"},
                {"source": "gate", "target": "d", "branch": "decline"},
                {"source": "a", "target": "out"},
                {"source": "d", "target": "out"},
            ],
        }
    )

    assert _errors(graph) == []
    assert "last branch is conditional" in _said(_warnings(graph))


def test_a_required_setting_left_empty_is_refused_and_named() -> None:
    graph = from_dict(
        {
            "nodes": [
                {
                    "id": "calc",
                    "type": "calculator",
                    "config": {"expression": "", "fact_name": "score"},
                }
            ],
            "edges": [],
        }
    )

    problems = _errors(graph)
    assert "needs Expression" in _said(problems)
    assert any(problem.node_id == "calc" and problem.field == "expression" for problem in problems)


def test_an_expression_that_does_not_parse_is_refused_with_the_reason() -> None:
    """Caught on the canvas, where the person can still see the node they typed it on."""
    graph = from_dict(
        {
            "nodes": [
                {
                    "id": "calc",
                    "type": "calculator",
                    "config": {
                        "expression": "workflow.facts.monthly_income * 12",
                        "fact_name": "annual_income",
                    },
                }
            ],
            "edges": [],
        }
    )

    assert "does not parse" in _said(_errors(graph))


def test_a_node_nothing_can_reach_is_a_warning() -> None:
    """Unreachability always comes with a cause, and the cause is the error.

    Anything with no incoming edge starts the run, so a node can only become
    unreachable by sitting behind a loop (or behind an edge from a node that is
    not there). The loop is the error; being stranded behind it is the warning,
    and both are reported so the person is told what happened as well as why.
    """
    graph = from_dict(
        {
            "nodes": [
                {"id": "in", "type": "input"},
                {
                    "id": "out",
                    "type": "output",
                    "config": {"mapping": {"decision": "{{workflow.facts.decision}}"}},
                },
                {"id": "a", "type": "set_state", "config": {"facts": {"x": 1}}},
                {"id": "b", "type": "set_state", "config": {"facts": {"y": 1}}},
            ],
            "edges": [
                {"source": "in", "target": "out"},
                {"source": "a", "target": "b"},
                {"source": "b", "target": "a"},
            ],
        }
    )

    stranded = [
        problem.node_id for problem in _warnings(graph) if "not connected" in problem.message
    ]
    assert sorted(stranded) == ["a", "b"]


def test_the_canvas_shape_used_by_the_rest_of_these_tests_is_clean() -> None:
    """If the fixture graph itself were invalid, every engine test below would lie."""
    assert _errors(_smoke_graph()) == []
    assert _warnings(_smoke_graph()) == []


# --- layers ------------------------------------------------------------------


def test_a_fan_out_lands_in_one_layer_and_the_join_waits_for_both() -> None:
    """A layer is "everything whose dependencies are settled", not "the next node".

    Putting the two branches in separate layers would be the obvious reading of
    a topological order, and it would serialise two pieces of work that have no
    reason to be serial.
    """
    layers = _fan_out_graph().layers()

    assert layers == [["in"], ["left", "right"], ["join"]]


def test_the_smoke_graph_layers_put_both_router_branches_together() -> None:
    layers = _smoke_graph().layers()

    assert layers[0] == ["in"]
    assert ["approve", "review"] in layers, "the two branches are independent"
    assert layers[-1] == ["out"], "the join is last, because it waits for both sides"


# --- the shared state --------------------------------------------------------


def test_set_fact_warns_when_a_later_node_changes_an_established_fact() -> None:
    """Silence is the one option that is not available.

    Refusing the write would stop runs where two nodes legitimately find the
    same thing by different routes. Accepting it quietly would make a fact that
    changed under a later node indistinguishable from one that never did, which
    is what makes a workflow impossible to debug after the fact.
    """
    state = WorkflowState()
    state.set_fact("monthly_income", 85000, node_id="statement")
    state.set_fact("monthly_income", 91000, node_id="payslip")

    assert state.facts["monthly_income"] == 91000
    assert len(state.warnings) == 1
    assert "payslip" in state.warnings[0]
    assert "85000" in state.warnings[0] and "91000" in state.warnings[0]


def test_set_fact_says_nothing_when_the_second_node_agrees() -> None:
    state = WorkflowState()
    state.set_fact("monthly_income", 85000, node_id="statement")
    state.set_fact("monthly_income", 85000, node_id="payslip")

    assert state.warnings == []


def test_a_model_cannot_overrule_a_deterministic_decision() -> None:
    """Rules decide, models reason.

    This is the rule the whole product rests on, so it is enforced in the state
    rather than in the node that happens to be writing: a model node that tries
    to overturn a rule engine gets a warning and no effect. The obvious
    implementation — last writer wins — would make the rule engine advisory,
    and an advisory rule engine is not one a lender can point a regulator at.
    """
    state = WorkflowState()
    state.add_decision(
        Decision(node_id="bre", name="eligibility", value="FAIL", deterministic=True)
    )
    state.add_decision(
        Decision(
            node_id="llm",
            name="eligibility",
            value="PASS",
            deterministic=False,
            reason="the applicant seems reliable",
        )
    )

    assert state.decision("eligibility") == "FAIL"
    assert len(state.decisions) == 1
    assert any("tried to overrule" in warning for warning in state.warnings)


def test_a_rule_may_replace_an_earlier_opinion() -> None:
    """The refusal is one-directional; a later rule settles what a model guessed."""
    state = WorkflowState()
    state.add_decision(
        Decision(node_id="llm", name="eligibility", value="PASS", deterministic=False)
    )
    state.add_decision(
        Decision(node_id="bre", name="eligibility", value="FAIL", deterministic=True)
    )

    assert state.decision("eligibility") == "FAIL"
    assert state.warnings == []


# --- the engine, end to end --------------------------------------------------


async def test_a_linear_workflow_completes_and_returns_the_output_mapping(sarvam) -> None:  # type: ignore[no-untyped-def]
    graph = from_dict(
        {
            "nodes": [
                {"id": "in", "type": "input", "config": {"schema": {"bureau_score": "number"}}},
                {
                    "id": "seed",
                    "type": "set_state",
                    "config": {"facts": {"decision": "approve"}},
                },
                {
                    "id": "out",
                    "type": "output",
                    "config": {
                        "mapping": {
                            "decision": "{{workflow.facts.decision}}",
                            "score": "{{workflow.facts.bureau_score}}",
                        }
                    },
                },
            ],
            "edges": [
                {"source": "in", "target": "seed"},
                {"source": "seed", "target": "out"},
            ],
        }
    )

    result = await run_workflow(graph, sarvam, inputs={"bureau_score": 712})

    assert result.status == "completed"
    assert result.output == {"decision": "approve", "score": "712"}
    assert [entry.status for entry in result.trace] == ["ok", "ok", "ok"]


async def test_a_router_takes_one_branch_and_the_other_is_skipped_not_failed(sarvam) -> None:  # type: ignore[no-untyped-def]
    """An unchosen branch is a path not taken, not a thing that went wrong.

    Reporting it as a failure would make every branching workflow — that is,
    every interesting one — report errors on a perfectly good run.
    """
    result = await run_workflow(_smoke_graph(), sarvam, inputs={"bureau_score": 712})

    statuses = {entry.node_id: entry.status for entry in result.trace}

    assert result.status == "completed"
    assert result.output == {"decision": "approve"}
    assert statuses["gate"] == "ok"
    assert statuses["approve"] == "ok"
    assert statuses["review"] == "skipped"
    assert statuses["escalate"] == "skipped", "skipping carries down the whole branch"
    assert statuses["out"] == "ok", "the join still runs on the side that was taken"
    assert "failed" not in statuses.values()
    assert result.state.errors == []


async def test_the_other_branch_runs_when_the_condition_says_so(sarvam) -> None:  # type: ignore[no-untyped-def]
    """The mirror image, so the test above is not passing on a hard-coded branch."""
    result = await run_workflow(_smoke_graph(), sarvam, inputs={"bureau_score": 610})

    statuses = {entry.node_id: entry.status for entry in result.trace}

    assert result.output == {"decision": "review"}
    assert statuses["review"] == "ok"
    assert statuses["escalate"] == "ok"
    assert statuses["approve"] == "skipped"
    assert result.state.facts["queue"] == "manual_underwriting"


async def test_a_human_approval_node_halts_the_run_and_nothing_after_it_executes(  # type: ignore[no-untyped-def]
    sarvam,
) -> None:
    """A genuine stop, not a flag set on the way past.

    The node's whole purpose is that a person sees the case before anything
    else happens to it, so the run ends here and the nodes downstream are never
    reached at all — they do not appear in the trace, because they did not get
    as far as being skipped.
    """
    graph = from_dict(
        {
            "nodes": [
                {"id": "in", "type": "input", "config": {"schema": {"loan_id": "string"}}},
                {
                    "id": "gate",
                    "type": "human_approval",
                    "config": {"reason": "Policy deviation on income", "assign_to": "credit_ops"},
                },
                {"id": "after", "type": "set_state", "config": {"facts": {"notified": True}}},
                {
                    "id": "out",
                    "type": "output",
                    "config": {"mapping": {"decision": "{{workflow.facts.decision}}"}},
                },
            ],
            "edges": [
                {"source": "in", "target": "gate"},
                {"source": "gate", "target": "after"},
                {"source": "after", "target": "out"},
            ],
        }
    )

    result = await run_workflow(graph, sarvam, inputs={"loan_id": "18302"})

    assert result.status == "awaiting_approval"
    assert [entry.node_id for entry in result.trace] == ["in", "gate"]
    assert result.trace[-1].status == "halted"
    assert result.trace[-1].summary == "Policy deviation on income"
    assert "notified" not in result.state.facts

    pending = next(entry for entry in result.state.decisions if entry.name == "human_approval")
    assert pending.value == "PENDING"
    assert pending.deterministic is True


async def test_a_failing_node_skips_what_is_downstream_and_the_trace_survives(sarvam) -> None:  # type: ignore[no-untyped-def]
    """The trace matters most on the run that did not work, so it is built as it goes.

    The downstream nodes are skipped rather than attempted: running them against
    a state that never received the failed node's output would turn one legible
    failure into several misleading ones.
    """
    graph = from_dict(
        {
            "nodes": [
                {"id": "in", "type": "input", "config": {"schema": {"loan_id": "string"}}},
                {
                    "id": "calc",
                    "type": "calculator",
                    "config": {
                        "expression": "workflow.facts.monthly_income",
                        "fact_name": "income",
                    },
                },
                {"id": "after", "type": "set_state", "config": {"facts": {"priced": True}}},
                {
                    "id": "out",
                    "type": "output",
                    "config": {"mapping": {"income": "{{workflow.facts.income}}"}},
                },
            ],
            "edges": [
                {"source": "in", "target": "calc"},
                {"source": "calc", "target": "after"},
                {"source": "after", "target": "out"},
            ],
        }
    )

    # `monthly_income` is never established, so the node fails at run time. It
    # cannot be caught at validation: with nothing having run, no fact exists
    # yet, so the validator can only judge the shape of the expression.
    result = await run_workflow(graph, sarvam, inputs={"loan_id": "18302"})

    statuses = {entry.node_id: entry.status for entry in result.trace}

    assert result.status == "failed"
    assert statuses == {"in": "ok", "calc": "failed", "after": "skipped", "out": "skipped"}

    failure = next(entry for entry in result.trace if entry.node_id == "calc")
    assert "monthly_income" in failure.error
    assert any("monthly_income" in message for message in result.state.errors)


async def test_an_invalid_graph_is_refused_without_running_anything() -> None:
    """Nothing has been called, nothing billed, no state half-written.

    The AI layer handed in here raises if it is touched at all, so this asserts
    the absence of work rather than merely the absence of a trace.
    """
    graph = from_dict(
        {
            "nodes": [
                {"id": "a", "type": "llm", "config": {"prompt": "Assess {{workflow.facts}}"}},
                {"id": "b", "type": "llm", "config": {"prompt": "Assess again"}},
            ],
            "edges": [
                {"source": "a", "target": "b"},
                {"source": "b", "target": "a"},
            ],
        }
    )

    result = await run_workflow(graph, _RefusesToBeCalled(), inputs={"loan_id": "18302"})

    assert result.status == "invalid"
    assert result.trace == []
    assert result.output == {}
    assert result.state.facts == {}
    assert any("form a loop" in problem for problem in result.problems)


async def test_two_independent_branches_run_together_and_the_join_sees_both(sarvam) -> None:  # type: ignore[no-untyped-def]
    """Both halves of the parallel claim, in one run.

    The paired chat client will not answer until two callers are waiting on it,
    so a serialised engine deadlocks and the timeout fails the test. A run that
    finishes is therefore proof the two nodes were in flight at once — and the
    join's mapping then proves it could read what both of them produced.
    """
    graph = _fan_out_graph("llm")
    paired = _PairedChat(sarvam.chat)
    sarvam.chat = paired

    with anyio.fail_after(15):
        result = await run_workflow(graph, sarvam, inputs={"loan_id": "18302"})

    assert paired.arrived == 2, "the barrier was never reached, so this proved nothing"
    assert result.status == "completed"
    assert {entry.node_id: entry.status for entry in result.trace} == {
        "in": "ok",
        "left": "ok",
        "right": "ok",
        "join": "ok",
    }
    assert sorted(result.output) == ["left", "right"]
    assert result.output["left"], "the join read nothing from the left branch"
    assert result.output["right"], "the join read nothing from the right branch"


async def test_the_trace_records_a_duration_and_the_tokens_for_each_node(sarvam) -> None:  # type: ignore[no-untyped-def]
    """What the TEST screen shows, and what a cost conversation later rests on."""
    sarvam.chat = _SlowChat(sarvam.chat, seconds=0.05)
    graph = from_dict(
        {
            "nodes": [
                {"id": "in", "type": "input", "config": {"schema": {"loan_id": "string"}}},
                {
                    "id": "think",
                    "type": "llm",
                    "config": {"prompt": "Assess the applicant using {{workflow.facts}}"},
                },
                {
                    "id": "out",
                    "type": "output",
                    "config": {"mapping": {"assessment": "{{nodes.think.text}}"}},
                },
            ],
            "edges": [
                {"source": "in", "target": "think"},
                {"source": "think", "target": "out"},
            ],
        }
    )

    result = await run_workflow(graph, sarvam, inputs={"loan_id": "18302"})
    assert result.status == "completed"

    # `duration_ms >= 0` is not worth asserting: it is an int off a monotonic
    # clock and cannot be otherwise. What can go wrong is a field never filled
    # in at all, which is what these two check.
    for entry in result.trace:
        assert entry.started_at, f"{entry.node_id} has no start time"
        assert isinstance(entry.cost_inr, Decimal)

    model_call = next(entry for entry in result.trace if entry.node_id == "think")
    assert model_call.duration_ms >= 40, "the measured duration is not a real measurement"
    assert model_call.input_tokens > 0
    assert model_call.output_tokens > 0

    # The run totals are the trace's totals; nothing is counted twice or lost.
    assert result.input_tokens == sum(entry.input_tokens for entry in result.trace)
    assert result.output_tokens == sum(entry.output_tokens for entry in result.trace)
    assert result.cost_inr == sum((entry.cost_inr for entry in result.trace), Decimal("0"))
    assert result.duration_ms >= model_call.duration_ms


async def test_a_model_call_is_priced_through_the_same_card_as_every_other_call(sarvam) -> None:  # type: ignore[no-untyped-def]
    """A node's cost has to be the same kind of number as an agent's.

    This figure is persisted on the run row and shown on the TEST screen, so a
    tenant will compare it against the agent ledger. Asserting only that it is
    non-zero would be satisfied by a node that priced one leg, or that priced
    output tokens at the input rate — both of which produce a plausible number
    and a wrong invoice. So the expected cost is rebuilt here from the card
    itself, which makes this an assertion about the composition rather than
    about the mere presence of a figure.
    """
    result = await run_workflow(_one_model_call_graph(), sarvam, inputs={"loan_id": "18302"})

    model_call = next(entry for entry in result.trace if entry.node_id == "think")
    assert model_call.input_tokens > 0 and model_call.output_tokens > 0

    card = RateCard()
    expected = card.price(
        CallRecord(
            product=Product.LLM_INPUT,
            endpoint="/v1/chat/completions",
            input_tokens=model_call.input_tokens,
        )
    ) + card.price(
        CallRecord(
            product=Product.LLM_OUTPUT,
            endpoint="/v1/chat/completions",
            output_tokens=model_call.output_tokens,
        )
    )

    assert expected > Decimal("0"), "the card itself prices this at nothing, so nothing is proved"
    assert model_call.cost_inr == expected
    assert result.cost_inr == expected, "the run total is the trace's total"
    assert not any("rate card" in warning for warning in result.state.warnings)


async def test_a_run_with_no_rate_card_says_so_rather_than_reporting_a_price_of_zero(  # type: ignore[no-untyped-def]
    sarvam,
) -> None:
    """Unknown and free are different claims, and a bare number cannot tell them apart.

    A screen showing ₹0 reads as "this cost nothing" whether that is what
    happened or whether the rates were simply unavailable, so the run says which
    it is. This is what keeps a silent `return Decimal("0")` from creeping back
    into the pricing path the next time something there is tidied up.
    """
    sarvam.rate_card = None

    result = await run_workflow(_one_model_call_graph(), sarvam, inputs={"loan_id": "18302"})

    model_call = next(entry for entry in result.trace if entry.node_id == "think")
    assert model_call.input_tokens > 0, "the call was made, so the tokens were counted"
    assert model_call.cost_inr == Decimal("0")
    assert any("could not be priced" in warning for warning in result.state.warnings)


async def test_a_sandboxed_model_says_so_instead_of_passing_canned_prose_off_as_analysis(  # type: ignore[no-untyped-def]
    sarvam,
) -> None:
    """The house rule, at the one place a reader would most easily be misled."""
    result = await run_workflow(_one_model_call_graph(), sarvam, inputs={"loan_id": "18302"})

    assert any("sandboxed" in warning for warning in result.state.warnings)


async def test_the_output_node_names_a_field_it_could_not_resolve(sarvam) -> None:  # type: ignore[no-untyped-def]
    """A final answer missing a field it promised is worse than one that says why."""
    graph = from_dict(
        {
            "nodes": [
                {"id": "in", "type": "input", "config": {"schema": {"loan_id": "string"}}},
                {
                    "id": "out",
                    "type": "output",
                    "config": {"mapping": {"decision": "{{workflow.facts.decision}}"}},
                },
            ],
            "edges": [{"source": "in", "target": "out"}],
        }
    )

    result = await run_workflow(graph, sarvam, inputs={"loan_id": "18302"})

    assert result.status == "completed"
    assert result.output == {"decision": None}
    assert any("decision" in warning for warning in result.state.warnings)
