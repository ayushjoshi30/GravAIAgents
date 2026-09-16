"""The HTTP MCP server, with the authentication actually exercised.

The stdio server can trust its caller because the host started the process.
This one cannot: the token is the only thing between the internet and a tool
that runs an agent. So these tests care much less about the tool surface —
`test_mcp_server.py` covers that — and much more about who is turned away.

A real uvicorn process is started and driven over real HTTP. Checking the
verifier in isolation would pass while the app forgot to install it.
"""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
from collections.abc import Iterator
from contextlib import asynccontextmanager, closing
from pathlib import Path

import httpx
import httpx2
import pytest
from gravai_core.auth import Role, issue_dev_token
from gravai_core.settings import Settings
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

REPO = Path(__file__).resolve().parents[1]

#: Not the repository default, so the server agrees to start at all.
TEST_SECRET = "test-only-secret-not-the-repository-default-0123456789abcdef"
TENANT = "11111111-2222-3333-4444-555555555555"


def _free_port() -> int:
    with closing(socket.socket()) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _token(*roles: str) -> str:
    settings = Settings(auth_dev_secret=TEST_SECRET)
    return issue_dev_token(
        subject="test:mcp",
        tenant_id=TENANT,
        roles=[Role(name) for name in roles],
        settings=settings,
    )


@pytest.fixture(scope="module")
def base_url() -> Iterator[str]:
    port = _free_port()
    env = {
        **os.environ,
        "AUTH_DEV_SECRET": TEST_SECRET,
        "GRAVAI_MCP_PORT": str(port),
        "GRAVAI_MCP_HOST": "127.0.0.1",
        "LOG_LEVEL": "WARNING",
    }
    proc = subprocess.Popen(
        [sys.executable, "-m", "gravai_mcp.http_server"],
        cwd=str(REPO),
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    url = f"http://127.0.0.1:{port}/mcp"
    try:
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                raise RuntimeError("the server exited before it was ready")
            try:
                # Unauthenticated, so a 401 means it is up and guarding itself.
                httpx.post(url, json={}, timeout=2.0)
                break
            except httpx.HTTPError:
                time.sleep(0.4)
        else:
            raise RuntimeError("the server never came up")
        yield url
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


@asynccontextmanager
async def session(url: str, token: str):
    """The transport takes a client, not headers, so the token rides on it."""
    auth = httpx2.AsyncClient(headers={"Authorization": f"Bearer {token}"})
    async with (
        auth,
        streamable_http_client(url, http_client=auth) as (read, write),
        ClientSession(read, write) as client,
    ):
        await client.initialize()
        yield client


def test_a_request_with_no_token_is_refused(base_url: str) -> None:
    """The endpoint must never be open, even before a session exists."""
    response = httpx.post(base_url, json={"jsonrpc": "2.0", "id": 1, "method": "ping"})
    assert response.status_code == 401


def test_a_garbage_token_is_refused_not_crashed(base_url: str) -> None:
    """A malformed token is a 401, never a 500 leaking a stack trace."""
    response = httpx.post(
        base_url,
        json={"jsonrpc": "2.0", "id": 1, "method": "ping"},
        headers={"Authorization": "Bearer not-a-jwt"},
    )
    assert response.status_code == 401
    assert "Traceback" not in response.text


def test_a_token_signed_with_the_wrong_secret_is_refused(base_url: str) -> None:
    """Forging one requires the secret, which is the whole basis of this."""
    forged = issue_dev_token(
        subject="attacker",
        tenant_id=TENANT,
        roles=[Role("tenant_admin")],
        settings=Settings(auth_dev_secret="a-different-secret-entirely-aaaaaaaa"),
    )
    response = httpx.post(
        base_url,
        json={"jsonrpc": "2.0", "id": 1, "method": "ping"},
        headers={"Authorization": f"Bearer {forged}"},
    )
    assert response.status_code == 401


def test_a_valid_token_without_agents_run_is_refused(base_url: str) -> None:
    """An auditor is authenticated but has no business running an agent.

    Authentication and authorisation are different questions, and a server that
    conflates them hands every valid token the full tool surface.
    """
    response = httpx.post(
        base_url,
        json={"jsonrpc": "2.0", "id": 1, "method": "ping"},
        headers={"Authorization": f"Bearer {_token('auditor')}"},
    )
    assert response.status_code == 401


async def test_an_authorised_caller_can_list_and_run(base_url: str) -> None:
    """The happy path, over real HTTP, with a real token."""
    async with session(base_url, _token("underwriter", "collections_manager")) as client:
        tools = (await client.list_tools()).tools
        assert len(tools) == 14

        result = await client.call_tool("score_risk", {})
        assert result.is_error is False
        output = result.structured_content["output"]
        assert output["band"] == "AMBER"
        assert output["probability_30dpd_6m"] == 0.0658


async def test_the_tool_list_narrows_to_the_callers_roles(base_url: str) -> None:
    """An over-broad list tempts a model into calls that will be refused."""
    async with session(base_url, _token("underwriter")) as client:
        names = {tool.name for tool in (await client.list_tools()).tools}

    assert "score_risk" in names
    assert "run_collections_followup" not in names


async def test_a_hidden_tool_is_also_refused_when_called_directly(base_url: str) -> None:
    """Omitting a tool from the listing is presentation, not a control.

    A caller can name any tool they like regardless of what was advertised, so
    the permission check has to happen where the work would start.
    """
    async with session(base_url, _token("underwriter")) as client:
        result = await client.call_tool("run_collections_followup", {})

    assert result.is_error is True
    text = "\n".join(b.text for b in result.content if b.type == "text").lower()
    assert "scope" in text


async def test_a_proxied_host_header_is_not_rejected() -> None:
    """Behind a reverse proxy the Host header carries the public name.

    DNS-rebinding protection checks that header against the bind address, so a
    server trusting only loopback answers every proxied request with 421 — and
    does it *after* authenticating, which makes it look like anything but a
    Host problem.

    421 is raised by the transport-security layer, before the session manager,
    so its absence is the whole assertion. Anything past that point is covered
    by the subprocess tests above, which run the app with its real lifespan.
    """
    from gravai_core.settings import get_settings
    from gravai_mcp.http_server import build_app

    os.environ["AUTH_DEV_SECRET"] = TEST_SECRET
    get_settings.cache_clear()
    try:
        app = build_app(host="127.0.0.1", port=8003, public_url="https://example.test")
    finally:
        get_settings.cache_clear()

    body = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "proxy-probe", "version": "1"},
        },
    }
    headers = {
        "Authorization": f"Bearer {_token('underwriter')}",
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json",
    }

    # The session manager starts in the app's lifespan, which ASGITransport
    # does not run on its own.
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="https://example.test"
        ) as client,
    ):
        response = await client.post("/mcp", json=body, headers=headers)

    assert response.status_code != 421, (
        f"the proxied Host header was rejected: {response.text[:200]}"
    )
    assert response.status_code == 200, response.text[:200]
