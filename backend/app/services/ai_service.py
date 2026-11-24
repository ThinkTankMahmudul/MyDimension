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


class BaseAIService(ABC):
    """Abstract AI interface. Subclasses decide *how* each task is done."""

    @abstractmethod
    def process_text(self, text: str, task: str) -> str:
        """Run a text task (``mood`` / ``summary`` / ``improve`` / ``prompt``)."""

    @abstractmethod
    def transcribe_audio(self, audio_bytes: bytes, mime_type: str) -> str:
        """Transcribe audio bytes to text."""


class GeminiAIService(BaseAIService):
    """Real AI via Google Gemini (``google-genai``), backend only."""

    def __init__(self, api_key: str | None = None, model: str = GEMINI_MODEL) -> None:
        self.api_key = api_key if api_key is not None else settings.gemini_api_key
        if not self.api_key:
            raise AINotConfiguredError(
                "Gemini is not configured yet. Add GEMINI_API_KEY to use AI features.")
        self.model = model

    def _client(self):
        from google import genai
        return genai.Client(api_key=self.api_key)

    def process_text(self, text: str, task: str) -> str:
        prompts = {
            "mood": ("Suggest one mood for this diary text (happy, calm, grateful, "
                     "sad, anxious, tired, excited, or angry) and one short sentence "
                     "explaining why. This is only a suggestion, not a diagnosis."),
            "summary": "Summarise this diary entry in 2-3 short sentences, keeping the original meaning.",
            "improve": ("Suggest gentle writing improvements for this diary text. "
                        "Do not rewrite it entirely; list small suggestions and keep "
                        "the owner's voice."),
            "prompt": "Write one short, thoughtful reflection prompt inspired by this diary text.",
        }
        prompt = prompts.get(task, prompts["summary"])
        response = self._client().models.generate_content(
            model=self.model, contents=f"{prompt}\n\n{text}")
        return (response.text or "").strip() or "Gemini returned an empty response."

    def transcribe_audio(self, audio_bytes: bytes, mime_type: str) -> str:
        from google.genai import types
        response = self._client().models.generate_content(
            model=self.model,
            contents=[
                "Transcribe this voice memory exactly, word for word.",
                types.Part.from_bytes(data=audio_bytes, mime_type=mime_type),
            ],
        )
        return (response.text or "").strip() or "Could not transcribe this recording."


class OfflineAIService(BaseAIService):
    """Fallback used when Gemini is not configured.

    Same interface as ``GeminiAIService`` (polymorphism), but every call
    returns a friendly message instead of calling any API.
    """

    def process_text(self, text: str, task: str) -> str:
        raise AINotConfiguredError(
            "AI is unavailable right now because Gemini is not configured. "
            "Add GEMINI_API_KEY to enable summaries, mood suggestions and "
            "writing help. Your original text was not changed.")

    def transcribe_audio(self, audio_bytes: bytes, mime_type: str) -> str:
        raise AINotConfiguredError(
            "Voice transcription is unavailable because Gemini is not "
            "configured. Add GEMINI_API_KEY to enable it.")


def get_ai_service() -> BaseAIService:
    """Factory: Gemini when a key is configured, otherwise the offline fallback."""
    if settings.gemini_api_key:
        return GeminiAIService()
    return OfflineAIService()
