"""Templates and conditions over the workflow state.

A router condition is a piece of a lending decision typed into a form field by
whoever drew the canvas. That makes this module the platform's widest untrusted
input, so the tests here are about two things in equal measure: that it computes
the right answer, and that it cannot be made to do anything other than compute.

The second half matters most. A grammar that can only compare and combine is
only a safety property if nothing can smuggle a call through it, so the
execution tests below try rather than assume.
"""

from __future__ import annotations

import pytest
from gravai_workflow.expressions import ExpressionError, check, evaluate, lookup, render
from gravai_workflow.state import new_state


def _scope(**facts: object) -> dict[str, object]:
    """A realistic resolution scope, built the way a run builds one.

    Assembling a bare dict by hand would let these tests pass against a scope
    shape the engine never actually produces.
    """
    return new_state(facts).resolution_scope()


# --- lookup ------------------------------------------------------------------


def test_lookup_walks_a_dotted_path() -> None:
    scope = _scope(bureau_score=712)
    assert lookup("workflow.facts.bureau_score", scope) == 712


def test_lookup_names_the_segment_that_failed_and_what_was_there_instead() -> None:
    """A message saying something is missing is not a fix; naming the segment is."""
    scope = _scope(bureau_score=712, loan_amount=500000)

    with pytest.raises(ExpressionError) as raised:
        lookup("workflow.facts.income", scope)

    message = str(raised.value)
    assert "'income' is not in workflow.facts" in message
    assert "bureau_score" in message, "the message must list what is addressable"


def test_lookup_says_where_it_got_to_when_an_index_runs_off_the_end() -> None:
    scope = _scope(emis=[{"lender": "HDFC"}])

    with pytest.raises(ExpressionError) as raised:
        lookup("workflow.facts.emis[3]", scope)

    assert "index 3 is past the end" in str(raised.value)
    assert "1 items" in str(raised.value)


def test_lookup_reads_an_element_out_of_a_list() -> None:
    scope = _scope(emis=[{"lender": "HDFC"}, {"lender": "ICICI"}])
    assert lookup("workflow.facts.emis[1].lender", scope) == "ICICI"


# --- render ------------------------------------------------------------------


def test_render_substitutes_every_path_it_finds() -> None:
    scope = _scope(applicant="Ayush", bureau_score=712)
    template = "{{workflow.facts.applicant}} scored {{workflow.facts.bureau_score}}"

    assert render(template, scope) == "Ayush scored 712"


def test_render_writes_an_object_as_json_rather_than_a_python_repr() -> None:
    """The destination is usually a prompt, and a repr of quotes reads badly there."""
    scope = _scope(bureau_score=712, tags=["salaried"])
    rendered = render("{{workflow.facts}}", scope)

    assert '"bureau_score": 712' in rendered
    assert '"salaried"' in rendered
    assert "'" not in rendered, "a Python repr has leaked into the prompt"


def test_render_raises_on_an_unknown_path_when_it_is_strict() -> None:
    with pytest.raises(ExpressionError):
        render("{{workflow.facts.missing}}", _scope(bureau_score=712))


def test_render_leaves_an_unknown_path_alone_when_it_is_not_strict() -> None:
    """A half-built prompt is better than a failed node while a canvas is in progress."""
    text = render("{{workflow.facts.missing}}", _scope(bureau_score=712), strict=False)
    assert text == "{{workflow.facts.missing}}"


# --- evaluate ----------------------------------------------------------------


def test_evaluate_combines_conditions_with_and_or_and_not() -> None:
    scope = _scope(verified=True, blocked=False, bureau_score=712)

    assert evaluate("verified and workflow.facts.bureau_score >= 700", scope) is True
    assert evaluate("blocked or verified", scope) is True
    assert evaluate("not verified", scope) is False
    assert evaluate("not blocked and verified", scope) is True


def test_parentheses_change_the_grouping() -> None:
    """`and` binds tighter than `or`, and brackets are the way to say otherwise."""
    assert evaluate("true or false and false", {}) is True
    assert evaluate("(true or false) and false", {}) is False


