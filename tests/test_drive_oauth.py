"""Tests for per-user Google Drive OAuth (connect, callback, status).

Each user connects their *own* Drive; the refresh token is encrypted
(Fernet, key derived from SESSION_SECRET) and stored per user. A
service account is deliberately not supported anymore: it has no
Drive storage quota, so uploads it creates fail live with Google's
403 storageQuotaExceeded.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.core.config import settings  # noqa: E402
from app.core.security import SESSION_COOKIE, create_session_token  # noqa: E402
from app.main import app  # noqa: E402
from app.services.database_manager import db_manager  # noqa: E402
from app.services.drive_auth import (  # noqa: E402
    DRIVE_FILE_SCOPE,
    decrypt_refresh_token,
    encrypt_refresh_token,
    make_state,
    verify_state,
)

client = TestClient(app, raise_server_exceptions=False)
AUTH_COOKIES = {SESSION_COOKIE: create_session_token(settings.admin_email)}


def _owner_id() -> str:
    """Ensure the owner user row exists and return its id."""
    resp = client.get("/api/me", cookies=AUTH_COOKIES)
    assert resp.status_code == 200, resp.text
    user = db_manager.get_user_by_email(settings.admin_email)
    assert user is not None
    return str(user["id"])


def test_state_sign_and_verify():
    state = make_state("user-123")
    assert verify_state(state) == "user-123"
    assert verify_state(state + "tampered") is None
    assert verify_state("user-123.nosig") is None
    assert verify_state("") is None


def test_refresh_token_encrypt_decrypt_round_trip():
    enc = encrypt_refresh_token("refresh-token-abc")
    assert enc != "refresh-token-abc"
    assert decrypt_refresh_token(enc) == "refresh-token-abc"
    with pytest.raises(Exception):
        decrypt_refresh_token("not-a-fernet-token")


def test_connect_url_requests_drive_file_offline(monkeypatch):
    monkeypatch.setattr(settings, "google_client_id", "test-client-id")
    resp = client.get("/api/drive/connect", cookies=AUTH_COOKIES,
                      follow_redirects=False)
    assert resp.status_code == 303, resp.text
    url = resp.headers["location"]
    assert url.startswith("https://accounts.google.com/o/oauth2/v2/auth")
    assert "drive.file" in url or "drive%2Efile" in url or DRIVE_FILE_SCOPE.split("/")[-1] in url
    assert "access_type=offline" in url
    assert "prompt=consent" in url


def test_drive_status_requires_auth_and_reports_unconnected():
    assert client.get("/api/drive/status").status_code == 401
    resp = client.get("/api/drive/status", cookies=AUTH_COOKIES)
    assert resp.status_code == 200
    assert resp.json() == {"connected": False}


def test_callback_stores_token_and_status_turns_connected(monkeypatch):
    owner_id = _owner_id()
    monkeypatch.setattr("app.api.routes_drive.exchange_code_for_tokens",
                        lambda code, uri: {"refresh_token": "rt-123",
                                           "access_token": "at-123"})
    resp = client.get("/auth/drive/callback",
                      params={"code": "auth-code", "state": make_state(owner_id)},
                      cookies=AUTH_COOKIES, follow_redirects=False)
    assert resp.status_code == 303, resp.text
    assert "drive=connected" in resp.headers["location"]
    assert client.get("/api/drive/status", cookies=AUTH_COOKIES).json() == {
        "connected": True}
    stored = db_manager.get_drive_token(owner_id)
    assert stored and decrypt_refresh_token(stored) == "rt-123"


def test_callback_rejects_forged_state(monkeypatch):
    monkeypatch.setattr("app.api.routes_drive.exchange_code_for_tokens",
                        lambda code, uri: {"refresh_token": "rt-x"})
    resp = client.get("/auth/drive/callback",
                      params={"code": "auth-code", "state": "someone-else.bad"},
                      cookies=AUTH_COOKIES, follow_redirects=False)
    assert resp.status_code == 303
    assert "drive=error" in resp.headers["location"]


def test_disconnect_removes_token(monkeypatch):
    owner_id = _owner_id()
    db_manager.save_drive_token(owner_id, encrypt_refresh_token("rt-1"))
    assert client.get("/api/drive/status", cookies=AUTH_COOKIES).json() == {
        "connected": True}
    monkeypatch.setattr("app.api.routes_drive.revoke_refresh_token",
                        lambda token: None)
    resp = client.post("/api/drive/disconnect", cookies=AUTH_COOKIES)
    assert resp.status_code == 200
    assert client.get("/api/drive/status", cookies=AUTH_COOKIES).json() == {
        "connected": False}


def test_upload_without_drive_connected_is_friendly_503():
    owner_id = _owner_id()
    db_manager.delete_drive_token(owner_id)
    resp = client.post("/api/media/upload",
                       files={"file": ("pic.png", b"fake-png", "image/png")},
                       data={"media_type": "photo"}, cookies=AUTH_COOKIES)
    assert resp.status_code == 503, resp.text
    assert "Google Drive" in resp.json()["detail"]
