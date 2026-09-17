"""Running an agent on a document the tenant uploaded.

`POST /v1/documents` scanned a file, stored it and returned an id, and nothing
could use that id: there was no table for it to name, so the only durable trace
of an upload was an audit entry — a record of what happened rather than
somewhere to look one up. These tests cover the path that closes that gap: a
`Document` row written as part of accepting the file, and `document_ids` on a
run that resolves those rows and hands the bytes to the runner.

The property most of this file defends is one sentence: **a document id is a
bearer of nothing.** Holding one says nothing whatever about being allowed to
read what it names, so every path that resolves one filters on the caller's
tenant, and an id belonging to someone else has to be indistinguishable from an
id belonging to nobody. One lender reading another's bureau report is worse than
any outage this platform can have — it is a breach the lender has to report — so
the assertions below are rarely about a status code alone. They check the body,
they check the blob store was never read, and they check the agent never ran.
"""

from __future__ import annotations

import importlib.util
import io
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from gravai_api.deps import get_config
from gravai_api.main import app
from gravai_api.routers import agents as agents_router
from gravai_api.routers.documents import get_blob_store, get_scanner
from gravai_core.auth import Role, issue_dev_token
from gravai_core.blobstore import BlobStoreError, StoredBlob, parse_uri
from gravai_core.models import Base, Document
from gravai_core.settings import get_settings
from gravai_core.virusscan import ScanResult
from httpx import ASGITransport, AsyncClient
from pypdf import PdfWriter
from sqlalchemy import create_engine, inspect, select, text
from sqlalchemy.exc import IntegrityError

TENANT_A = uuid4()
TENANT_B = uuid4()

#: The standard anti-malware test string, so the scanner below has something
#: real to look for rather than being a stub that says "clean" without reading.
EICAR = rb"X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"

REPO_ROOT = Path(__file__).resolve().parents[1]

#: The agent most of these runs execute. Which one it is barely matters: what is
#: under test is what the router resolved and handed the runner, and this one
#: assembles its inputs in milliseconds. The document agent is used where the
#: point is the whole path end to end, and it spends half a minute polling a
#: simulated extraction job — a price worth paying once rather than twenty times.
CHEAP_AGENT = "kyc_verification"
DOCUMENT_AGENT = "doc_intelligence"


def _pdf(pages: int = 1) -> bytes:
    """A real, parseable PDF, so a reported page count is a read fact."""
    writer = PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(width=200, height=200)
    buffer = io.BytesIO()
    writer.write(buffer)
    return buffer.getvalue()


def _auth(tenant_id: UUID = TENANT_A) -> dict[str, str]:
    """An underwriter, who holds both documents:write and agents:run."""
    token = issue_dev_token(
        tenant_id=tenant_id,
        subject="test:console",
        roles=[Role.UNDERWRITER],
    )
    return {"Authorization": f"Bearer {token}"}


class MemoryBlobStore:
    """A bucket that lives in the test process, and remembers what was read.

    Defined here rather than shared with `test_document_upload` because this
    file needs something that file does not: a record of every reference the API
    tried to resolve. That list is how a test can assert the platform never even
    went looking for another tenant's object, which is a stronger claim than the
    404 on its own.

    `resolve` raises `BlobStoreError` for a key it does not hold, which is what
    `S3BlobStore` does when the store answers 404 — a fake that raised KeyError
    would turn a clean 502 into an accidental 500 and prove nothing.
    """

    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}
        self.reads: list[str] = []

    async def put(self, content: bytes, *, content_type: str, prefix: str = "") -> StoredBlob:
        import hashlib
        import secrets

        key = f"{prefix.strip('/')}/{secrets.token_urlsafe(16)}"
        self.objects[key] = content
        return StoredBlob(
            uri=f"blob://test-bucket/{key}",
            key=key,
            size_bytes=len(content),
            content_type=content_type,
            sha256=hashlib.sha256(content).hexdigest(),
        )

    async def resolve(self, uri: str) -> bytes:
        self.reads.append(uri)
        _, key = parse_uri(uri)
        if key not in self.objects:
            raise BlobStoreError(
                "The object store could not return this object", bucket="test-bucket", status=404
            )
        return self.objects[key]


