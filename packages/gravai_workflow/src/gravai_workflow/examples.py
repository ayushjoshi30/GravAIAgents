"""Two workflows to start from.

These are **seeds, not fixtures**. Nothing in the engine depends on their
contents being any particular thing: they exist so that "new agent" need not
mean "blank page". Copy one, change it, delete the parts you do not want.

Worth knowing before you go looking for them in the product: nothing serves them
yet. No endpoint under `/v1/studio` offers a seed and the console has no control
that asks for one, so today they are reached by importing them — from this
module, or from the package. That is a missing endpoint rather than a missing
seed, and it is the reason `tests/test_workflow_examples.py` runs them itself:
until something serves them, the test suite is the only thing that would notice
a seed that had stopped working.

`CREDIT_UNDERWRITING` is the full shape — read the documents, compile what
matters, score the risk, apply policy, then either write the memorandum or
raise a review task. `TWO_STEP` is the smallest thing that is still a workflow
rather than a single call, and is the one to reach for when demonstrating the
mechanism rather than the domain.

Both are plain dictionaries in the shape `graph.from_dict` accepts, so they
travel over the API, save into the database and load onto the canvas without a
conversion step. Giving them a Python type of their own would mean the format
the studio speaks and the format this module speaks could drift apart.
"""

from __future__ import annotations

from typing import Any

# Node positions are laid out by hand rather than by an auto-layout pass: the
# canvas preserves whatever coordinates it is given, so a seed that opens
# already legible is worth more than one that arrives as a pile at the origin.
# The mainline runs left to right a column at a time; the branch that needs a
# person drops one row below it.
_COLUMN = 320.0
_ROW = 180.0


def _x(column: int) -> float:
    return column * _COLUMN


CREDIT_UNDERWRITING: dict[str, Any] = {
    "name": "Credit underwriting",
    "description": (
        "Reads the application's documents, establishes what the file actually "
        "says, scores it, applies policy, and then either writes the appraisal "
        "memorandum or hands the case to a person."
    ),
    "nodes": [
        {
            "id": "intake",
            "type": "input",
            "name": "Application intake",
            # The schema is what the deployed agent will accept as arguments. It
            # names the underwriting figures rather than only an identifier
            # because every one of them is also a policy input below, and a
            # field that reaches the rule engine should be visible at the door.
            "config": {
                "schema": {
                    "application_id": "string",
                    "loan_amount": "number",
                    "tenure_months": "number",
                    "interest_rate_pct": "number",
                    "net_monthly_income": "number",
                    "existing_monthly_emi": "number",
                    "bureau_score": "number",
                    "enquiries_3m": "number",
                    "employment_vintage_months": "number",
                }
            },
            "position": {"x": _x(0), "y": 0.0},
        },
        {
            "id": "documents",
            "type": "agent.doc_intelligence",
            "name": "Read the file",
            # Nothing is overridden: this agent takes the application's own
            # documents, and the point of the node is to find out what they say.
            # `publish_facts` promotes two of its outputs into the shared facts
            # so that later nodes can read them by name instead of reaching back
            # into this node's raw output, which would couple them to its id.
            "config": {
                "overrides": {},
                "publish_facts": "total_pages,unknown_type_ratio",
            },
            "position": {"x": _x(1), "y": 0.0},
        },
        {
            "id": "compile_context",
            "type": "context_compiler",
            "name": "What matters so far",
            "config": {
                "keep_facts": (
                    "loan_amount,tenure_months,interest_rate_pct,net_monthly_income,"
                    "existing_monthly_emi,bureau_score,enquiries_3m,"
                    "employment_vintage_months,total_pages,unknown_type_ratio"
                ),
                # Left off deliberately, and this is the interesting setting on
                # the node. Selecting named facts, counting them and carrying
                # them forward is ordinary data work that code does exactly and
                # instantly; putting a language model between every pair of
                # nodes is the usual way a workflow becomes slow and expensive
                # without becoming better. Turn it on where a stage genuinely
                # needs prose compressed, not as a matter of course.
                "use_model": False,
                "recommended_next_action": "Score the applicant, then apply policy.",
            },
            "position": {"x": _x(2), "y": 0.0},
        },
        {
            "id": "risk",
            "type": "agent.risk_scoring",
            "name": "Score the risk",
            # No overrides: the agent declares its own input fields, and the
            # executor fills any it has not been given from the shared facts.
            # That is what makes the figures the intake accepted the same
            # figures the scorecard reads, rather than each stage starting from
            # its own defaults.
            "config": {
                "overrides": {},
                "publish_facts": "band,probability_30dpd_6m,model_version",
            },
            "position": {"x": _x(3), "y": 0.0},
        },
        {
            "id": "policy",
            "type": "bre",
            "name": "Apply policy",
            "config": {
                "decision_name": "policy_check",
                # Every value is read out of the shared facts rather than typed
                # in here. A threshold belongs to the policy pack; a figure
                # belongs to the application. Writing a figure into the node
                # would mean the canvas quietly disagreeing with the file.
                "input_mapping": {
                    "application_id": "{{workflow.facts.application_id}}",
                    "loan_amount": "{{workflow.facts.loan_amount}}",
                    "tenure_months": "{{workflow.facts.tenure_months}}",
                    "interest_rate_pct": "{{workflow.facts.interest_rate_pct}}",
                    "net_monthly_income": "{{workflow.facts.net_monthly_income}}",
                    "existing_monthly_emi": "{{workflow.facts.existing_monthly_emi}}",
                    "bureau_score": "{{workflow.facts.bureau_score}}",
                    "enquiries_3m": "{{workflow.facts.enquiries_3m}}",
                    "employment_vintage_months": "{{workflow.facts.employment_vintage_months}}",
                },
            },
            "position": {"x": _x(4), "y": 0.0},
        },
        {
            "id": "route",
            "type": "router",
            "name": "Policy outcome",
            "config": {
                "branches": [
                    # The router reads the fact the rule engine wrote, not the
                    # risk band. A model's opinion of the applicant does not get
                    # to decide whether policy was met; that is the whole reason
                    # the rule engine runs first and records a deterministic
                    # decision.
                    {
                        "label": "pass",
                        "condition": 'workflow.facts.policy_check == "PASS"',
                    },
                    # The last branch is an unconditional fallback. Without one,
                    # a file matching none of the conditions simply stops at the
                    # router, and "the run ended and nobody was told" is the
                    # worst outcome a lending workflow can have.
                    {"label": "fail", "condition": "true"},
                ]
            },
            "position": {"x": _x(5), "y": 0.0},
        },
        {
            "id": "appraisal",
            "type": "agent.credit_appraisal",
            "name": "Write the memorandum",
            "config": {
                "overrides": {},
                "publish_facts": "recommendation",
            },
            "position": {"x": _x(6), "y": 0.0},
        },
        {
            "id": "answer",
            "type": "output",
            "name": "Decision",
            # Each value is an expression over the state, so the answer is
            # assembled from what the workflow established rather than from
            # whichever node happened to run last.
            "config": {
                "mapping": {
                    "policy_check": "{{workflow.facts.policy_check}}",
                    "risk_band": "{{workflow.facts.band}}",
                    "probability_30dpd_6m": "{{workflow.facts.probability_30dpd_6m}}",
                    "recommendation": "{{nodes.appraisal.recommendation}}",
                    "applicant_explanation": "{{nodes.appraisal.applicant_explanation}}",
                    "trail": "{{workflow.summaries}}",
                }
            },
            "position": {"x": _x(7), "y": 0.0},
        },
        {
            "id": "review",
            "type": "human_approval",
            "name": "Send to credit ops",
            "config": {
                "reason": (
                    "Policy was not met, so a credit officer decides this one. "
                    "The rule engine's finding is recorded and stands."
                ),
                "assign_to": "credit_ops",
            },
            # One row below the mainline, so the two outcomes of the router are
            # visibly two outcomes rather than a continuation.
            "position": {"x": _x(6), "y": _ROW},
        },
    ],
    "edges": [
        {"source": "intake", "target": "documents"},
        {"source": "documents", "target": "compile_context"},
        {"source": "compile_context", "target": "risk"},
        {"source": "risk", "target": "policy"},
        {"source": "policy", "target": "route"},
        # A branching node's edges must name the branch they follow, or the
        # engine has no way to prune the path that was not taken.
        {"source": "route", "target": "appraisal", "branch": "pass"},
        {"source": "route", "target": "review", "branch": "fail"},
        {"source": "appraisal", "target": "answer"},
    ],
}


