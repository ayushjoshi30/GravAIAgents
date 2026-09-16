"""OAuth 2.1 authorization server for the MCP endpoint.

A static bearer token works for a client you configure by hand. It does not
work for claude.ai, which has nowhere to put one: a remote connector discovers
the server, registers itself, sends a human through a login, and receives its
own credentials. That is what this provides.

The SDK owns the protocol — metadata, `/authorize`, `/token`, `/register`,
`/revoke`, and PKCE verification. This file owns the three decisions the
protocol deliberately leaves to the deployment:

**Who is allowed in.** `authorize()` does NOT mint a code. It redirects to a
login page that demands a passphrase. Without that, dynamic client registration
is an open door: anyone who finds the URL registers a client, completes the
flow unchallenged, and runs agents. The whole point of this file is that the
door has a lock on it.

**What an access token is.** A GravAI JWT, signed with the same secret and
validated by the same `decode_token` the REST API uses. So there is one
definition of identity across both auth modes, and the token verifier already
in `http_server.py` needs no special case.

**What survives a restart.** Registered clients and refresh tokens are written
to disk, because systemd restarts this process and a connector that silently
stopped working after a deploy would be baffling. Authorization codes are held
in memory only: they live sixty seconds and are single-use.
"""

from __future__ import annotations

import contextlib
import json
import os
import secrets
import time
from dataclasses import dataclass, field
from datetime import timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

from gravai_core.auth import Role, Scope, decode_token, issue_dev_token
from gravai_core.telemetry import get_logger
from mcp.server.auth.provider import (
    AccessToken,
    AuthorizationCode,
    AuthorizationParams,
    OAuthAuthorizationServerProvider,
    RefreshToken,
)
from mcp.shared.auth import OAuthClientInformationFull, OAuthToken

log = get_logger("gravai.mcp.oauth")

#: Long enough for a human to read a page and type, short enough to matter.
LOGIN_TTL_SECONDS = 600
#: An authorization code is handed straight back to the client. Sixty seconds
#: is generous for a redirect and leaves almost no window to replay one.
CODE_TTL_SECONDS = 60
ACCESS_TTL_SECONDS = 8 * 3600
REFRESH_TTL_SECONDS = 30 * 24 * 3600
#: However often it rotates, one login is good for this long and no longer.
FAMILY_TTL_SECONDS = 90 * 24 * 3600

LOGIN_PATH = "/mcp-login"

#: The only scope an OAuth client is ever granted.
#:
#: The roles below imply far more than this — underwriter alone carries
#: decisions:approve, which is the authority to sign off a lending decision.
#: `issue_dev_token` intersects this set with what the roles imply, so the
#: token can run agents and do nothing else. Without the narrowing, a consent
#: screen that says "run the fourteen agents" would be handing over a REST
#: credential that can approve credit.
GRANTED_SCOPES = frozenset({Scope.AGENTS_RUN})

#: Fallback roles when GRAVAI_MCP_ROLES is unset. Deliberately not
#: tenant_admin: a remote client should run agents, not administer a tenant.
DEFAULT_ROLES = (Role.UNDERWRITER, Role.COLLECTIONS_MANAGER)


def configured_roles() -> list[Role]:
    """Roles a connector is granted, from GRAVAI_MCP_ROLES.

    The stdio server already reads this variable, and an operator who narrows
    it there reasonably expects the same narrowing here. Hardcoding the roles
    meant the documented knob silently did nothing over OAuth.
    """
    raw = os.environ.get("GRAVAI_MCP_ROLES", "")
    roles: list[Role] = []
    for name in (part.strip() for part in raw.split(",")):
        if not name:
            continue
        try:
            roles.append(Role(name))
        except ValueError:
            log.warning("oauth_unknown_role_ignored", role=name)
    return roles or list(DEFAULT_ROLES)


#: An unauthenticated endpoint that appends to a file rewritten in full on
#: every call is a denial-of-service primitive. Registration stays open — the
#: spec requires it — but it is not unbounded.
MAX_CLIENTS = 200


