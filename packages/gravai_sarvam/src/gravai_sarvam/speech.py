"""Speech and language services: STT, TTS, translate, transliterate, language id.

Text is chunked at sentence boundaries before synthesis and translation, because
both endpoints cap input length and splitting mid-sentence produces audible
seams and mistranslations.
"""

from __future__ import annotations

import base64
import re
import time
from typing import Any

from gravai_core.errors import UnsupportedLanguage
from gravai_core.settings import Settings, get_settings

from .http import SarvamHTTP
from .types import Audio, Transcript, TranscriptSegment

STT_PATH = "/speech-to-text"
STT_TRANSLATE_PATH = "/speech-to-text-translate"
TTS_PATH = "/text-to-speech"
TRANSLATE_PATH = "/translate"
TRANSLITERATE_PATH = "/transliterate"
LANGUAGE_ID_PATH = "/text-lid"

#: Languages the platform exposes. The exact set a given model supports must be
#: confirmed against Sarvam's documentation per model (DECISIONS.md D-004).
SUPPORTED_LANGUAGES: frozenset[str] = frozenset(
    {
        "en-IN",
        "hi-IN",
        "bn-IN",
        "gu-IN",
        "kn-IN",
        "ml-IN",
        "mr-IN",
        "od-IN",
        "pa-IN",
        "ta-IN",
        "te-IN",
    }
)

#: Conservative caps; a request that exceeds them is chunked, not rejected.
TTS_CHUNK_CHARS = 1000
TRANSLATE_CHUNK_CHARS = 1500

_SENTENCE = re.compile(r"(?<=[.!?।])\s+")


def chunk_text(text: str, limit: int) -> list[str]:
    """Split on sentence boundaries, packing up to ``limit`` characters.

    Devanagari danda (।) counts as a sentence end, so Hindi and Marathi chunk
    as sensibly as English.
    """
    text = (text or "").strip()
    if not text:
        return []
    if len(text) <= limit:
        return [text]

    chunks: list[str] = []
    current = ""
    for sentence in _SENTENCE.split(text):
        if not sentence:
            continue
        if len(sentence) > limit:
            # A single oversized sentence still has to be broken somewhere.
            if current:
                chunks.append(current.strip())
                current = ""
            for start in range(0, len(sentence), limit):
                chunks.append(sentence[start : start + limit].strip())
            continue
        if len(current) + len(sentence) + 1 > limit:
            chunks.append(current.strip())
            current = sentence
        else:
            current = f"{current} {sentence}".strip()
    if current:
        chunks.append(current.strip())
    return [c for c in chunks if c]


def require_supported(language: str) -> str:
    """Validate a language tag before spending a call on it."""
    if language not in SUPPORTED_LANGUAGES:
        raise UnsupportedLanguage(
            "Language is not in the configured supported set",
            language=language,
            supported=sorted(SUPPORTED_LANGUAGES),
        )
    return language


class SarvamSpeech:
    """Speech-to-text, text-to-speech and translation."""

    def __init__(self, http: SarvamHTTP, settings: Settings | None = None) -> None:
        self.http = http
        self.settings = settings or get_settings()

    async def transcribe(
        self,
        audio: bytes,
        *,
        language: str | None = None,
        diarize: bool = False,
        filename: str = "audio.wav",
    ) -> Transcript:
        """Speech to text in the source language."""
        data: dict[str, Any] = {
            "model": self.settings.sarvam_stt_model,
            "language_code": language or "unknown",
        }
        if diarize:
            data["with_diarization"] = "true"
        response = await self.http.request(
            "POST",
            STT_PATH,
            product="stt",
            files={"file": (filename, audio, "audio/wav")},
            data=data,
        )
        return self._to_transcript(response.json(), fallback_language=language or "unknown")

    async def transcribe_translate(
        self, audio: bytes, *, filename: str = "audio.wav"
    ) -> Transcript:
        """Speech to English text, whatever the source language."""
        response = await self.http.request(
            "POST",
            STT_TRANSLATE_PATH,
            product="stt",
            files={"file": (filename, audio, "audio/wav")},
            data={"model": self.settings.sarvam_stt_translate_model},
        )
        return self._to_transcript(response.json(), fallback_language="en-IN")

    @staticmethod
    def _to_transcript(body: dict[str, Any], *, fallback_language: str) -> Transcript:
        segments = tuple(
            TranscriptSegment(
                text=str(segment.get("transcript", segment.get("text", ""))),
                start_seconds=float(segment.get("start_time_seconds", 0.0)),
                end_seconds=float(segment.get("end_time_seconds", 0.0)),
                speaker=segment.get("speaker_id") or segment.get("speaker"),
            )
            for segment in (body.get("diarized_transcript") or {}).get("entries", [])
        )
        return Transcript(
            text=str(body.get("transcript", "")),
            language=str(body.get("language_code") or fallback_language),
            duration_seconds=float(body.get("duration_seconds", 0.0)),
            segments=segments,
        )

    async def synthesize(
        self,
        text: str,
        *,
        language: str,
        speaker: str = "anushka",
        pace: float = 1.0,
        sample_rate: int = 22050,
    ) -> Audio:
        """Text to speech, concatenating chunks for long input."""
        require_supported(language)
        chunks = chunk_text(text, TTS_CHUNK_CHARS)
        if not chunks:
            return Audio(data=b"", characters=0)

        buffers: list[bytes] = []
        started = time.perf_counter()
        for chunk in chunks:
            response = await self.http.request(
                "POST",
                TTS_PATH,
                product="tts",
                json={
                    "inputs": [chunk],
                    "target_language_code": language,
                    "speaker": speaker,
                    "pace": pace,
                    "speech_sample_rate": sample_rate,
                    "model": self.settings.sarvam_tts_model,
                },
            )
            for encoded in response.json().get("audios", []):
                buffers.append(base64.b64decode(encoded))

        elapsed = time.perf_counter() - started
        return Audio(
            data=b"".join(buffers),
            audio_format="wav",
            sample_rate=sample_rate,
            characters=sum(len(c) for c in chunks),
            duration_seconds=elapsed,
        )

    async def translate(
        self,
        text: str,
        *,
        source: str,
        target: str,
        mode: str = "formal",
    ) -> str:
        """Translate, chunked at sentence boundaries."""
        require_supported(target)
        chunks = chunk_text(text, TRANSLATE_CHUNK_CHARS)
        if not chunks:
            return ""
        out: list[str] = []
        for chunk in chunks:
            response = await self.http.request(
                "POST",
                TRANSLATE_PATH,
                product="translate",
                json={
                    "input": chunk,
                    "source_language_code": source,
                    "target_language_code": target,
                    "mode": mode,
                    "model": self.settings.sarvam_translate_model,
                },
            )
            out.append(str(response.json().get("translated_text", "")))
        return " ".join(part for part in out if part)

    async def transliterate(self, text: str, *, source: str, target: str) -> str:
        """Script conversion without translating meaning."""
        response = await self.http.request(
            "POST",
            TRANSLITERATE_PATH,
            product="translate",
            json={
                "input": text,
                "source_language_code": source,
                "target_language_code": target,
            },
        )
        return str(response.json().get("transliterated_text", ""))

    async def identify_language(self, text: str) -> str:
        """Detect the language of a piece of text."""
        response = await self.http.request(
            "POST", LANGUAGE_ID_PATH, product="translate", json={"input": text}
        )
        return str(response.json().get("language_code") or "unknown")