class RefusingBlobStore(MemoryBlobStore):
    """A store that will not accept a write. Nothing may be recorded as stored."""

    async def put(self, content: bytes, *, content_type: str, prefix: str = "") -> StoredBlob:
        raise BlobStoreError("The object store refused the write", bucket="test-bucket", status=503)


class LookingScanner:
    """A fake scanner that actually reads what it is given."""

    name = "fake-clamav 1.0.0/27000/test"

    async def scan(self, content: bytes) -> ScanResult:
        if EICAR in content:
            return ScanResult(clean=False, scanner=self.name, signature="Eicar-Test-Signature")
        return ScanResult(clean=True, scanner=self.name)


@pytest.fixture
def store() -> MemoryBlobStore:
    return MemoryBlobStore()


@pytest.fixture
async def client(_schema: None, make_tenant, db_session, store):  # type: ignore[no-untyped-def]
    """Both tenants exist; the API answers for whichever token is presented."""
    for tenant in (TENANT_A, TENANT_B):
        try:
            await make_tenant(tenant, slug=f"rwd-{tenant.hex[:8]}")
        except IntegrityError:
            # The two tenants are module-level so that uploads accumulate
            # somewhere real, which means every test after the first finds them
            # already inserted. The rollback matters: without it the session
            # stays refusing work and the second insert fails for a reason that
            # has nothing to do with the test.
            await db_session.rollback()

    app.dependency_overrides[get_blob_store] = lambda: store
    app.dependency_overrides[get_scanner] = lambda: LookingScanner()
    app.dependency_overrides[get_config] = get_settings

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as http:
        yield http

    for dependency in (get_blob_store, get_scanner, get_config):
        app.dependency_overrides.pop(dependency, None)


@pytest.fixture
def runs(monkeypatch) -> list[Any]:  # type: ignore[no-untyped-def]
    """Every `source` the router handed the runner, in order.

    The real runner still executes — these tests assert on real 201s — but what
    reached it is captured on the way past. It is the only way to see what the
    run was actually given rather than what the response says about it.
    """
    seen: list[Any] = []
    real = agents_router.run_agent

    async def _recording(agent_id: str, sarvam: Any, **kwargs: Any) -> Any:
        seen.append(kwargs.get("source"))
        return await real(agent_id, sarvam, **kwargs)

    monkeypatch.setattr(agents_router, "run_agent", _recording)
    return seen


