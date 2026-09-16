"""Error taxonomy.

Every failure the platform can produce maps to one of these, so retry policy,
HTTP status and console messaging are decided in one place rather than at each
call site.
"""

from __future__ import annotations

from typing import Any


class GravAIError(Exception):
    """Base class. ``retryable`` drives Temporal retry policy."""

    status_code: int = 500
    code: str = "gravai_error"
    retryable: bool = False

    def __init__(self, message: str, **context: Any) -> None:
        super().__init__(message)
        self.message = message
        self.context = context

    def to_problem(self) -> dict[str, Any]:
        """RFC 9457 problem details body."""
        body: dict[str, Any] = {
            "type": f"https://docs.gravai.in/errors/{self.code}",
            "title": self.code.replace("_", " "),
            "status": self.status_code,
            "detail": self.message,
        }
        if self.context:
            body["context"] = self.context
        return body


# --- Request / authorisation ---------------------------------------------


class ValidationFailed(GravAIError):
    status_code = 422
    code = "validation_failed"


class NotFound(GravAIError):
    status_code = 404
    code = "not_found"


class Unauthenticated(GravAIError):
    status_code = 401
    code = "unauthenticated"


class Forbidden(GravAIError):
    status_code = 403
    code = "forbidden"


class TenantMismatch(Forbidden):
    """A principal from one tenant touched another tenant's row.

    This is a security event, not a routine 403: it is always audited.
    """

    code = "tenant_mismatch"


class MissingTenantContext(GravAIError):
    """A tenant-scoped operation ran with no tenant bound to the context."""

    status_code = 500
    code = "missing_tenant_context"


# --- Sarvam ---------------------------------------------------------------


class SarvamError(GravAIError):
    code = "sarvam_error"
    status_code = 502


class SarvamAuthError(SarvamError):
    code = "sarvam_auth_error"
    retryable = False


class SarvamRateLimited(SarvamError):
    code = "sarvam_rate_limited"
    status_code = 429
    retryable = True

    def __init__(self, message: str, retry_after: float | None = None, **context: Any) -> None:
        super().__init__(message, **context)
        self.retry_after = retry_after


class SarvamServerError(SarvamError):
    code = "sarvam_server_error"
    retryable = True


class DocJobFailed(SarvamError):
    code = "doc_job_failed"
    retryable = False


class DocJobTimeout(SarvamError):
    code = "doc_job_timeout"
    retryable = True


class SchemaViolation(GravAIError):
    """A model returned JSON that does not satisfy the agent's output contract.

    Not retryable at the Temporal layer: the client already ran its repair loop,
    so the run escalates to a human instead of burning more quota.
    """

    status_code = 502
    code = "schema_violation"
    retryable = False


class ContentTooLong(GravAIError):
    status_code = 413
    code = "content_too_long"


class UnsupportedLanguage(GravAIError):
    status_code = 400
    code = "unsupported_language"


# --- Platform -------------------------------------------------------------


class QuotaExhausted(GravAIError):
    """A tenant hit its configured call or rupee budget."""

    status_code = 429
    code = "quota_exhausted"
    retryable = False


class AuditChainBroken(GravAIError):
    """Verification found a row whose hash does not follow its predecessor."""

    status_code = 500
    code = "audit_chain_broken"


class ConnectorError(GravAIError):
    code = "connector_error"
    status_code = 502
    retryable = True
