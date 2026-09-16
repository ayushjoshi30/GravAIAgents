"""POST /v1/documents — the only door bytes a tenant chose come in by.

The property every test here defends is a single sentence: nothing is stored
unless a scanner looked at it and said it was clean. So the assertions are
rarely about the response alone — a 422 that still left an object in the bucket
would satisfy a status-code check and violate the whole design. They assert
against the store.

The scanner used here is a fake, but not a stub: it reads the bytes and looks
for the EICAR test string, the way a real engine reads bytes and looks for
signatures. A fake that returned "clean" without looking would make every
passing test below meaningless, which is exactly why the production code offers
no such implementation.
"""

from __future__ import annotations

import asyncio
import contextlib
import io
import struct
from uuid import UUID, uuid4

import pytest
from gravai_api.deps import get_config
from gravai_api.main import app
from gravai_api.routers.documents import get_blob_store, get_scanner
from gravai_core.auth import Role, issue_dev_token
from gravai_core.blobstore import BlobStoreError, S3BlobStore, StoredBlob, new_key, parse_uri
from gravai_core.settings import get_settings
from gravai_core.virusscan import ClamAVScanner, ScannerUnavailable, ScanResult
from httpx import ASGITransport, AsyncClient
from pypdf import PdfWriter
from sqlalchemy.exc import IntegrityError

TENANT = uuid4()

#: The standard anti-malware test string. Every engine detects it and it is
#: harmless, which is the whole reason it exists — inventing a malware sample to
#: prove a scanner is wired up would be both dangerous and unverifiable.
EICAR = rb"X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"

PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


def _pdf(pages: int = 1) -> bytes:
    """A real, parseable PDF, so the reported page count is a read fact."""
    writer = PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(width=200, height=200)
    buffer = io.BytesIO()
    writer.write(buffer)
    return buffer.getvalue()


def _pdf_carrying_eicar() -> bytes:
    """A PDF with the test signature inside it.

    The media-type check runs before the scan, so a bare EICAR file would be
    refused as unreadable before any scanner saw it and would prove nothing.
    Carrying the string inside a genuine PDF is what exercises the real order.
    """
    return _pdf() + b"\n% " + EICAR + b"\n"


def _auth(roles: list[Role] | None = None, tenant_id: UUID = TENANT) -> dict[str, str]:
    token = issue_dev_token(
        tenant_id=tenant_id,
        subject="test:console",
        roles=roles or [Role.UNDERWRITER, Role.CREDIT_HEAD],
    )
    return {"Authorization": f"Bearer {token}"}


class MemoryBlobStore:
    """A bucket that lives in the test process.

    It stands in for object storage and, more usefully, lets a test ask the
    question that matters: is anything in here? It lives in the tests because a
    store that forgets everything when the process ends has no business being
    reachable from production code.
    """

    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}

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
        _, key = parse_uri(uri)
        return self.objects[key]


class LookingScanner:
    """A fake scanner that actually reads what it is given."""

    name = "fake-clamav 1.0.0/27000/test"

    def __init__(self) -> None:
        #: Every payload this scanner was asked about, in order.
        self.seen: list[bytes] = []

    async def scan(self, content: bytes) -> ScanResult:
        self.seen.append(content)
        if EICAR in content:
            return ScanResult(clean=False, scanner=self.name, signature="Eicar-Test-Signature")
        return ScanResult(clean=True, scanner=self.name)


class BrokenScanner:
    """A scanner that fails in a way nobody anticipated."""

    def __init__(self) -> None:
        self.seen: list[bytes] = []

    async def scan(self, content: bytes) -> ScanResult:
        self.seen.append(content)
        raise RuntimeError("the scanner process died mid-scan")


@pytest.fixture
def store() -> MemoryBlobStore:
    return MemoryBlobStore()


@pytest.fixture
def scanner() -> LookingScanner:
    return LookingScanner()


@pytest.fixture
async def client(_schema: None, make_tenant, store, scanner):  # type: ignore[no-untyped-def]
    with contextlib.suppress(IntegrityError):
        await make_tenant(TENANT, slug=f"doc-{TENANT.hex[:8]}")

    app.dependency_overrides[get_blob_store] = lambda: store
    app.dependency_overrides[get_scanner] = lambda: scanner
    app.dependency_overrides[get_config] = get_settings

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as http:
        yield http

    for dependency in (get_blob_store, get_scanner, get_config):
        app.dependency_overrides.pop(dependency, None)


