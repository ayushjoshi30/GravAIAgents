"""Virus scanning for bytes a tenant hands us.

The public security page says the platform performs "virus scanning on upload".
That sentence is already published, so an upload path that does not scan would
make a published claim false. This module exists to keep it true, and it is
built around one rule that outranks every convenience:

    If a file cannot be scanned, it is not stored and not accepted.

Everything here follows from that. There is no null scanner, no "skip when
unconfigured" branch and no environment flag that turns scanning off, because
each of those is a way for a misconfigured deployment to start accepting
unscanned files while still reporting success. When the daemon cannot be
reached, ``scan`` raises ``ScannerUnavailable`` and the caller answers 503
without storing anything. A deployment with no scanner configured therefore
cannot accept uploads at all, which is the intended behaviour rather than a
defect to work around.

The implementation speaks clamd's INSTREAM protocol over TCP directly. ClamAV
is what a real deployment already runs, and the wire protocol is small enough
that talking it costs less than a dependency: a command terminated by a NUL,
length-prefixed chunks, and a one-line verdict.
"""

from __future__ import annotations

import asyncio
import contextlib
import struct
from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

from .errors import GravAIError
from .settings import Settings, get_settings
from .telemetry import get_logger

log = get_logger("gravai.virusscan")

#: INSTREAM carries the payload as length-prefixed chunks, so the daemon can
#: start matching before the whole file has arrived and neither side has to
#: hold an unbounded buffer.
CHUNK_BYTES = 8192

#: clamd's "z" command prefix asks for NUL-terminated framing in both
#: directions. The older newline framing cannot be told apart from a signature
#: name that happens to contain a newline.
_TERMINATOR = b"\0"


class ScannerUnavailable(GravAIError):
    """No scanner could be reached, so no verdict exists.

    This is deliberately not a failure the caller can shrug off: there is no
    verdict to fall back to, and inventing a clean one is precisely the
    behaviour the fail-closed rule forbids. It renders as 503 so a caller knows
    to retry later rather than to try a different file.
    """

    status_code = 503
    code = "scanner_unavailable"
    retryable = True


@dataclass(frozen=True, slots=True)
class ScanResult:
    """One verdict, and who produced it.

    ``scanner`` is the daemon's own version string rather than a label we chose,
    so an audit entry records which engine and signature database actually
    cleared the file.
    """

    clean: bool
    scanner: str
    #: The name the engine gave what it found. Only meaningful when not clean.
    signature: str | None = None


@runtime_checkable
class Scanner(Protocol):
    """Anything that can give a verdict on bytes.

    Tests inject their own implementation of this. Production code has exactly
    one: ``ClamAVScanner``. Nothing in this package provides an implementation
    that answers without looking at the content.
    """

    async def scan(self, content: bytes) -> ScanResult:
        """Return a verdict, or raise ``ScannerUnavailable`` if none can be had."""
        ...


