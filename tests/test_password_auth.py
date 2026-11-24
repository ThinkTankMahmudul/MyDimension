"""Password-login tests (User ID + Password, Google OAuth untouched).

Uses the same TestClient + dev-fallback store as test_api.py: no real
database, Google account, or Gemini key is needed. The password hash
lives in the dev-fallback in-memory store, mirroring the PostgreSQL
``auth_settings`` table used in production.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from fastapi.testclient import TestClient  # noqa: E402

from app.core.config import settings  # noqa: E402
from app.core.security import SESSION_COOKIE, create_session_token  # noqa: E402
from app.main import app  # noqa: E402
from app.services.password_auth import (  # noqa: E402
    hash_password,
    verify_password,
)

client = TestClient(app, raise_server_exceptions=False)
AUTH_COOKIES = {SESSION_COOKIE: create_session_token(settings.admin_email)}
USERNAME = settings.admin_username


def test_hash_and_verify_roundtrip():
    stored = hash_password("correct horse battery staple")
    assert stored != "correct horse battery staple"
    assert "$" in stored
    assert verify_password("correct horse battery staple", stored) is True
    assert verify_password("wrong password", stored) is False
    assert verify_password("correct horse battery staple", None) is False
    assert verify_password("correct horse battery staple", "not-a-hash") is False


def test_password_status_false_before_setup():
    resp = client.get("/api/auth/password-status")
    assert resp.status_code == 200
    assert resp.json() == {"password_set": False}


def test_password_login_before_setup_is_409():
    resp = client.post("/api/auth/login", json={"username": USERNAME, "password": "anything"})
    assert resp.status_code == 409


def test_set_password_requires_login():
    resp = client.post("/api/auth/set-password", json={"new_password": "s3cret-pass"})
    assert resp.status_code == 401


def test_set_password_rejects_short_password():
    resp = client.post("/api/auth/set-password", json={"new_password": "abc"},
                       cookies=AUTH_COOKIES)
    assert resp.status_code == 422


def test_password_login_flow():
    # First-time setup (signed in via the Google-equivalent session cookie).
    resp = client.post("/api/auth/set-password", json={"new_password": "s3cret-pass"},
                       cookies=AUTH_COOKIES)
    assert resp.status_code == 200, resp.text

    # Wrong password -> generic 401, same as wrong username.
    assert client.post("/api/auth/login",
                       json={"username": USERNAME, "password": "nope"}).status_code == 401
    assert client.post("/api/auth/login",
                       json={"username": "someone-else", "password": "s3cret-pass"}).status_code == 401

    # Correct credentials -> 200 + session cookie that works for /api/me.
    resp = client.post("/api/auth/login",
                       json={"username": USERNAME, "password": "s3cret-pass"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["email"] == settings.admin_email
    assert resp.json()["is_owner"] is True
    me = client.get("/api/me", cookies=resp.cookies)
    assert me.status_code == 200
    assert me.json()["email"] == settings.admin_email

    # Changing the password invalidates the old one.
    assert client.post("/api/auth/set-password", json={"new_password": "n3w-pass-word"},
                       cookies=resp.cookies).status_code == 200
    assert client.post("/api/auth/login",
                       json={"username": USERNAME, "password": "s3cret-pass"}).status_code == 401
    assert client.post("/api/auth/login",
                       json={"username": USERNAME, "password": "n3w-pass-word"}).status_code == 200
