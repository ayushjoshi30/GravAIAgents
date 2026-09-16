"""Object storage for document bytes.

``DocumentRef`` has always said that its ``uri`` is "a reference the platform
resolves itself (blob storage, or a sandbox fixture) — it is never sent to the
provider". This module is the half of that sentence the design left open: it
puts bytes in a bucket and resolves a reference back to bytes, so a document
that arrived by upload can be read by the same path that reads a fixture.

Two decisions worth stating, because both are easy to get wrong later:

* **The reference is not a URL.** A stored object is named ``blob://bucket/key``
  and ``resolve`` refuses anything else. If the reference were an ``https://``
  URL then every place that resolves one would become a server-side request
  forgery primitive — exactly the thing ``netguard`` exists to prevent — and a
  stored row would be able to point the fetcher anywhere.
* **Keys carry no meaning.** A key is random, not derived from the application
  id, the tenant's name or the filename. A key derived from an application id
  would let anyone holding one id enumerate another applicant's documents in a
  bucket that is, by design, reachable by the platform without a tenant check.

The client is written against the S3 API with stdlib signing and ``httpx``
rather than an SDK: ``boto3`` is not a dependency of this workspace and pulling
a large SDK in for two verbs is a poor trade when signing a request is forty
lines. MinIO, which is the local default, is addressed path-style because
virtual-host style needs a DNS entry per bucket.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol, runtime_checkable
from urllib.parse import quote, urlsplit

import httpx

from .errors import GravAIError
from .settings import Settings, get_settings
from .telemetry import get_logger
from .time_utils import utc_now

log = get_logger("gravai.blobstore")

#: The scheme that says "the platform resolves this itself". Deliberately not
#: http(s): see the module docstring.
BLOB_SCHEME = "blob"

#: File extensions for the media types the document reader accepts. The same
#: three ``DocumentRef.upload_name`` maps, kept in one place so a key and a
#: generated filename cannot end up disagreeing about what a file is.
EXTENSIONS = {
    "application/pdf": ".pdf",
    "image/jpeg": ".jpg",
    "image/png": ".png",
}

_SIGNING_ALGORITHM = "AWS4-HMAC-SHA256"


class BlobStoreError(GravAIError):
    """The object store could not be read or written."""

    status_code = 502
    code = "blob_store_error"
    retryable = True


@dataclass(frozen=True, slots=True)
class StoredBlob:
    """What a successful store produced."""

    uri: str
    key: str
    size_bytes: int
    content_type: str
    #: SHA-256 of the bytes that were stored. Recorded in the audit entry so a
    #: later reader can prove the object it fetched is the object that was
    #: scanned and accepted, rather than something substituted since.
    sha256: str


@runtime_checkable
class BlobStore(Protocol):
    """Store bytes under a generated key; resolve a reference back to bytes."""

    async def put(self, content: bytes, *, content_type: str, prefix: str = "") -> StoredBlob:
        """Store bytes under a fresh, unguessable key."""
        ...

    async def resolve(self, uri: str) -> bytes:
        """Read back the bytes a ``blob://`` reference names."""
        ...


def extension_for(content_type: str) -> str:
    """The file extension for a media type, or none when we have no mapping."""
    return EXTENSIONS.get(content_type, "")


def new_key(*, prefix: str = "", content_type: str = "") -> str:
    """A fresh object key with no information in it.

    ``secrets`` rather than a uuid derived from anything the caller supplied:
    the point is that holding an application id, a tenant id or a filename tells
    you nothing about where the object landed. The prefix only groups objects
    for lifecycle rules and is never the secret part.
    """
    token = secrets.token_urlsafe(24)
    name = f"{token}{extension_for(content_type)}"
    cleaned = prefix.strip("/")
    return f"{cleaned}/{name}" if cleaned else name


def parse_uri(uri: str) -> tuple[str, str]:
    """Split ``blob://bucket/key`` into its bucket and key.

    Anything that is not a blob reference is refused rather than fetched. This
    is the check that keeps a stored reference from becoming a URL the server
    will go and request.

    The key is also required to be a plain, forward-only path. A key containing
    a ``..`` segment would pass the bucket check in ``resolve`` — the netloc
    still names our bucket — and then climb straight back out of it, because an
    HTTP client normalises ``/bucket/../other-bucket/key`` to
    ``/other-bucket/key`` before sending it. Today S3 happens to reject that
    request anyway, since the signature was computed over the path we wrote
    rather than the path that arrived; relying on a signature mismatch to
    enforce bucket confinement is relying on an accident. The shape of the key
    is checked here instead, where the reference is first believed.
    """
    split = urlsplit(uri)
    if split.scheme != BLOB_SCHEME or not split.netloc or not split.path.strip("/"):
        raise BlobStoreError(
            "Not a blob reference",
            uri=uri,
            expected=f"{BLOB_SCHEME}://bucket/key",
        )

    key = split.path.lstrip("/")
    segments = key.split("/")
    if any(segment in ("", ".", "..") for segment in segments) or "\\" in key:
        raise BlobStoreError(
            "This blob reference does not name a plain key inside the bucket",
            uri=uri,
            expected=f"{BLOB_SCHEME}://bucket/key",
        )
    return split.netloc, key