@dataclass
class _Pending:
    """An authorization request waiting for someone to prove who they are."""

    client_id: str
    params: AuthorizationParams
    created_at: float = field(default_factory=time.monotonic)

    def expired(self) -> bool:
        return time.monotonic() - self.created_at > LOGIN_TTL_SECONDS


class GravAIOAuthProvider(
    OAuthAuthorizationServerProvider[AuthorizationCode, RefreshToken, AccessToken]
):
    """Issues GravAI tokens to clients whose human proved they belong here."""

    def __init__(self, *, issuer: str, passphrase: str, state_dir: Path, tenant_id: str) -> None:
        if not passphrase or len(passphrase) < 16:
            raise ValueError(
                "GRAVAI_MCP_AUTH_PASSPHRASE must be at least 16 characters. It is "
                "the only thing standing between dynamic client registration and "
                "anyone on the internet running your agents."
            )
        self.issuer = issuer.rstrip("/")
        self._passphrase = passphrase
        self.tenant_id = tenant_id
        self._state_path = state_dir / "oauth-state.json"
        self._pending: dict[str, _Pending] = {}
        self._codes: dict[str, AuthorizationCode] = {}
        self._clients: dict[str, dict[str, Any]] = {}
        self._refresh: dict[str, dict[str, Any]] = {}
        #: Families whose token has already been rotated once.
        self._burned: set[str] = set()
        self._load()

    # --- persistence ----------------------------------------------------

    def _load(self) -> None:
        if not self._state_path.exists():
            return
        try:
            raw = json.loads(self._state_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            log.warning("oauth_state_unreadable", error=str(exc))
            return
        self._clients = raw.get("clients", {})
        self._refresh = {
            token: meta
            for token, meta in raw.get("refresh", {}).items()
            if meta.get("expires_at", 0) > time.time()
            and meta.get("family_expires_at", float("inf")) > time.time()
        }
        log.info("oauth_state_loaded", clients=len(self._clients), refresh=len(self._refresh))

    def _save(self) -> None:
        self._state_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"clients": self._clients, "refresh": self._refresh}
        tmp = self._state_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        tmp.replace(self._state_path)
        # Refresh tokens are credentials; nobody else on the box needs them.
        with contextlib.suppress(OSError):
            self._state_path.chmod(0o600)

    # --- dynamic client registration ------------------------------------

    async def get_client(self, client_id: str) -> OAuthClientInformationFull | None:
        raw = self._clients.get(client_id)
        return OAuthClientInformationFull.model_validate(raw) if raw else None

    async def register_client(self, client_info: OAuthClientInformationFull) -> None:
        """Accept a new client.

        Registration is open by design — that is how a remote connector
        onboards itself, and it is what the spec requires. Registration alone
        grants nothing: the client still cannot obtain a token without a human
        passing the login gate below.
        """
        if len(self._clients) >= MAX_CLIENTS and client_info.client_id not in self._clients:
            log.warning("oauth_registration_refused", registered=len(self._clients))
            raise ValueError(f"This server holds the maximum of {MAX_CLIENTS} registered clients.")
        self._clients[client_info.client_id] = client_info.model_dump(mode="json")
        self._save()
        log.info(
            "oauth_client_registered",
            client_id=client_info.client_id,
            name=client_info.client_name,
            redirect_uris=[str(u) for u in client_info.redirect_uris or []],
        )

    # --- authorization --------------------------------------------------

    async def authorize(
        self, client: OAuthClientInformationFull, params: AuthorizationParams
    ) -> str:
        """Send the human to a login page rather than issuing a code.

        Returning a redirect straight back to the client here — which is the
        shortest implementation and the one most examples show — would mean any
        registered client gets a token for the asking. The ticket below is
        opaque and short-lived; the code is only minted once the passphrase has
        been checked.
        """
        self._sweep()

        # Registration is open, so an attacker can register a client whose
        # redirect_uri points at them. Checking the destination against what
        # this client declared is what stops /authorize being an open redirect
        # and, worse, a way to have a code delivered elsewhere.
        registered = {str(uri) for uri in (client.redirect_uris or [])}
        if registered and str(params.redirect_uri) not in registered:
            log.warning(
                "oauth_redirect_uri_rejected",
                client_id=client.client_id,
                requested=str(params.redirect_uri),
            )
            raise ValueError("redirect_uri does not match a registered redirect URI")

        ticket = secrets.token_urlsafe(32)
        self._pending[ticket] = _Pending(client_id=client.client_id, params=params)
        log.info("oauth_login_required", client_id=client.client_id)
        return f"{self.issuer}{LOGIN_PATH}?{urlencode({'ticket': ticket})}"

    def check_passphrase(self, supplied: str) -> bool:
        """Constant-time, so a wrong answer leaks nothing about the right one."""
        return secrets.compare_digest(supplied.strip(), self._passphrase)

    def pending(self, ticket: str) -> _Pending | None:
        self._sweep()
        return self._pending.get(ticket)

    def complete_login(self, ticket: str) -> str | None:
        """Passphrase accepted: mint the code and return where to send them.

        The ticket is consumed here, so a replayed login page POST cannot
        produce a second code.
        """
        entry = self._pending.pop(ticket, None)
        if entry is None or entry.expired():
            return None

        code = secrets.token_urlsafe(32)
        params = entry.params
        self._codes[code] = AuthorizationCode(
            code=code,
            scopes=params.scopes or [],
            expires_at=time.time() + CODE_TTL_SECONDS,
            client_id=entry.client_id,
            code_challenge=params.code_challenge,
            redirect_uri=params.redirect_uri,
            redirect_uri_provided_explicitly=params.redirect_uri_provided_explicitly,
            resource=params.resource,
        )
        log.info("oauth_code_issued", client_id=entry.client_id)

        query = {"code": code}
        if params.state:
            query["state"] = params.state
        separator = "&" if "?" in str(params.redirect_uri) else "?"
        return f"{params.redirect_uri}{separator}{urlencode(query)}"

    async def load_authorization_code(
        self, client: OAuthClientInformationFull, authorization_code: str
    ) -> AuthorizationCode | None:
        entry = self._codes.get(authorization_code)
        if entry is None:
            return None
        if entry.expires_at < time.time():
            self._codes.pop(authorization_code, None)
            return None
        # A code belongs to the client it was issued to. Without this check a
        # second registered client could redeem someone else's code.
        if entry.client_id != client.client_id:
            log.warning("oauth_code_client_mismatch", client_id=client.client_id)
            return None
        return entry

    async def exchange_authorization_code(
        self, client: OAuthClientInformationFull, authorization_code: AuthorizationCode
    ) -> OAuthToken:
        """Single use: the code is destroyed whether or not the rest succeeds."""
        self._codes.pop(authorization_code.code, None)
        return self._issue(client.client_id, authorization_code.scopes)

    # --- tokens ----------------------------------------------------------

    def _issue(
        self,
        client_id: str,
        scopes: list[str],
        *,
        family: str | None = None,
        family_expires_at: float | None = None,
    ) -> OAuthToken:
        """Mint a GravAI JWT, so one `decode_token` validates every path."""
        access = issue_dev_token(
            tenant_id=self.tenant_id,
            subject=f"oauth:{client_id}",
            roles=configured_roles(),
            ttl=timedelta(seconds=ACCESS_TTL_SECONDS),
            scopes=GRANTED_SCOPES,
        )
        refresh = secrets.token_urlsafe(48)
        self._refresh[refresh] = {
            "client_id": client_id,
            "scopes": scopes,
            "expires_at": time.time() + REFRESH_TTL_SECONDS,
            # An absolute ceiling, so rotating forever cannot turn one login
            # into permanent access.
            "family_expires_at": family_expires_at or time.time() + FAMILY_TTL_SECONDS,
            "family": family or secrets.token_urlsafe(16),
        }
        self._save()
        return OAuthToken(
            access_token=access,
            token_type="Bearer",
            expires_in=ACCESS_TTL_SECONDS,
            scope=" ".join(scopes) if scopes else None,
            refresh_token=refresh,
        )

    async def load_refresh_token(
        self, client: OAuthClientInformationFull, refresh_token: str
    ) -> RefreshToken | None:
        meta = self._refresh.get(refresh_token)
        if meta is None or meta["expires_at"] < time.time():
            self._refresh.pop(refresh_token, None)
            return None
        if meta["client_id"] != client.client_id:
            log.warning("oauth_refresh_client_mismatch", client_id=client.client_id)
            return None
        return RefreshToken(
            token=refresh_token,
            client_id=meta["client_id"],
            scopes=meta.get("scopes", []),
            expires_at=int(meta["expires_at"]),
        )

    async def exchange_refresh_token(
        self,
        client: OAuthClientInformationFull,
        refresh_token: RefreshToken,
        scopes: list[str],
    ) -> OAuthToken:
        """Rotated, not reused, and reuse burns the whole family.

        Rotation alone means a stolen token works once. If the thief uses it
        before the legitimate holder does, the holder's next refresh reveals
        that a rotated token was replayed — and the only safe reading of that
        is that the chain is compromised, so every token descended from the
        same login is dropped.
        """
        meta = self._refresh.pop(refresh_token.token, None)
        family = (meta or {}).get("family")
        family_expires_at = (meta or {}).get("family_expires_at")

        if family and family in self._burned:
            log.warning("oauth_refresh_replayed", client_id=client.client_id)
            self._revoke_family(family)
            raise ValueError("refresh token replayed; this authorization has been revoked")

        if family:
            self._burned.add(family)

        return self._issue(
            client.client_id,
            scopes or refresh_token.scopes,
            family=family,
            family_expires_at=family_expires_at,
        )

    def _revoke_family(self, family: str) -> None:
        for token, meta in list(self._refresh.items()):
            if meta.get("family") == family:
                self._refresh.pop(token, None)
        self._save()

    async def load_access_token(self, token: str) -> AccessToken | None:
        try:
            principal = decode_token(token)
        except Exception:
            return None
        return AccessToken(
            token=token,
            client_id=principal.subject,
            subject=principal.subject,
            scopes=sorted(scope.value for scope in principal.scopes),
            claims={"tenant_id": str(principal.tenant_id)},
        )

    async def revoke_token(self, token: AccessToken | RefreshToken) -> None:
        """Refresh tokens can be revoked; issued JWTs expire on their own."""
        self._refresh.pop(getattr(token, "token", ""), None)
        self._save()

    async def exchange_identity_assertion(self, client: Any, params: Any) -> OAuthToken:
        raise NotImplementedError("identity assertion is not enabled")

    # --- housekeeping ----------------------------------------------------

    def _sweep(self) -> None:
        now = time.time()
        for ticket, entry in list(self._pending.items()):
            if entry.expired():
                self._pending.pop(ticket, None)
        for code, entry in list(self._codes.items()):
            if entry.expires_at < now:
                self._codes.pop(code, None)


#: Which tenant an OAuth client acts as. Every GravAI token carries a tenant —
#: there is no such thing as a tenant-less request — and stdio takes this from
#: configuration for the same reason. Override with GRAVAI_MCP_TENANT_ID.
DEFAULT_TENANT_ID = "1185b782-3c7a-5ae6-89ca-ce9ecfe534d3"  # acme, from scripts/seed.py


def build_provider(
    *, issuer: str, passphrase: str, state_dir: Path, tenant_id: str | None = None
) -> GravAIOAuthProvider:
    return GravAIOAuthProvider(
        issuer=issuer,
        passphrase=passphrase,
        state_dir=state_dir,
        tenant_id=tenant_id or os.environ.get("GRAVAI_MCP_TENANT_ID") or DEFAULT_TENANT_ID,
    )
