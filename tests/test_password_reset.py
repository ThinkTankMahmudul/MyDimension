"""Password-reset tests (POST /api/auth/forgot-password,
/api/auth/reset-password) and change-password while signed in
(POST /api/auth/change-password).

Uses the same TestClient + dev-fallback store as the other API tests:
no real database or email account is needed. SMTP is faked by
monkeypatching ``email_service.send_password_reset_code`` to capture
the code instead of sending a real email, and by setting dummy
SMTP_USER / SMTP_PASSWORD on the shared settings object.

Every test uses a unique email address because all tests share the
one in-memory store (see the note in test_api.py).
"""
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from fastapi.testclient import TestClient  # noqa: E402

from app.core.config import settings  # noqa: E402
from app.core.security import SESSION_COOKIE, create_session_token  # noqa: E402
from app.main import app  # noqa: E402
from app.services.database_manager import db_manager  # noqa: E402
from app.services.email_service import email_service  # noqa: E402

client = TestClient(app, raise_server_exceptions=False)
AUTH_COOKIES = {SESSION_COOKIE: create_session_token(settings.admin_email)}


def _unique_email() -> str:
    return f"reset-{uuid.uuid4().hex[:10]}@example.com"


@pytest.fixture
def smtp(monkeypatch):
    """Pretend SMTP is configured and capture every sent reset code."""
    captured: dict[str, str] = {}
    monkeypatch.setattr(settings, "smtp_user", "sender@example.com")
    monkeypatch.setattr(settings, "smtp_password", "fake-app-password")

    def fake_send(to_email: str, name: str, code: str) -> None:
        captured[to_email] = code

    monkeypatch.setattr(email_service, "send_password_reset_code", fake_send)
    return captured


def _register(email: str, name: str = "Reset User", password: str = "old-pass-1"):
    return client.post("/api/auth/register",
                       json={"name": name, "email": email, "password": password})


def _verify(email: str, code: str):
    return client.post("/api/auth/verify-code",
                       json={"email": email, "code": code})


def _register_and_verify_captured(email: str, captured, password: str = "old-pass-1"):
    """Register + verify using the captured sign-up code; returns the
    session cookies."""
    assert _register(email, password=password).status_code == 200
    code = captured[email]
    resp = _verify(email, code)
    assert resp.status_code == 200, resp.text
    assert SESSION_COOKIE in resp.cookies
    return resp.cookies


def _forgot(email: str):
    return client.post("/api/auth/forgot-password", json={"email": email})


def _reset(email: str, code: str, new_password: str):
    return client.post("/api/auth/reset-password",
                       json={"email": email, "code": code,
                             "new_password": new_password})


def _age_reset_codes(email: str, seconds: int) -> None:
    """Move every stored reset code for *email* back in time (dev fallback only)."""
    for code in db_manager._codes.values():  # noqa: SLF001 - test-only store access
        if code["email"] == email and code.get("purpose") == "reset":
            code["created_at"] = code["created_at"] - timedelta(seconds=seconds)


def test_forgot_unknown_email_is_200_and_sends_nothing(smtp):
    """No account probing: an unknown email gets the same 200, and no
    code is created or sent."""
    email = _unique_email()
    resp = _forgot(email)
    assert resp.status_code == 200, resp.text
    assert "If an account exists" in resp.json()["detail"]
    assert email not in smtp
    assert db_manager.get_latest_verification_code(email, "reset") is None


def test_forgot_unverified_email_sends_nothing(smtp, monkeypatch):
    """An unverified user gets the same generic 200 and no code — they
    must finish sign-up verification first."""
    # Capture the sign-up code too (same fixture style as registration).
    signups: dict[str, str] = {}
    monkeypatch.setattr(email_service, "send_verification_code",
                        lambda to, name, code: signups.__setitem__(to, code))
    email = _unique_email()
    assert _register(email).status_code == 200
    assert email in signups
    resp = _forgot(email)
    assert resp.status_code == 200, resp.text
    assert email not in smtp
    assert db_manager.get_latest_verification_code(email, "reset") is None


def test_forgot_and_reset_flow(smtp, monkeypatch):
    """Happy path: forgot -> code mailed -> wrong code 400 -> right
    code + new password 200 -> old password dead, new password works."""
    signups: dict[str, str] = {}
    monkeypatch.setattr(email_service, "send_verification_code",
                        lambda to, name, code: signups.__setitem__(to, code))
    email = _unique_email()
    _register_and_verify_captured(email, signups)

    resp = _forgot(email)
    assert resp.status_code == 200, resp.text
    assert "If an account exists" in resp.json()["detail"]
    code = smtp[email]
    assert len(code) == 6 and code.isdigit()

    # Wrong code -> 400, password unchanged.
    assert _reset(email, "000000", "new-pass-1").status_code == 400
    assert client.post("/api/auth/login",
                       json={"username": email, "password": "old-pass-1"}).status_code == 200

    # Short new password -> 400, code still valid.
    assert _reset(email, code, "abc").status_code == 400

    # Correct code -> 200, reset codes gone.
    resp = _reset(email, code, "new-pass-1")
    assert resp.status_code == 200, resp.text
    assert db_manager.get_latest_verification_code(email, "reset") is None

    # Old password dead, new password works.
    assert client.post("/api/auth/login",
                       json={"username": email, "password": "old-pass-1"}).status_code == 401
    resp = client.post("/api/auth/login",
                       json={"username": email, "password": "new-pass-1"})
    assert resp.status_code == 200, resp.text


