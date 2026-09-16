"""GravAI MCP server, over Streamable HTTP.

The stdio server in `server.py` is launched by the host and talks over pipes,
which only works when the host and the agents are on the same machine. This is
the same tool surface reachable over the network.

    python -m gravai_mcp.http_server            # 127.0.0.1:8003/mcp

Deliberately different from the stdio server in exactly one respect: **every
request must carry a bearer token**. stdio can trust the process because the
host started it. Over a socket there is no such guarantee, so the token is the
only thing standing between the internet and a tool that runs an agent.

Tokens are validated by `gravai_core.auth.decode_token`, the same function the
REST API uses, so there is one definition of who a caller is. Scopes come from
the token's roles, and the advertised tool list is filtered by them: a caller
without `agents:run` is offered nothing rather than being offered fourteen
tools that will all refuse.

Bind to loopback and put a TLS terminator in front. A bearer token sent over
plain HTTP is a bearer token you have given away.
"""

from __future__ import annotations

import html
import os
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

# structlog caches its configuration on the first gravai import, so the level
# has to be set before them.
os.environ.setdefault("LOG_LEVEL", "INFO")

import uvicorn
from gravai_core.auth import Principal, Scope, decode_token
from gravai_core.errors import Unauthenticated
from gravai_core.settings import get_settings
from gravai_core.telemetry import get_logger
from mcp.server.auth.provider import AccessToken, TokenVerifier
from mcp.server.auth.settings import AuthSettings, ClientRegistrationOptions, RevocationOptions
from mcp.server.transport_security import TransportSecuritySettings
from starlette.responses import HTMLResponse, RedirectResponse
from starlette.routing import Route

from .oauth import LOGIN_PATH, GravAIOAuthProvider, build_provider
from .server import build_server

log = get_logger("gravai.mcp.http")

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8003
MOUNT_PATH = "/mcp"


class GravAITokenVerifier(TokenVerifier):
    """Validates a bearer token against the platform's own auth.

    Returning `None` is how this SDK says "unauthenticated"; it must not raise,
    or a malformed token becomes a 500 instead of a 401.

    `agents:run` is required here rather than merely recorded. Every tool this
    server exposes runs an agent, so a token without it has no business
    establishing a session at all.
    """

    def __init__(self, *, required_scope: Scope = Scope.AGENTS_RUN) -> None:
        self.required_scope = required_scope

    async def verify_token(self, token: str) -> AccessToken | None:
        try:
            principal: Principal = decode_token(token)
        except Unauthenticated as exc:
            log.info("mcp_auth_rejected", reason=str(exc))
            return None
        except Exception as exc:
            log.warning("mcp_auth_error", error=type(exc).__name__)
            return None

        if not principal.has_scope(self.required_scope):
            log.info(
                "mcp_auth_insufficient_scope",
                subject=principal.subject,
                required=self.required_scope.value,
            )
            return None

        log.info(
            "mcp_session_authorised",
            subject=principal.subject,
            tenant_id=str(principal.tenant_id),
            roles=sorted(role.value for role in principal.roles),
        )
        return AccessToken(
            token=token,
            client_id=principal.subject,
            subject=principal.subject,
            scopes=sorted(scope.value for scope in principal.scopes),
            claims={
                "tenant_id": str(principal.tenant_id),
                "roles": sorted(role.value for role in principal.roles),
            },
        )


#: Every token this server accepts is signed with AUTH_DEV_SECRET, so that
#: secret IS the authentication. Anything a reader of the repository could
#: guess has to be refused, and a blocklist of one exact string is not that:
#: the checked-in .env ships "change-me-local-only-and-make-it-32-bytes", which
#: an equality check against "change-me-local-only" waves straight through.
MIN_SECRET_LENGTH = 32


def _secret_is_unsafe(secret: str) -> str | None:
    """Why this signing key must not be used, or None if it is fine."""
    if not secret:
        return "AUTH_DEV_SECRET is empty"
    if secret.lower().startswith("change-me"):
        return (
            f"AUTH_DEV_SECRET starts with 'change-me' ({secret[:20]}...), a "
            "placeholder from the repository"
        )
    if len(secret) < MIN_SECRET_LENGTH:
        return (
            f"AUTH_DEV_SECRET is {len(secret)} characters; at least "
            f"{MIN_SECRET_LENGTH} are required"
        )
    if len(set(secret)) < 8:
        return "AUTH_DEV_SECRET has too little variety to be random"
    return None


def _refuse_unsafe_configuration() -> None:
    """Stop rather than serve something that only looks protected.

    A server signing with a guessable key is not authenticated, it is
    decorated. Every caller can mint themselves any tenant and any role, and
    because `decode_token` is shared with the REST API, that forgery is
    platform-wide rather than confined to this endpoint. Failing to start is
    far kinder than discovering it later.
    """
    cfg = get_settings()
    if not cfg.use_dev_auth:
        return
    problem = _secret_is_unsafe(cfg.auth_dev_secret)
    if problem:
        raise SystemExit(
            "gravai-mcp-http: refusing to start.\n"
            f"  {problem}.\n"
            "  Anyone who can guess that value forges a token for any tenant "
            "and any role.\n"
            "  Generate one with:  openssl rand -hex 48\n"
            "  Or set OIDC_JWKS_URL to validate against a real provider."
        )