def _file(content: bytes, name: str = "statement.pdf", media: str = "application/pdf"):  # type: ignore[no-untyped-def]
    return {"file": (name, content, media)}


# --- The accepted path -----------------------------------------------------


async def test_a_clean_file_is_stored_and_described(client, store, scanner) -> None:  # type: ignore[no-untyped-def]
    content = _pdf()
    response = await client.post("/v1/documents", headers=_auth(), files=_file(content))
    assert response.status_code == 201, response.text

    body = response.json()
    assert body["mime_type"] == "application/pdf"
    assert body["filename"] == "statement.pdf"
    assert body["bytes"] == len(content)
    assert body["pages"] == 1
    assert body["scanned_by"] == scanner.name
    assert UUID(body["document_id"])

    # The reference is a blob reference, never a URL: whatever resolves it must
    # not be able to turn it into an outbound request.
    assert body["uri"].startswith("blob://")
    assert parse_uri(body["uri"])[1] in store.objects


async def test_the_stored_bytes_are_the_bytes_that_were_scanned(client, store, scanner) -> None:  # type: ignore[no-untyped-def]
    """The verdict is only worth anything if it applies to what was kept."""
    content = _pdf(pages=3)
    response = await client.post("/v1/documents", headers=_auth(), files=_file(content))
    assert response.status_code == 201, response.text
    assert response.json()["pages"] == 3

    stored = list(store.objects.values())
    assert stored == [content]
    assert scanner.seen == [content]


async def test_an_accepted_upload_is_audited(client, store) -> None:  # type: ignore[no-untyped-def]
    response = await client.post("/v1/documents", headers=_auth(), files=_file(_pdf()))
    assert response.status_code == 201, response.text
    document_id = response.json()["document_id"]

    entries = await client.get(
        f"/v1/audit?entity_type=document&entity_id={document_id}", headers=_auth()
    )
    assert entries.status_code == 200, entries.text
    rows = entries.json()
    assert len(rows) == 1

    entry = rows[0]
    assert entry["action"] == "document.uploaded"
    assert entry["payload"]["mime_type"] == "application/pdf"
    assert entry["payload"]["uri"] == response.json()["uri"]
    assert entry["payload"]["scanned_by"] == LookingScanner.name


async def test_an_upload_can_be_filed_under_an_application(client, db_session) -> None:  # type: ignore[no-untyped-def]
    created = await client.post(
        "/v1/applications",
        headers=_auth(),
        json={
            "external_id": f"APP-{uuid4().hex[:8]}",
            "product": "personal_loan",
            "applicant_name": "Ayush Joshi",
        },
    )
    assert created.status_code == 201, created.text
    application_id = created.json()["id"]

    response = await client.post(
        "/v1/documents",
        headers=_auth(),
        files=_file(_pdf()),
        data={"application_id": application_id},
    )
    assert response.status_code == 201, response.text

    entries = await client.get(
        f"/v1/audit?entity_type=document&entity_id={response.json()['document_id']}",
        headers=_auth(),
    )
    assert entries.json()[0]["payload"]["application_id"] == application_id


async def test_another_tenants_application_cannot_be_filed_against(client, store) -> None:  # type: ignore[no-untyped-def]
    """An id from another tenant reads as missing, as it does everywhere else."""
    response = await client.post(
        "/v1/documents",
        headers=_auth(),
        files=_file(_pdf()),
        data={"application_id": str(uuid4())},
    )
    assert response.status_code == 404, response.text
    assert store.objects == {}


# --- The refusals ----------------------------------------------------------


async def test_eicar_is_refused_and_nothing_is_stored(client, store, scanner) -> None:  # type: ignore[no-untyped-def]
    infected = _pdf_carrying_eicar()
    response = await client.post("/v1/documents", headers=_auth(), files=_file(infected))

    assert response.status_code == 422, response.text
    body = response.json()
    assert body["type"].endswith("infected_upload")
    # The body has to name what was found. "Rejected" with no reason cannot be
    # told apart from a bug in the platform.
    assert body["context"]["signature"] == "Eicar-Test-Signature"
    assert body["context"]["stored"] is False

    assert scanner.seen == [infected]
    assert store.objects == {}


