"""Settings and the Document Intelligence cost model.

These tests pin the numbers the whole platform is shaped around. If the poll
schedule changes, the calls-per-document figure changes, and the capacity plan
changes with it — so the arithmetic is asserted, not assumed.
"""

from __future__ import annotations

import pytest
from gravai_core.settings import PollSchedule, Settings

PRODUCTION_SCHEDULE = PollSchedule(first=0.8, growth=1.35, cap=5.0, max_wall_clock=180.0)


def test_thirty_second_job_costs_ten_polls() -> None:
    """The production back-off reaches ~10 polls on a ~30s job.

    This is the observed behaviour of the existing extract client and the basis
    for "one document is twelve API calls".
    """
    assert PRODUCTION_SCHEDULE.expected_polls(30.0) == 10


def test_poll_delays_are_capped() -> None:
    """Delays grow geometrically and then flatten at the ceiling."""
    delays = []
    for index, delay in enumerate(PRODUCTION_SCHEDULE.delays()):
        delays.append(delay)
        if index >= 20:
            break
    assert delays[0] == pytest.approx(0.8)
    assert delays[1] == pytest.approx(0.8 * 1.35)
    assert max(delays) <= 5.0
    assert delays[-1] == pytest.approx(5.0)


def test_a_flat_poll_costs_far_more_than_backoff() -> None:
    """Why D-006 exists: no back-off is 37 polls where back-off is 10.

    The digitise path previously polled at a flat 0.8s. On the same 30s job that
    is 38 polls against 10 — the difference between ~40 calls per document and 13.
    (The production analysis recorded 37; the one-poll difference is a rounding
    convention on where the job lands, and does not change the conclusion.)
    """
    flat = PollSchedule(first=0.8, growth=1.0, cap=0.8, max_wall_clock=180.0)
    assert flat.expected_polls(30.0) == 38
    assert PRODUCTION_SCHEDULE.expected_polls(30.0) == 10
    assert flat.expected_polls(30.0) > 3 * PRODUCTION_SCHEDULE.expected_polls(30.0)


def test_extract_costs_twelve_calls_per_document() -> None:
    """submit + 10 polls + results = 12."""
    settings = Settings(sarvam_api_key="")
    assert settings.docai_calls_per_document(30.0, digitise=False) == 12


def test_digitise_costs_one_more_call_for_the_llm_read() -> None:
    """Digitise returns text, so something must read it: 13 calls, not 12."""
    settings = Settings(sarvam_api_key="")
    assert settings.docai_calls_per_document(30.0, digitise=True) == 13


def test_quota_units_count_polls_by_default() -> None:
    """The conservative default assumes status polls consume the 10/min bucket."""
    settings = Settings(sarvam_api_key="", sarvam_docai_polls_count_toward_limit=True)
    assert settings.docai_quota_units_per_document(30.0, digitise=False) == 12


def test_quota_units_drop_to_one_if_polls_are_free() -> None:
    """If Sarvam confirms polls are free, throughput rises about twelve-fold.

    This is the single highest-value question to put to the vendor (D-005).
    """
    settings = Settings(sarvam_api_key="", sarvam_docai_polls_count_toward_limit=False)
    assert settings.docai_quota_units_per_document(30.0, digitise=False) == 1


def test_llm_read_is_not_charged_to_the_document_quota() -> None:
    """The extra digitise LLM call draws on a different product's limit."""
    settings = Settings(sarvam_api_key="")
    assert settings.docai_quota_units_per_document(
        30.0, digitise=True
    ) == settings.docai_quota_units_per_document(30.0, digitise=False)


def test_missing_api_key_forces_sandbox() -> None:
    """A fresh checkout cannot accidentally attempt a billable call."""
    settings = Settings(sarvam_api_key="", sarvam_sandbox=False)
    assert settings.sarvam_sandbox is True


def test_api_key_allows_live_mode() -> None:
    settings = Settings(sarvam_api_key="sk-test", sarvam_sandbox=False)
    assert settings.sarvam_sandbox is False


def test_production_refuses_the_dev_auth_path() -> None:
    """Production must use a real identity provider."""
    with pytest.raises(ValueError, match="OIDC_JWKS_URL"):
        Settings(app_env="prod", oidc_jwks_url="")


def test_production_accepts_a_jwks_url() -> None:
    settings = Settings(app_env="prod", oidc_jwks_url="https://idp.example.in/jwks")
    assert settings.use_dev_auth is False


def test_rls_is_reported_only_for_postgres() -> None:
    """Row-level security is a PostgreSQL feature; SQLite must not claim it."""
    sqlite = Settings(database_url="sqlite+aiosqlite:///./x.db")
    postgres = Settings(database_url="postgresql+asyncpg://u:p@localhost/db")
    assert sqlite.rls_available is False
    assert postgres.rls_available is True