LOGIN_PAGE = """<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect to GravAI</title>
<style>
  body {{ font: 15px/1.55 ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif;
         background: #f7f9fc; color: #101828; display: grid; place-items: center;
         min-height: 100vh; margin: 0; padding: 24px; }}
  .card {{ background: #fff; border: 1px solid #e4e8ef; border-radius: 12px;
           padding: 28px; max-width: 420px; width: 100%;
           box-shadow: 0 1px 2px -1px rgb(20 40 78 / .08), 0 4px 10px -3px rgb(20 40 78 / .07); }}
  h1 {{ font-size: 19px; margin: 0 0 6px; letter-spacing: -.01em; }}
  p {{ color: #475467; margin: 0 0 18px; font-size: 13.5px; }}
  label {{ display: block; font-size: 12.5px; color: #475467; margin-bottom: 6px; }}
  input {{ width: 100%; box-sizing: border-box; padding: 10px 12px; font-size: 14px;
           border: 1px solid #cfd6e0; border-radius: 8px; }}
  input:focus {{ outline: 2px solid #204887; outline-offset: 1px; border-color: #204887; }}
  button {{ margin-top: 14px; width: 100%; padding: 10px; font-size: 14px; font-weight: 600;
            color: #fff; background: #204887; border: 0; border-radius: 8px; cursor: pointer; }}
  button:hover {{ background: #1b3d74; }}
  .err {{ color: #b42318; font-size: 13px; margin: 0 0 14px; }}
  .note {{ color: #667085; font-size: 12px; margin: 16px 0 0; }}
  .dest {{ background: #f7f9fc; border: 1px solid #e4e8ef; border-radius: 8px;
           padding: 10px 12px; font-size: 12.5px; }}
  .dest code {{ font-family: ui-monospace, monospace; color: #204887; word-break: break-all; }}
</style>
<div class="card">
  <h1>Connect to GravAI</h1>
  <p><strong>{client}</strong> is asking to run GravAI agents on your behalf.</p>
  <p class="dest">It will be sent back to <code>{destination}</code>. If you do not
  recognise that, close this page.</p>
  {error}
  <form method="post" action="{login_path}">
    <input type="hidden" name="ticket" value="{ticket}">
    <label for="passphrase">Authorization passphrase</label>
    <input id="passphrase" name="passphrase" type="password" autocomplete="current-password"
           autofocus required>
    <button type="submit">Authorize</button>
  </form>
  <p class="note">Grants the <code>agents:run</code> scope only &mdash; enough to run
  the fourteen agents, and nothing else. It cannot approve decisions or change
  application data.</p>
</div>
"""

EXPIRED_PAGE = """<!doctype html><meta charset="utf-8"><title>Request expired</title>
<body style="font:15px/1.6 system-ui;padding:40px;color:#101828">
<h1 style="font-size:18px">This request has expired</h1>
<p style="color:#475467">Authorization requests are valid for ten minutes and can only be
used once. Start the connection again from your client.</p>"""


def _login_routes(provider: GravAIOAuthProvider) -> list[Route]:
    """The consent screen. A GET shows it; a POST checks the passphrase.

    Deliberately boring: one field, no accounts, no cookies, no session. The
    passphrase is the whole gate, and the ticket it is paired with is consumed
    on success so the page cannot be replayed.
    """

    async def show(request):
        ticket = request.query_params.get("ticket", "")
        entry = provider.pending(ticket)
        if entry is None:
            return HTMLResponse(EXPIRED_PAGE, status_code=400, headers=SECURITY_HEADERS)
        client = await provider.get_client(entry.client_id)
        name = (client.client_name if client else None) or "An MCP client"
        return HTMLResponse(
            LOGIN_PAGE.format(
                client=html.escape(name),
                destination=html.escape(str(entry.params.redirect_uri)),
                error="",
                ticket=html.escape(ticket),
                login_path=LOGIN_PATH,
            ),
            headers=SECURITY_HEADERS,
        )

    async def submit(request):
        form = await request.form()
        ticket = str(form.get("ticket", ""))
        supplied = str(form.get("passphrase", ""))
        entry = provider.pending(ticket)
        if entry is None:
            return HTMLResponse(EXPIRED_PAGE, status_code=400, headers=SECURITY_HEADERS)

        if not provider.check_passphrase(supplied):
            log.info("oauth_login_rejected", client_id=entry.client_id)
            client = await provider.get_client(entry.client_id)
            name = (client.client_name if client else None) or "An MCP client"
            return HTMLResponse(
                LOGIN_PAGE.format(
                    client=html.escape(name),
                    destination=html.escape(str(entry.params.redirect_uri)),
                    error='<p class="err">That passphrase was not correct.</p>',
                    ticket=html.escape(ticket),
                    login_path=LOGIN_PATH,
                ),
                status_code=401,
                headers=SECURITY_HEADERS,
            )

        target = provider.complete_login(ticket)
        if target is None:
            return HTMLResponse(EXPIRED_PAGE, status_code=400, headers=SECURITY_HEADERS)
        log.info("oauth_login_accepted", client_id=entry.client_id)
        return RedirectResponse(target, status_code=302, headers=SECURITY_HEADERS)

    return [
        Route(LOGIN_PATH, endpoint=show, methods=["GET"]),
        Route(LOGIN_PATH, endpoint=submit, methods=["POST"]),
    ]


