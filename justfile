# GravAI task runner. Requires `just` (https://github.com/casey/just).
# Every recipe has a plain `uv run ...` equivalent documented in README.md.

set windows-shell := ["powershell.exe", "-NoLogo", "-NoProfile", "-Command"]

default:
    @just --list

# Install the workspace into .venv
install:
    uv sync

# Apply database migrations
migrate:
    uv run alembic upgrade head

# Generate a new migration: just revision "add foo"
revision message:
    uv run alembic revision --autogenerate -m "{{message}}"

# Seed 2 tenants, roles, users, rate card, demo applications
seed:
    uv run python scripts/seed.py

# Fresh local database from scratch
reset:
    -rm gravai.db
    uv run alembic upgrade head
    uv run python scripts/seed.py

# Run the test suite
test:
    uv run pytest

# Tests with coverage
cov:
    uv run pytest --cov=packages --cov-report=term-missing --cov-report=xml

# Lint and format check
lint:
    uv run ruff check .
    uv run ruff format --check .

# Autofix lint and format
fmt:
    uv run ruff check --fix .
    uv run ruff format .

# Static type check
types:
    uv run mypy packages

# Everything CI runs
check: lint types test

# Run the REST API
api:
    uv run uvicorn gravai_api.main:app --reload --port 8000

# Run the MCP server
mcp:
    uv run uvicorn gravai_mcp.main:app --reload --port 8001

# Mint a local dev JWT
token tenant="acme" role="underwriter":
    uv run python scripts/dev_token.py --tenant {{tenant}} --role {{role}}
