"""AI services: abstraction + inheritance + polymorphism.

OOP concepts demonstrated here:
- Abstraction: ``BaseAIService`` is an abstract base class (ABC). It
  declares ``process_text`` and ``transcribe_audio`` but does not
  implement them, so no one can instantiate it directly.
- Inheritance: ``GeminiAIService`` and ``OfflineAIService`` both inherit
  from ``BaseAIService``.
- Polymorphism: both subclasses implement the *same* methods, but behave
  differently -- Gemini calls Google's API, Offline returns a friendly
  "AI unavailable" message. Callers just use the shared interface and
  do not care which one they got.

Privacy: only the text/audio the owner explicitly sends to an AI
endpoint is passed to Gemini. Diary content is never sent silently.
"""
from __future__ import annotations

import logging
from abc import ABC, abstractmethod

from ..core.config import GEMINI_MODEL, settings

logger = logging.getLogger("mydimension.ai")


class AINotConfiguredError(Exception):
    """Gemini is not configured (no API key); the API returns a friendly 503."""


# Transcription languages: "auto" detects the spoken language, "bn" is
# Bengali, "en" is English. The frontend sends one of these with the audio.
TRANSCRIBE_LANGUAGES = ("auto", "bn", "en")


def transcribe_prompt(language: str = "auto") -> str:
    """Prompt that makes Gemini detect Bengali and/or English and
    transcribe verbatim in the speaker's own script.

    Bengali must come back in Bengali script (বাংলা লিপি) — never
    Romanised — and mixed Bengali/English speech keeps each part in
    its own script, so a diary note in either language (or both)
    transcribes faithfully.
    """
    if language == "bn":
        lang_line = "The speech is in Bengali (Bangla)."
    elif language == "en":
        lang_line = "The speech is in English."
    else:
        lang_line = ("The speech may be in Bengali (Bangla), English, or a mix of "
                     "both in one recording — detect the language automatically, "
                     "sentence by sentence.")
    return (
        "Transcribe this voice memory exactly, word for word. " + lang_line +
        " Write Bengali speech in Bengali script (বাংলা লিপি) — never Romanised "
        "or transliterated Bengali. Write English speech in English. If the "
        "speaker switches between Bengali and English, keep each part in its "
        "own script. Do not translate, summarise, correct, or add anything. "
        "Return only the transcript — no explanation, no timestamps, "
        "no speaker labels."
    )


class BaseAIService(ABC):
    """Abstract AI interface. Subclasses decide *how* each task is done."""

    @abstractmethod
    def process_text(self, text: str, task: str, language: str = "en") -> str:
        """Run a text task (``mood`` / ``summary`` / ``improve`` / ``prompt`` / ``chat``).

        ``language`` is "bn" for Bengali, anything else for English.
        """

    @abstractmethod
    def transcribe_audio(self, audio_bytes: bytes, mime_type: str,
                         language: str = "auto") -> str:
        """Transcribe audio bytes to text.

        ``language`` is "auto" (detect Bengali/English), "bn" or "en".
        """

    @abstractmethod
    def check_connection(self) -> bool:
        """True when the AI backend answers a cheap metadata call.

        Used by the AI status line so it reports a real connection,
        not just "a key is configured".
        """


