"""Document Intelligence runner.

These pin the platform's two most consequential numbers: a document costs twelve
API calls on the extract path, and thirteen on the digitise path because the text
still has to be read. If either changes, the capacity plan changes with it.
"""

from __future__ import annotations

import pytest
from gravai_core.errors import DocJobFailed, DocJobTimeout
from gravai_core.settings import Settings
from gravai_sarvam import (
    DocumentMode,
    DocumentReader,
    DocumentRef,
    DocumentRunner,
    FakeSarvamChat,
    FakeSarvamDocuments,
    RateGovernor,
)


async def _nosleep(_: float) -> None:
    """Skip the wait; the poll *count* is what these tests are about."""
    return None


def _settings(**overrides: object) -> Settings:
    return Settings(sarvam_api_key="", **overrides)  # type: ignore[arg-type]


def _runner(
    documents: FakeSarvamDocuments,
    *,
    settings: Settings | None = None,
    with_reader: bool = True,
) -> tuple[DocumentRunner, RateGovernor]:
    governor = RateGovernor(limits={"docai": 1_000_000.0})
    reader = DocumentReader(FakeSarvamChat()) if with_reader else None
    runner = DocumentRunner(
        documents,
        governor,
        settings=settings or _settings(),
        reader=reader,
        sleep=_nosleep,
        seed=7,
    )
    return runner, governor


def _ref(document_id: str = "doc-1", doc_type: str | None = None) -> DocumentRef:
    return DocumentRef(
        document_id=document_id,
        uri=f"sandbox://{document_id}",
        pages=3,
        doc_type=doc_type,
    )


async def test_extract_costs_twelve_calls() -> None:
    """1 submit + 10 polls + 1 results."""
    documents = FakeSarvamDocuments(polls_before_done=10)
    runner, _ = _runner(documents)
    result = await runner.run(_ref(), mode=DocumentMode.EXTRACT, tenant_id="acme")

    assert result.calls.submit == 1
    assert result.calls.polls == 10
    assert result.calls.results == 1
    assert result.calls.llm_reads == 0
    assert result.calls.total == 12


async def test_digitise_costs_thirteen_because_the_text_must_be_read() -> None:
    """The extra call is the whole difference between the two paths."""
    documents = FakeSarvamDocuments(polls_before_done=10)
    runner, _ = _runner(documents)
    result = await runner.run(_ref(), mode=DocumentMode.DIGITISE, tenant_id="acme")

    assert result.calls.llm_reads == 1
    assert result.calls.total == 13
    assert result.text, "digitise must return text"


async def test_digitise_without_a_reader_returns_text_but_no_fields() -> None:
    """Honest degradation: no reader means no fields, not invented ones."""
    documents = FakeSarvamDocuments(polls_before_done=4)
    runner, _ = _runner(documents, with_reader=False)
    result = await runner.run(_ref(), mode=DocumentMode.DIGITISE, tenant_id="acme")

    assert result.text
    assert result.fields == {}
    assert result.calls.llm_reads == 0


async def test_both_paths_draw_on_the_same_quota() -> None:
    """Routing to digitise buys no throughput relief."""
    documents = FakeSarvamDocuments(polls_before_done=3)
    governor = RateGovernor(limits={"docai": 1_000_000.0})
    runner = DocumentRunner(documents, governor, settings=_settings(), reader=None, sleep=_nosleep)
    before = governor.stats("docai").served
    await runner.run(_ref("a"), mode=DocumentMode.EXTRACT, tenant_id="acme")
    after_extract = governor.stats("docai").served
    await runner.run(_ref("b"), mode=DocumentMode.DIGITISE, tenant_id="acme")
    after_digitise = governor.stats("docai").served

    extract_units = after_extract - before
    digitise_units = after_digitise - after_extract
    # 1 submit + 3 polls + 1 results, on both paths.
    assert extract_units == digitise_units == 5


async def test_polls_consume_quota_by_default() -> None:
    """The conservative default: submit + polls + results all count."""
    documents = FakeSarvamDocuments(polls_before_done=5)
    governor = RateGovernor(limits={"docai": 1_000_000.0})
    runner = DocumentRunner(
        documents,
        governor,
        settings=_settings(sarvam_docai_polls_count_toward_limit=True),
        reader=None,
        sleep=_nosleep,
    )
    before = governor.stats("docai").served
    await runner.run(_ref(), mode=DocumentMode.EXTRACT, tenant_id="acme")
    # submit + 5 polls + results
    assert governor.stats("docai").served - before == 7


async def test_only_the_submit_counts_if_polls_are_free() -> None:
    """If Sarvam confirms polls are free, throughput rises roughly sevenfold here."""
    documents = FakeSarvamDocuments(polls_before_done=5)
    governor = RateGovernor(limits={"docai": 1_000_000.0})
    runner = DocumentRunner(
        documents,
        governor,
        settings=_settings(sarvam_docai_polls_count_toward_limit=False),
        reader=None,
        sleep=_nosleep,
    )
    before = governor.stats("docai").served
    await runner.run(_ref(), mode=DocumentMode.EXTRACT, tenant_id="acme")
    # Only the submit draws on the bucket: a sevenfold throughput difference.
    assert governor.stats("docai").served - before == 1


async def test_a_failed_job_raises_rather_than_returning_empty_fields() -> None:
    documents = FakeSarvamDocuments(polls_before_done=10, fail_documents=frozenset({"bad"}))
    runner, _ = _runner(documents)
    with pytest.raises(DocJobFailed):
        await runner.run(_ref("bad"), mode=DocumentMode.EXTRACT, tenant_id="acme")


async def test_a_job_that_never_finishes_times_out() -> None:
    """A stuck job must surface, not hang a workflow forever."""
    documents = FakeSarvamDocuments(polls_before_done=10_000)
    runner, _ = _runner(documents, settings=_settings(sarvam_docai_poll_max_wall_clock=20.0))
    with pytest.raises(DocJobTimeout):
        await runner.run(_ref(), mode=DocumentMode.EXTRACT, tenant_id="acme")


async def test_heartbeat_is_called_for_each_poll() -> None:
    """Long polls must heartbeat or Temporal will consider the activity dead."""
    beats: list[str] = []
    documents = FakeSarvamDocuments(polls_before_done=4)
    runner, _ = _runner(documents, with_reader=False)
    await runner.run(
        _ref(),
        mode=DocumentMode.EXTRACT,
        tenant_id="acme",
        heartbeat=beats.append,
    )
    assert len(beats) == 5  # one submit + four polls