@dataclass(slots=True)
class ClamAVScanner:
    """A clamd client speaking INSTREAM over TCP.

    The daemon is addressed over TCP rather than a Unix socket because the
    scanner usually runs in its own container, where a socket file cannot be
    shared.
    """

    host: str
    port: int = 3310
    timeout: float = 30.0
    #: The daemon's version string, learned once. Caching it saves a round trip
    #: per upload; it does not weaken anything, because the INSTREAM exchange
    #: that follows proves the daemon is still there. A daemon restarted onto a
    #: newer signature database will be reported under its previous version
    #: until this process is replaced.
    _version: str | None = field(default=None, init=False, repr=False, compare=False)

    @classmethod
    def from_settings(cls, settings: Settings | None = None) -> ClamAVScanner:
        """Build the configured scanner.

        An empty host is not rejected here, because refusing to construct would
        stop the whole API from starting over a capability most requests never
        touch. It is rejected at ``scan`` instead, where the consequence is a
        503 on uploads only.
        """
        cfg = settings or get_settings()
        return cls(
            host=cfg.clamav_host,
            port=cfg.clamav_port,
            timeout=cfg.clamav_timeout_seconds,
        )

    async def scan(self, content: bytes) -> ScanResult:
        """Scan bytes and return the verdict.

        Raises ``ScannerUnavailable`` for every outcome that is not a verdict:
        no host configured, a refused or timed-out connection, a connection
        that dies mid-stream, and a reply the protocol does not define. Each of
        those is a case where we do not know whether the file is safe, and not
        knowing is treated the same as knowing it is not.
        """
        version = await self.version()
        reply = await self._round_trip(b"zINSTREAM" + _TERMINATOR, payload=content)
        return self._interpret(reply, scanner=version)

    async def version(self) -> str:
        """The daemon's version string, learned on first use."""
        if self._version is None:
            reply = await self._round_trip(b"zVERSION" + _TERMINATOR)
            if not reply:
                raise ScannerUnavailable(
                    "The virus scanner answered its version query with nothing",
                    host=self.host,
                    port=self.port,
                )
            self._version = reply
        return self._version

    async def _open(self) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
        """Connect, or explain why there is no scanner to talk to."""
        if not self.host:
            raise ScannerUnavailable(
                "No virus scanner is configured, so uploads cannot be accepted",
                setting="CLAMAV_HOST",
                hint="Point CLAMAV_HOST at a clamd instance. Uploads stay refused until then.",
            )
        try:
            return await asyncio.wait_for(
                asyncio.open_connection(self.host, self.port), timeout=self.timeout
            )
        except (OSError, TimeoutError) as exc:
            raise ScannerUnavailable(
                "The virus scanner could not be reached",
                host=self.host,
                port=self.port,
                reason=str(exc) or exc.__class__.__name__,
            ) from exc

    async def _round_trip(self, command: bytes, payload: bytes | None = None) -> str:
        """Send one command, optionally streaming a payload, and read the reply."""
        reader, writer = await self._open()
        try:
            writer.write(command)
            if payload is not None:
                for start in range(0, len(payload), CHUNK_BYTES):
                    chunk = payload[start : start + CHUNK_BYTES]
                    writer.write(struct.pack("!I", len(chunk)) + chunk)
                # A zero-length chunk ends the stream. Without it the daemon
                # waits for more data until it times out and we would report an
                # unreachable scanner on a file that was merely finished.
                writer.write(struct.pack("!I", 0))
            await asyncio.wait_for(writer.drain(), timeout=self.timeout)
            raw = await asyncio.wait_for(reader.readuntil(_TERMINATOR), timeout=self.timeout)
        except (OSError, TimeoutError, EOFError, asyncio.LimitOverrunError) as exc:
            # A daemon that hangs up mid-stream — because the file exceeded its
            # StreamMaxLength, or because it died — leaves us with no verdict.
            raise ScannerUnavailable(
                "The virus scanner closed the connection before giving a verdict",
                host=self.host,
                port=self.port,
                reason=str(exc) or exc.__class__.__name__,
            ) from exc
        finally:
            writer.close()
            with contextlib.suppress(OSError, ConnectionError):
                await writer.wait_closed()

        return raw.rstrip(_TERMINATOR).decode("utf-8", errors="replace").strip()

    def _interpret(self, reply: str, *, scanner: str) -> ScanResult:
        """Turn one clamd reply line into a verdict.

        Only two replies are verdicts. Anything else — an ERROR line, an empty
        line, a line from a protocol version we do not know — is reported as no
        verdict at all, because a reply we cannot parse is not evidence that a
        file is safe.
        """
        if reply.endswith("OK") and "FOUND" not in reply:
            return ScanResult(clean=True, scanner=scanner)

        if reply.endswith("FOUND"):
            # "stream: Eicar-Test-Signature FOUND" -> "Eicar-Test-Signature"
            found = reply.rsplit(":", 1)[-1].strip().removesuffix("FOUND").strip()
            log.warning("upload_infected", signature=found or "unnamed", scanner=scanner)
            return ScanResult(clean=False, scanner=scanner, signature=found or None)

        raise ScannerUnavailable(
            "The virus scanner did not return a verdict",
            host=self.host,
            port=self.port,
            reply=reply,
        )