class GeminiAIService(BaseAIService):
    """Real AI via Google Gemini (``google-genai``), backend only."""

    def __init__(self, api_key: str | None = None, model: str = GEMINI_MODEL) -> None:
        self.api_key = api_key if api_key is not None else settings.gemini_api_key
        if not self.api_key:
            raise AINotConfiguredError(
                "Gemini is not configured yet. Add GEMINI_API_KEY to use AI features.")
        self.model = model

    def _client(self, timeout_ms: int | None = None):
        from google import genai
        if timeout_ms is None:
            return genai.Client(api_key=self.api_key)
        from google.genai import types
        return genai.Client(api_key=self.api_key,
                            http_options=types.HttpOptions(timeout=timeout_ms))

    def _generate(self, contents):
        """Run one generate_content call.

        The genai Client MUST stay alive for the whole call: its
        ``__del__`` closes the underlying HTTP client, and a temporary
        such as ``self._client().models.generate_content(...)`` is
        garbage-collected (refcount 0) the moment ``.models`` is read —
        so the request dies with "Cannot send a request, as the client
        has been closed" before it ever reaches Google. Holding the
        client in a local keeps it open until the call returns.
        (Reproduced locally with a dummy key: the temporary pattern
        raises that RuntimeError with no network traffic; the held
        client reaches Google and fails only on the bad key.)
        """
        client = self._client()
        return client.models.generate_content(model=self.model, contents=contents)

    def check_connection(self) -> bool:
        """True when Gemini answers a model-metadata call (no generation)."""
        try:
            client = self._client(timeout_ms=8000)
            client.models.get(model=self.model)
        except Exception:
            return False
        return True

    def process_text(self, text: str, task: str, language: str = "en") -> str:
        # Answer language (2026-11-27): the UI language toggle used to
        # change only buttons and labels, while Gemini always answered
        # in English. "bn" asks for Bengali in Bengali script, never
        # Romanised — the same rule transcription already used.
        if (language or "en").lower().startswith("bn"):
            lang_line = ("Answer in Bengali (Bangla), using Bengali script "
                         "(বাংলা লিপি) — never Romanised Bengali.")
        else:
            lang_line = "Answer in English."
        prompts = {
            "mood": ("Suggest one mood for this diary text (happy, calm, grateful, "
                     "sad, anxious, tired, excited, or angry) and one short sentence "
                     "explaining why. This is only a suggestion, not a diagnosis."),
            "summary": "Summarise this diary entry in 2-3 short sentences, keeping the original meaning.",
            "improve": ("Suggest gentle writing improvements for this diary text. "
                        "Do not rewrite it entirely; list small suggestions and keep "
                        "the owner's voice."),
            "prompt": "Write one short, thoughtful reflection prompt inspired by this diary text.",
            # General Q&A (2026-11-27): answer the question directly.
            # No diary entry is attached to this task, so the answer
            # must not invent or reflect on a diary entry.
            "chat": "Answer the owner's question directly and briefly, in a helpful tone.",
        }
        prompt = prompts.get(task, prompts["summary"])
        response = self._generate(f"{lang_line} {prompt}\n\n{text}")
        return (response.text or "").strip() or "Gemini returned an empty response."

    def transcribe_audio(self, audio_bytes: bytes, mime_type: str,
                         language: str = "auto") -> str:
        from google.genai import types
        response = self._generate([
            transcribe_prompt(language),
            types.Part.from_bytes(data=audio_bytes, mime_type=mime_type),
        ])
        return (response.text or "").strip() or "Could not transcribe this recording."


class OfflineAIService(BaseAIService):
    """Fallback used when Gemini is not configured.

    Same interface as ``GeminiAIService`` (polymorphism), but every call
    returns a friendly message instead of calling any API.
    """

    def process_text(self, text: str, task: str, language: str = "en") -> str:
        raise AINotConfiguredError(
            "AI is unavailable right now because Gemini is not configured. "
            "Add GEMINI_API_KEY to enable summaries, mood suggestions and "
            "writing help. Your original text was not changed.")

    def transcribe_audio(self, audio_bytes: bytes, mime_type: str,
                         language: str = "auto") -> str:
        raise AINotConfiguredError(
            "Voice transcription is unavailable because Gemini is not "
            "configured. Add GEMINI_API_KEY to enable it.")

    def check_connection(self) -> bool:
        return False


def get_ai_service() -> BaseAIService:
    """Factory: Gemini when a key is configured, otherwise the offline fallback."""
    if settings.gemini_api_key:
        return GeminiAIService()
    return OfflineAIService()
