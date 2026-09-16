# Changelog

All notable changes to GravAI. Format follows [Keep a Changelog]; the project
uses conventional commits and one entry per completed phase.

[Keep a Changelog]: https://keepachangelog.com/en/1.1.0/

## [0.1.0] — 2026-09-14 — Phase 0: Skeleton

The foundation every later phase builds on. Runs with no infrastructure: SQLite,
in-memory rate governor, SANDBOX mode, HS256 dev tokens.

### Added

- **Monorepo** — `uv` workspace with five packages (`gravai_core`,
  `gravai_sarvam`, `gravai_agents`, `gravai_connectors`, `gravai_evals`) and
  three apps (`api`, `mcp`, `worker`).
- **`gravai_core`** — settings with the Document Intelligence cost model;
  error taxonomy; tenant context; OIDC/HS256 auth with roles and scopes;
  append-only hash-chained audit log; PII masking, validation and redaction;
  Indian currency formatting and EMI/FOIR/LTV arithmetic; IST time handling and
  collections calling windows; async SQLAlchemy with tenant-bound sessions;
  structured logging and optional OTLP tracing.
- **`gravai_sarvam`** — rate governor enforcing the 10 req/min Document
  Intelligence ceiling, with continuous-refill token buckets and weighted
  round-robin fair sharing across tenants.
- **`gravai_agents`** — the 13-agent catalog (3 P0, 7 P1, 3 P2) as the single
  source of truth read by the API, the MCP server and the docs.
- **`gravai_connectors`** — connector registry that reports readiness honestly,
  including Account Aggregator as an external dependency rather than a build task.
- **`gravai_evals`** — promotion gates per agent, agreed before any prompt exists.
- **REST API** — health and readiness, agent catalog, tenant-scoped applications
  with FOIR/LTV computation, audit listing and chain verification, connector
  status. RFC 9457 problem documents with correlation ids.
- **MCP tool contract** — 17 systems-as-tools and 13 agents-as-tools with JSON
  schemas, read-only/destructive annotations and scope-filtered visibility.
- **Worker** — Temporal task queues and per-activity retry policy.
- **Migrations** — baseline schema; on PostgreSQL also row-level security on
  every tenant-scoped table and an append-only trigger on `audit_log`.
- **Seed** — two tenants (including the large one), eight roles, twelve users,
  a versioned rate card and demo applications.
- **Tests** — 139 passing, 5 PostgreSQL-only tests skipping cleanly on SQLite.

### Fixed

- **Audit chain broke on reload.** The digest hashed `isoformat()`, which
  differs between PostgreSQL (aware) and SQLite (naive), so a chain written and
  then re-read never verified. Timestamps are now canonicalised (D-010).
- **Rate governor starved small tenants.** The fair-share ring rotated even when
  no token was available, so whichever tenant happened to be at the head when a
  token arrived won every time. Rotation now advances only after an actual
  release.
- **Token bucket never refilled when the clock read 0.0.** `0.0` was used as both
  "never refilled" and a legitimate timestamp; an event loop clock starts near
  zero, so refilling was silently disabled.

### Known gaps (scheduled, not forgotten)

- Sarvam clients (chat, speech, documents) — Phase 1.
- Agent prompts, schemas and Temporal workflows — Phases 1–3.
- MCP served over Streamable HTTP with OAuth2 — Phase 1 (contract defined here).
- Web console and marketing site — Phases 1 and 3.
- Account Aggregator rail — external dependency; requires a licensed AA or TSP.