async def _upload(
    client: AsyncClient,
    content: bytes | None = None,
    *,
    headers: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Upload one document and return the accepted body."""
    payload = content if content is not None else _pdf(pages=3)
    response = await client.post(
        "/v1/documents",
        headers=headers or _auth(),
        files={"file": ("bureau-report.pdf", payload, "application/pdf")},
    )
    assert response.status_code == 201, response.text
    return response.json()


# --- The upload writes the row --------------------------------------------


async def test_an_accepted_upload_writes_the_row_the_id_resolves_to(  # type: ignore[no-untyped-def]
    client, db_session, store
) -> None:
    """The id the endpoint returns now names something durable.

    Every field on the row is checked against what the response and the store
    say, because a row that merely exists is not the point — a row that agrees
    with the object it names is.
    """
    body = await _upload(client)

    row = (
        await db_session.execute(select(Document).where(Document.id == UUID(body["document_id"])))
    ).scalar_one()

    assert row.tenant_id == TENANT_A
    assert row.uri == body["uri"]
    assert row.filename == "bureau-report.pdf"
    assert row.mime_type == "application/pdf"
    assert row.pages == 3
    assert row.size_bytes == len(store.objects[parse_uri(body["uri"])[1]])
    assert row.stored_at is not None


async def test_the_row_records_the_digest_of_the_stored_bytes(client, db_session, store) -> None:  # type: ignore[no-untyped-def]
    """A row that did not carry the digest could not be checked against the bytes."""
    import hashlib

    content = _pdf(pages=2)
    body = await _upload(client, content)

    row = (
        await db_session.execute(select(Document).where(Document.id == UUID(body["document_id"])))
    ).scalar_one()
    assert row.sha256 == hashlib.sha256(content).hexdigest()
    assert store.objects[parse_uri(row.uri)[1]] == content


async def test_nothing_is_recorded_when_the_store_refuses_the_write(  # type: ignore[no-untyped-def]
    client, db_session, make_tenant
) -> None:
    """The order of the two writes, asserted rather than assumed.

    A row written before the object would be a claim that a document exists made
    before any bytes had landed anywhere. This is that claim not being made.

    A tenant of its own, so "no row" means no row rather than "no more rows than
    the other tests in this file happened to leave behind".
    """
    lonely = uuid4()
    await make_tenant(lonely, slug=f"rwd-none-{lonely.hex[:8]}")
    app.dependency_overrides[get_blob_store] = lambda: RefusingBlobStore()

    response = await client.post(
        "/v1/documents",
        headers=_auth(lonely),
        files={"file": ("bureau-report.pdf", _pdf(), "application/pdf")},
    )
    assert response.status_code == 502, response.text

    # The session read the tenant row before the request; ending its transaction
    # is what makes the read below see anything the API committed since.
    await db_session.rollback()
    rows = (
        (await db_session.execute(select(Document).where(Document.tenant_id == lonely)))
        .scalars()
        .all()
    )
    assert rows == []


async def test_the_object_key_is_under_the_uploading_tenants_prefix(client, store) -> None:  # type: ignore[no-untyped-def]
    """Defence in depth, and only that — the check that matters is in the query."""
    body = await _upload(client)
    assert parse_uri(body["uri"])[1].startswith(f"documents/{TENANT_A}/")


async def test_a_document_cannot_be_filed_under_another_tenants_application(  # type: ignore[no-untyped-def]
    client, db_session, store
) -> None:
    """The other id a caller supplies, checked against the caller's tenant too.

    `application_id` is the one field on the upload that names an existing row,
    so it is the one field that could otherwise tie this tenant's document to
    somebody else's case — and a row carrying another tenant's application id is
    a link between two lenders that nobody asked for. Written against a real
    application belonging to TENANT_B rather than an invented uuid, because an
    id that exists is what a filter applied after the fetch would let through.
    """
    created = await client.post(
        "/v1/applications",
        headers=_auth(TENANT_B),
        json={
            "external_id": f"APP-{uuid4().hex[:8]}",
            "product": "personal_loan",
            "applicant_name": "Ayush Joshi",
        },
    )
    assert created.status_code == 201, created.text
    theirs = created.json()["id"]
    store.objects.clear()

    response = await client.post(
        "/v1/documents",
        headers=_auth(TENANT_A),
        files={"file": ("bureau-report.pdf", _pdf(), "application/pdf")},
        data={"application_id": theirs},
    )

    assert response.status_code == 404, response.text
    # Refused before the scan and before the write, so there is no object and no
    # row to go looking for afterwards.
    assert store.objects == {}
    await db_session.rollback()
    rows = (
        (await db_session.execute(select(Document).where(Document.application_id == UUID(theirs))))
        .scalars()
        .all()
    )
    assert rows == []


# --- The run resolves it ---------------------------------------------------


async def test_an_uploaded_document_is_read_and_handed_to_the_run(client, runs) -> None:  # type: ignore[no-untyped-def]
    """The whole point: the id names bytes, and the run gets them.

    The claim is precise, because the honest one always is. The platform
    resolved the id against the caller's tenant, read the object out of storage,
    and handed the document to the runner inside `source` — the same place the
    data-source connector puts the documents it fetches, so nothing downstream of
    the connector had to change. Whether a given agent then opens it is the
    runner's business; the test below this one says what it does today.
    """
    content = _pdf(pages=3)
    uploaded = await _upload(client, content)

    response = await client.post(
        f"/v1/agents/{DOCUMENT_AGENT}/run",
        headers=_auth(),
        json={"document_ids": [uploaded["document_id"]]},
    )
    assert response.status_code == 201, response.text

    assert len(runs) == 1
    source = runs[0]
    assert source is not None
    assert len(source.documents) == 1

    document = source.documents[0]
    assert document.document_id == uploaded["document_id"]
    assert document.content == content
    assert document.mime_type == "application/pdf"
    assert document.filename == "bureau-report.pdf"
    assert document.pages == 3


async def test_the_document_agent_reads_the_uploaded_file_not_the_fixtures(client) -> None:  # type: ignore[no-untyped-def]
    """The whole point of the upload path: the agent assesses YOUR document.

    This replaces a test that pinned the opposite. `SandboxFixtures.documents()`
    used to ask the LOS connector for an application's documents and never look
    at `source.documents`, so an uploaded file was resolved, tenant-checked,
    merged into the source, counted in the report — and then ignored in favour
    of a demo applicant's fixtures. The run succeeded and described somebody
    else's paperwork, which is worse than failing: the output looks like an
    answer about the file you sent.

    Two things had to change for this to pass, and both are asserted here
    because either one regressing alone would bring the silent version back.
    The runner now prefers supplied documents over fixtures, and
    `GravitonDocument` carries `content` so the bytes survive the hop to the
    provider client — which refuses a reference having neither content nor an
    upload id.
    """
    uploaded = await _upload(client)

    response = await client.post(
        f"/v1/agents/{DOCUMENT_AGENT}/run",
        headers=_auth(),
        json={"document_ids": [uploaded["document_id"]]},
    )
    assert response.status_code == 201, response.text

    assessed = [entry["document_id"] for entry in response.json()["output"]["documents"]]
    assert uploaded["document_id"] in assessed, (
        "the uploaded document was not assessed; the runner is reading fixtures again"
    )
    # And ONLY it. A fixture appearing alongside would mean the agent reported on
    # documents the caller never sent, which is the failure this replaces.
    assert assessed == [uploaded["document_id"]], (
        f"the run also assessed documents nobody uploaded: {assessed}"
    )
    assert response.json()["source"]["documents"] == 1


async def test_the_run_report_counts_the_uploaded_document(client) -> None:  # type: ignore[no-untyped-def]
    """The numbers the console shows have to include what was uploaded."""
    uploaded = await _upload(client)

    response = await client.post(
        f"/v1/agents/{CHEAP_AGENT}/run",
        headers=_auth(),
        json={"document_ids": [uploaded["document_id"]]},
    )
    assert response.status_code == 201, response.text

    report = response.json()["source"]
    assert report["documents"] == 1
    assert report["documents_with_content"] == 1
    # No URL was fetched, and the report says so rather than naming one.
    assert report["url"] == ""
    assert any("uploaded document" in note for note in report["notes"])


async def test_two_uploads_are_both_resolved(client, runs) -> None:  # type: ignore[no-untyped-def]
    """A file is rarely on its own — a report, a payslip and a statement are one case."""
    first = await _upload(client, _pdf(pages=1))
    second = await _upload(client, _pdf(pages=2))

    response = await client.post(
        f"/v1/agents/{CHEAP_AGENT}/run",
        headers=_auth(),
        json={"document_ids": [first["document_id"], second["document_id"]]},
    )
    assert response.status_code == 201, response.text
    assert response.json()["source"]["documents"] == 2

    # In the order they were asked for, which is the order they reach the run.
    assert [d.document_id for d in runs[0].documents] == [
        first["document_id"],
        second["document_id"],
    ]


async def test_the_same_id_twice_is_one_document_and_one_read(client, runs, store) -> None:  # type: ignore[no-untyped-def]
    """Handing the agent the same file twice would be inventing a second one."""
    uploaded = await _upload(client)
    store.reads.clear()

    response = await client.post(
        f"/v1/agents/{CHEAP_AGENT}/run",
        headers=_auth(),
        json={"document_ids": [uploaded["document_id"], uploaded["document_id"]]},
    )
    assert response.status_code == 201, response.text
    assert response.json()["source"]["documents"] == 1
    assert len(runs[0].documents) == 1
    assert len(store.reads) == 1


async def test_a_run_with_no_document_ids_is_untouched(client, runs) -> None:  # type: ignore[no-untyped-def]
    """The endpoint predates this field; a caller that never sends it must not change."""
    response = await client.post(f"/v1/agents/{CHEAP_AGENT}/run", headers=_auth(), json={})
    assert response.status_code == 201, response.text
    assert response.json()["source"] is None
    assert runs[0] is None


# --- Tenant isolation ------------------------------------------------------


async def test_another_tenants_document_is_not_readable(client, runs, store) -> None:  # type: ignore[no-untyped-def]
    """The reason this task exists.

    Tenant A uploads a bureau report. Tenant B holds the id — assume the worst
    and say it was leaked, logged, or guessed — and asks an agent to read it.
    """
    uploaded = await _upload(client, headers=_auth(TENANT_A))
    store.reads.clear()

    response = await client.post(
        f"/v1/agents/{CHEAP_AGENT}/run",
        headers=_auth(TENANT_B),
        json={"document_ids": [uploaded["document_id"]]},
    )

    assert response.status_code == 404, response.text
    # Not merely refused: never looked for. The bytes were never fetched and the
    # agent never ran, so there is nothing for a timing or a cost to give away.
    assert store.reads == []
    assert runs == []


async def test_another_tenants_id_is_indistinguishable_from_one_that_is_not_real(  # type: ignore[no-untyped-def]
    client,
) -> None:
    """Same status, same body. Anything else answers "does this id exist?".

    The two responses differ only in the id each one echoes back, which is the id
    the caller sent in the first place. Take that away and they are the same
    response, so nothing about them can be used to tell a real document from an
    invented one.
    """
    uploaded = await _upload(client, headers=_auth(TENANT_A))
    real_id = uploaded["document_id"]
    invented_id = str(uuid4())

    real = await client.post(
        f"/v1/agents/{CHEAP_AGENT}/run",
        headers=_auth(TENANT_B),
        json={"document_ids": [real_id]},
    )
    invented = await client.post(
        f"/v1/agents/{CHEAP_AGENT}/run",
        headers=_auth(TENANT_B),
        json={"document_ids": [invented_id]},
    )

    assert real.status_code == invented.status_code == 404
    assert real.headers["content-type"] == invented.headers["content-type"]

    # The correlation id is per-request by design and is the one thing that is
    # meant to differ.
    real_body = {k: v for k, v in real.json().items() if k != "correlation_id"}
    invented_body = {k: v for k, v in invented.json().items() if k != "correlation_id"}
    assert real_body == {**invented_body, "context": {"entity_id": real_id}}


async def test_an_unknown_id_is_a_404(client, runs) -> None:  # type: ignore[no-untyped-def]
    response = await client.post(
        f"/v1/agents/{CHEAP_AGENT}/run",
        headers=_auth(),
        json={"document_ids": [str(uuid4())]},
    )
    assert response.status_code == 404, response.text
    assert response.json()["type"].endswith("not_found")
    assert runs == []


async def test_an_id_that_is_not_a_uuid_is_answered_the_same_way(client, runs) -> None:  # type: ignore[no-untyped-def]
    """One question, one answer, whatever shape the id arrived in."""
    response = await client.post(
        f"/v1/agents/{CHEAP_AGENT}/run",
        headers=_auth(),
        json={"document_ids": ["../../etc/passwd"]},
    )
    assert response.status_code == 404, response.text
    assert response.json()["context"]["entity_id"] == "../../etc/passwd"
    assert runs == []


async def test_respelling_another_tenants_id_does_not_get_past_the_check(client) -> None:  # type: ignore[no-untyped-def]
    """Trying to defeat the check by writing the id differently.

    `UUID()` accepts the urn form, the braced form and any mixture of case, and
    all of them parse to the same value — so if the tenant filter were anywhere
    but in the query, a respelling is what would slip past it. It does not,
    because the same normalised value is what the WHERE clause is given. The
    second half of the test is the other half of the claim: the respellings are
    not being refused for being unusual, since the owning tenant still resolves
    every one of them.
    """
    uploaded = await _upload(client, headers=_auth(TENANT_A))
    raw = uploaded["document_id"]
    spellings = [raw.upper(), f"urn:uuid:{raw}", f"{{{raw}}}", raw.replace("-", "")]

    for spelling in spellings:
        refused = await client.post(
            f"/v1/agents/{CHEAP_AGENT}/run",
            headers=_auth(TENANT_B),
            json={"document_ids": [spelling]},
        )
        assert refused.status_code == 404, f"{spelling}: {refused.text}"

        allowed = await client.post(
            f"/v1/agents/{CHEAP_AGENT}/run",
            headers=_auth(TENANT_A),
            json={"document_ids": [spelling]},
        )
        assert allowed.status_code == 201, f"{spelling}: {allowed.text}"
        assert allowed.json()["source"]["documents"] == 1


async def test_one_foreign_id_refuses_the_whole_run(client, runs, store) -> None:  # type: ignore[no-untyped-def]
    """A run is not partially served.

    Mixing a readable id with one that is not the caller's must not produce a run
    over whatever happened to be readable: an agent that silently read two of the
    three documents it was given would answer a question nobody asked.
    """
    mine = await _upload(client, headers=_auth(TENANT_A))
    theirs = await _upload(client, headers=_auth(TENANT_B))
    store.reads.clear()

    response = await client.post(
        f"/v1/agents/{CHEAP_AGENT}/run",
        headers=_auth(TENANT_A),
        json={"document_ids": [mine["document_id"], theirs["document_id"]]},
    )

    assert response.status_code == 404, response.text
    assert runs == []
    # A's own document may well have been read before B's was refused; what must
    # never appear here is B's object.
    assert theirs["uri"] not in store.reads


async def test_the_uploading_tenant_can_still_read_its_own_document(client) -> None:  # type: ignore[no-untyped-def]
    """The isolation tests above would also pass if nothing worked at all."""
    uploaded = await _upload(client, headers=_auth(TENANT_B))

    response = await client.post(
        f"/v1/agents/{CHEAP_AGENT}/run",
        headers=_auth(TENANT_B),
        json={"document_ids": [uploaded["document_id"]]},
    )
    assert response.status_code == 201, response.text
    assert response.json()["source"]["documents_with_content"] == 1


# --- When storage cannot answer --------------------------------------------


async def test_a_row_whose_object_is_gone_fails_cleanly(client, runs, store) -> None:  # type: ignore[no-untyped-def]
    """Better a 502 than an agent reporting on a document it never saw."""
    uploaded = await _upload(client)
    store.objects.clear()

    response = await client.post(
        f"/v1/agents/{CHEAP_AGENT}/run",
        headers=_auth(),
        json={"document_ids": [uploaded["document_id"]]},
    )

    assert response.status_code == 502, response.text
    assert response.json()["type"].endswith("blob_store_error")
    assert response.json()["correlation_id"]
    assert runs == []


async def test_an_object_that_comes_back_empty_is_refused(client, runs, store) -> None:  # type: ignore[no-untyped-def]
    """An accepted upload can never have been empty, so zero bytes is a fault."""
    uploaded = await _upload(client)
    store.objects[parse_uri(uploaded["uri"])[1]] = b""

    response = await client.post(
        f"/v1/agents/{CHEAP_AGENT}/run",
        headers=_auth(),
        json={"document_ids": [uploaded["document_id"]]},
    )

    assert response.status_code == 502, response.text
    assert runs == []


async def test_an_unreachable_store_is_a_502_not_a_404(client, runs) -> None:  # type: ignore[no-untyped-def]
    """An outage is an outage, and is never reported as a missing document.

    A storage failure dressed as "no such document" sends whoever reads it
    hunting for a bad id instead of a broken bucket, and it is not true.
    """
    uploaded = await _upload(client)

    class DeadStore(MemoryBlobStore):
        async def resolve(self, uri: str) -> bytes:
            raise BlobStoreError("The object store could not be reached", endpoint="minio:9000")

    app.dependency_overrides[get_blob_store] = lambda: DeadStore()

    response = await client.post(
        f"/v1/agents/{CHEAP_AGENT}/run",
        headers=_auth(),
        json={"document_ids": [uploaded["document_id"]]},
    )
    assert response.status_code == 502, response.text
    assert runs == []


# --- A source URL and uploads together -------------------------------------


class _Server:
    """A throwaway HTTP server, as in test_document_source."""

    def __init__(self, payload: dict[str, Any]) -> None:
        body = json.dumps(payload).encode()

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):  # keep the test output readable
                return

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}/source.json"

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


@pytest.fixture
def source_server():  # type: ignore[no-untyped-def]
    import base64

    server = _Server(
        {
            "documents": [
                {
                    "document_id": "remote-001",
                    "filename": "payslip.pdf",
                    "mime_type": "application/pdf",
                    "content_base64": base64.b64encode(_pdf()).decode(),
                }
            ],
            "transactions": [
                {"date": "2026-05-01", "description": "SALARY MAY", "credit": "90000"}
            ],
            "account": {"bank": "Kotak Mahindra Bank", "account_last4": "7731"},
        }
    )
    yield server
    server.close()


@pytest.fixture
def allow_loopback(monkeypatch):  # type: ignore[no-untyped-def]
    """Let the router fetch from 127.0.0.1 for the length of one test.

    `_fetch` reads the settings itself rather than taking the injected Config, so
    this is patched on the module. The guard being relaxed is the one
    test_document_source exercises over a real socket; all this file needs from
    it is a source URL that answers.
    """
    relaxed = get_settings().model_copy(update={"document_source_allow_private": True})
    monkeypatch.setattr(agents_router, "get_settings", lambda: relaxed)


async def test_a_run_can_have_both_a_source_url_and_uploads(  # type: ignore[no-untyped-def]
    client, runs, source_server, allow_loopback
) -> None:
    """Neither silently discards the other.

    A URL is where a tenant's own system keeps the figures; an upload is a file
    someone had in their hand. A run may legitimately have both, and the answer
    to "which one wins" is neither.
    """
    uploaded = await _upload(client)

    response = await client.post(
        f"/v1/agents/{CHEAP_AGENT}/run",
        headers=_auth(),
        json={
            "source": {"url": source_server.url},
            "document_ids": [uploaded["document_id"]],
        },
    )
    assert response.status_code == 201, response.text

    report = response.json()["source"]
    assert report["url"] == source_server.url
    assert report["documents"] == 2
    assert report["documents_with_content"] == 2
    assert report["transactions"] == 1

    source = runs[0]
    # The fetched document keeps its place at the front; the upload follows it.
    assert [d.document_id for d in source.documents] == [
        "remote-001",
        uploaded["document_id"],
    ]
    # And nothing else the fetch produced was dropped on the way.
    assert source.transactions
    assert source.account["bank_name"] == "Kotak Mahindra Bank"


async def test_the_facts_from_a_source_still_reach_the_agent_alongside_a_file(  # type: ignore[no-untyped-def]
    client, source_server, allow_loopback
) -> None:
    """The statement lines are what the analytics agent actually runs on."""
    uploaded = await _upload(client)

    response = await client.post(
        "/v1/agents/bank_statement_analytics/run",
        headers=_auth(),
        json={
            "source": {"url": source_server.url},
            "document_ids": [uploaded["document_id"]],
        },
    )
    assert response.status_code == 201, response.text
    body = response.json()
    # The account the analysis ran on is the one the endpoint supplied, not a
    # fixture: the upload rode alongside the figures without displacing them.
    assert [account["account_last4"] for account in body["output"]["accounts"]] == ["7731"]
    assert body["source"]["documents"] == 2


async def test_four_spellings_of_one_id_are_one_document_and_one_read(  # type: ignore[no-untyped-def]
    client, runs, store
) -> None:
    """Deduplication that compares ids, not the strings that carried them.

    `UUID()` accepts the urn form, the braced form, the hyphenless form and any
    mixture of case, so one document can be named four ways in a single list. If
    the list were deduplicated as text those would be four reads out of storage
    and the same file handed to the agent four times, as though four had been
    sent — the run would report four documents that do not exist and hold four
    copies of a nineteen-page report in memory while it worked.
    """
    uploaded = await _upload(client)
    raw = uploaded["document_id"]
    store.reads.clear()

    response = await client.post(
        f"/v1/agents/{CHEAP_AGENT}/run",
        headers=_auth(),
        json={
            "document_ids": [
                raw,
                raw.upper(),
                f"urn:uuid:{raw}",
                f"{{{raw}}}",
                raw.replace("-", ""),
            ]
        },
    )

    assert response.status_code == 201, response.text
    assert response.json()["source"]["documents"] == 1
    assert len(runs[0].documents) == 1
    assert len(store.reads) == 1


# --- Reading a document costs what reading a document costs ----------------


async def test_naming_a_document_needs_the_scope_that_reading_one_needs(  # type: ignore[no-untyped-def]
    client, runs, store
) -> None:
    """`agents:run` alone must not be a way round `documents:read`.

    A collections manager holds `agents:run` and holds neither `documents:read`
    nor `documents:write`: the platform has always kept that role away from
    files. `document_ids` would otherwise hand it one through an agent, which is
    the same bytes reaching the same person by a different door.
    """
    uploaded = await _upload(client, headers=_auth(TENANT_A))
    token = issue_dev_token(
        tenant_id=TENANT_A,
        subject="test:collections",
        roles=[Role.COLLECTIONS_MANAGER],
    )
    store.reads.clear()

    response = await client.post(
        f"/v1/agents/{CHEAP_AGENT}/run",
        headers={"Authorization": f"Bearer {token}"},
        json={"document_ids": [uploaded["document_id"]]},
    )

    assert response.status_code == 403, response.text
    assert store.reads == []
    assert runs == []


async def test_a_run_without_documents_still_needs_only_agents_run(client, runs) -> None:  # type: ignore[no-untyped-def]
    """The scope above is asked for only when the field is used.

    A role that could run an agent before this field existed runs one now on
    exactly the terms it always did.
    """
    token = issue_dev_token(
        tenant_id=TENANT_A,
        subject="test:collections",
        roles=[Role.COLLECTIONS_MANAGER],
    )

    response = await client.post(
        f"/v1/agents/{CHEAP_AGENT}/run",
        headers={"Authorization": f"Bearer {token}"},
        json={},
    )

    assert response.status_code == 201, response.text
    assert runs[0] is None


# --- The migration ---------------------------------------------------------


def _revision():  # type: ignore[no-untyped-def]
    """Load 0004 from its path; the versions directory is not an importable package."""
    path = REPO_ROOT / "migrations" / "versions" / "0004_documents.py"
    spec = importlib.util.spec_from_file_location("gravai_migration_0004", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _apply(engine, step) -> None:  # type: ignore[no-untyped-def]
    """Run one migration function against a connection, as alembic would."""
    with engine.begin() as connection:
        context = MigrationContext.configure(connection)
        with Operations.context(context):
            step()


def test_the_migration_round_trips(tmp_path: Path) -> None:
    """Upgrade, downgrade, upgrade — on a database of its own.

    Run against a throwaway SQLite file rather than the suite's database,
    because a migration test that dropped a table out from under the other tests
    would be a worse bug than anything it could catch.
    """
    revision = _revision()
    assert revision.revision == "0004_documents"
    assert revision.down_revision == "0003_agent_studio"

    engine = create_engine(f"sqlite:///{(tmp_path / 'migration.db').as_posix()}")
    # The tables 0004's foreign keys name, as earlier revisions leave them.
    Base.metadata.create_all(
        engine,
        tables=[Base.metadata.tables["tenant"], Base.metadata.tables["application"]],
    )
    tenant_id = uuid4()
    with engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO tenant (id, slug, name, is_active, config, created_at, updated_at) "
                "VALUES (:id, 'acme', 'Acme Finance', 1, '{}', :now, :now)"
            ),
            {"id": str(tenant_id), "now": "2026-09-16 00:00:00"},
        )

    assert "document" not in inspect(engine).get_table_names()

    _apply(engine, revision.upgrade)
    assert "document" in inspect(engine).get_table_names()
    indexes = {index["name"] for index in inspect(engine).get_indexes("document")}
    assert "ix_document_tenant_application" in indexes

    _apply(engine, revision.downgrade)
    assert "document" not in inspect(engine).get_table_names()
    # Downgrading removes what the upgrade created and nothing else. The tables
    # 0004's foreign keys point at predate it, and so do their rows.
    with engine.begin() as connection:
        surviving = connection.execute(text("SELECT slug FROM tenant")).scalars().all()
    assert surviving == ["acme"]
    assert "application" in inspect(engine).get_table_names()

    _apply(engine, revision.upgrade)
    assert "document" in inspect(engine).get_table_names()

    engine.dispose()


def test_the_document_table_is_tenant_scoped_in_the_models() -> None:
    """Row-level security on PostgreSQL follows from this list, not from a guess."""
    from gravai_core.models import TENANT_SCOPED_TABLES

    assert "document" in TENANT_SCOPED_TABLES
    assert "tenant_id" in Base.metadata.tables["document"].columns