#: A consent screen that can be framed can be clickjacked, and one that can be
#: cached can be read out of a shared browser later. Caddy adds the site's
#: headers to everything it serves from the credit app, but this page comes
#: from a different backend and inherits none of them.
SECURITY_HEADERS = {
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": (
        "frame-ancestors 'none'; default-src 'self'; style-src 'unsafe-inline'"
    ),
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
}


def build_app(
    *,
    host: str = DEFAULT_HOST,
    port: int = DEFAULT_PORT,
    public_url: str | None = None,
) -> Any:
    """The ASGI app: the same tool surface as stdio, behind a token.

    Both `auth` and `token_verifier` are required, and the pairing is not
    obvious. The SDK guards the route whenever a verifier is supplied, but only
    installs the middleware that CALLS that verifier when `auth` is also set.
    Supplying just the verifier produces a server that refuses everything,
    including valid tokens, which looks like a token bug for a long time.

    `validate_token_resource` stays off: these are the platform's own tokens,
    not RFC 8707 resource-indicator tokens, and turning it on would reject
    every one of them for lacking an audience they were never issued with.
    """
    _refuse_unsafe_configuration()
    # Behind a proxy this is the public HTTPS address; run directly it is the
    # socket actually bound, which is not always the default port.
    bound = f"{host}:{port}"
    url = (public_url or os.environ.get("GRAVAI_MCP_PUBLIC_URL") or f"http://{bound}").rstrip("/")
    public_host = urlparse(url).netloc or host

    # DNS-rebinding protection checks the Host header, and behind a reverse
    # proxy that header carries the PUBLIC name, not the loopback address this
    # process is bound to. Trusting only the bind address rejects every real
    # request with 421 Misdirected Request — after authenticating it, which
    # makes it look like anything but a Host problem. Both names are listed:
    # the public one for proxied traffic, loopback for a local health check.
    # OAuth turns on only when a passphrase is configured. Without one the
    # server keeps its static-bearer behaviour rather than standing up an
    # authorization server with no gate on it, which would let anyone register
    # a client and walk straight through.
    passphrase = os.environ.get("GRAVAI_MCP_AUTH_PASSPHRASE", "")
    provider: GravAIOAuthProvider | None = None
    extra_routes: list[Route] = []
    if passphrase:
        provider = build_provider(
            issuer=url,
            passphrase=passphrase,
            state_dir=Path(os.environ.get("GRAVAI_MCP_STATE_DIR", ".")),
        )
        extra_routes = _login_routes(provider)

    server = build_server()
    return server.streamable_http_app(
        streamable_http_path=MOUNT_PATH,
        host=host,
        transport_security=TransportSecuritySettings(
            allowed_hosts=[public_host, bound, host, "localhost", f"localhost:{port}"],
            allowed_origins=[url, f"http://{bound}"],
        ),
        auth=AuthSettings(
            issuer_url=url,
            resource_server_url=f"{url}{MOUNT_PATH}",
            required_scopes=[Scope.AGENTS_RUN.value],
            validate_token_resource=False,
            client_registration_options=ClientRegistrationOptions(
                enabled=bool(provider),
                valid_scopes=[Scope.AGENTS_RUN.value],
                default_scopes=[Scope.AGENTS_RUN.value],
            ),
            revocation_options=RevocationOptions(enabled=bool(provider)),
        ),
        token_verifier=GravAITokenVerifier(),
        auth_server_provider=provider,
        custom_starlette_routes=extra_routes or None,
        stateless_http=True,
    )


def main() -> None:
    host = os.environ.get("GRAVAI_MCP_HOST", DEFAULT_HOST)
    port = int(os.environ.get("GRAVAI_MCP_PORT", DEFAULT_PORT))

    if host not in {"127.0.0.1", "localhost", "::1"}:
        print(
            f"gravai-mcp-http: binding {host}, which is not loopback. Terminate "
            "TLS in front of this or bearer tokens travel in clear text.",
            file=sys.stderr,
        )

    cfg = get_settings()
    mode = "sandbox" if cfg.sarvam_sandbox else "LIVE"
    if not cfg.use_dev_auth:
        auth = "oidc-rs256"
    elif os.environ.get("GRAVAI_MCP_AUTH_PASSPHRASE"):
        auth = "oauth2.1+bearer"
    else:
        auth = "hs256-shared-secret"
    print(
        f"gravai-mcp-http: {host}:{port}{MOUNT_PATH} | ai={mode} | auth={auth}",
        file=sys.stderr,
    )

    uvicorn.run(build_app(host=host, port=port), host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
