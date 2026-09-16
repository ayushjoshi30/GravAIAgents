"""Ops & Research Agent (P2).

The productised version of the analysis this platform was designed around:
what does the pipeline cost, how much traffic does it actually generate, and
can it keep up.

Every figure is computed by ``volume_model`` from stated assumptions or from the
ledger — never produced by the language model, which writes only the summary. So
a number in this report can always be traced to an input, and changing an input
changes the number rather than the wording around it.

The report deliberately leads with request volume rather than document count,
because on the production book polling is about three quarters of all traffic and
a document count makes that invisible.
"""

from __future__ import annotations

from dataclasses import replace
from decimal import Decimal
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from ..base import Agent, AgentContext, AgentResult, AgentStep
from ..guardrails import run_all
from ..prompting import input_block
from ..schemas import AgentOutput
from ..volume_model import (
    VolumeAssumptions,
    backlog,
    build_volume_model,
    routing_scenarios,
)


class EndpointRow(BaseModel):
    model_config = ConfigDict(extra="forbid")

    endpoint: str
    label: str
    per_month: int
    per_working_day: int
    per_minute: float


class ScenarioRow(BaseModel):
    model_config = ConfigDict(extra="forbid")

    label: str
    total_calls_per_month: int
    delta_vs_baseline: int
    note: str = ""


class ThroughputRow(BaseModel):
    model_config = ConfigDict(extra="forbid")

    quota_units_per_document: int
    hours_required_per_month: float
    business_hours_available: int
    utilisation: float
    fits_in_business_hours: bool


class BacklogRow(BaseModel):
    model_config = ConfigDict(extra="forbid")

    assumption: str
    documents: int
    days_continuous: float
    business_days: float


class OpsReportOutput(AgentOutput):
    model_config = ConfigDict(extra="forbid")

    question: str
    period: str
    assumptions: dict[str, Any] = Field(default_factory=dict)
    endpoints: list[EndpointRow] = Field(default_factory=list)
    total_calls_per_month: int = 0
    poll_calls_per_month: int = 0
    poll_share: float = 0.0
    throughput: ThroughputRow | None = None
    routing_scenarios: list[ScenarioRow] = Field(default_factory=list)
    backlog_scenarios: list[BacklogRow] = Field(default_factory=list)
    observed_cost_inr: Decimal | None = None
    headline: str = ""
    open_questions: list[str] = Field(default_factory=list)


class ReportNarrative(BaseModel):
    """The model's only contribution: the summary sentence and the caveats."""

    model_config = ConfigDict(extra="forbid")

    headline: str = Field(
        description="One or two sentences stating the single most important finding"
    )
    summary: str = Field(description="Three to six sentences for an engineering leader")