def test_reset_expired_code_is_400(smtp, monkeypatch):
    email = _unique_email()
    signups: dict[str, str] = {}
    monkeypatch.setattr(email_service, "send_verification_code",
                        lambda to, name, code: signups.__setitem__(to, code))
    _register_and_verify_captured(email, signups)
    assert _forgot(email).status_code == 200
    code = smtp[email]
    for stored in db_manager._codes.values():  # noqa: SLF001 - test-only store access
        if stored["email"] == email and stored.get("purpose") == "reset":
            stored["expires_at"] = datetime.now(timezone.utc) - timedelta(minutes=1)
    resp = _reset(email, code, "new-pass-1")
    assert resp.status_code == 400, resp.text
    assert "expired" in resp.json()["detail"]


def test_reset_five_wrong_attempts_blocks(smtp, monkeypatch):
    email = _unique_email()
    signups: dict[str, str] = {}
    monkeypatch.setattr(email_service, "send_verification_code",
                        lambda to, name, code: signups.__setitem__(to, code))
    _register_and_verify_captured(email, signups)
    assert _forgot(email).status_code == 200
    # 5 wrong attempts are 400s; the 6th is blocked (429).
    for _ in range(5):
        assert _reset(email, "000000", "new-pass-1").status_code == 400
    resp = _reset(email, "000000", "new-pass-1")
    assert resp.status_code == 429, resp.text


def test_signup_code_cannot_reset_password(smtp, monkeypatch):
    """Purpose separation: a sign-up verification code is never
    accepted as a password-reset code."""
    signups: dict[str, str] = {}
    monkeypatch.setattr(email_service, "send_verification_code",
                        lambda to, name, code: signups.__setitem__(to, code))
    email = _unique_email()
    assert _register(email).status_code == 200
    verify_code = signups[email]
    # No reset code exists for this email at all — the verify code must
    # not be found by the reset flow.
    resp = _reset(email, verify_code, "new-pass-1")
    assert resp.status_code == 400, resp.text
    assert "expired" in resp.json()["detail"]


def test_forgot_without_smtp_is_503(smtp, monkeypatch):
    """Email not configured: forgot-password answers 503 (for a real
    account — no code is created). SMTP is switched off only after the
    user is registered and verified, so the sign-up itself still works."""
    signups: dict[str, str] = {}
    monkeypatch.setattr(email_service, "send_verification_code",
                        lambda to, name, code: signups.__setitem__(to, code))
    email = _unique_email()
    _register_and_verify_captured(email, signups)
    monkeypatch.setattr(settings, "smtp_user", None)
    monkeypatch.setattr(settings, "smtp_password", None)
    resp = _forgot(email)
    assert resp.status_code == 503, resp.text
    assert "not configured" in resp.json()["detail"]
    assert db_manager.get_latest_verification_code(email, "reset") is None


def test_forgot_cooldown_and_hourly_limit(smtp, monkeypatch):
    email = _unique_email()
    signups: dict[str, str] = {}
    monkeypatch.setattr(email_service, "send_verification_code",
                        lambda to, name, code: signups.__setitem__(to, code))
    _register_and_verify_captured(email, signups)
    assert _forgot(email).status_code == 200  # code 1
    assert _forgot(email).status_code == 429  # within 60 seconds
    for _ in range(4):  # codes 2-5, ageing past the cooldown each time
        _age_reset_codes(email, 61)
        assert _forgot(email).status_code == 200
    _age_reset_codes(email, 61)
    assert _forgot(email).status_code == 429  # 6th code within an hour


def test_change_password_wrong_current_fails_then_ok(smtp, monkeypatch):
    email = _unique_email()
    signups: dict[str, str] = {}
    monkeypatch.setattr(email_service, "send_verification_code",
                        lambda to, name, code: signups.__setitem__(to, code))
    cookies = _register_and_verify_captured(email, signups)

    # No session -> 401.
    client.cookies.clear()
    assert client.post("/api/auth/change-password",
                       json={"current_password": "old-pass-1",
                             "new_password": "new-pass-1"}).status_code == 401

    # Wrong current password -> 400, password unchanged.
    resp = client.post("/api/auth/change-password",
                       json={"current_password": "not-the-password",
                             "new_password": "new-pass-1"},
                       cookies=cookies)
    assert resp.status_code == 400, resp.text
    assert "Current password" in resp.json()["detail"]

    # Short new password -> 400.
    resp = client.post("/api/auth/change-password",
                       json={"current_password": "old-pass-1",
                             "new_password": "abc"},
                       cookies=cookies)
    assert resp.status_code == 400, resp.text

    # Correct current password -> 200, new password works.
    resp = client.post("/api/auth/change-password",
                       json={"current_password": "old-pass-1",
                             "new_password": "new-pass-1"},
                       cookies=cookies)
    assert resp.status_code == 200, resp.text
    assert client.post("/api/auth/login",
                       json={"username": email, "password": "old-pass-1"}).status_code == 401
    assert client.post("/api/auth/login",
                       json={"username": email, "password": "new-pass-1"}).status_code == 200


def test_owner_forgot_and_reset_updates_user_id_login(smtp):
    """The owner resets by email too — and the new password must work
    for the User ID + Password login (auth_settings), not just the
    users row."""
    client.cookies.clear()
    # Touch /api/me so the owner's users row exists (verified).
    me = client.get("/api/me", cookies=AUTH_COOKIES)
    assert me.status_code == 200, me.text
    email = settings.admin_email

    resp = _forgot(email)
    assert resp.status_code == 200, resp.text
    code = smtp[email]
    assert len(code) == 6 and code.isdigit()

    resp = _reset(email, code, "owner-reset-pass-1")
    assert resp.status_code == 200, resp.text
    # The User ID login now takes the new password.
    resp = client.post("/api/auth/login",
                       json={"username": settings.admin_username,
                             "password": "owner-reset-pass-1"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["is_owner"] is True