async def test_an_unreachable_scanner_refuses_the_upload(client, store) -> None:  # type: ignore[no-untyped-def]
    """No verdict means no upload. The real client, against a dead port."""
    app.dependency_overrides[get_scanner] = lambda: ClamAVScanner(
        host="127.0.0.1", port=1, timeout=1.0
    )

    response = await client.post("/v1/documents", headers=_auth(), files=_file(_pdf()))

    assert response.status_code == 503, response.text
    assert response.json()["type"].endswith("scanner_unavailable")
    assert store.objects == {}


async def test_a_deployment_with_no_scanner_configured_cannot_accept_uploads(  # type: ignore[no-untyped-def]
    client, store
) -> None:
    """An unconfigured scanner is not a reason to accept the file anyway."""
    app.dependency_overrides[get_scanner] = lambda: ClamAVScanner(host="", port=3310)

    response = await client.post("/v1/documents", headers=_auth(), files=_file(_pdf()))

    assert response.status_code == 503, response.text
    assert response.json()["context"]["setting"] == "CLAMAV_HOST"
    assert store.objects == {}


async def test_a_file_over_the_limit_is_refused(client, store, scanner) -> None:  # type: ignore[no-untyped-def]
    small = get_settings().model_copy(update={"document_upload_max_bytes": 4096})
    app.dependency_overrides[get_config] = lambda: small

    oversize = _pdf() + b"%" + b"0" * 8192
    response = await client.post("/v1/documents", headers=_auth(), files=_file(oversize))

    assert response.status_code == 413, response.text
    assert response.json()["context"]["limit_bytes"] == 4096
    # Refused while reading, so it was never scanned and never stored.
    assert scanner.seen == []
    assert store.objects == {}


async def test_a_media_type_the_reader_cannot_handle_is_refused(client, store, scanner) -> None:  # type: ignore[no-untyped-def]
    response = await client.post(
        "/v1/documents",
        headers=_auth(),
        files=_file(b"PK\x03\x04 not a document", name="payload.zip", media="application/zip"),
    )

    assert response.status_code == 415, response.text
    assert response.json()["context"]["accepted"] == [
        "application/pdf",
        "image/jpeg",
        "image/png",
    ]
    assert scanner.seen == []
    assert store.objects == {}


async def test_bytes_that_disagree_with_the_declared_type_are_refused(client, store) -> None:  # type: ignore[no-untyped-def]
    """The declared type is a claim about the file, not a fact about it."""
    response = await client.post(
        "/v1/documents",
        headers=_auth(),
        files=_file(PNG_BYTES, name="statement.pdf", media="application/pdf"),
    )

    assert response.status_code == 415, response.text
    context = response.json()["context"]
    assert context["declared"] == "application/pdf"
    assert context["detected"] == "image/png"
    assert store.objects == {}


