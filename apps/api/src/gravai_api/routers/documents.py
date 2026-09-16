"""Document upload.

The console could point an agent at a GET endpoint of the tenant's, but there
was no way to hand it a file: ten routers and not one of them accepted one.
This is that door, and it is the only place in the platform where bytes a
tenant chose enter the system, so it is also where the published security
claim — "virus scanning on upload" — is either honoured or quietly broken.

The order of operations below is the whole design and is not a matter of taste:

    read the part -> check the size -> check the media type -> SCAN -> store

Storing before scanning would put an unscanned object in the bucket even when
the response is an error, and an object in a bucket outlives the request that
put it there. Nothing is written anywhere — not the bucket, not the audit log —
until a scanner has looked at the bytes and said they are clean. If no scanner
can be reached there is no verdict, and a request with no verdict is answered
503 with nothing stored. That is the fail-closed rule, and it has no exceptions
for local development or for making a test pass.

What comes back is a ``blob://`` reference, never a URL. ``DocumentRef`` says
its ``uri`` is "a reference the platform resolves itself ... it is never sent
to the provider", and ``gravai_core.blobstore`` is what resolves it.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Annotated
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, File, Form, UploadFile, status
from gravai_core.auth import Scope
from gravai_core.blobstore import BlobStore, S3BlobStore, extension_for
from gravai_core.errors import ContentTooLong, GravAIError, ValidationFailed
from gravai_core.models import Application
from gravai_core.repositories import AuditRepository, get_or_404
from gravai_core.settings import get_settings
from gravai_core.telemetry import get_logger
from gravai_core.virusscan import ClamAVScanner, Scanner
from gravai_sarvam.batching import count_pages
from pydantic import BaseModel, Field

from ..deps import Config, CurrentPrincipal, DbSession, require_scope

log = get_logger("gravai.api.documents")

router = APIRouter(prefix="/v1/documents", tags=["documents"])

#: The part is read in pieces so this process never holds more than the
#: configured limit of a caller's file in memory. It is worth being precise
#: about what that does and does not cover: Starlette's multipart parser has
#: already spooled the part to a temporary file by the time this handler runs,
#: so the check below bounds our memory and produces the contract's 413 — it
#: does not stop a huge body from reaching the machine. Capping that is the
#: reverse proxy's job, and the deployment should set it there as well.
READ_CHUNK_BYTES = 64 * 1024

#: The media types the document reader can actually handle, each with the bytes
#: that identify it. The list is not a guess: ``DocumentRef.upload_name`` in
#: gravai_sarvam maps exactly these three to file suffixes, and it is the only
#: place in the Sarvam layer that enumerates what a document may be. Accepting
#: anything else here would mean accepting files nothing downstream can read.
MAGIC_NUMBERS: tuple[tuple[bytes, str], ...] = (
    (b"%PDF-", "application/pdf"),
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
)

ACCEPTED_MEDIA_TYPES: frozenset[str] = frozenset(media for _, media in MAGIC_NUMBERS)

#: Spellings browsers and clients send for types we accept under another name.
MEDIA_TYPE_ALIASES: dict[str, str] = {
    "image/jpg": "image/jpeg",
    "image/pjpeg": "image/jpeg",
    "application/x-pdf": "application/pdf",
}

#: A part that claims one of these is claiming nothing in particular — it is
#: what a client sends when its operating system has no mapping for the file.
#: Such a part is judged on its bytes alone rather than refused for disagreeing
#: with a claim it never made.
UNCOMMITTED_MEDIA_TYPES: frozenset[str] = frozenset({"", "application/octet-stream"})

#: Canonical action name for an accepted upload, in the same dotted form as the
#: constants in ``gravai_core.audit.AuditActions``. It is declared here because
#: this router introduced the event; it belongs alongside the others once the
#: owner of that module moves it.
DOCUMENT_UPLOADED = "document.uploaded"


class UnsupportedMediaType(GravAIError):
    """The bytes are not something the document reader can read."""

    status_code = 415
    code = "unsupported_media_type"


class EmptyUpload(GravAIError):
    """There was no file part, or it carried no bytes."""

    status_code = 400
    code = "empty_upload"


class InfectedUpload(ValidationFailed):
    """The scanner found something. Nothing was stored.

    A 422 rather than a 400: the request was well formed, and it is the content
    that was refused. The body names what the scanner found, because "rejected"
    with no reason is indistinguishable from a bug in the platform.
    """

    code = "infected_upload"


class DocumentOut(BaseModel):
    """An accepted document, as the console and the agents see it."""

    document_id: str
    uri: str = Field(
        description=(
            "A blob reference the platform resolves itself. Never a URL, and never "
            "handed to a provider."
        )
    )
    mime_type: str = Field(description="Determined from the bytes, not from what was declared")
    filename: str
    bytes: int
    pages: int | None = Field(
        default=None,
        description="Pages for a PDF; null when the count cannot be read, never a guess",
    )
    scanned_by: str = Field(description="The scanner that cleared this file, as it names itself")


@lru_cache(maxsize=1)
def get_blob_store() -> BlobStore:
    """The process-wide object store."""
    return S3BlobStore.from_settings(get_settings())


@lru_cache(maxsize=1)
def get_scanner() -> Scanner:
    """The process-wide virus scanner.

    There is one implementation and no fallback. If this cannot reach a daemon
    it raises, and the upload is refused — which is the entire point.
    """
    return ClamAVScanner.from_settings(get_settings())


BlobStoreDep = Annotated[BlobStore, Depends(get_blob_store)]
ScannerDep = Annotated[Scanner, Depends(get_scanner)]


async def _read_within_limit(file: UploadFile, limit: int) -> bytes:
    """Read the part, refusing it the moment it exceeds the configured size.

    Reading in chunks and stopping at the limit is what keeps a caller from
    deciding how much memory this process uses. The bytes that do fit are held
    in memory deliberately: the same bytes have to be sniffed, scanned and
    stored, and re-reading the part between those steps would mean the bytes
    that were scanned and the bytes that were stored are only probably the same.
    """
    chunks: list[bytes] = []
    total = 0
    while chunk := await file.read(READ_CHUNK_BYTES):
        total += len(chunk)
        if total > limit:
            raise ContentTooLong(
                "This file is larger than the platform accepts",
                limit_bytes=limit,
            )
        chunks.append(chunk)
    return b"".join(chunks)


def _detect_media_type(content: bytes) -> str | None:
    """What these bytes actually are, or None if they are nothing we read."""
    for magic, media_type in MAGIC_NUMBERS:
        if content.startswith(magic):
            return media_type
    return None


def _normalise(declared: str | None) -> str:
    """The declared type without its parameters, lowercased, aliases resolved."""
    base = (declared or "").split(";", 1)[0].strip().lower()
    return MEDIA_TYPE_ALIASES.get(base, base)


def _resolve_media_type(content: bytes, declared: str | None) -> str:
    """Decide what this file is, letting the bytes win.

    A part's ``Content-Type`` is whatever the client chose to write there, so it
    is treated as a claim to be checked rather than as a fact. A claim that
    contradicts the bytes is refused outright rather than silently corrected: a
    PDF arriving labelled as a PNG is either a broken client or someone probing
    what the platform does with a mislabelled file, and neither deserves a
    stored object.
    """
    detected = _detect_media_type(content)
    if detected is None:
        raise UnsupportedMediaType(
            "The platform cannot read this kind of file",
            declared=_normalise(declared) or None,
            accepted=sorted(ACCEPTED_MEDIA_TYPES),
        )

    claimed = _normalise(declared)
    if claimed not in UNCOMMITTED_MEDIA_TYPES and claimed != detected:
        raise UnsupportedMediaType(
            "The file's contents do not match the media type it was sent as",
            declared=claimed,
            detected=detected,
        )
    return detected


def _safe_filename(raw: str | None, *, fallback: str) -> str:
    """A filename fit to store and to show.

    The client chooses this string, so it is never allowed to influence where
    anything is written — the object key is random and owes nothing to it. This
    only strips what would make the name dangerous to log or to render.
    """
    candidate = (raw or "").replace("\\", "/").rsplit("/", 1)[-1]
    cleaned = "".join(ch for ch in candidate if ch.isprintable()).strip()
    return cleaned[:200] or fallback


@router.post(
    "",
    response_model=DocumentOut,
    status_code=status.HTTP_201_CREATED,
    summary="Upload a document",
)
async def upload_document(
    session: DbSession,
    principal: CurrentPrincipal,
    settings: Config,
    store: BlobStoreDep,
    scanner: ScannerDep,
    _: Annotated[object, Depends(require_scope(Scope.DOCUMENTS_WRITE))],
    file: Annotated[UploadFile | str | None, File(description="The document itself")] = None,
    application_id: Annotated[
        str | None, Form(description="Optional application to file this document under")
    ] = None,
) -> DocumentOut:
    """Accept one document, scan it, and store it only if it is clean.

    The file part is optional in the signature and required in the body. That
    is deliberate: declaring it required would have FastAPI answer a missing
    part with its own 422, which is both the wrong status for this contract and
    a different error shape from every other failure in this platform.

    ``str`` is in the annotation for the same reason. A multipart part with no
    filename is not a file part at all — the parser hands it over as text — and
    without this it would be FastAPI, not us, that answered. The contract calls
    that case 400, so it has to reach the body of this function to be answered.
    """
    if file is None or isinstance(file, str):
        raise EmptyUpload(
            "Send the document as a multipart file part named 'file'",
            hint="A part with no filename is read as a text field, not as a file.",
        )

    content = await _read_within_limit(file, settings.document_upload_max_bytes)
    if not content:
        raise EmptyUpload("The file part carried no bytes")

    media_type = _resolve_media_type(content, file.content_type)

    # An application id that is not this tenant's reads as missing, the same way
    # it does everywhere else. Checked before scanning only because it costs a
    # query rather than a scan; nothing is stored either way.
    application: Application | None = None
    if application_id:
        try:
            parsed = UUID(application_id)
        except ValueError as exc:
            raise ValidationFailed(
                "application_id is not a valid UUID", application_id=application_id
            ) from exc
        application = await get_or_404(session, Application, parsed)

    # Scan before anything is written. A scanner that cannot be reached raises
    # ScannerUnavailable, which is rendered as 503 — and because that happens
    # here, before the store, an unreachable scanner can never leave an object
    # behind.
    verdict = await scanner.scan(content)
    if not verdict.clean:
        log.warning(
            "upload_refused_infected",
            signature=verdict.signature,
            scanner=verdict.scanner,
            bytes=len(content),
        )
        raise InfectedUpload(
            "The virus scanner refused this file, so it was not stored",
            signature=verdict.signature,
            scanned_by=verdict.scanner,
            stored=False,
        )

    document_id = str(uuid4())
    # A part can arrive with no filename at all. The fallback is generated and
    # says so, rather than inventing a plausible-looking name for a file whose
    # real one we were never told.
    filename = _safe_filename(file.filename, fallback=f"{document_id}{extension_for(media_type)}")
    # Only now, on bytes a scanner has cleared, is it safe to let a PDF library
    # parse the file. count_pages returns None rather than guessing, and a
    # non-PDF has no page count at all.
    pages = count_pages(content)

    # Stored before it is audited, because an audit entry names the uri and the
    # digest, and neither exists until the write has happened. If the audit
    # write then fails the transaction rolls back and the object is orphaned in
    # the bucket — a scanned, clean object nothing refers to, which is the safer
    # of the two ways to be inconsistent.
    stored = await store.put(
        content,
        content_type=media_type,
        prefix=f"documents/{principal.tenant_id}",
    )

    await AuditRepository(session).append(
        action=DOCUMENT_UPLOADED,
        entity_type="document",
        entity_id=document_id,
        payload={
            "filename": filename,
            "mime_type": media_type,
            "bytes": stored.size_bytes,
            "pages": pages,
            "uri": stored.uri,
            # The digest is what makes the entry evidence: it ties this audited
            # decision to the exact bytes that were scanned and stored.
            "sha256": stored.sha256,
            "scanned_by": verdict.scanner,
            "application_id": str(application.id) if application else None,
        },
        actor_type="service" if principal.is_service else "user",
        actor_id=principal.subject,
    )

    log.info(
        "document_uploaded",
        document_id=document_id,
        mime_type=media_type,
        bytes=stored.size_bytes,
        pages=pages,
    )

    return DocumentOut(
        document_id=document_id,
        uri=stored.uri,
        mime_type=media_type,
        filename=filename,
        bytes=stored.size_bytes,
        pages=pages,
        scanned_by=verdict.scanner,
    )