def test_a_score_that_arrived_as_a_string_still_compares_as_a_number() -> None:
    """The case this exists for: a JSON source sends "712", not 712.

    The thresholds have to be chosen so the two readings disagree, or the test
    proves nothing. Against 700 the answer is the same either way — "712" sorts
    above "700" as text as surely as 712 exceeds 700 as a number — so a suite
    built only on neighbouring thresholds would stay green against a comparison
    that never converted anything at all. Against 80 the readings part company:
    712 is the larger number, while "712" sorts *below* "80" on the first
    character. Those are the assertions that bite, and they are the shape of the
    real defect — a router declining a file it should have approved, noticeable
    only in the decisions it quietly made.
    """
    scope = _scope(bureau_score="712", enquiries_3m="9")

    assert evaluate("workflow.facts.bureau_score >= 80", scope) is True
    assert evaluate("workflow.facts.bureau_score < 80", scope) is False
    assert evaluate("workflow.facts.enquiries_3m < 10", scope) is True

    assert evaluate("workflow.facts.bureau_score >= 700", scope) is True
    assert evaluate("workflow.facts.bureau_score > 800", scope) is False
    assert evaluate("workflow.facts.bureau_score == 712", scope) is True


def test_ordering_two_things_that_are_not_numbers_is_refused_rather_than_guessed() -> None:
    scope = _scope(applicant_name="Ayush")

    with pytest.raises(ExpressionError) as raised:
        evaluate("workflow.facts.applicant_name > 700", scope)

    assert "not both numbers" in str(raised.value)


def test_in_and_contains_read_from_either_side() -> None:
    scope = _scope(tags=["salaried", "existing_customer"], narration="NACH DR HDFC HOME LOAN")

    assert evaluate("'salaried' in workflow.facts.tags", scope) is True
    assert evaluate("workflow.facts.tags contains 'existing_customer'", scope) is True
    assert evaluate("'NACH' in workflow.facts.narration", scope) is True
    assert evaluate("'defaulter' in workflow.facts.tags", scope) is False


def test_an_empty_list_or_string_is_false_and_a_populated_one_is_true() -> None:
    scope = _scope(flags=[], notes="", warnings=["bounce"], reason="late")

    assert evaluate("workflow.facts.flags", scope) is False
    assert evaluate("workflow.facts.notes", scope) is False
    assert evaluate("workflow.facts.warnings", scope) is True
    assert evaluate("workflow.facts.reason", scope) is True
    assert evaluate("workflow.facts.flags empty", scope) is True


def test_zero_is_false_and_any_other_number_is_true() -> None:
    scope = _scope(bounces=0, emis=2)
    assert evaluate("workflow.facts.bounces", scope) is False
    assert evaluate("workflow.facts.emis", scope) is True


# --- the safety property -----------------------------------------------------


@pytest.mark.parametrize(
    "attempt",
    [
        "__import__('os')",
        "os.system('shutdown')",
        "eval('1')",
        "exec('x = 1')",
        "open('/etc/passwd')",
        "().__class__.__bases__",
        "1 + 1",
        "lambda: 1",
    ],
)
def test_a_condition_cannot_execute_code(attempt: str) -> None:
    """The point of parsing rather than evaluating.

    Every one of these is refused, and refused for the same structural reason:
    the grammar has no call form and no arithmetic, so `(` is either a bracket
    or a syntax error and a bare name is either a path into the state or a name
    that is not there. There is no third thing for it to be.
    """
    with pytest.raises(ExpressionError):
        evaluate(attempt, {})


def test_a_callable_sitting_in_the_state_still_cannot_be_invoked() -> None:
    """The strongest form of the claim, and the one worth proving directly.

    Refusing `__import__` only shows that the name is absent. Putting a real
    callable in the scope under a name the expression *can* resolve removes that
    excuse: the parser reaches it, hands it back as a value, and then has no
    production that would call it.
    """
    calls: list[tuple[object, ...]] = []
    scope: dict[str, object] = {"danger": lambda *args: calls.append(args)}

    with pytest.raises(ExpressionError):
        evaluate("danger('boom')", scope)

    assert calls == [], "the expression grammar invoked something"


def test_an_empty_condition_is_refused_rather_than_treated_as_true() -> None:
    """A blank field must not silently mean "always take this branch"."""
    with pytest.raises(ExpressionError):
        evaluate("   ", {})


# --- check, the pre-run syntax pass ------------------------------------------


def test_check_accepts_a_name_it_cannot_resolve_yet() -> None:
    """Nothing has run, so no fact exists; only the shape can be judged here."""
    check("workflow.facts.bureau_score >= 700 and workflow.facts.verified")


def test_check_rejects_arithmetic_because_the_grammar_has_none() -> None:
    """Worth stating plainly: the Calculator node resolves a path, it does not compute.

    Its label invites `monthly_income * 12`, and this build cannot do that. The
    honest behaviour is the one asserted here — the canvas refuses it before the
    run, rather than a node failing later with something obscure.
    """
    with pytest.raises(ExpressionError) as raised:
        check("workflow.facts.monthly_income * 12")

    assert "Cannot read" in str(raised.value)


def test_check_rejects_an_unclosed_bracket() -> None:
    with pytest.raises(ExpressionError):
        check("(true and false")
