"""The document submission contract.

These pin four corrections made after the provider's API was verified against
its documentation. Each was a real defect: the code would have failed against
the live service while passing every test, because the sandbox happily accepted
whatever it was sent.

1. Submission is multipart with a file part or an upload id — never JSON with a
   document URL.
2. There is no page-range parameter; a job takes at most ten pages, so longer
   documents are split client-side.
3. The extraction schema is a serialised JSON Schema, not prose.
4. The chat model id `sarvam-m` was withdrawn.
"""

from __future__ import annotations

import io
import json

import pytest
from gravai_core.errors import DocJobFailed
from gravai_core.settings import Settings
from gravai_sarvam import (
    MAX_PAGES_PER_JOB,
    DocOptions,
    DocumentMode,
    DocumentRef,
    SarvamDocuments,
    count_pages,
    page_ranges,
    split_document,
)


def _pdf(pages: int) -> bytes:
    """A real multi-page PDF, so the splitter is exercised rather than mocked."""
    pypdf = pytest.importorskip("pypdf")
    writer = pypdf.PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(width=200, height=200)
    buffer = io.BytesIO()
    writer.write(buffer)
    return buffer.getvalue()


# --- page batching --------------------------------------------------------


def test_short_documents_are_one_job() -> None:
    assert page_ranges(1) == [(1, 1)]
    assert page_ranges(10) == [(1, 10)]


def test_a_twelve_page_statement_becomes_two_jobs() -> None:
    """The most valuable document in a lending file is over the cap."""
    assert page_ranges(12) == [(1, 10), (11, 12)]


def test_ranges_cover_every_page_exactly_once() -> None:
    for pages in (1, 9, 10, 11, 23, 197):
        ranges = page_ranges(pages)
        covered = [p for first, last in ranges for p in range(first, last + 1)]
        assert covered == list(range(1, pages + 1))


def test_page_count_is_read_from_a_real_pdf() -> None:
    assert count_pages(_pdf(12)) == 12


def test_unreadable_bytes_report_no_page_count_rather_than_guessing() -> None:
    assert count_pages(b"this is not a pdf") is None


def test_a_long_pdf_is_split_into_valid_pdfs() -> None:
    batches = split_document(_pdf(12), filename="statement.pdf")
    assert len(batches) == 2
    assert [b.pages for b in batches] == [10, 2]
    # Each batch must itself be a readable PDF, or the provider rejects it.
    assert [count_pages(b.content) for b in batches] == [10, 2]
    assert batches[0].filename.endswith("p1-10.pdf")


def test_a_short_pdf_is_left_whole() -> None:
    batches = split_document(_pdf(3), filename="pan.pdf")
    assert len(batches) == 1
    assert batches[0].is_whole_document


def test_a_non_pdf_is_passed_through_untouched() -> None:
    """Better to let the provider judge it than to corrupt it with a guess."""
    content = b"\x89PNG\r\n\x1a\n-not-really"
    batches = split_document(content, filename="photo.png")
    assert len(batches) == 1
    assert batches[0].content == content


# --- capacity arithmetic follows the page cap -----------------------------


def test_a_twelve_page_document_costs_two_jobs_worth_of_calls() -> None:
    """Capacity planning that ignores the cap understates the biggest files."""
    settings = Settings(sarvam_api_key="")
    one_page = settings.docai_calls_per_document(30.0, digitise=False, pages=1)
    twelve = settings.docai_calls_per_document(30.0, digitise=False, pages=12)
    assert one_page == 12
    assert twelve == 24


def test_quota_units_also_double_across_batches() -> None:
    settings = Settings(sarvam_api_key="")
    assert settings.docai_quota_units_per_document(30.0, digitise=False, pages=12) == 24


def test_batches_for_matches_the_cap() -> None:
    settings = Settings(sarvam_api_key="")
    assert settings.batches_for(1) == 1
    assert settings.batches_for(MAX_PAGES_PER_JOB) == 1
    assert settings.batches_for(MAX_PAGES_PER_JOB + 1) == 2
    assert settings.batches_for(197) == 20


# --- the wire contract ----------------------------------------------------


class _Recorder:
    """Captures exactly what would go on the wire."""

    def __init__(self) -> None:
        self.calls: list[dict] = []

    async def request(self, method, path, *, product, **kwargs):  # type: ignore[no-untyped-def]
        self.calls.append({"method": method, "path": path, **kwargs})

        class _Response:
            @staticmethod
            def json() -> dict:
                return {"job_id": "job-123"}

        return _Response()


def _documents() -> tuple[SarvamDocuments, _Recorder]:
    recorder = _Recorder()
    client = SarvamDocuments(
        http=recorder,  # type: ignore[arg-type]
        settings=Settings(sarvam_api_key="k"),
    )
    return client, recorder


