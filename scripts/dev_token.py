"""Mint a local development bearer token.

Refuses to run when APP_ENV=prod: production tokens come from the identity
provider, never from a script in the repository.

    uv run python scripts/dev_token.py --tenant acme --role underwriter
"""

from __future__ import annotations

import argparse
import sys
from datetime import timedelta
from pathlib import Path

from gravai_core.auth import Role, issue_dev_token, scopes_for_roles
from gravai_core.settings import get_settings

# Resolve sibling scripts regardless of how this file was invoked.
sys.path.insert(0, str(Path(__file__).parent))

# Must match scripts/seed.py so the token addresses a tenant that exists.
from seed import _tenant_id


def main() -> None:
    parser = argparse.ArgumentParser(description="Mint a GravAI development token")
    parser.add_argument("--tenant", default="acme", help="tenant slug, e.g. acme or lodestar")
    parser.add_argument(
        "--role",
        action="append",
        default=None,
        help="role name; repeat for several (default: underwriter)",
    )
    parser.add_argument("--subject", default=None, help="token subject (default: <tenant>:dev)")
    parser.add_argument("--ttl", type=int, default=None, help="lifetime in seconds")
    args = parser.parse_args()

    settings = get_settings()
    role_names = args.role or [Role.UNDERWRITER.value]
    roles = [Role(name) for name in role_names]
    tenant_id = _tenant_id(args.tenant)
    subject = args.subject or f"{args.tenant}:dev"

    # --ttl was parsed and printed but never passed, so every token was the
    # default hour while the output claimed otherwise.
    ttl = timedelta(seconds=args.ttl) if args.ttl else None

    token = issue_dev_token(
        tenant_id=tenant_id,
        subject=subject,
        roles=roles,
        settings=settings,
        ttl=ttl,
    )

    print(f"tenant   : {args.tenant} ({tenant_id})")
    print(f"subject  : {subject}")
    print(f"roles    : {', '.join(r.value for r in roles)}")
    print(f"scopes   : {', '.join(sorted(s.value for s in scopes_for_roles(frozenset(roles))))}")
    print(f"expires  : {args.ttl or settings.token_ttl_seconds}s")
    print()
    print(token)
    print()
    print("Use it:")
    print(f'  curl -H "Authorization: Bearer {token[:24]}..." http://localhost:8000/v1/agents')


if __name__ == "__main__":
    main()
