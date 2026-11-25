"""Tests for the Gemini client-lifetime fix and the real AI status check.

Regression: ``GeminiAIService`` used to call
``self._client().models.generate_content(...)`` — a temporary client.
The genai ``Client.__del__`` closes the underlying HTTP client, and
CPython garbage-collects the temporary the moment ``.models`` is read,
so every AI call died with
``RuntimeError: Cannot send a request, as the client has been closed``
before reaching Google. The fix holds the client in a local for the
whole call. These tests use a fake client whose ``__del__`` marks it
closed, so the old pattern fails and the fixed code passes.
"""
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.core.config import settings  # noqa: E402
from app.core.security import SESSION_COOKIE, create_session_token  # noqa: E402
from app.main import app  # noqa: E402
from app.services.ai_service import GeminiAIService  # noqa: E402

client = TestClient(app, raise_server_exceptions=False)
AUTH_COOKIES = {SESSION_COOKIE: create_session_token(settings.admin_email)}


class _FakeModels:
    def __init__(self, state):
        self._state = state

    def generate_content(self, model, contents):
        assert not self._state["closed"], (
            "generate_content ran after the genai client was closed")
        return SimpleNamespace(text="fake result")

    def get(self, model):
        assert not self._state["closed"], (
            "models.get ran after the genai client was closed")
        return SimpleNamespace(name=model)


class _FakeGenAIClient:
    """Mimics genai.Client's __del__-closes-the-http-client behaviour."""

    def __init__(self, state, *args, **kwargs):
        self._state = state
        self.models = _FakeModels(state)

    def __del__(self):
        self._state["closed"] = True


@pytest.fixture
def fake_genai(monkeypatch):
    state = {"closed": False}

    def _factory(*args, **kwargs):
        return _FakeGenAIClient(state, *args, **kwargs)

    monkeypatch.setattr("google.genai.Client", _factory)
    return state


def test_old_temporary_client_pattern_fails(fake_genai):
    """Documents the bug: a temporary client is garbage-collected (and
    closed) the moment ``.models`` is read, before the call runs."""
    from google import genai
    with pytest.raises(AssertionError, match="closed"):
        genai.Client(api_key="dummy").models.generate_content(
            model="m", contents="hi")


def test_transcribe_keeps_client_alive_until_call_returns(fake_genai):
    service = GeminiAIService(api_key="dummy")
    assert service.transcribe_audio(b"fake-audio", "audio/mpeg") == "fake result"


def test_process_text_keeps_client_alive_until_call_returns(fake_genai):
    service = GeminiAIService(api_key="dummy")
    assert service.process_text("Today was good.", "summary") == "fake result"


def test_check_connection_uses_live_client(fake_genai):
    service = GeminiAIService(api_key="dummy")
    assert service.check_connection() is True


def test_ai_status_without_key_reports_not_configured():
    resp = client.get("/api/ai/status", cookies=AUTH_COOKIES)
    assert resp.status_code == 200
    assert resp.json() == {"configured": False, "reachable": False,
                           "model": "gemini-3.5-flash"}


def test_ai_status_reachable_with_working_client(monkeypatch, fake_genai):
    monkeypatch.setattr(settings, "gemini_api_key", "dummy")
    resp = client.get("/api/ai/status", cookies=AUTH_COOKIES)
    assert resp.status_code == 200
    assert resp.json()["configured"] is True
    assert resp.json()["reachable"] is True


def test_ai_status_requires_auth():
    assert client.get("/api/ai/status").status_code == 401
