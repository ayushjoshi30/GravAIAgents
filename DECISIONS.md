# DECISIONS.md

Every assumption made while building GravAI, recorded instead of blocking.
Format: `D-nnn | date | area | Decision | Rationale | Alternatives | Verify-with | Reversible?`

---

**D-001 | 2026-09-14 | Runtime | Target Python >=3.12, run on 3.13.6**
The spec names Python 3.12; the machine has 3.13.6 and every pinned dependency
supports it. `requires-python = ">=3.12"` keeps 3.12 valid for CI images.
*Alternatives:* install 3.12 alongside — rejected as unnecessary friction.
*Verify-with:* CI matrix on 3.12 and 3.13. *Reversible:* yes.

**D-002 | 2026-09-14 | Database | SQLite fallback for local, PostgreSQL for real**
`DATABASE_URL` defaults to `sqlite+aiosqlite` so the platform runs with zero
infrastructure (the user asked to build locally and add Docker later). All models
use dialect-portable types (`sqlalchemy.Uuid`, `JSON`) so the same schema runs on
both. Row-level security is PostgreSQL-only and is applied conditionally by the
baseline migration.
*Consequence:* on SQLite, tenant isolation rests on the service layer alone; on
PostgreSQL it is service layer **plus** RLS (defence in depth). Tests reflect this:
service-layer isolation always runs, RLS tests are marked `@pytest.mark.postgres`
and auto-skip without a live PostgreSQL.
*Verify-with:* run the suite against PostgreSQL before any deployment.
*Reversible:* yes — change one env var.

**D-003 | 2026-09-14 | Auth | HS256 dev tokens, RS256/JWKS in production**
When `OIDC_JWKS_URL` is empty the platform validates HS256 tokens signed with
`AUTH_DEV_SECRET`, so local development needs no identity provider. When the JWKS
URL is set, validation switches to RS256 against the provider's keys and the dev
secret is refused outright.
*Verify-with:* staging must set `OIDC_JWKS_URL`; a startup check fails the boot if
`APP_ENV=prod` and the dev path is active. *Reversible:* yes.

**D-004 | 2026-09-14 | Sarvam | Document Intelligence endpoint paths are configurable**
The paths `/doc-ai/v1/job/{extract,digitise}` and the status/results paths come from
the owner's observed production traffic, not from confirmed public documentation.
They are environment variables so a correction needs no code change.
*Verify-with:* Sarvam dashboard/API docs and the tenant's contract. **OPEN.**
*Reversible:* yes.

**D-005 | 2026-09-14 | Sarvam | Assume status polls DO count against the rate limit**
`SARVAM_DOCAI_POLLS_COUNT_TOWARD_LIMIT=true` by default. This is the conservative
reading: if polls are actually free, throughput rises roughly 10x and nothing
breaks. The opposite assumption would silently overrun the limit.
*Verify-with:* Sarvam support — this is the single highest-value question to ask.
**OPEN.** *Reversible:* yes — one env var.

**D-006 | 2026-09-14 | Sarvam | Back-off applied to BOTH extract and digitise**
Production code previously polled `digitise` at a flat 0.8s with no back-off (37
polls on a 30s job) while `extract` backed off to ~10 polls. GravAI applies the
same schedule (0.8s first, x1.35 growth, 5.0s cap) to both paths, cutting digitise
from ~40 calls/document to ~13.
*Verify-with:* confirm with Sarvam that the status endpoint tolerates back-off on
the digitise path. **OPEN.** *Reversible:* yes.

**D-007 | 2026-09-14 | Sarvam | Model ids are placeholders pending confirmation**
`SARVAM_MODEL_REASONING` defaults to `sarvam-m`. The owner's production pipeline
uses a larger model referred to as "105B"; its exact API identifier must be read
from the existing `readers/sarvam.py` or the Sarvam dashboard and set in `.env`.
No model id is hardcoded anywhere in the source.
*Verify-with:* existing production code / Sarvam dashboard. **OPEN.**
*Reversible:* yes.

**D-013 | 2026-09-14 | Connectors | The AA agent is real; the AA transport is not**
`aa_data` fetches consented bank data and normalises it into exactly the shape
`bank_statement_analytics` already consumes, so a file sourced through Account
Aggregator underwrites identically to one built from uploaded PDFs — proven by a
test that runs both paths to the same income, obligation and bounce figures.
Everything except the transport is real: the ReBIT consent artefact, status and
expiry rules, purpose limitation, fetch-frequency exhaustion, retention expiry.
*The gap:* fetching real FI data requires registration as a Financial
Information User behind a licensed AA, or a TSP arrangement. That is contractual,
not technical. Sandbox fetches set `live_data=false` and **always escalate**, so
fixture data cannot underwrite a real decision.
*Consequence:* the day an AA is contracted, only `SandboxAccountAggregator.fetch`
is replaced. Nothing downstream changes. *Reversible:* yes.