def _sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _hmac(key: bytes, message: str) -> bytes:
    return hmac.new(key, message.encode("utf-8"), hashlib.sha256).digest()


@dataclass(frozen=True, slots=True)
class S3BlobStore:
    """An S3-compatible object store, signed with Signature Version 4."""

    endpoint: str
    access_key: str
    secret_key: str
    bucket: str
    region: str = "us-east-1"
    timeout: float = 30.0

    @classmethod
    def from_settings(cls, settings: Settings | None = None) -> S3BlobStore:
        cfg = settings or get_settings()
        return cls(
            endpoint=cfg.blob_endpoint.rstrip("/"),
            access_key=cfg.blob_key,
            secret_key=cfg.blob_secret,
            bucket=cfg.blob_bucket,
            region=cfg.blob_region,
            timeout=cfg.blob_timeout_seconds,
        )

    def uri_for(self, key: str) -> str:
        return f"{BLOB_SCHEME}://{self.bucket}/{key}"

    async def put(self, content: bytes, *, content_type: str, prefix: str = "") -> StoredBlob:
        """Store bytes under a fresh key and return the reference to them."""
        key = new_key(prefix=prefix, content_type=content_type)
        digest = _sha256(content)

        response = await self._request(
            "PUT",
            key,
            payload=content,
            payload_sha256=digest,
            extra_headers={"content-type": content_type} if content_type else {},
        )
        if response.status_code not in (200, 201):
            raise BlobStoreError(
                "The object store refused the write",
                bucket=self.bucket,
                status=response.status_code,
            )

        log.info("blob_stored", bucket=self.bucket, key=key, bytes=len(content))
        return StoredBlob(
            uri=self.uri_for(key),
            key=key,
            size_bytes=len(content),
            content_type=content_type,
            sha256=digest,
        )

    async def resolve(self, uri: str) -> bytes:
        """Read the object a reference names.

        A reference naming a different bucket is refused: a row can otherwise
        point a reader at any bucket the platform's credentials can reach.
        """
        bucket, key = parse_uri(uri)
        if bucket != self.bucket:
            raise BlobStoreError(
                "This reference belongs to another bucket",
                uri=uri,
                bucket=self.bucket,
            )

        response = await self._request("GET", key, payload=b"", payload_sha256=_sha256(b""))
        if response.status_code != 200:
            raise BlobStoreError(
                "The object store could not return this object",
                bucket=bucket,
                status=response.status_code,
            )
        return response.content

    async def _request(
        self,
        method: str,
        key: str,
        *,
        payload: bytes,
        payload_sha256: str,
        extra_headers: dict[str, str] | None = None,
    ) -> httpx.Response:
        """Sign and send one request to the object store."""
        path = f"/{self.bucket}/{quote(key, safe='/~')}"
        url = f"{self.endpoint}{path}"
        headers = self._signed_headers(
            method,
            path,
            payload_sha256=payload_sha256,
            extra_headers=extra_headers or {},
        )
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                return await client.request(method, url, content=payload, headers=headers)
        except httpx.HTTPError as exc:
            raise BlobStoreError(
                "The object store could not be reached",
                endpoint=self.endpoint,
                reason=str(exc) or exc.__class__.__name__,
            ) from exc

    def _signed_headers(
        self,
        method: str,
        path: str,
        *,
        payload_sha256: str,
        extra_headers: dict[str, str],
        now: datetime | None = None,
    ) -> dict[str, str]:
        """Signature Version 4, as S3 and every compatible store expect it.

        Only host and the ``x-amz-*`` headers are signed. That is all S3
        requires, and signing fewer headers means a proxy that adds one of its
        own cannot invalidate a request we know is ours.
        """
        moment = now or utc_now()
        amz_date = moment.strftime("%Y%m%dT%H%M%SZ")
        date_stamp = moment.strftime("%Y%m%d")
        host = urlsplit(self.endpoint).netloc

        canonical_headers = (
            f"host:{host}\nx-amz-content-sha256:{payload_sha256}\nx-amz-date:{amz_date}\n"
        )
        signed_headers = "host;x-amz-content-sha256;x-amz-date"
        canonical_request = "\n".join(
            [method, path, "", canonical_headers, signed_headers, payload_sha256]
        )

        scope = f"{date_stamp}/{self.region}/s3/aws4_request"
        string_to_sign = "\n".join(
            [_SIGNING_ALGORITHM, amz_date, scope, _sha256(canonical_request.encode("utf-8"))]
        )

        signing_key = _hmac(f"AWS4{self.secret_key}".encode(), date_stamp)
        signing_key = _hmac(signing_key, self.region)
        signing_key = _hmac(signing_key, "s3")
        signing_key = _hmac(signing_key, "aws4_request")
        signature = hmac.new(
            signing_key, string_to_sign.encode("utf-8"), hashlib.sha256
        ).hexdigest()

        return {
            "host": host,
            "x-amz-content-sha256": payload_sha256,
            "x-amz-date": amz_date,
            "authorization": (
                f"{_SIGNING_ALGORITHM} Credential={self.access_key}/{scope}, "
                f"SignedHeaders={signed_headers}, Signature={signature}"
            ),
            **extra_headers,
        }
