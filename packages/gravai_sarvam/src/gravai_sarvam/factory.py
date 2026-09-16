"""Assembling the Sarvam layer.

One place decides whether the platform talks to Sarvam or to the sandbox, so no
agent ever has to know — and so a missing API key cannot silently become a
billable call.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from gravai_core.settings import Settings, get_settings
from gravai_core.telemetry import get_logger

from .chat import ChatClient, SarvamChat
from .documents import DocumentReader, DocumentRunner, DocumentService, SarvamDocuments
from .governor import RateGovernor
from .http import SarvamHTTP
from .pricing import RateCard
from .sandbox import FakeSarvamChat, FakeSarvamDocuments, FakeSarvamSpeech
from .speech import SarvamSpeech

log = get_logger("gravai.sarvam")


@dataclass(slots=True)
class SarvamBundle:
    """Everything an agent needs from the AI layer."""

    chat: Any
    speech: Any
    documents: Any
    runner: DocumentRunner
    governor: RateGovernor
    rate_card: RateCard
    sandbox: bool
    http: SarvamHTTP | None = None

    async def aclose(self) -> None:
        if self.http is not None:
            await self.http.aclose()
        await self.governor.aclose()


#: What the sandbox uses instead of the real ceiling. High enough not to block,
#: finite so the fair-share machinery is still exercised.
SANDBOX_DOCAI_RPM = 100_000.0


def build_governor(
    settings: Settings | None = None, *, sandbox: bool | None = None
) -> RateGovernor:
    """A governor configured from settings.

    Document Intelligence is the binding constraint at 10 requests a minute; the
    other products get generous defaults until measured.

    **In sandbox the ceiling is lifted.** The governor exists to respect a
    vendor's limit, and in sandbox there is no vendor: throttling would make a
    local run take four minutes to read eight documents while proving nothing
    that the governor's own tests do not already prove. The configured ceiling
    is still reported by the throughput endpoint, so the capacity picture stays
    honest — it is the enforcement that is suspended, not the arithmetic.
    """
    cfg = settings or get_settings()
    use_sandbox = cfg.sarvam_sandbox if sandbox is None else sandbox
    docai = SANDBOX_DOCAI_RPM if use_sandbox else float(cfg.sarvam_docai_rpm)

    if use_sandbox:
        log.info(
            "governor_ceiling_lifted",
            reason="sandbox: no vendor quota is being consumed",
            configured_rpm=cfg.sarvam_docai_rpm,
            active_rpm=docai,
        )

    return RateGovernor(
        limits={
            "docai": docai,
            "llm": SANDBOX_DOCAI_RPM if use_sandbox else 600.0,
            "stt": 300.0,
            "tts": 300.0,
            "translate": 300.0,
        }
    )


def build_sarvam(
    settings: Settings | None = None,
    *,
    governor: RateGovernor | None = None,
    sandbox: bool | None = None,
    polls_before_done: int = 10,
    sleep: Any = None,
) -> SarvamBundle:
    """Build the AI layer for the current configuration.

    ``sandbox`` defaults to the setting, which itself is forced on whenever no
    API key is present.
    """
    cfg = settings or get_settings()
    use_sandbox = cfg.sarvam_sandbox if sandbox is None else sandbox
    gov = governor or build_governor(cfg, sandbox=use_sandbox)

    documents: DocumentService
    chat: ChatClient
    speech: Any
    http: SarvamHTTP | None

    if use_sandbox:
        documents = FakeSarvamDocuments(polls_before_done=polls_before_done)
        chat = FakeSarvamChat(settings=cfg)
        speech = FakeSarvamSpeech()
        http = None
        log.info(
            "sarvam_sandbox_mode", reason="no api key" if not cfg.sarvam_api_key else "configured"
        )
    else:
        http = SarvamHTTP(cfg)
        documents = SarvamDocuments(http, cfg)
        chat = SarvamChat(http, cfg)
        speech = SarvamSpeech(http, cfg)
        log.info("sarvam_live_mode", base_url=cfg.sarvam_base_url)

    runner = DocumentRunner(
        documents,
        gov,
        settings=cfg,
        reader=DocumentReader(chat),
        sleep=sleep,
    )

    return SarvamBundle(
        chat=chat,
        speech=speech,
        documents=documents,
        runner=runner,
        governor=gov,
        rate_card=RateCard(),
        sandbox=use_sandbox,
        http=http,
    )
