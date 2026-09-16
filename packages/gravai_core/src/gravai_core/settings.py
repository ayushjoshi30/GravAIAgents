"""Application settings.

Every configurable value the platform needs lives here, so no other module reads
``os.environ`` directly. Settings are cached; tests that mutate the environment
should call ``get_settings.cache_clear()``.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from functools import lru_cache
from typing import Literal

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

Environment = Literal["local", "dev", "staging", "prod"]


@dataclass(frozen=True, slots=True)
class PollSchedule:
    """Back-off schedule for Sarvam Document Intelligence status polling.

    Applied to **both** the extract and digitise paths. Production code
    previously polled digitise at a flat 0.8s with no back-off, costing 37 polls
    on a 30s job where extract cost 10 (see DECISIONS.md D-006).
    """

    first: float
    growth: float
    cap: float
    max_wall_clock: float
    jitter: float = 0.15

    def delays(self) -> Iterator[float]:
        """Successive poll delays until the wall-clock budget is exhausted."""
        elapsed = 0.0
        delay = self.first
        while elapsed < self.max_wall_clock:
            yield delay
            elapsed += delay
            delay = min(delay * self.growth, self.cap)

    def expected_polls(self, job_seconds: float) -> int:
        """Polls a job of ``job_seconds`` costs under this schedule.

        This is the function the cost and volume model is built on: a ~30s job
        under the production schedule (0.8s, x1.35, 5.0s cap) costs 10 polls,
        making one extracted document 12 API calls (submit + 10 polls + results).
        """
        elapsed = 0.0
        delay = self.first
        polls = 0
        while elapsed < job_seconds and elapsed < self.max_wall_clock:
            elapsed += delay
            polls += 1
            delay = min(delay * self.growth, self.cap)
        return polls


class Settings(BaseSettings):
    """Root configuration object."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # --- Application ------------------------------------------------------
    app_env: Environment = "local"
    log_level: str = "INFO"
    #: Browser origins the API answers cross-origin requests from. A single
    #: hardcoded port breaks the moment the console is served from another one,
    #: which is exactly what happens under the preview server.
    cors_origins: str = "http://localhost:3000,http://localhost:3100,http://127.0.0.1:3000,http://127.0.0.1:3100"
    default_timezone: str = "Asia/Kolkata"

    # --- Persistence ------------------------------------------------------
    database_url: str = "sqlite+aiosqlite:///./gravai.db"
    redis_url: str = "redis://localhost:6379/0"

    # --- Temporal ---------------------------------------------------------
    temporal_address: str = "localhost:7233"
    temporal_namespace: str = "gravai-local"

    # --- Object storage ---------------------------------------------------
    blob_endpoint: str = "http://localhost:9000"
    blob_key: str = "minioadmin"
    blob_secret: str = "minioadmin"
    blob_bucket: str = "gravai-documents"

    # --- Auth -------------------------------------------------------------
    auth_dev_secret: str = "change-me-local-only"
    oidc_issuer: str = ""
    oidc_audience: str = "gravai"
    oidc_jwks_url: str = ""
    token_ttl_seconds: int = 3600

    # --- Sarvam -----------------------------------------------------------
    sarvam_api_key: str = ""
    sarvam_base_url: str = "https://api.sarvam.ai"
    sarvam_sandbox: bool = True
    #: The reasoning model. `sarvam-m` was removed by the vendor and now returns a
    #: hard deprecation error, so both roles point at the same model.
    #:
    #: There is no cheaper chat tier: `sarvam-105b` and `sarvam-105b-conversations`
    #: are priced identically. `sarvam_model_fast` therefore cannot be used as a
    #: cost lever within this provider — routing cheap work to a smaller model is
    #: not an option the vendor offers (DECISIONS.md D-012).
    sarvam_model_reasoning: str = "sarvam-105b"
    sarvam_model_fast: str = "sarvam-105b"
    sarvam_stt_model: str = "saarika:v2.5"
    sarvam_stt_translate_model: str = "saaras:v2.5"
    sarvam_tts_model: str = "bulbul:v2"
    sarvam_translate_model: str = "sarvam-translate:v1"

    # --- Sarvam Document Intelligence governor ---------------------------
    sarvam_docai_rpm: int = 10
    sarvam_docai_polls_count_toward_limit: bool = True
    sarvam_docai_extract_path: str = "/doc-ai/v1/job/extract"
    sarvam_docai_digitise_path: str = "/doc-ai/v1/job/digitise"
    sarvam_docai_status_path: str = "/doc-ai/v1/job/{job_id}/status"
    sarvam_docai_results_path: str = "/doc-ai/v1/job/{job_id}/results"
    #: Two-step submission: upload returns an id that extract/digitise consume.
    sarvam_docai_upload_path: str = "/doc-ai/v1/job/upload"
    #: Hard vendor limit. A job carrying more pages than this is rejected with
    #: 400, so documents are split client-side before submission.
    sarvam_docai_max_pages_per_job: int = 10
    sarvam_docai_poll_first: float = 0.8
    sarvam_docai_poll_growth: float = 1.35
    sarvam_docai_poll_cap: float = 5.0
    sarvam_docai_poll_max_wall_clock: float = 180.0

    # --- Observability ----------------------------------------------------
    otel_exporter_otlp_endpoint: str = ""
    otel_service_name: str = "gravai"
    dd_api_key: str = ""
    langfuse_host: str = ""
    langfuse_public_key: str = ""
    langfuse_secret_key: str = ""

    # --- Document source --------------------------------------------------
    #: Lets a run fetch from loopback and private addresses. For local
    #: development only: on a real host the API, the MCP server and the console
    #: all listen on loopback, so leaving this on turns a document source into a
    #: proxy into them. Production refuses to keep it on.
    document_source_allow_private: bool = False
    document_source_timeout_seconds: float = 20.0
    document_source_max_bytes: int = 20 * 1024 * 1024
    document_source_max_redirects: int = 3

    # --- Security ---------------------------------------------------------
    key_vault_url: str = ""
    pii_encryption_key: str = "local-dev-kek-change-me"
    webhook_signing_secret: str = "local-dev-webhook-secret"

    # --- Derived ----------------------------------------------------------
    @model_validator(mode="after")
    def _force_sandbox_without_key(self) -> Settings:
        """No Sarvam key means sandbox, whatever the flag says.

        This makes it impossible to accidentally attempt a billable call with no
        credentials, and makes SANDBOX the default for a fresh checkout.
        """
        if not self.sarvam_api_key:
            object.__setattr__(self, "sarvam_sandbox", True)
        return self

    @model_validator(mode="after")
    def _production_refuses_dev_auth(self) -> Settings:
        """Production must use a real identity provider, not the dev secret."""
        if self.app_env == "prod" and not self.oidc_jwks_url:
            raise ValueError(
                "APP_ENV=prod requires OIDC_JWKS_URL; the HS256 dev auth path is "
                "refused in production (DECISIONS.md D-003)."
            )
        return self

    @model_validator(mode="after")
    def _no_private_fetches_in_production(self) -> Settings:
        """Refuse to leave the private-address escape hatch open in production.

        It exists so a developer can point a run at a JSON file on localhost.
        On a deployed host the same setting would let anyone who can reach the
        console read the loopback-only services sitting beside it.
        """
        if self.app_env == "prod" and self.document_source_allow_private:
            object.__setattr__(self, "document_source_allow_private", False)
        return self

    @property
    def allowed_origins(self) -> list[str]:
        """Origins permitted cross-origin, outside production.

        Empty in production: the console is served from the same origin there,
        so a browser never needs a CORS grant and handing one out would only
        widen what a stolen token could be used from.
        """
        if self.app_env == "prod":
            return []
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def is_sqlite(self) -> bool:
        return self.database_url.startswith("sqlite")

    @property
    def is_postgres(self) -> bool:
        return self.database_url.startswith("postgresql")

    @property
    def rls_available(self) -> bool:
        """Row-level security is a PostgreSQL feature (DECISIONS.md D-002)."""
        return self.is_postgres

    @property
    def use_dev_auth(self) -> bool:
        return not self.oidc_jwks_url

    @property
    def docai_poll_schedule(self) -> PollSchedule:
        return PollSchedule(
            first=self.sarvam_docai_poll_first,
            growth=self.sarvam_docai_poll_growth,
            cap=self.sarvam_docai_poll_cap,
            max_wall_clock=self.sarvam_docai_poll_max_wall_clock,
        )

    def batches_for(self, pages: int) -> int:
        """How many jobs a document of this many pages becomes.

        The vendor caps a job at ten pages, so a twelve-page bank statement is
        two jobs — and therefore two submits, two poll loops and two results
        fetches. Capacity planning that ignores this understates the load on
        exactly the documents that matter most.
        """
        if pages <= 0:
            return 1
        limit = max(1, self.sarvam_docai_max_pages_per_job)
        return (pages + limit - 1) // limit

    def docai_calls_per_document(
        self, job_seconds: float, *, digitise: bool, pages: int = 1
    ) -> int:
        """Total API calls one document costs.

        Per batch: submit + polls + results. Plus one model call per digitised
        batch, since digitise returns text that something must then read.
        """
        polls = self.docai_poll_schedule.expected_polls(job_seconds)
        per_batch = 1 + polls + 1 + (1 if digitise else 0)
        return per_batch * self.batches_for(pages)

    def docai_quota_units_per_document(
        self, job_seconds: float, *, digitise: bool, pages: int = 1
    ) -> int:
        """Units consumed from the 10/min Document Intelligence bucket.

        Whether polls count is unverified; the conservative default counts them
        (DECISIONS.md D-005). The model read draws on a different product's
        quota and is excluded here. Multiplied by batches, because each batch is
        its own job against the same bucket.
        """
        polls = self.docai_poll_schedule.expected_polls(job_seconds)
        per_batch = (1 + polls + 1) if self.sarvam_docai_polls_count_toward_limit else 1
        return per_batch * self.batches_for(pages)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Cached settings singleton."""
    return Settings()