**D-012 | 2026-09-14 | Sarvam | Four corrections after verifying the live API**
Documentation research against the provider's own reference confirmed the four
Doc AI paths, the `api-subscription-key` header, and — verbatim — the 10 req/min
Document Intelligence limit uniform across plan tiers, closing the open half of
D-004. It also found four things wrong, each of which would have failed against
the live service while passing every sandbox test:
1. **`sarvam-m` was withdrawn** and returns a hard deprecation error. The model
   is `sarvam-105b`, which closes D-007. There is no cheaper chat tier — both
   model roles are the same model at the same price, so `SARVAM_MODEL_FAST`
   cannot be used as a cost lever with this provider.
2. **Submission is `multipart/form-data`** with a `file` part or `upload_ids`,
   exactly one. There is no `document_url` field; the JSON body the client sent
   would never have worked.
3. **There is no page-range parameter**, and a job takes at most ten pages.
   Longer documents are split client-side (`gravai_sarvam.batching`), which also
   means a twelve-page bank statement is *two* jobs — 24 API calls, not 12. The
   capacity model now accounts for this.
4. **`schema` is a serialised JSON Schema string**, not prose. The same field
   list now renders two ways: a schema for the extractor, a sentence for the
   model that reads digitised text.
*Verify-with:* `tests/test_document_submission.py` pins all four. The remaining
unknown is D-005 — whether status polls consume the rate limit — which is not
documented anywhere and needs the live probe. *Reversible:* yes.

**D-011 | 2026-09-14 | Brand | The GravAI mark is derived from the Graviton wordmark**
The supplied `GRAVITON` SVG contains every letter `GravAI` needs. The G, R, A and
V keep their original coordinates; the second A and the I are the same outlines
translated `+39.7` and `+21.6` along the baseline. Both resulting gaps (9.47 and
8.42) are taken from the source mark's own spacing, so the `GRAV | AI` split
still reads in a single colour. Colour carries the meaning: GRAV in Graviton
blue, AI in the platform teal — the platform you have, and the layer on top.
*Corrected:* the brand blue is **`#204887`**, read from the supplied file. §7.1 of
`GRAVAI_SPEC.md` guessed `#2F3F8F` before the asset existed; the real file wins
and the token is updated.
*Alternatives:* setting the name in Fraunces or another typeface — rejected,
because it would break the visual lineage that makes GravAI legible as a
Graviton product rather than a separate brand.
*Verify-with:* `brand/contact-sheet.html`. *Reversible:* yes, but it should not be.

**D-010 | 2026-09-14 | Audit | Timestamps are canonicalised before hashing**
The audit digest formats `recorded_at` through `canonical_timestamp()` — coerce
naive to UTC, convert to UTC, render `%Y-%m-%dT%H:%M:%S.%fZ` — rather than
calling `isoformat()`. Found by a failing test: PostgreSQL `timestamptz` returns
an aware datetime while SQLite returns a naive one, so the digest computed on
write did not match the digest recomputed on read, and **every chain failed
verification after a reload**. Canonicalising makes the hash independent of how
a dialect chose to store the value.
*Consequence:* the hash format is now frozen. Changing it invalidates every
existing chain, so it is versioned with the chain, not edited in place.
*Verify-with:* `test_timestamp_hashing_survives_a_storage_round_trip`.
*Reversible:* no.

**D-009 | 2026-09-14 | Runtime | `tzdata` is a hard dependency**
The platform resolves `Asia/Kolkata` at import time, because every business date
and every collections calling window is evaluated in IST. Linux containers carry
a system zoneinfo database; Windows does not, so `ZoneInfo("Asia/Kolkata")`
raises `ZoneInfoNotFoundError` on a developer machine. Pinning `tzdata` makes the
behaviour identical on both rather than "works in CI, fails on the laptop".
*Alternatives:* a fixed UTC+5:30 offset — rejected, it silently hardcodes an
assumption about a timezone that has changed before and would be wrong for any
future rule change. *Reversible:* yes.

**D-008 | 2026-09-14 | Audit | Hash chain is per tenant, not global**
`audit_log` chains each tenant's events independently (`prev_hash` of the previous
row for that tenant). A global chain would serialise all writes across tenants and
leak activity volume between them.
*Alternatives:* global chain (rejected: contention + cross-tenant inference),
per-entity chain (rejected: too granular to prove completeness).
*Verify-with:* the chain-verification test and the console's verify button.
*Reversible:* no — changing it invalidates existing chains.
