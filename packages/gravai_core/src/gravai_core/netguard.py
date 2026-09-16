"""Deciding whether the server may fetch a URL someone typed in.

A document source is a URL a tenant supplies and the server then fetches. That
is a server-side request forgery primitive unless it is guarded, and on this
deployment the consequences are concrete: the REST API, the MCP server, the
console and a separate credit application all listen on loopback and are
reachable by nothing else, while the cloud metadata service answers on
169.254.169.254 and hands out credentials to anything that asks. A fetcher that
takes a hostname on trust gives all of them to whoever can type in a form.

The guard is deliberately two-sided:

* **Before the request** — resolve the name and refuse if any address it
  resolves to is not globally routable. This stops the direct attempt.
* **After the connection** — compare the address actually connected to against
  the ones that were approved. This stops DNS rebinding, where a name answers
  with a public address for the check and a private one microseconds later for
  the connection.

Neither half is sufficient. The first alone loses to rebinding; the second
alone means the request has already been sent before anything is checked.
"""

from __future__ import annotations

import ipaddress
import socket
from dataclasses import dataclass
from urllib.parse import urlsplit

#: Schemes worth allowing. `file://`, `gopher://` and friends are SSRF
#: classics and no document source needs them.
ALLOWED_SCHEMES = frozenset({"http", "https"})


class UnsafeUrl(ValueError):
    """The URL may not be fetched. The message says why, in the caller's terms."""


@dataclass(frozen=True, slots=True)
class ApprovedTarget:
    """A URL that passed the pre-flight check, with what it resolved to."""

    url: str
    host: str
    port: int
    #: Every address the host resolved to, as strings. The connection must land
    #: on one of these or it is treated as a rebind.
    addresses: frozenset[str]
    #: True when the private-address block was deliberately lifted. Carried so
    #: a caller can say so in its output rather than leave it invisible.
    private_allowed: bool = False


def _canonical(raw: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address:
    """Parse an address, collapsing the IPv4-mapped IPv6 spelling.

    `::ffff:127.0.0.1` is loopback, but `IPv6Address.is_loopback` answers False
    for it because the mapped form is a different address. Unmapping first is
    what makes the category checks below mean what they appear to mean.
    """
    address = ipaddress.ip_address(raw)
    if isinstance(address, ipaddress.IPv6Address):
        mapped = address.ipv4_mapped
        if mapped is not None:
            return mapped
    return address


def _reject_reason(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> str | None:
    """Why this address is not fetchable, or None if it is fine.

    Categories are checked explicitly rather than relying on `is_global` alone,
    because the error a person reads should name what they hit.
    """
    if address.is_loopback:
        return "a loopback address, where this server's own internal services listen"
    if address.is_link_local:
        return "a link-local address, which is where cloud metadata services live"
    if address.is_private:
        return "a private address inside the host's own network"
    if address.is_multicast:
        return "a multicast address"
    if address.is_reserved or address.is_unspecified:
        return "a reserved address"
    if not address.is_global:
        # Catches the remainder, notably 100.64.0.0/10 carrier-grade NAT.
        return "not a globally routable address"
    return None


def resolve(host: str, port: int) -> list[str]:
    """Every address a host resolves to. Split out so tests can substitute it."""
    try:
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except socket.gaierror as exc:
        raise UnsafeUrl(f"Could not resolve {host!r}: {exc.strerror or exc}") from exc
    return [info[4][0] for info in infos]


def approve(
    url: str,
    *,
    allow_private: bool = False,
    resolver=resolve,
) -> ApprovedTarget:
    """Check a URL before fetching it, or raise `UnsafeUrl` saying why not.

    `allow_private` exists for local development, where the thing you want to
    point at genuinely is on localhost. It must never be on in production, and
    `Settings` refuses to leave it on there.
    """
    parts = urlsplit(url.strip())

    if parts.scheme not in ALLOWED_SCHEMES:
        allowed = " or ".join(sorted(ALLOWED_SCHEMES))
        raise UnsafeUrl(
            f"The URL must start with {allowed}://, not {parts.scheme or 'a missing scheme'}."
        )

    # user:password@host is both a credential leak and a parser-confusion
    # trick, and no document source needs it — use a header instead.
    if parts.username or parts.password:
        raise UnsafeUrl(
            "Credentials in the URL are not accepted. Send them in a header instead."
        )

    host = parts.hostname
    if not host:
        raise UnsafeUrl("The URL has no host.")

    port = parts.port or (443 if parts.scheme == "https" else 80)

    # A bare address skips DNS entirely; it still has to pass the same test.
    resolved = resolver(host, port)
    if not resolved:
        raise UnsafeUrl(f"{host!r} resolved to no addresses.")

    if not allow_private:
        for raw in resolved:
            address = _canonical(raw)
            reason = _reject_reason(address)
            if reason is not None:
                raise UnsafeUrl(
                    f"{host} resolves to {address}, which is {reason}. "
                    "Point the source at a publicly reachable URL."
                )

    return ApprovedTarget(
        url=url.strip(),
        host=host,
        port=port,
        addresses=frozenset(str(_canonical(raw)) for raw in resolved),
        private_allowed=allow_private,
    )


def peer_is_approved(target: ApprovedTarget, peer: str | None) -> bool:
    """Whether the address actually connected to is one that was approved.

    A False here means the name resolved to something different between the
    check and the connection, which is the rebinding attack. The response must
    be discarded unread.
    """
    if target.private_allowed:
        return True
    if peer is None:
        # No peer information means the check cannot be made, and an
        # unverifiable connection is treated as a failed one.
        return False
    try:
        return str(_canonical(peer)) in target.addresses
    except ValueError:
        return False