async def test_submission_is_multipart_not_json() -> None:
    """The original defect: a JSON body with a document_url the API has no field for."""
    client, recorder = _documents()
    await client.submit(
        DocumentRef(document_id="d1", uri="blob://x", content=b"%PDF-1.4 bytes"),
        DocumentMode.EXTRACT,
    )
    sent = recorder.calls[0]
    assert "files" in sent and sent["files"] is not None
    assert sent.get("json") is None
    assert "file" in sent["files"]


async def test_the_document_uri_never_reaches_the_provider() -> None:
    """There is no URL-fetch mode; the uri is ours, for resolving bytes."""
    client, recorder = _documents()
    await client.submit(
        DocumentRef(document_id="d1", uri="blob://secret-internal-path", content=b"x"),
        DocumentMode.EXTRACT,
    )
    assert "secret-internal-path" not in json.dumps(recorder.calls[0], default=str)


async def test_an_upload_id_is_sent_instead_of_a_file() -> None:
    client, recorder = _documents()
    await client.submit(
        DocumentRef(document_id="d1", uri="blob://x"),
        DocumentMode.EXTRACT,
        upload_id="up-77",
    )
    sent = recorder.calls[0]
    assert sent["files"] is None
    assert sent["data"]["upload_ids"] == "up-77"


async def test_supplying_both_content_and_upload_id_is_refused() -> None:
    """The provider requires exactly one; sending both is a silent misuse."""
    client, _ = _documents()
    with pytest.raises(DocJobFailed, match="Exactly one"):
        await client.submit(
            DocumentRef(document_id="d1", uri="blob://x", content=b"x"),
            DocumentMode.EXTRACT,
            upload_id="up-77",
        )


async def test_supplying_neither_is_refused() -> None:
    client, _ = _documents()
    with pytest.raises(DocJobFailed, match="Exactly one"):
        await client.submit(DocumentRef(document_id="d1", uri="blob://x"), DocumentMode.EXTRACT)


async def test_extraction_schema_is_serialised_json_schema() -> None:
    """Prose in this field is rejected by the provider."""
    client, recorder = _documents()
    schema = {"type": "object", "properties": {"pan": {"type": "string"}}}
    await client.submit(
        DocumentRef(document_id="d1", uri="blob://x", content=b"x"),
        DocumentMode.EXTRACT,
        DocOptions(extraction_schema=schema, classify=True),
    )
    form = recorder.calls[0]["data"]
    assert json.loads(form["schema"]) == schema
    # Form fields are text, so a boolean goes as a lowercase string.
    assert form["classification"] == "true"


async def test_no_page_range_field_is_ever_sent() -> None:
    """There is no such parameter; splitting happens client-side instead."""
    client, recorder = _documents()
    await client.submit(
        DocumentRef(document_id="d1", uri="blob://x", content=b"x"),
        DocumentMode.EXTRACT,
        DocOptions(),
    )
    assert "page_range" not in json.dumps(recorder.calls[0], default=str)


async def test_upload_handshake_posts_the_file(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    client, recorder = _documents()

    async def _upload_response(method, path, *, product, **kwargs):  # type: ignore[no-untyped-def]
        recorder.calls.append({"method": method, "path": path, **kwargs})

        class _Response:
            @staticmethod
            def json() -> dict:
                return {"upload_id": "up-9"}

        return _Response()

    monkeypatch.setattr(recorder, "request", _upload_response)
    upload_id = await client.upload(b"bytes", "statement.pdf", "application/pdf")
    assert upload_id == "up-9"
    assert recorder.calls[0]["path"].endswith("/upload")


# --- model identifiers ----------------------------------------------------


def test_the_withdrawn_model_id_is_not_the_default() -> None:
    """`sarvam-m` was removed and now returns a hard deprecation error."""
    settings = Settings(sarvam_api_key="")
    assert settings.sarvam_model_reasoning != "sarvam-m"
    assert settings.sarvam_model_fast != "sarvam-m"


def test_both_model_roles_point_at_the_available_model() -> None:
    """There is no cheaper tier, so `fast` cannot be a cost lever here."""
    settings = Settings(sarvam_api_key="")
    assert settings.sarvam_model_reasoning == "sarvam-105b"
    assert settings.sarvam_model_fast == settings.sarvam_model_reasoning


def test_document_endpoints_are_configurable_not_hardcoded() -> None:
    """Verified against the docs, but still overridable without a code change."""
    settings = Settings(sarvam_api_key="", sarvam_docai_extract_path="/custom/extract")
    assert settings.sarvam_docai_extract_path == "/custom/extract"
    assert settings.sarvam_docai_upload_path.endswith("/upload")