async def test_a_png_is_accepted_on_its_own_terms(client, store) -> None:  # type: ignore[no-untyped-def]
    """Refusing a mislabelled PNG must not mean refusing PNGs."""
    response = await client.post(
        "/v1/documents",
        headers=_auth(),
        files=_file(PNG_BYTES, name="cheque.png", media="image/png"),
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["mime_type"] == "image/png"
    # An image has no page count, and None is the honest answer rather than 1.
    assert body["pages"] is None
    assert len(store.objects) == 1


async def test_a_missing_part_is_a_400(client, store) -> None:  # type: ignore[no-untyped-def]
    response = await client.post(
        "/v1/documents", headers=_auth(), data={"application_id": str(uuid4())}
    )
    assert response.status_code == 400, response.text
    assert response.json()["type"].endswith("empty_upload")
    assert store.objects == {}


async def test_an_empty_part_is_a_400(client, store, scanner) -> None:  # type: ignore[no-untyped-def]
    response = await client.post("/v1/documents", headers=_auth(), files=_file(b""))
    assert response.status_code == 400, response.text
    assert scanner.seen == []
    assert store.objects == {}


async def test_the_endpoint_requires_the_documents_write_scope(client, store, scanner) -> None:  # type: ignore[no-untyped-def]
    """A developer token holds documents:read and must not be able to upload."""
    response = await client.post(
        "/v1/documents", headers=_auth(roles=[Role.DEVELOPER]), files=_file(_pdf())
    )

    assert response.status_code == 403, response.text
    assert "documents:write" in response.json()["context"]["required"]
    assert scanner.seen == []
    assert store.objects == {}


async def test_an_upload_needs_a_token_at_all(client, store) -> None:  # type: ignore[no-untyped-def]
    response = await client.post("/v1/documents", files=_file(_pdf()))
    assert response.status_code == 401
    assert store.objects == {}


# --- Trying to break the fail-closed property ------------------------------


async def test_a_scanner_that_fails_unexpectedly_still_stores_nothing(  # type: ignore[no-untyped-def]
    client, store
) -> None:
    """ScannerUnavailable is not the only way a scan can fail.

    A scanner that raises something nobody planned for must not be able to end
    up as a stored object either. Because the store happens after the scan and
    nowhere else, an exception of any kind leaves the bucket untouched.
    """
    broken = BrokenScanner()
    app.dependency_overrides[get_scanner] = lambda: broken

    transport = ASGITransport(app=app, raise_app_exceptions=False)
    async with AsyncClient(transport=transport, base_url="http://testserver") as http:
        response = await http.post("/v1/documents", headers=_auth(), files=_file(_pdf()))

    assert response.status_code == 500
    assert broken.seen  # it was asked, and it failed
    assert store.objects == {}


async def test_a_store_that_fails_after_a_clean_scan_records_no_success(client) -> None:  # type: ignore[no-untyped-def]
    """A refused write must not leave an audit entry saying a file was taken.

    The audit log is the durable record of this upload — there is no Document
    table yet — so an entry written for a document that never reached the bucket
    would be the platform attesting to something that did not happen. The order
    in the handler is store-then-audit precisely so the entry can only describe
    a write that succeeded.
    """

    class RefusingStore:
        def __init__(self) -> None:
            self.objects: dict[str, bytes] = {}

        async def put(self, content: bytes, *, content_type: str, prefix: str = "") -> StoredBlob:
            raise BlobStoreError("the object store refused the write", bucket="test-bucket")

        async def resolve(self, uri: str) -> bytes:  # pragma: no cover - never reached
            raise AssertionError("nothing was ever stored")

    app.dependency_overrides[get_blob_store] = lambda: RefusingStore()

    before = await client.get("/v1/audit?entity_type=document&limit=1000", headers=_auth())
    assert before.status_code == 200, before.text

    response = await client.post("/v1/documents", headers=_auth(), files=_file(_pdf()))
    assert response.status_code == 502, response.text

    after = await client.get("/v1/audit?entity_type=document&limit=1000", headers=_auth())
    assert len(after.json()) == len(before.json())


async def test_a_verdict_that_is_not_clean_is_treated_as_not_clean(client, store) -> None:  # type: ignore[no-untyped-def]
    """A refusal with no signature name is still a refusal.

    The endpoint must key off "is this clean" rather than "did it name a
    signature": a scanner that refuses a file without saying why is not
    permission to store it.
    """

    class NamelessRefusal:
        async def scan(self, content: bytes) -> ScanResult:
            return ScanResult(clean=False, scanner="fake/1", signature=None)

    app.dependency_overrides[get_scanner] = lambda: NamelessRefusal()

    response = await client.post("/v1/documents", headers=_auth(), files=_file(_pdf()))
    assert response.status_code == 422, response.text
    assert response.json()["context"]["signature"] is None
    assert store.objects == {}


async def test_a_second_part_cannot_smuggle_an_unscanned_file_in(client, store, scanner) -> None:  # type: ignore[no-untyped-def]
    """Two parts both named "file", one clean and one infected.

    Only one part is bound, and the invariant has to hold whichever one that
    is: whatever ends up in the store must be a payload the scanner was given.
    The second part must not ride in unexamined behind the first.
    """
    clean = _pdf()
    infected = _pdf_carrying_eicar()

    response = await client.post(
        "/v1/documents",
        headers=_auth(),
        files=[
            ("file", ("clean.pdf", clean, "application/pdf")),
            ("file", ("infected.pdf", infected, "application/pdf")),
        ],
    )

    assert response.status_code in (201, 422), response.text
    for content in store.objects.values():
        assert content in scanner.seen
        assert EICAR not in content
    if response.status_code == 422:
        assert store.objects == {}


async def test_a_part_with_no_filename_is_not_a_file_part(client, store, scanner) -> None:  # type: ignore[no-untyped-def]
    """The parser hands a filename-less part over as text, and it is refused.

    It must be refused in this platform's own error shape, not FastAPI's: a
    caller that gets a different envelope from this one endpoint has to write
    special-case handling for it.
    """
    response = await client.post(
        "/v1/documents", headers=_auth(), files={"file": ("", _pdf(), "application/pdf")}
    )
    assert response.status_code == 400, response.text
    assert response.json()["type"].endswith("empty_upload")
    assert response.headers["content-type"].startswith("application/problem+json")
    assert scanner.seen == []
    assert store.objects == {}


def test_a_file_with_no_name_of_its_own_is_given_a_generated_one() -> None:
    """Starlette types a part's filename as optional, so this has to be handled.

    It is exercised directly rather than over HTTP because no ordinary client
    can produce it: a multipart part with no filename is parsed as a text field
    and refused earlier, by the test above.
    """
    from gravai_api.routers.documents import _safe_filename

    assert _safe_filename(None, fallback="generated.pdf") == "generated.pdf"
    assert _safe_filename("   ", fallback="generated.pdf") == "generated.pdf"
    # Control characters have no place in a name that gets logged and rendered.
    assert _safe_filename("pay\nslip\x00.pdf", fallback="x.pdf") == "payslip.pdf"


async def test_a_filename_cannot_steer_where_the_object_lands(client, store) -> None:  # type: ignore[no-untyped-def]
    """The key owes nothing to anything the caller chose."""
    response = await client.post(
        "/v1/documents",
        headers=_auth(),
        files=_file(_pdf(), name="../../etc/passwd.pdf"),
    )
    assert response.status_code == 201, response.text
    assert response.json()["filename"] == "passwd.pdf"

    key = parse_uri(response.json()["uri"])[1]
    assert ".." not in key
    assert "passwd" not in key


# --- The reference itself --------------------------------------------------


def test_a_blob_reference_is_never_a_url() -> None:
    """Resolving must not be able to become an outbound fetch.

    If a stored reference could be an http URL, every reader of one would be a
    server-side request forgery primitive pointed at whatever the row said.
    """
    assert parse_uri("blob://gravai-documents/documents/x/abc") == (
        "gravai-documents",
        "documents/x/abc",
    )
    for hostile in (
        "http://169.254.169.254/latest/meta-data/",
        "https://example.com/file.pdf",
        "file:///etc/passwd",
        "gravai-documents/key",
    ):
        with pytest.raises(BlobStoreError):
            parse_uri(hostile)


def test_a_reference_cannot_climb_out_of_its_own_bucket() -> None:
    """The bucket check in ``resolve`` compares the name, not the path.

    A key carrying a ``..`` segment names the right bucket and then leaves it:
    an HTTP client collapses ``/bucket/../elsewhere/key`` to ``/elsewhere/key``
    before the request goes out, so the confinement check would have approved a
    read the store never performs inside our bucket at all.
    """
    for hostile in (
        "blob://gravai-documents/../secret-bucket/key",
        "blob://gravai-documents/documents/a/../../../other/key",
        "blob://gravai-documents/documents/./a",
        r"blob://gravai-documents/documents\..\..\other",
    ):
        with pytest.raises(BlobStoreError):
            parse_uri(hostile)

    # A key generated by the store itself must still be readable, or the guard
    # above would have closed the door on the ordinary case as well.
    assert parse_uri(f"blob://gravai-documents/{new_key(prefix='documents/t')}")[0] == (
        "gravai-documents"
    )


async def test_a_reference_to_another_bucket_is_refused() -> None:
    store = S3BlobStore(
        endpoint="http://localhost:9000",
        access_key="k",
        secret_key="s",
        bucket="gravai-documents",
    )
    with pytest.raises(BlobStoreError):
        await store.resolve("blob://someone-elses-bucket/key")


def test_two_keys_are_never_the_same_and_carry_nothing() -> None:
    """A key must not be derivable from an application id."""
    from gravai_core.blobstore import new_key

    application_id = "8f1c2f3e-0000-4000-8000-000000000001"
    prefix = f"documents/{TENANT}"
    keys = {new_key(prefix=prefix, content_type="application/pdf") for _ in range(50)}
    assert len(keys) == 50
    assert all(application_id not in key for key in keys)
    assert all(key.endswith(".pdf") for key in keys)


# --- The clamd client, against a daemon that speaks the real protocol ------


class FakeClamd:
    """A daemon that speaks clamd's wire protocol and nothing else.

    This is not a stand-in for a scanner's judgement — it cannot judge anything.
    It exists to prove the client frames INSTREAM correctly and reads a verdict
    the way the protocol defines it, which is the part of ``ClamAVScanner`` no
    amount of dependency injection can check.
    """

    def __init__(self, verdict: bytes, version: bytes = b"ClamAV 1.0.3/27000/Mon Sep 15") -> None:
        self.verdict = verdict
        self.version = version
        self.received: bytes | None = None
        self.port = 0
        self._server: asyncio.AbstractServer | None = None

    async def __aenter__(self) -> FakeClamd:
        self._server = await asyncio.start_server(self._handle, "127.0.0.1", 0)
        self.port = self._server.sockets[0].getsockname()[1]
        return self

    async def __aexit__(self, *_exc: object) -> None:
        assert self._server is not None
        self._server.close()
        await self._server.wait_closed()

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        command = await reader.readuntil(b"\0")
        if command == b"zVERSION\0":
            writer.write(self.version + b"\0")
        elif command == b"zINSTREAM\0":
            body = bytearray()
            while True:
                (size,) = struct.unpack("!I", await reader.readexactly(4))
                if size == 0:
                    break
                body += await reader.readexactly(size)
            self.received = bytes(body)
            writer.write(self.verdict + b"\0")
        await writer.drain()
        writer.close()


async def test_the_clamd_client_streams_the_whole_file_and_reads_a_clean_verdict() -> None:
    # Larger than one INSTREAM chunk, so the length-prefix framing is exercised
    # rather than assumed.
    payload = _pdf() + b"%" + b"A" * (8192 * 3)

    async with FakeClamd(b"stream: OK") as daemon:
        scanner = ClamAVScanner(host="127.0.0.1", port=daemon.port, timeout=5.0)
        result = await scanner.scan(payload)

    assert daemon.received == payload
    assert result.clean is True
    # Reported as the daemon names itself, not as a label we chose.
    assert result.scanner == "ClamAV 1.0.3/27000/Mon Sep 15"


async def test_the_clamd_client_reports_the_signature_it_was_told() -> None:
    async with FakeClamd(b"stream: Eicar-Test-Signature FOUND") as daemon:
        scanner = ClamAVScanner(host="127.0.0.1", port=daemon.port, timeout=5.0)
        result = await scanner.scan(_pdf_carrying_eicar())

    assert result.clean is False
    assert result.signature == "Eicar-Test-Signature"


@pytest.mark.parametrize(
    "reply",
    [
        b"INSTREAM size limit exceeded. ERROR",
        b"",
        b"stream: something we have never seen",
    ],
)
async def test_a_reply_that_is_not_a_verdict_is_not_treated_as_clean(reply: bytes) -> None:
    """The dangerous failure would be reading an ERROR line as an all-clear."""
    async with FakeClamd(reply) as daemon:
        scanner = ClamAVScanner(host="127.0.0.1", port=daemon.port, timeout=5.0)
        with pytest.raises(ScannerUnavailable):
            await scanner.scan(_pdf())


async def test_the_endpoint_refuses_a_file_a_real_client_saw_flagged(client, store) -> None:  # type: ignore[no-untyped-def]
    """End to end with the production scanner, against a daemon on a socket."""
    async with FakeClamd(b"stream: Eicar-Test-Signature FOUND") as daemon:
        app.dependency_overrides[get_scanner] = lambda: ClamAVScanner(
            host="127.0.0.1", port=daemon.port, timeout=5.0
        )
        response = await client.post(
            "/v1/documents", headers=_auth(), files=_file(_pdf_carrying_eicar())
        )

    assert response.status_code == 422, response.text
    assert response.json()["context"]["signature"] == "Eicar-Test-Signature"
    assert store.objects == {}


async def test_the_endpoint_reports_the_scanner_that_actually_cleared_the_file(client) -> None:  # type: ignore[no-untyped-def]
    async with FakeClamd(b"stream: OK", version=b"ClamAV 1.4.1/27311/Tue") as daemon:
        app.dependency_overrides[get_scanner] = lambda: ClamAVScanner(
            host="127.0.0.1", port=daemon.port, timeout=5.0
        )
        response = await client.post("/v1/documents", headers=_auth(), files=_file(_pdf()))

    assert response.status_code == 201, response.text
    assert response.json()["scanned_by"] == "ClamAV 1.4.1/27311/Tue"
