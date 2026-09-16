"""The OAuth flow, driven end to end against a real server.

Dynamic client registration is open by design — that is how a remote connector
onboards itself. So the security of this endpoint rests almost entirely on one
thing: that registering a client gets you nothing until a human passes the
login gate. Most of what follows is an attempt to get a token without doing
that.

The happy path is here too, because a gate nobody can pass is not a feature.
"""

from __future__ import annotations

import base64
import hashlib
import os
import secrets
import socket
import subprocess
import sys
import time
from collections.abc import Iterator
from contextlib import closing
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import httpx
import pytest

REPO = Path(__file__).resolve().parents[1]

TEST_SECRET = "oauth-test-secret-not-the-repository-default-0123456789"
PASSPHRASE = "correct-horse-battery-staple-16plus"
REDIRECT = "http://localhost:9999/callback"


def _free_port() -> int:
    with closing(socket.socket()) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _pkce() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(64)
    digest = hashlib.sha256(verifier.encode()).digest()
    challenge = base64.urlsafe_b64encode(digest).decode().rstrip("=")
    return verifier, challenge


@pytest.fixture(scope="module")
def server(tmp_path_factory) -> Iterator[str]:
    port = _free_port()
    base = f"http://127.0.0.1:{port}"
    env = {
        **os.environ,
        "AUTH_DEV_SECRET": TEST_SECRET,
        "GRAVAI_MCP_AUTH_PASSPHRASE": PASSPHRASE,
        "GRAVAI_MCP_PORT": str(port),
        "GRAVAI_MCP_HOST": "127.0.0.1",
        "GRAVAI_MCP_PUBLIC_URL": base,
        "GRAVAI_MCP_STATE_DIR": str(tmp_path_factory.mktemp("oauth-state")),
        "LOG_LEVEL": "WARNING",
    }
    proc = subprocess.Popen(
        [sys.executable, "-m", "gravai_mcp.http_server"],
        cwd=str(REPO),
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                raise RuntimeError("server exited before it was ready")
            try:
                httpx.get(f"{base}/.well-known/oauth-authorization-server", timeout=2.0)
                break
            except httpx.HTTPError:
                time.sleep(0.4)
        else:
            raise RuntimeError("server never came up")
        yield base
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


def _register(base: str, name: str = "Test Connector") -> str:
    response = httpx.post(
        f"{base}/register",
        json={
            "client_name": name,
            "redirect_uris": [REDIRECT],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
        },
        timeout=20.0,
    )
    assert response.status_code in (200, 201), response.text
    return response.json()["client_id"]


def _authorize(base: str, client_id: str, challenge: str, state: str = "xyz"):
    return httpx.get(
        f"{base}/authorize",
        params={
            "client_id": client_id,
            "redirect_uri": REDIRECT,
            "response_type": "code",
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "state": state,
            "scope": "agents:run",
        },
        follow_redirects=False,
        timeout=20.0,
    )


def _login(base: str, ticket: str, passphrase: str):
    return httpx.post(
        f"{base}/mcp-login",
        data={"ticket": ticket, "passphrase": passphrase},
        follow_redirects=False,
        timeout=20.0,
    )


def _ticket_from(response) -> str:
    location = response.headers["location"]
    return parse_qs(urlparse(location).query)["ticket"][0]


# --- discovery -----------------------------------------------------------


def test_discovery_metadata_is_published(server: str) -> None:
    """A connector finds the endpoints by reading these, not by being told."""
    meta = httpx.get(f"{server}/.well-known/oauth-authorization-server", timeout=10).json()
    assert meta["authorization_endpoint"].endswith("/authorize")
    assert meta["token_endpoint"].endswith("/token")
    assert meta["registration_endpoint"].endswith("/register")
    assert "S256" in meta["code_challenge_methods_supported"]


def test_the_resource_points_at_the_authorization_server(server: str) -> None:
    meta = httpx.get(f"{server}/.well-known/oauth-protected-resource/mcp", timeout=10).json()
    assert meta["authorization_servers"]


# --- the gate ------------------------------------------------------------


def test_authorize_does_not_hand_back_a_code(server: str) -> None:
    """The failure this whole file exists to prevent.

    If /authorize redirected to the client's redirect_uri carrying a code, any
    client that registered itself would hold a token seconds later, with no
    human ever involved.
    """
    client_id = _register(server)
    _, challenge = _pkce()
    response = _authorize(server, client_id, challenge)

    assert response.status_code in (302, 307)
    location = response.headers["location"]
    assert "/mcp-login" in location, f"expected the login gate, got {location}"
    assert "code=" not in location, "a code was issued without anyone logging in"


def test_a_wrong_passphrase_yields_no_code(server: str) -> None:
    client_id = _register(server)
    _, challenge = _pkce()
    ticket = _ticket_from(_authorize(server, client_id, challenge))

    response = _login(server, ticket, "not-the-passphrase-at-all")
    assert response.status_code == 401
    assert "location" not in response.headers


def test_a_forged_ticket_is_refused(server: str) -> None:
    """Tickets are opaque and server-side; guessing one must lead nowhere."""
    response = _login(server, secrets.token_urlsafe(32), PASSPHRASE)
    assert response.status_code == 400
    assert "location" not in response.headers


def test_a_ticket_cannot_be_used_twice(server: str) -> None:
    """Otherwise one login could be replayed into any number of codes."""
    client_id = _register(server)
    _, challenge = _pkce()
    ticket = _ticket_from(_authorize(server, client_id, challenge))

    first = _login(server, ticket, PASSPHRASE)
    assert first.status_code == 302

    second = _login(server, ticket, PASSPHRASE)
    assert second.status_code == 400


# --- the happy path ------------------------------------------------------


def _full_flow(base: str) -> dict:
    client_id = _register(base)
    verifier, challenge = _pkce()
    ticket = _ticket_from(_authorize(base, client_id, challenge))
    redirect = _login(base, ticket, PASSPHRASE)
    assert redirect.status_code == 302

    query = parse_qs(urlparse(redirect.headers["location"]).query)
    assert query["state"] == ["xyz"], "state must survive the round trip"
    code = query["code"][0]

    token = httpx.post(
        f"{base}/token",
        data={
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": REDIRECT,
            "client_id": client_id,
            "code_verifier": verifier,
        },
        timeout=20.0,
    )
    assert token.status_code == 200, token.text
    payload = token.json()
    payload["client_id"] = client_id
    payload["code"] = code
    payload["verifier"] = verifier
    return payload


def test_a_human_who_knows_the_passphrase_gets_a_working_token(server: str) -> None:
    payload = _full_flow(server)
    assert payload["token_type"].lower() == "bearer"
    assert payload["refresh_token"]

    # The real proof: the token opens the MCP endpoint.
    response = httpx.post(
        f"{server}/mcp",
        json={"jsonrpc": "2.0", "id": 1, "method": "ping"},
        headers={
            "Authorization": f"Bearer {payload['access_token']}",
            "Accept": "application/json, text/event-stream",
        },
        timeout=20.0,
    )
    assert response.status_code != 401


def test_the_issued_token_is_a_gravai_token(server: str) -> None:
    """One identity format across both auth modes, not two."""
    from gravai_core.auth import Scope
    from gravai_core.settings import Settings

    payload = _full_flow(server)
    import jwt

    settings = Settings(auth_dev_secret=TEST_SECRET)
    claims = jwt.decode(
        payload["access_token"],
        TEST_SECRET,
        algorithms=["HS256"],
        audience=settings.oidc_audience,
    )
    assert claims["sub"].startswith("oauth:")
    assert Scope.AGENTS_RUN.value in claims["scope"]
    assert "admin" not in claims["scope"], "a connector must not get admin"


# --- code handling -------------------------------------------------------


def test_an_authorization_code_is_single_use(server: str) -> None:
    """Replaying a code is the classic way a leaked redirect becomes a session."""
    payload = _full_flow(server)
    again = httpx.post(
        f"{server}/token",
        data={
            "grant_type": "authorization_code",
            "code": payload["code"],
            "redirect_uri": REDIRECT,
            "client_id": payload["client_id"],
            "code_verifier": payload["verifier"],
        },
        timeout=20.0,
    )
    assert again.status_code >= 400


def test_a_code_cannot_be_redeemed_by_a_different_client(server: str) -> None:
    """Registration is open, so a second client is free to create."""
    victim = _register(server, "Victim")
    attacker = _register(server, "Attacker")
    verifier, challenge = _pkce()

    ticket = _ticket_from(_authorize(server, victim, challenge))
    redirect = _login(server, ticket, PASSPHRASE)
    code = parse_qs(urlparse(redirect.headers["location"]).query)["code"][0]

    stolen = httpx.post(
        f"{server}/token",
        data={
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": REDIRECT,
            "client_id": attacker,
            "code_verifier": verifier,
        },
        timeout=20.0,
    )
    assert stolen.status_code >= 400, "another client redeemed a code that was not its own"


def test_pkce_is_enforced(server: str) -> None:
    """Without this, intercepting the redirect is enough to steal the session."""
    client_id = _register(server)
    _, challenge = _pkce()
    ticket = _ticket_from(_authorize(server, client_id, challenge))
    redirect = _login(server, ticket, PASSPHRASE)
    code = parse_qs(urlparse(redirect.headers["location"]).query)["code"][0]

    wrong_verifier, _ = _pkce()
    response = httpx.post(
        f"{server}/token",
        data={
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": REDIRECT,
            "client_id": client_id,
            "code_verifier": wrong_verifier,
        },
        timeout=20.0,
    )
    assert response.status_code >= 400, "a mismatched PKCE verifier was accepted"


# --- refresh -------------------------------------------------------------


def test_a_refresh_token_is_rotated_on_use(server: str) -> None:
    """A leaked refresh token should be good for one use, not for a month."""
    payload = _full_flow(server)
    first = httpx.post(
        f"{server}/token",
        data={
            "grant_type": "refresh_token",
            "refresh_token": payload["refresh_token"],
            "client_id": payload["client_id"],
        },
        timeout=20.0,
    )
    assert first.status_code == 200, first.text
    assert first.json()["refresh_token"] != payload["refresh_token"], "token was not rotated"

    replay = httpx.post(
        f"{server}/token",
        data={
            "grant_type": "refresh_token",
            "refresh_token": payload["refresh_token"],
            "client_id": payload["client_id"],
        },
        timeout=20.0,
    )
    assert replay.status_code >= 400, "the old refresh token still worked"


# --- regressions from the security review --------------------------------


def test_the_issued_token_cannot_approve_credit_decisions(server: str) -> None:
    """The consent screen says 'run agents'. The token must mean only that.

    The underwriter role carries decisions:approve — the authority to sign off
    a lending decision — and the token is a valid REST API credential because
    decode_token is shared. Granting the role without narrowing the scope
    handed every connector that authority.
    """
    import jwt
    from gravai_core.auth import Scope
    from gravai_core.settings import Settings

    payload = _full_flow(server)
    claims = jwt.decode(
        payload["access_token"],
        TEST_SECRET,
        algorithms=["HS256"],
        audience=Settings(auth_dev_secret=TEST_SECRET).oidc_audience,
    )
    granted = set(claims["scope"].split())
    assert granted == {Scope.AGENTS_RUN.value}, f"token carries more than agents:run: {granted}"
    assert Scope.DECISIONS_APPROVE.value not in granted
    assert Scope.APPLICATIONS_WRITE.value not in granted


def test_a_redirect_uri_the_client_never_registered_is_refused(server: str) -> None:
    """Otherwise /authorize is an open redirect, and worse, a code courier."""
    client_id = _register(server)
    _, challenge = _pkce()
    response = httpx.get(
        f"{server}/authorize",
        params={
            "client_id": client_id,
            "redirect_uri": "https://attacker.example/steal",
            "response_type": "code",
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "state": "xyz",
            "scope": "agents:run",
        },
        follow_redirects=False,
        timeout=20.0,
    )
    assert response.status_code != 302 or "attacker.example" not in response.headers.get(
        "location", ""
    ), "a code could be delivered to an unregistered destination"


def test_replaying_a_rotated_refresh_token_revokes_the_whole_chain(server: str) -> None:
    """Rotation alone leaves a stolen token good for one use.

    If the thief gets there first, the legitimate holder's next refresh is the
    replay — and the only safe reading is that the chain is compromised.
    """
    payload = _full_flow(server)
    first = httpx.post(
        f"{server}/token",
        data={
            "grant_type": "refresh_token",
            "refresh_token": payload["refresh_token"],
            "client_id": payload["client_id"],
        },
        timeout=20.0,
    )
    assert first.status_code == 200
    rotated = first.json()["refresh_token"]

    # The old one is replayed by whoever stole it.
    replay = httpx.post(
        f"{server}/token",
        data={
            "grant_type": "refresh_token",
            "refresh_token": payload["refresh_token"],
            "client_id": payload["client_id"],
        },
        timeout=20.0,
    )
    assert replay.status_code >= 400

    # And the legitimate rotated token is now dead too.
    after = httpx.post(
        f"{server}/token",
        data={
            "grant_type": "refresh_token",
            "refresh_token": rotated,
            "client_id": payload["client_id"],
        },
        timeout=20.0,
    )
    assert after.status_code >= 400, "the chain survived a detected replay"


def test_the_consent_page_is_not_framable_and_names_the_destination(server: str) -> None:
    """Two failures at once if this regresses.

    Framable means clickjackable. Not naming the destination means a phished
    passphrase entry authorizes whatever the attacker registered, and the
    human had no way to notice.
    """
    client_id = _register(server, "Phishy Connector")
    _, challenge = _pkce()
    ticket = _ticket_from(_authorize(server, client_id, challenge))

    page = httpx.get(f"{server}/mcp-login", params={"ticket": ticket}, timeout=20.0)
    assert page.status_code == 200
    assert page.headers.get("x-frame-options") == "DENY"
    assert "frame-ancestors 'none'" in page.headers.get("content-security-policy", "")
    assert "no-store" in page.headers.get("cache-control", "")
    assert REDIRECT in page.text, "the page does not say where approval is going"
    assert "Phishy Connector" in page.text