class OpsResearchAgent(Agent[OpsReportOutput]):
    """Answers cost, volume and throughput questions from measured data."""

    id = "ops_research"
    name = "Ops & Research Agent"
    task = (
        "Summarise a computed API volume and throughput analysis for an engineering "
        "leader, stating the most important finding first."
    )
    output_model = OpsReportOutput
    tools = ("ledger.query",)
    agent_rules = """
8. Every figure in the input block is already computed. Quote them exactly;
   never recompute, re-derive or round differently.
9. Lead with whatever the numbers say is the binding constraint, even if it is
   not what was asked about. If throughput fails before cost does, say so first.
10. Distinguish measured figures from assumptions, and name anything that rests
   on an unverified vendor behaviour rather than presenting it as settled.
"""

    #: The production backlog, as a default subject for the drain calculation.
    DEFAULT_BACKLOG_DOCUMENTS = 2_644_052

    async def run(
        self,
        ctx: AgentContext,
        *,
        question: str = "What does the document pipeline cost and can it keep up?",
        assumptions: VolumeAssumptions | None = None,
        period: str = "current month",
        observed_cost_inr: Decimal | None = None,
        backlog_documents: int | None = None,
        **_: Any,
    ) -> AgentResult[OpsReportOutput]:
        a = assumptions or VolumeAssumptions()
        model = build_volume_model(a)

        endpoints = [
            EndpointRow(
                endpoint=e.endpoint,
                label=e.label,
                per_month=e.per_month,
                per_working_day=e.per_working_day(),
                per_minute=e.per_minute(),
            )
            for e in model.endpoints
            if e.per_month
        ]

        baseline = model.total_calls_per_month
        scenarios = [
            ScenarioRow(
                label=f"{share:.0%} digitised",
                total_calls_per_month=scenario.total_calls_per_month,
                delta_vs_baseline=scenario.total_calls_per_month - baseline,
                note=(
                    "Digitise returns text, so each digitised document also costs one "
                    "model call to read it."
                    if share
                    else "Baseline: all documents extracted."
                ),
            )
            for share, scenario in routing_scenarios(a)
        ]

        documents = backlog_documents or self.DEFAULT_BACKLOG_DOCUMENTS
        counted = backlog(documents, a, polls_count=True)
        free = backlog(documents, a, polls_count=False)
        backlogs = [
            BacklogRow(
                assumption="status polls count against the rate limit",
                documents=documents,
                days_continuous=counted.days_continuous,
                business_days=counted.business_days,
            ),
            BacklogRow(
                assumption="status polls are free",
                documents=documents,
                days_continuous=free.days_continuous,
                business_days=free.business_days,
            ),
        ]

        # A flat-poll comparison, to show what the back-off is worth.
        flat = build_volume_model(
            replace(
                a,
                digitise_share=1.0,
                poll_schedule=replace(a.poll_schedule, growth=1.0, cap=a.poll_schedule.first),
            )
        )
        all_digitise = next(s for share, s in routing_scenarios(a, (1.0,)))

        facts = input_block(
            {
                "question": question,
                "period": period,
                "documents_per_month": a.documents_per_month,
                "applications_per_month": a.applications_per_month,
                "polls_per_document": a.polls_per_document,
                "total_calls_per_month": model.total_calls_per_month,
                "poll_calls_per_month": model.poll_calls_per_month,
                "poll_share_of_all_traffic": f"{model.poll_share:.1%}",
                "rate_limit_per_minute": a.rate_limit_per_minute,
                "hours_required_per_month": model.throughput.hours_required,
                "business_hours_available": model.throughput.business_hours_available,
                "utilisation": f"{model.throughput.utilisation:.0%}",
                "fits_in_business_hours": model.throughput.fits_in_business_hours,
                "backlog_days_if_polls_count": counted.days_continuous,
                "backlog_days_if_polls_free": free.days_continuous,
                "all_digitise_with_backoff": all_digitise.total_calls_per_month,
                "all_digitise_without_backoff": flat.total_calls_per_month,
                "observed_cost_inr": str(observed_cost_inr) if observed_cost_inr else None,
                "unverified": (
                    "Whether status polls count against the rate limit is not documented. "
                    "The conservative reading is assumed."
                ),
            }
        )
        narrative, step, calls = await self.ask(
            ctx,
            "Summarise this analysis. Quote the figures exactly.\n\n" + facts,
            ReportNarrative,
            step_name="write_report",
        )

        open_questions = [
            "Do Document Intelligence status polls count against the rate limit? "
            f"The answer changes the backlog estimate from {free.days_continuous} days "
            f"to {counted.days_continuous}.",
            "Is the per-minute limit uniform across plan tiers, and is a committed-rate "
            "arrangement available at this volume?",
            "Does the digitise status endpoint tolerate back-off? The platform assumes it "
            f"does; without it, all-digitise routing costs {flat.total_calls_per_month:,} "
            f"calls a month instead of {all_digitise.total_calls_per_month:,}.",
        ]

        output = OpsReportOutput(
            question=question,
            period=period,
            assumptions={
                "applications_per_month": a.applications_per_month,
                "documents_per_month": a.documents_per_month,
                "pages_per_document": str(a.pages_per_document),
                "reasoning_calls_per_application": a.reasoning_calls_per_application,
                "job_seconds": a.job_seconds,
                "polls_per_document": a.polls_per_document,
                "rate_limit_per_minute": a.rate_limit_per_minute,
                "polls_count_toward_limit": a.polls_count_toward_limit,
            },
            endpoints=endpoints,
            total_calls_per_month=model.total_calls_per_month,
            poll_calls_per_month=model.poll_calls_per_month,
            poll_share=model.poll_share,
            throughput=ThroughputRow(
                quota_units_per_document=model.throughput.quota_units_per_document,
                hours_required_per_month=model.throughput.hours_required,
                business_hours_available=model.throughput.business_hours_available,
                utilisation=model.throughput.utilisation,
                fits_in_business_hours=model.throughput.fits_in_business_hours,
            ),
            routing_scenarios=scenarios,
            backlog_scenarios=backlogs,
            observed_cost_inr=observed_cost_inr,
            headline=narrative.headline,
            open_questions=open_questions,
            # Throughput failing is a capacity decision, not an agent's to take.
            escalate=not model.throughput.fits_in_business_hours,
            escalation_reason=(
                f"The month's document volume needs {model.throughput.hours_required} hours "
                f"against {model.throughput.business_hours_available} business hours "
                f"available; this is a capacity decision"
                if not model.throughput.fits_in_business_hours
                else None
            ),
            reasoning_summary=narrative.summary,
        )

        report = run_all(output)
        return AgentResult(
            agent_id=self.id,
            output=output,
            steps=[AgentStep(name="build_volume_model", kind="deterministic"), step],
            validation=report,
            calls=calls,
        )
