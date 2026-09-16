"""API volume, throughput and cost model.

The arithmetic behind the question "what does this actually cost, and can the
pipeline keep up". It exists as a module rather than a spreadsheet so the answer
is reproducible, testable, and recomputed from the ledger instead of retyped.

The central point it makes: **a document is not a request.** Document
Intelligence is asynchronous, so one document is a submit, N status polls and a
results fetch. Counting documents hides that polling is the large majority of
all traffic — and polling, not document count, is what meets the rate ceiling.

Calibrated against a real production book: 3,533 applications and 68,976
documents a month across 18 tenants, 24 reasoning calls per application, a ~30s
job. A test asserts this model reproduces that study's published totals.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal

from gravai_core.settings import PollSchedule

#: Working days and hours used for "per working day" and business-hours capacity.
WORKING_DAYS_PER_MONTH = 22
WORKING_HOURS_PER_DAY = 8


@dataclass(frozen=True, slots=True)
class VolumeAssumptions:
    """Everything the model needs. Every figure is an input, none are buried."""

    applications_per_month: int = 3_533
    documents_per_month: int = 68_976
    pages_per_document: Decimal = Decimal("3.0")
    #: Reasoning calls per application. Fixed: it does not scale with documents.
    reasoning_calls_per_application: int = 24
    stt_calls_per_application: int = 1
    translate_calls_per_application: int = 1
    #: Share of documents routed to digitise rather than extract, 0.0 to 1.0.
    digitise_share: float = 0.0
    #: How long a document takes on the provider's side; sets the poll count.
    job_seconds: float = 30.0
    #: Requests per minute the provider allows for Document Intelligence.
    rate_limit_per_minute: int = 10
    #: Whether status polls consume the rate limit. Unverified with the vendor.
    polls_count_toward_limit: bool = True
    poll_schedule: PollSchedule = field(
        default_factory=lambda: PollSchedule(first=0.8, growth=1.35, cap=5.0, max_wall_clock=180.0)
    )

    @property
    def polls_per_document(self) -> int:
        return self.poll_schedule.expected_polls(self.job_seconds)

    @property
    def extract_documents(self) -> int:
        return round(self.documents_per_month * (1.0 - self.digitise_share))

    @property
    def digitise_documents(self) -> int:
        return self.documents_per_month - self.extract_documents


@dataclass(frozen=True, slots=True)
class EndpointVolume:
    """One endpoint's load."""

    endpoint: str
    label: str
    per_month: int

    def per_working_day(self) -> int:
        return round(self.per_month / WORKING_DAYS_PER_MONTH)

    def per_minute(self) -> float:
        minutes = WORKING_DAYS_PER_MONTH * WORKING_HOURS_PER_DAY * 60
        return round(self.per_month / minutes, 2)


@dataclass(frozen=True, slots=True)
class ThroughputView:
    """Whether the month's work fits inside the ceiling."""

    quota_units_per_document: int
    documents_per_month: int
    total_quota_units: int
    rate_limit_per_minute: int
    minutes_required: float
    hours_required: float
    business_hours_available: int
    utilisation: float
    fits_in_business_hours: bool


@dataclass(frozen=True, slots=True)
class BacklogView:
    documents: int
    quota_units_per_document: int
    days_continuous: float
    business_days: float


@dataclass(frozen=True, slots=True)
class VolumeModel:
    """The full picture."""

    assumptions: VolumeAssumptions
    endpoints: list[EndpointVolume]
    total_calls_per_month: int
    poll_calls_per_month: int
    throughput: ThroughputView

    @property
    def poll_share(self) -> float:
        """Polls as a share of all traffic.

        On the production book this is about three quarters — which is the whole
        argument for measuring requests rather than documents.
        """
        if not self.total_calls_per_month:
            return 0.0
        return round(self.poll_calls_per_month / self.total_calls_per_month, 4)

    def endpoint(self, name: str) -> EndpointVolume:
        for item in self.endpoints:
            if item.endpoint == name:
                return item
        raise KeyError(name)


def build_volume_model(assumptions: VolumeAssumptions | None = None) -> VolumeModel:
    """Compute monthly call volume and throughput from assumptions."""
    a = assumptions or VolumeAssumptions()
    polls = a.polls_per_document

    extract_docs = a.extract_documents
    digitise_docs = a.digitise_documents

    # Both paths: one submit, N polls, one results fetch. Digitise additionally
    # needs a model call to read the text it returns.
    submits = extract_docs + digitise_docs
    poll_calls = submits * polls
    results = submits
    digitise_reads = digitise_docs

    reasoning = a.applications_per_month * a.reasoning_calls_per_application
    stt = a.applications_per_month * a.stt_calls_per_application
    translate = a.applications_per_month * a.translate_calls_per_application

    endpoints = [
        EndpointVolume("docai.extract", "Document extraction (submit)", extract_docs),
        EndpointVolume("docai.digitise", "Document digitisation (submit)", digitise_docs),
        EndpointVolume("docai.status", "Document job status (polling)", poll_calls),
        EndpointVolume("docai.results", "Document job results", results),
        EndpointVolume(
            "chat.completions",
            "Model reasoning",
            reasoning + digitise_reads,
        ),
        EndpointVolume("speech.stt", "Speech to text", stt),
        EndpointVolume("speech.translate", "Translation", translate),
    ]
    total = sum(e.per_month for e in endpoints)

    # Only Document Intelligence draws on the 10/min bucket.
    units_per_document = (1 + polls + 1) if a.polls_count_toward_limit else 1
    total_units = a.documents_per_month * units_per_document
    minutes = total_units / a.rate_limit_per_minute if a.rate_limit_per_minute else 0.0
    hours = minutes / 60
    available = WORKING_DAYS_PER_MONTH * WORKING_HOURS_PER_DAY

    throughput = ThroughputView(
        quota_units_per_document=units_per_document,
        documents_per_month=a.documents_per_month,
        total_quota_units=total_units,
        rate_limit_per_minute=a.rate_limit_per_minute,
        minutes_required=round(minutes, 1),
        hours_required=round(hours, 1),
        business_hours_available=available,
        utilisation=round(hours / available, 4) if available else 0.0,
        fits_in_business_hours=hours <= available,
    )

    return VolumeModel(
        assumptions=a,
        endpoints=endpoints,
        total_calls_per_month=total,
        poll_calls_per_month=poll_calls,
        throughput=throughput,
    )


def backlog(
    documents: int,
    assumptions: VolumeAssumptions | None = None,
    *,
    polls_count: bool | None = None,
) -> BacklogView:
    """How long a backlog takes to clear against the ceiling."""
    a = assumptions or VolumeAssumptions()
    counts = a.polls_count_toward_limit if polls_count is None else polls_count
    units = (1 + a.polls_per_document + 1) if counts else 1
    hours = (documents * units / a.rate_limit_per_minute) / 60
    return BacklogView(
        documents=documents,
        quota_units_per_document=units,
        days_continuous=round(hours / 24, 1),
        business_days=round(hours / WORKING_HOURS_PER_DAY, 1),
    )


def routing_scenarios(
    assumptions: VolumeAssumptions | None = None,
    shares: tuple[float, ...] = (0.0, 0.6, 1.0),
) -> list[tuple[float, VolumeModel]]:
    """The same book at different extract/digitise mixes.

    Answers the question a per-page price invites — "digitisation is half the
    price, should we route everything to it?" — by showing what it does to
    request volume, which is the dimension that is actually constrained.
    """
    from dataclasses import replace

    base = assumptions or VolumeAssumptions()
    return [(share, build_volume_model(replace(base, digitise_share=share))) for share in shares]
