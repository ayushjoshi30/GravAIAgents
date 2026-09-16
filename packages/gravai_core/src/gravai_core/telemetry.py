"""Logging and tracing.

Structured logging is always on. OpenTelemetry export is enabled only when an
OTLP endpoint is configured, so local development needs no collector and the
same code runs unchanged in production.
"""

from __future__ import annotations

import logging
import sys
from collections.abc import MutableMapping
from typing import Any

import structlog

from .settings import Settings, get_settings
from .tenancy import current_correlation_id, current_tenant_id

_configured = False


def _add_context(
    _logger: Any, _name: str, event_dict: MutableMapping[str, Any]
) -> MutableMapping[str, Any]:
    """Attach tenant and correlation id to every line, without call sites asking."""
    tenant = current_tenant_id()
    if tenant is not None:
        event_dict.setdefault("tenant_id", str(tenant))
    correlation = current_correlation_id()
    if correlation:
        event_dict.setdefault("correlation_id", correlation)
    return event_dict


def configure_logging(settings: Settings | None = None) -> None:
    """Configure structlog once per process."""
    global _configured
    if _configured:
        return
    cfg = settings or get_settings()

    renderer: Any = (
        structlog.dev.ConsoleRenderer(colors=False)
        if cfg.app_env == "local"
        else structlog.processors.JSONRenderer()
    )

    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", utc=True),
            _add_context,
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            renderer,
        ],
        wrapper_class=structlog.make_filtering_bound_logger(
            logging.getLevelNamesMapping().get(cfg.log_level.upper(), logging.INFO)
        ),
        logger_factory=structlog.PrintLoggerFactory(file=sys.stderr),
        cache_logger_on_first_use=True,
    )
    _configured = True


def get_logger(name: str = "gravai") -> Any:
    """A bound structured logger."""
    configure_logging()
    return structlog.get_logger(name)


def configure_tracing(settings: Settings | None = None) -> bool:
    """Enable OTLP tracing if an endpoint is configured.

    Returns whether tracing was switched on, so callers can log it rather than
    guess. Import failures degrade to "tracing off" instead of breaking boot.
    """
    cfg = settings or get_settings()
    if not cfg.otel_exporter_otlp_endpoint:
        return False
    try:
        from opentelemetry import trace
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
    except ImportError:
        get_logger().warning(
            "otel_endpoint_set_but_sdk_missing",
            hint="install the opentelemetry extras to enable tracing",
        )
        return False

    provider = TracerProvider(
        resource=Resource.create(
            {"service.name": cfg.otel_service_name, "deployment.environment": cfg.app_env}
        )
    )
    provider.add_span_processor(
        BatchSpanProcessor(OTLPSpanExporter(endpoint=cfg.otel_exporter_otlp_endpoint))
    )
    trace.set_tracer_provider(provider)
    return True
