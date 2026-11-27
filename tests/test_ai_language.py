"""AI language + general chat (2026-11-27).

- Bangla UI must make Gemini answer in Bengali script, not English:
  process_text(language="bn") must put a Bengali instruction in the
  prompt sent to Gemini; language="en" must not.
- General Q&A: POST /api/ai/chat answers the question directly, with
  no diary entry attached.
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
from app.schemas.schemas import AIRequest  # noqa: E402
from app.services.ai_service import GeminiAIService  # noqa: E402

client = TestClient(app, raise_server_exceptions=False)
AUTH_COOKIES = {SESSION_COOKIE: create_session_token(settings.admin_email)}


class _CapturingModels:
    def __init__(self, seen):
        self._seen = seen

    def generate_content(self, model, contents):
        self._seen.append(contents)
        return SimpleNamespace(text="fake result")

    def get(self, model):
        return SimpleNamespace(name=model)


class _CapturingClient:
    def __init__(self, seen, *args, **kwargs):
        self.models = _CapturingModels(seen)


def test_process_text_bn_asks_for_bengali_script(monkeypatch):
    seen = []
    monkeypatch.setattr("google.genai.Client",
                        lambda *a, **k: _CapturingClient(seen))
    service = GeminiAIService(api_key="dummy")
    assert service.process_text("Today was good.", "summary",
                                language="bn") == "fake result"
    assert "Bengali" in seen[0] and "বাংলা লিপি" in seen[0]
    assert "never Romanised" in seen[0]


def test_process_text_en_does_not_ask_for_bengali(monkeypatch):
    seen = []
    monkeypatch.setattr("google.genai.Client",
                        lambda *a, **k: _CapturingClient(seen))
    service = GeminiAIService(api_key="dummy")
    service.process_text("Today was good.", "summary", language="en")
    assert "Bengali" not in seen[0]
    assert "Answer in English" in seen[0]


def test_chat_task_answers_directly_without_entry(monkeypatch):
    seen = []
    monkeypatch.setattr("google.genai.Client",
                        lambda *a, **k: _CapturingClient(seen))
    service = GeminiAIService(api_key="dummy")
    service.process_text("What is the capital of France?", "chat",
                         language="en")
    assert "diary entry" not in seen[0].lower()
    assert "What is the capital of France?" in seen[0]


def test_ai_request_language_defaults_to_en():
    assert AIRequest(text="hi").language == "en"
    assert AIRequest(text="hi", language="bn").language == "bn"


def test_ai_chat_route_uses_general_chat_task(monkeypatch):
    calls = {}

    class FakeService:
        def process_text(self, text, task, language="en"):
            calls.update(text=text, task=task, language=language)
            return "Paris is the capital of France."

    import app.api.routes_ai as routes_ai
    monkeypatch.setattr(routes_ai, "get_ai_service", lambda: FakeService())
    resp = client.post("/api/ai/chat",
                       json={"text": "What is the capital of France?",
                             "language": "bn"},
                       cookies=AUTH_COOKIES)
    assert resp.status_code == 200, resp.text
    assert resp.json()["result"] == "Paris is the capital of France."
    assert calls == {"text": "What is the capital of France?",
                     "task": "chat", "language": "bn"}


def test_ai_chat_route_requires_auth():
    assert client.post("/api/ai/chat",
                       json={"text": "hi"}).status_code == 401
