# Contributing to GravAI

## Setup

```bash
uv sync
cp .env.example .env
uv run alembic upgrade head
uv run python scripts/seed.py
uv run pytest
```

`uv` on this machine lives at
`%LOCALAPPDATA%\Programs\Python\Python313\Scripts\uv.exe`.

## The ten rules

They are in [`README.md`](./README.md) and they override style preferences,
convenience and personal taste. The three most often violated by accident:

1. **Sarvam is the only AI provider.** Importing `openai`, `anthropic`,
   `google.generativeai` or similar in a runtime path fails the build.
2. **No invented numbers.** If a value cannot be read or computed from a cited
   source, return `null` with a reason. This applies to code and to prompts.
3. **No TODOs in production paths.** Something unimplemented is absent, not
   faked. Record the assumption in `DECISIONS.md` instead.

## Before you push

```bash
uv run ruff format .
uv run ruff check --fix .
uv run mypy packages
uv run pytest
```

All four must be clean. Coverage on `packages/` must not fall below 85%.

## Writing tests

- **Unit tests never touch the network and never spend Sarvam quota.** The suite
  forces `SARVAM_SANDBOX=1` and a throwaway SQLite database in `tests/conftest.py`.
- **Tests that need PostgreSQL** are marked `@pytest.mark.postgres` and skip
  automatically. Run them before any deployment:
  ```bash
  DATABASE_URL=postgresql+asyncpg://gravai:gravai@localhost:5432/gravai uv run pytest
  ```
- **Assert the number, not the shape.** The platform's capacity plan rests on
  figures like "a 30-second job costs 10 polls" and "one extracted document is 12
  API calls". Those are pinned by tests precisely so a quiet change to the
  back-off schedule cannot silently invalidate the plan.
- **Every tenant-scoped feature needs an isolation test.** Creating a row as one
  tenant and failing to read it as another is the minimum.

## Assumptions

Never stop work to ask a question. Choose the option that best fits the spec's
stated intent, record it in `DECISIONS.md` in the documented format, and keep
going. Entries marked **OPEN** are questions for Sarvam or a regulator and must
be resolved before production, not before the next commit.

## Commits

Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`).
One commit per completed phase minimum, with a `CHANGELOG.md` entry.

## Migrations

```bash
uv run alembic revision --autogenerate -m "add thing"
uv run alembic upgrade head
```

Any new tenant-scoped table must be added to `TENANT_SCOPED_TABLES` in
`gravai_core/models.py` **and** given a row-level security policy in the
migration, or it will be protected on SQLite exactly as much as it is on
PostgreSQL — which is to say, not at all.
