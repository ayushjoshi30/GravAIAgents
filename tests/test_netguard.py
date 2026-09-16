"""The URL guard, checked against the things it exists to stop.

This is the security boundary for the remote document source: a URL a tenant
types, fetched by the server. Every test below is a real SSRF technique rather
than a shape of input, because that is what the guard is for.
"""

from __future__ import annotations

import pytest
from gravai_core.netguard import ApprovedTarget, UnsafeUrl, approve, peer_is_approved


def _resolves_to(*addresses: str):
    """A resolver that answers with fixed addresses, so no DNS is involved."""

    def resolver(host: str, port: int) -> list[str]:
        return list(addresses)

    return resolver


PUBLIC = _resolves_to("93.184.216.34")


def test_a_public_url_is_approved() -> None:
    target = approve("https://example.com/docs.json", resolver=PUBLIC)
    assert target.host == "example.com"
    assert target.port == 443
    assert target.addresses == {"93.184.216.34"}


def test_the_port_comes_from_the_url_when_given() -> None:
    target = approve("https://example.com:8443/docs", resolver=PUBLIC)
    assert target.port == 8443


@pytest.mark.parametrize(
    ("address", "what"),
    [
        ("127.0.0.1", "loopback, where this server's own API and MCP listen"),
        ("::1", "IPv6 loopback"),
        ("169.254.169.254", "the cloud metadata service"),
        ("10.0.0.5", "RFC1918"),
        ("192.168.1.1", "RFC1918"),
        ("172.16.0.1", "RFC1918"),
        ("100.64.0.1", "carrier-grade NAT"),
        ("0.0.0.0", "unspecified"),
        ("224.0.0.1", "multicast"),
        ("fd00::1", "IPv6 unique local"),
        ("fe80::1", "IPv6 link-local"),
    ],
)
def test_an_address_that_is_not_globally_routable_is_refused(address: str, what: str) -> None:
    with pytest.raises(UnsafeUrl):
        approve("https://anything.test/docs", resolver=_resolves_to(address))


def test_the_ipv4_mapped_spelling_of_loopback_is_refused() -> None:
    """`IPv6Address('::ffff:127.0.0.1').is_loopback` is False.

    Relying on the category flags without unmapping first is exactly how this
    bypass survives a guard that looks correct.
    """
    with pytest.raises(UnsafeUrl, match="loopback"):
        approve("https://anything.test/docs", resolver=_resolves_to("::ffff:127.0.0.1"))


def test_one_bad_address_among_good_ones_refuses_the_whole_host() -> None:
    """A host can answer with several addresses, and the attacker picks."""
    with pytest.raises(UnsafeUrl):
        approve(
            "https://anything.test/docs",
            resolver=_resolves_to("93.184.216.34", "127.0.0.1"),
        )


@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "gopher://example.com/",
        "ftp://example.com/x",
        "example.com/docs",
    ],
)
def test_only_http_and_https_are_fetchable(url: str) -> None:
    with pytest.raises(UnsafeUrl, match="must start with"):
        approve(url, resolver=PUBLIC)


def test_credentials_in_the_url_are_refused() -> None:
    """Both a leak and a parser-confusion trick; a header is the right place."""
    with pytest.raises(UnsafeUrl, match="[Cc]redentials"):
        approve("https://user:secret@example.com/docs", resolver=PUBLIC)


def test_a_url_with_no_host_is_refused() -> None:
    with pytest.raises(UnsafeUrl):
        approve("https:///docs", resolver=PUBLIC)


def test_a_host_that_resolves_to_nothing_is_refused() -> None:
    with pytest.raises(UnsafeUrl, match="no addresses"):
        approve("https://example.com/docs", resolver=_resolves_to())


def test_localhost_is_reachable_only_when_deliberately_allowed() -> None:
    """The development escape hatch, which production refuses to leave open."""
    with pytest.raises(UnsafeUrl):
        approve("http://localhost:8004/docs", resolver=_resolves_to("127.0.0.1"))

    target = approve(
        "http://localhost:8004/docs", allow_private=True, resolver=_resolves_to("127.0.0.1")
    )
    assert target.private_allowed is True


# --- the second half of the guard ------------------------------------------


def _target(*addresses: str) -> ApprovedTarget:
    return ApprovedTarget(
        url="https://example.com/docs",
        host="example.com",
        port=443,
        addresses=frozenset(addresses),
    )


def test_a_connection_to_an_approved_address_passes() -> None:
    assert peer_is_approved(_target("93.184.216.34"), "93.184.216.34") is True


def test_a_connection_to_a_different_address_is_a_rebind() -> None:
    """The name answered publicly for the check and privately for the connect."""
    assert peer_is_approved(_target("93.184.216.34"), "127.0.0.1") is False


def test_the_mapped_spelling_of_an_approved_address_still_passes() -> None:
    assert peer_is_approved(_target("93.184.216.34"), "::ffff:93.184.216.34") is True


def test_an_unverifiable_connection_is_treated_as_failed() -> None:
    """No peer information means the check cannot be made, so it has not passed."""
    assert peer_is_approved(_target("93.184.216.34"), None) is False


def test_nonsense_peer_information_is_treated_as_failed() -> None:
    assert peer_is_approved(_target("93.184.216.34"), "not-an-address") is False
