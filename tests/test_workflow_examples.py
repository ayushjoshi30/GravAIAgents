"""The two seed workflows, held to the bar a hand-drawn one is held to.

A seed that does not run is worse than no seed: the first thing a new person
does with one is press TEST, and a broken example teaches them that the
platform is broken. So these must validate without a blocking problem, and they
must actually execute end to end. Nothing serves them over HTTP yet, which is
the other reason this file exists — until something does, it is the only thing
that would notice a seed going stale.

Everything runs in sandbox, so no test reaches a vendor and no test spends
anything. What is not faked is the engine: the layering, the branch pruning and
the halt are the real code paths.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from gravai_sarvam import build_sarvam
from gravai_workflow import from_dict, run_workflow, to_dict
from gravai_workflow.examples import CREDIT_UNDERWRITING, EXAMPLES, TWO_STEP


async def _nosleep(_: float) -> None:
    """The document runner's back-off, with the waiting taken out.

    The back-off is asserted in test_governor.py; re-imposing it here would only
    make each of these tests sit for seconds while proving nothing new.
    """
    return None


@pytest.fixture
async def sarvam():  # type: ignore[no-untyped-def]
    # One poll rather than ten: the document stage reads eight documents, and
    # the default polling turns a two-second test into a two-minute one.
    bundle = build_sarvam(polls_before_done=1, sleep=_nosleep)
    yield bundle
    await bundle.aclose()


#: A file that meets policy: the figures are inside every threshold the sandbox
#: rule set applies.
ACCEPTABLE: dict[str, Any] = {
    "application_id": "18302",
    "loan_amount": 1000000,
    "tenure_months": 60,
    "interest_rate_pct": 11.0,
    "net_monthly_income": 85000,
    "existing_monthly_emi": 12000,
    "bureau_score": 712,
    "enquiries_3m": 3,
    "employment_vintage_months": 28,
}

#: The same file with the bureau score under the floor, which is the cleanest
#: single change that makes policy fail without making anything else fail.
BELOW_POLICY: dict[str, Any] = {**ACCEPTABLE, "bureau_score": 610}

#: The same file again, changed only where the rule set asks for a person rather
#: than refusing outright. Every other figure stays inside its threshold, so a
#: run that treats this as acceptable has done so on the referral alone.
REFERRED: dict[str, Any] = {**ACCEPTABLE, "enquiries_3m": 9}


# --- the definitions themselves ----------------------------------------------


@pytest.mark.parametrize("name", sorted(EXAMPLES))
def test_every_seed_validates_with_nothing_blocking_wrong_with_it(name: str) -> None:
    problems = from_dict(EXAMPLES[name]).validate()
    assert [p.message for p in problems if p.blocking] == []


@pytest.mark.parametrize("name", sorted(EXAMPLES))
def test_every_seed_is_clean_enough_to_raise_no_warnings_either(name: str) -> None:
    """Not merely runnable — exemplary.

    A seed carrying a warning teaches the warning. The validator's warnings are
    all things a person should fix on their own canvas, so the examples they
    copy from should not be demonstrating any of them.
    """
    problems = from_dict(EXAMPLES[name]).validate()
    assert [p.message for p in problems if not p.blocking] == []


@pytest.mark.parametrize("name", sorted(EXAMPLES))
def test_every_seed_survives_a_round_trip_through_the_definition_format(name: str) -> None:
    """The seeds travel as JSON, so they have to be expressible as JSON.

    A seed that only works as a Python literal would break the moment it was
    saved and loaded back, which is the only way anybody will ever use one.

    The serialisation is done for real rather than by handing one dictionary
    back to `from_dict`: those two functions are pure dictionary work and a
    `Decimal` or a `date` left in a config would survive them happily, only to
    fail at the database or on the wire. `json.dumps` is the step that refuses.
    """
    once = from_dict(EXAMPLES[name])
    travelled = json.loads(json.dumps(to_dict(once)))
    twice = from_dict(travelled)
    assert to_dict(twice) == to_dict(once)


@pytest.mark.parametrize("name", sorted(EXAMPLES))
def test_no_two_nodes_in_a_seed_sit_on_top_of_each_other(name: str) -> None:
    """The canvas honours the coordinates it is given and does not lay out.

    Two nodes at the same point are one node as far as the person looking at the
    screen is concerned.
    """
    positions = [(node["position"]["x"], node["position"]["y"]) for node in EXAMPLES[name]["nodes"]]
    assert len(set(positions)) == len(positions)


def test_the_underwriting_seed_ends_its_router_with_a_fallback() -> None:
    """Asserted on the definition, not only via the validator's warning.

    This is the property that keeps a file from vanishing at the router, and it
    is worth stating here so that someone editing the branches sees why the last
    one is unconditional.
    """
    router = next(n for n in CREDIT_UNDERWRITING["nodes"] if n["type"] == "router")
    assert router["config"]["branches"][-1]["condition"] == "true"


def test_the_underwriting_seed_does_not_put_a_model_between_every_pair_of_nodes() -> None:
    compiler = next(n for n in CREDIT_UNDERWRITING["nodes"] if n["type"] == "context_compiler")
    assert compiler["config"]["use_model"] is False


# --- and that they run --------------------------------------------------------


async def test_the_underwriting_seed_runs_all_the_way_to_its_output(sarvam) -> None:  # type: ignore[no-untyped-def]
    result = await run_workflow(from_dict(CREDIT_UNDERWRITING), sarvam, inputs=ACCEPTABLE)

    assert result.status == "completed", result.state.errors
    assert result.state.errors == []
    ran = {entry.node_id for entry in result.trace if entry.status == "ok"}
    assert {"intake", "documents", "compile_context", "risk", "policy", "route"} <= ran

    # The presence of the keys proves nothing on its own: the output node reports
    # an expression it could not read by setting that field to None and keeping
    # the key, so a seed whose every reference had gone stale would still produce
    # a dictionary of exactly this shape. The values are the assertion.
    assert set(result.output) >= {"policy_check", "risk_band", "recommendation"}
    assert result.output["policy_check"] == "PASS"
    assert all(value for value in result.output.values())
    assert not any("{{" in str(value) for value in result.output.values())


async def test_the_underwriting_seed_takes_the_appraisal_branch_when_policy_is_met(  # type: ignore[no-untyped-def]
    sarvam,
) -> None:
    result = await run_workflow(from_dict(CREDIT_UNDERWRITING), sarvam, inputs=ACCEPTABLE)

    outcome = {entry.node_id: entry.status for entry in result.trace}
    assert outcome["appraisal"] == "ok"
    # Skipped rather than failed: the branch was not taken, which is not an
    # error, and a run reporting one here would make every branching workflow
    # look broken.
    assert outcome["review"] == "skipped"


async def test_the_policy_node_applies_its_rules_to_the_figures_the_mapping_carries(  # type: ignore[no-untyped-def]
    sarvam,
) -> None:
    """The policy mapping is an identifier and eight figures, proved here alone.

    A rule handed nothing reports `na` rather than failing, so a seed whose
    mapping had silently stopped resolving would still run to completion and
    still report a pass, and every other test in this file would stay green. So
    this one asserts which rules actually reached a verdict, and that the ratio
    one of them computed is the ratio those figures imply — which is the only
    way the income and the existing instalment are shown to have arrived at all.
    """
    result = await run_workflow(from_dict(CREDIT_UNDERWRITING), sarvam, inputs=ACCEPTABLE)

    policy = next(entry for entry in result.trace if entry.node_id == "policy")
    applied = {rule["rule_id"] for rule in policy.outputs["rules"] if rule["result"] != "na"}
    # Loan-to-value is absent deliberately: the intake asks for no collateral, so
    # that rule abstains, and a seed claiming an LTV verdict would be claiming a
    # figure nobody supplied.
    assert applied == {"ELIG-FOIR-01", "RISK-BUREAU-01", "RISK-ENQ-01", "POLICY-VINTAGE-01"}

    foir = next(rule for rule in policy.outputs["rules"] if rule["rule_id"] == "ELIG-FOIR-01")
    assert foir["detail"] == "39.7% against at most 55.0%"


async def test_a_referral_reaches_a_person_rather_than_an_automated_approval(sarvam) -> None:  # type: ignore[no-untyped-def]
    """The rule set's middle verdict, which is the easy one to lose.

    Counting only outright failures would read a referral as "nothing objected"
    and send the file down the automated branch — precisely the outcome the
    referral exists to prevent, and invisible in a run that otherwise looks
    perfectly healthy.
    """
    result = await run_workflow(from_dict(CREDIT_UNDERWRITING), sarvam, inputs=REFERRED)

    assert result.status == "awaiting_approval"
    policy = next(entry for entry in result.trace if entry.node_id == "policy")
    assert policy.outputs["passed"] is False
    assert [rule["rule_id"] for rule in policy.outputs["failed_rules"]] == ["RISK-ENQ-01"]


async def test_policy_does_not_report_met_when_no_rule_could_be_applied(sarvam) -> None:  # type: ignore[no-untyped-def]
    """A file carrying only an identifier has not passed anything.

    Every rule abstains, so there is nothing to fail, and reporting a pass on
    that basis would hand an automated approval to an application the rule
    engine never saw a figure from.
    """
    result = await run_workflow(
        from_dict(CREDIT_UNDERWRITING), sarvam, inputs={"application_id": "18302"}
    )

    policy = next(entry for entry in result.trace if entry.node_id == "policy")
    assert policy.outputs["passed"] is False
    assert result.state.facts["policy_check"] == "FAIL"
    assert result.status == "awaiting_approval"

    finding = next(d for d in result.state.decisions if d.name == "policy_check")
    assert finding.reason == "no rule could be applied to the figures supplied"


async def test_a_file_below_policy_reaches_a_person_instead_of_a_memorandum(sarvam) -> None:  # type: ignore[no-untyped-def]
    result = await run_workflow(from_dict(CREDIT_UNDERWRITING), sarvam, inputs=BELOW_POLICY)

    assert result.status == "awaiting_approval"
    outcome = {entry.node_id: entry.status for entry in result.trace}
    assert outcome["review"] == "halted"
    assert outcome["appraisal"] == "skipped"


async def test_the_rule_engines_finding_is_recorded_as_deterministic(sarvam) -> None:  # type: ignore[no-untyped-def]
    """The whole reason the router reads a fact rather than a model's opinion.

    A determination that is not marked deterministic can be overwritten by one
    that is not, which is exactly the thing `add_decision` exists to refuse.
    """
    result = await run_workflow(from_dict(CREDIT_UNDERWRITING), sarvam, inputs=BELOW_POLICY)

    finding = next(d for d in result.state.decisions if d.name == "policy_check")
    assert finding.value == "FAIL"
    assert finding.deterministic is True


async def test_the_two_step_seed_runs_and_returns_both_of_its_fields(sarvam) -> None:  # type: ignore[no-untyped-def]
    result = await run_workflow(
        from_dict(TWO_STEP), sarvam, inputs={"subject": "a salaried applicant"}
    )

    assert result.status == "completed", result.state.errors
    assert set(result.output) == {"assessment", "carried_forward"}
    # Every field resolved. The output node reports an expression it could not
    # read rather than dropping it, so an empty answer here would be silent.
    assert all(value is not None for value in result.output.values())
