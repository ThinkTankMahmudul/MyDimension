"""API tests using FastAPI's TestClient and the dev fallback store.

No real database, Google account, or Gemini key is needed: with
DATABASE_URL unset the app uses the in-memory dev fallback (labelled as
such in /health), and AI endpoints return a friendly 503 when Gemini
is not configured instead of crashing with a 500.

Auth in tests: a signed session cookie for the placeholder owner email
(ADMIN_EMAIL default, the confirmed owner email) is created with the same
``create_session_token`` helper the app itself uses.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.core.config import settings  # noqa: E402
from app.core.security import SESSION_COOKIE, create_session_token  # noqa: E402
from app.main import app  # noqa: E402

client = TestClient(app, raise_server_exceptions=False)
AUTH_COOKIES = {SESSION_COOKIE: create_session_token(settings.admin_email)}


def test_health_ok():
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"
    assert "dev-fallback" in resp.json()["storage"]


def test_unauthenticated_entries_returns_401():
    assert client.get("/api/entries").status_code == 401
    assert client.post("/api/entries", json={"title": "x"}).status_code == 401
    assert client.get("/api/me").status_code == 401


def test_entries_crud_with_dev_fallback():
    created = client.post("/api/entries",
                          json={"title": "First entry", "content": "Hello world",
                                "mood": "happy", "tags": ["test"]},
                          cookies=AUTH_COOKIES)
    assert created.status_code == 201, created.text
    entry_id = created.json()["id"]

    got = client.get(f"/api/entries/{entry_id}", cookies=AUTH_COOKIES)
    assert got.status_code == 200 and got.json()["title"] == "First entry"

    listed = client.get("/api/entries?search=hello", cookies=AUTH_COOKIES)
    assert listed.status_code == 200
    assert any(e["id"] == entry_id for e in listed.json())

    updated = client.put(f"/api/entries/{entry_id}",
                         json={"title": "Edited entry"}, cookies=AUTH_COOKIES)
    assert updated.status_code == 200 and updated.json()["title"] == "Edited entry"

    deleted = client.delete(f"/api/entries/{entry_id}", cookies=AUTH_COOKIES)
    assert deleted.status_code == 200
    assert client.get(f"/api/entries/{entry_id}", cookies=AUTH_COOKIES).status_code == 404


def test_invalid_uuid_returns_404_not_500():
    resp = client.get("/api/entries/not-a-uuid", cookies=AUTH_COOKIES)
    assert resp.status_code == 404


def test_ai_endpoints_friendly_error_without_gemini_key():
    # No GEMINI_API_KEY is set in this environment, so these must be a
    # friendly 503 -- not a 500 crash.
    for path in ("/api/ai/mood", "/api/ai/summary", "/api/ai/improve"):
        resp = client.post(path, json={"text": "Today was a good day."},
                           cookies=AUTH_COOKIES)
        assert resp.status_code == 503, (path, resp.status_code, resp.text)
        assert "Gemini" in resp.json()["detail"] or "AI" in resp.json()["detail"]


def test_transcribe_prompt_detects_bangla_and_english():
    # Auto-detect must cover Bengali + English (including mixed speech),
    # and Bengali must come back in Bengali script, never Romanised.
    from app.services.ai_service import transcribe_prompt
    auto = transcribe_prompt("auto")
    assert "Bengali" in auto and "English" in auto
    assert "detect the language automatically" in auto
    assert "Bengali script" in auto and "never Romanised" in auto
    assert "mix" in auto
    assert "Bengali" in transcribe_prompt("bn")
    assert "English" in transcribe_prompt("en")
    # An unknown language falls back to auto-detect.
    assert "detect the language automatically" in transcribe_prompt("xx")


def test_transcribe_rejects_unknown_language():
    resp = client.post("/api/ai/transcribe",
                       files={"file": ("t.mp3", b"fake", "audio/mpeg")},
                       data={"language": "xx"}, cookies=AUTH_COOKIES)
    assert resp.status_code == 400


def test_transcribe_language_defaults_to_auto_and_needs_gemini():
    # No language sent: auto-detect; no Gemini key in tests: friendly 503.
    resp = client.post("/api/ai/transcribe",
                       files={"file": ("t.mp3", b"fake", "audio/mpeg")},
                       cookies=AUTH_COOKIES)
    assert resp.status_code == 503


def test_calendar_and_mood_insights_require_auth_and_work():
    assert client.get("/api/calendar").status_code == 401
    resp = client.get("/api/calendar", cookies=AUTH_COOKIES)
    assert resp.status_code == 200 and isinstance(resp.json(), list)
    resp = client.get("/api/insights/moods", cookies=AUTH_COOKIES)
    assert resp.status_code == 200


def test_media_upload_without_drive_returns_503():
    resp = client.post("/api/media/upload",
                       files={"file": ("photo.jpg", b"fake-bytes", "image/jpeg")},
                       data={"media_type": "photo"}, cookies=AUTH_COOKIES)
    assert resp.status_code == 503, resp.text


def test_media_upload_accepts_recorder_mime_with_codec_parameter(monkeypatch):
    """Regression (25 Nov 2026, live): Chrome's MediaRecorder reports
    'audio/webm;codecs=opus'. The exact-string allowlist rejected it with
    400, so a recorded voice note was never saved with its entry — the
    detail view showed no voice player even though the recording worked
    in the form. Content types are normalised (parameters stripped)
    before the allowlist check."""
    import app.api.routes_media as routes_media

    class FakeDrive:
        def upload(self, name, content_type, data, media_type):
            assert content_type == "audio/webm"  # normalised, no ;codecs=…
            return "drive-test-1"

    monkeypatch.setattr(routes_media, "get_drive_service_for_user",
                        lambda *a, **k: FakeDrive())
    entry_id = client.post("/api/entries", json={"title": "Voice", "content": "x"},
                           cookies=AUTH_COOKIES).json()["id"]
    resp = client.post("/api/media/upload",
                       files={"file": ("voice-note.webm", b"fake-audio",
                                       "audio/webm;codecs=opus")},
                       data={"media_type": "audio", "entry_id": entry_id},
                       cookies=AUTH_COOKIES)
    assert resp.status_code == 201, resp.text
    assert resp.json()["mime_type"] == "audio/webm"
    assert resp.json()["entry_id"] == entry_id
    assert client.get(f"/api/media?entry_id={entry_id}",
                      cookies=AUTH_COOKIES).json()[0]["file_name"] == "voice-note.webm"


def test_media_file_route_requires_auth_and_returns_404_for_unknown_id():
    # The /file route streams bytes for <img>/<audio>; the plain /{id} route
    # returns JSON metadata only. Unknown id -> 404, no auth -> 401.
    assert client.get("/api/media/nope/file").status_code == 401
    resp = client.get("/api/media/00000000-0000-0000-0000-000000000000/file",
                      cookies=AUTH_COOKIES)
    assert resp.status_code == 404, resp.text

def test_uuid_ids_from_postgres_serialize_as_strings():
    """Regression: PostgreSQL returns uuid.UUID objects for id/user_id.

    Pydantic v2 rejects a UUID where a response model declares `str`, so
    listing entries 500d live as soon as one row existed (the save itself
    succeeded — only the list crashed). Models must coerce UUIDs to str.
    """
    import uuid

    from app.models.models import DiaryEntry, MediaFile, MoodRecord
    from app.schemas.schemas import EntryResponse, MediaResponse

    entry_id, user_id = uuid.uuid4(), uuid.uuid4()
    entry = DiaryEntry.from_dict({
        "id": entry_id, "title": "From Postgres", "content": "x",
        "mood": "happy", "tags": [], "user_id": user_id,
    })
    assert isinstance(entry.id, str) and entry.id == str(entry_id)
    assert isinstance(entry.user_id, str) and entry.user_id == str(user_id)
    resp = EntryResponse(**entry.to_dict())
    assert resp.id == str(entry_id)
    assert isinstance(entry.to_dict()["user_id"], str)

    media = MediaFile("drive-1", "a.jpg", "image/jpeg", "photo",
                      media_id=uuid.uuid4(), entry_id=entry_id, user_id=user_id)
    mresp = MediaResponse(**media.to_dict())
    assert mresp.id and mresp.entry_id == str(entry_id)
    assert isinstance(media.to_dict()["user_id"], str)

    mood = MoodRecord("calm", entry_id=entry_id)
    assert mood.to_dict()["entry_id"] == str(entry_id)


def test_drive_service_needs_user_oauth_token(monkeypatch):
    """No service account anymore: Drive works only with the user's own
    OAuth refresh token. Without one, the per-user factory refuses with
    DriveNotConfiguredError (the old service-account path failed live
    with Google's 403 storageQuotaExceeded — a service account has no
    Drive storage quota of its own)."""
    from app.services.drive_service import (
        DriveNotConfiguredError,
        GoogleDriveService,
        get_drive_service_for_user,
    )

    monkeypatch.delenv("GOOGLE_DRIVE_CREDENTIALS_JSON", raising=False)
    with pytest.raises(DriveNotConfiguredError):
        get_drive_service_for_user("no-such-user")
    assert GoogleDriveService().configured is False


def test_entry_theme_round_trip_and_unknown_falls_back_to_default():
    """Note themes (Google Keep-style): create/update keep the theme,
    and an unknown theme id never breaks anything — it becomes default."""
    from app.models.models import VALID_THEMES

    assert "lavender" in VALID_THEMES and "forest" in VALID_THEMES
    # Illustrated themes (SVG art, right edge of the note).
    assert {"pencil", "river", "garden", "space"} <= VALID_THEMES
    resp = client.post("/api/entries", json={
        "title": "Themed", "content": "x", "theme": "lavender",
    }, cookies=AUTH_COOKIES)
    assert resp.status_code == 201, resp.text
    assert resp.json()["theme"] == "lavender"
    entry_id = resp.json()["id"]
    resp = client.put(f"/api/entries/{entry_id}", json={"theme": "rose"},
                      cookies=AUTH_COOKIES)
    assert resp.status_code == 200, resp.text
    assert resp.json()["theme"] == "rose"
    resp = client.post("/api/entries", json={
        "title": "Bad theme", "content": "x", "theme": "not-a-theme",
    }, cookies=AUTH_COOKIES)
    assert resp.status_code == 201, resp.text
    assert resp.json()["theme"] == "default"
    assert client.get(f"/api/entries/{entry_id}",
                      cookies=AUTH_COOKIES).json()["theme"] == "rose"


def test_media_list_filters_by_entry_id():
    """GET /api/media?entry_id=… returns only that entry's attachments
    (used by the detail view and the edit form to show voice/files)."""
    from app.models.models import MediaFile
    from app.services.database_manager import db_manager

    owner = db_manager.get_user_by_email(settings.admin_email)
    entry_a = client.post("/api/entries", json={"title": "A", "content": "x"},
                          cookies=AUTH_COOKIES).json()["id"]
    entry_b = client.post("/api/entries", json={"title": "B", "content": "y"},
                          cookies=AUTH_COOKIES).json()["id"]
    db_manager.create_media(
        MediaFile("drive-a", "a.jpg", "image/jpeg", "photo", entry_id=entry_a),
        user_id=str(owner["id"]))
    db_manager.create_media(
        MediaFile("drive-b", "b.webm", "audio/webm", "audio", entry_id=entry_b),
        user_id=str(owner["id"]))
    got = client.get(f"/api/media?entry_id={entry_a}", cookies=AUTH_COOKIES)
    assert got.status_code == 200, got.text
    assert [m["file_name"] for m in got.json()] == ["a.jpg"]
    assert client.get(f"/api/media?entry_id={entry_b}",
                      cookies=AUTH_COOKIES).json()[0]["file_name"] == "b.webm"
    assert client.get("/api/media?entry_id=no-such-entry",
                      cookies=AUTH_COOKIES).json() == []


def test_gemini_model_default_is_supported_and_env_overridable(monkeypatch):
    """gemini-2.0-flash was retired by Google on 1 Jun 2026; the default
    must be a supported model, and GEMINI_MODEL must override it."""
    import importlib

    import app.core.config as config_module

    monkeypatch.delenv("GEMINI_MODEL", raising=False)
    importlib.reload(config_module)
    assert config_module.GEMINI_MODEL == "gemini-3.5-flash"
    monkeypatch.setenv("GEMINI_MODEL", "gemini-3.5-flash")
    importlib.reload(config_module)
    assert config_module.GEMINI_MODEL == "gemini-3.5-flash"