TWO_STEP: dict[str, Any] = {
    "name": "Two-step assessment",
    "description": (
        "The minimum that is still a workflow: reason, decide what carries "
        "forward, reason again. Useful for seeing the mechanism without a "
        "domain on top of it."
    ),
    "nodes": [
        {
            "id": "intake",
            "type": "input",
            "name": "Input",
            "config": {"schema": {"subject": "string"}},
            "position": {"x": _x(0), "y": 0.0},
        },
        {
            "id": "first_pass",
            "type": "llm",
            "name": "First pass",
            "config": {
                "system_prompt": (
                    "You assess material for a credit officer. State only what the material says."
                ),
                "prompt": "Assess what is known so far:\n\n{{workflow.facts}}",
                "output_schema": {},
                "temperature": 0.2,
                "max_tokens": 400,
            },
            "position": {"x": _x(1), "y": 0.0},
        },
        {
            "id": "compile_context",
            "type": "context_compiler",
            "name": "Carry forward",
            # Empty `keep_facts` carries every fact. In a two-node workflow that
            # is the honest setting: there is nothing yet worth dropping, and
            # naming facts that do not exist would only produce warnings.
            "config": {
                "keep_facts": "",
                "use_model": False,
                "recommended_next_action": "Turn the first pass into a recommendation.",
            },
            "position": {"x": _x(2), "y": 0.0},
        },
        {
            "id": "second_pass",
            "type": "llm",
            "name": "Second pass",
            "config": {
                "system_prompt": "You write the final note. Be brief and specific.",
                # Reads the compiler's own output by node id rather than the raw
                # state, which is the point of having put a compiler here at all.
                "prompt": (
                    "What the first pass found:\n\n{{nodes.first_pass.text}}\n\n"
                    "What carries forward:\n\n{{nodes.compile_context.summary}}\n\n"
                    "Write the recommendation."
                ),
                "output_schema": {},
                "temperature": 0.2,
                "max_tokens": 400,
            },
            "position": {"x": _x(3), "y": 0.0},
        },
        {
            "id": "answer",
            "type": "output",
            "name": "Output",
            "config": {
                "mapping": {
                    "assessment": "{{nodes.second_pass.text}}",
                    "carried_forward": "{{nodes.compile_context.summary}}",
                }
            },
            "position": {"x": _x(4), "y": 0.0},
        },
    ],
    "edges": [
        {"source": "intake", "target": "first_pass"},
        {"source": "first_pass", "target": "compile_context"},
        {"source": "compile_context", "target": "second_pass"},
        {"source": "second_pass", "target": "answer"},
    ],
}


#: Every seed, by the key the API offers it under.
EXAMPLES: dict[str, dict[str, Any]] = {
    "credit_underwriting": CREDIT_UNDERWRITING,
    "two_step": TWO_STEP,
}
