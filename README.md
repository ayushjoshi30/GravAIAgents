# GravAI

The AI agent layer for the **Graviton** lending platform. Multi-tenant, audited,
and powered end to end by **Sarvam AI** — LLM, Document Intelligence, speech and
translation. Agents are callable three ways: from Graviton over REST, from any
model host over **MCP**, and from the GravAI console.

> Full specification: [`GRAVAI_SPEC.md`](./GRAVAI_SPEC.md). Assumptions log:
> [`DECISIONS.md`](./DECISIONS.md). Build status: **Phase 0 complete.**

---

## Quickstart (no Docker, no infrastructure)

```bash
uv sync                       # create .venv and install the workspace
cp .env.example .env          # SQLite + SANDBOX defaults; nothing to configure
uv run alembic upgrade head   # create the schema
uv run python scripts/seed.py # 2 tenants, roles, users, rate card, demo applications
uv run pytest                 # the test suite
uv run uvicorn gravai_api.main:app --reload --port 8000
```

Then open <http://localhost:8000/docs> for the OpenAPI UI and
<http://localhost:8000/healthz> for health.

`uv` lives at `%LOCALAPPDATA%\Programs\Python\Python313\Scripts\uv.exe` on this
machine — add that directory to `PATH`, or call the executable by full path.

## What runs without infrastructure

| Capability | Local default | Production |
|---|---|---|
| Database | SQLite (`gravai.db`) | PostgreSQL 16 + row-level security |
| Tenant isolation | Service layer | Service layer **and** RLS |
| AI calls | SANDBOX — recorded fixtures, zero spend | Sarvam APIs |
| Orchestration | In-process | Temporal |
| Rate governor | In-memory token bucket | Redis token bucket |
| Auth | HS256 dev tokens | OIDC / RS256 via JWKS |

Nothing is mocked away: the same code paths run in both modes, selected by
configuration. See [`DECISIONS.md`](./DECISIONS.md) D-002 and D-003.

## Turning on PostgreSQL (when you want RLS)

```bash
# in .env
DATABASE_URL=postgresql+asyncpg://gravai:gravai@localhost:5432/gravai
```

```bash
uv run alembic upgrade head   # now also creates RLS policies
uv run pytest                 # the @pytest.mark.postgres tests stop skipping
```

## Layout

```
apps/api          FastAPI REST API, OpenAPI, health
apps/mcp          remote MCP server (Streamable HTTP, OAuth2)
apps/worker       Temporal workers: agent workflows and activities
apps/web          Next.js site: marketing, docs, console
packages/
  gravai_core        settings, tenancy, auth, audit, PII, money, time, db, events
  gravai_sarvam      Sarvam clients, job poller, rate governor, cost ledger, sandbox
  gravai_agents      agent registry, prompts, schemas, guardrails
  gravai_connectors  graviton, bre, digilocker, aa (sandbox), telephony, notification
  gravai_evals       golden sets, metrics, runners, red-team suites
migrations        Alembic
scripts           seed, cassette recorder
tests             unit (always run) + integration (marked, auto-skip)
```

## Commands

| Task | Command |
|---|---|
| Install | `uv sync` |
| Migrate | `uv run alembic upgrade head` |
| Seed | `uv run python scripts/seed.py` |
| Test | `uv run pytest` |
| Coverage | `uv run pytest --cov=packages --cov-report=term-missing` |
| Lint | `uv run ruff check . && uv run ruff format --check .` |
| Types | `uv run mypy packages` |
| API | `uv run uvicorn gravai_api.main:app --reload --port 8000` |
| Mint a dev token | `uv run python scripts/dev_token.py --tenant acme --role underwriter` |

A `justfile` wraps all of these if you have [`just`](https://github.com/casey/just).

## The ten rules

1. Sarvam is the only AI provider in runtime code.
2. Fixed stack — no substitutions.
3. Multi-tenant isolation in the service layer and in the database, proven by tests.
4. No invented numbers: cite the source or return `null` with a reason.
5. PII minimisation; Aadhaar masked to the last 4 digits, never stored in full.
6. Human-in-the-loop for credit decisions, deviations, adverse actions.
7. Document Intelligence: back-off on both paths, shared quota, 10 req/min governor.
8. Audit everything into an append-only, hash-chained log.
9. Tests never spend Sarvam quota.
10. No TODOs in production paths.

## Licence

Proprietary — see [`LICENSE`](./LICENSE).
