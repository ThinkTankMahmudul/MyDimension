"""Sign-up / email-verification tests (POST /api/auth/register,
/api/auth/verify-code, /api/auth/resend-code) and multi-user isolation.

Uses the same TestClient + dev-fallback store as the other API tests:
no real database or Gmail account is needed. SMTP is faked by
monkeypatching ``email_service.send_verification_code`` to capture
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
    return f"user-{uuid.uuid4().hex[:10]}@example.com"


@pytest.fixture
def smtp(monkeypatch):
    """Pretend SMTP is configured and capture every sent code."""
    captured: dict[str, str] = {}
    monkeypatch.setattr(settings, "smtp_user", "sender@example.com")
    monkeypatch.setattr(settings, "smtp_password", "fake-app-password")

    def fake_send(to_email: str, name: str, code: str) -> None:
        captured[to_email] = code

    monkeypatch.setattr(email_service, "send_verification_code", fake_send)
    return captured


@pytest.fixture
def no_smtp(monkeypatch):
    """SMTP not configured: register / resend must answer 503."""
    monkeypatch.setattr(settings, "smtp_user", None)
    monkeypatch.setattr(settings, "smtp_password", None)


def _register(email: str, name: str = "Test User", password: str = "pass1234"):
    return client.post("/api/auth/register",
                       json={"name": name, "email": email, "password": password})


def _verify(email: str, code: str):
    return client.post("/api/auth/verify-code",
                       json={"email": email, "code": code})


def _register_and_verify(email: str, captured, name: str = "Test User",
                         password: str = "pass1234"):
    """Register + verify a user; returns the session cookies."""
    resp = _register(email, name, password)
    assert resp.status_code == 200, resp.text
    code = captured[email]
    assert len(code) == 6 and code.isdigit()
    resp = _verify(email, code)
    assert resp.status_code == 200, resp.text
    assert resp.json()["email"] == email
    assert resp.json()["name"] == name
    assert resp.json()["is_owner"] is False
    assert SESSION_COOKIE in resp.cookies
    return resp.cookies


def _age_codes(email: str, seconds: int) -> None:
    """Move every stored code for *email* back in time (dev fallback only)."""
    for code in db_manager._codes.values():  # noqa: SLF001 - test-only store access
        if code["email"] == email:
            code["created_at"] = code["created_at"] - timedelta(seconds=seconds)


def test_register_without_smtp_is_503_and_saves_nothing(no_smtp):
    email = _unique_email()
    resp = _register(email)
    assert resp.status_code == 503, resp.text
    assert "not configured" in resp.json()["detail"]
    assert db_manager.get_user_by_email(email) is None
    assert db_manager.get_latest_verification_code(email) is None


def test_register_validation_errors(smtp):
    email = _unique_email()
    assert _register(email, name="").status_code == 400
    assert _register(email, name="x" * 101).status_code == 400
    assert _register("not-an-email").status_code == 400
    assert _register(email, password="abc").status_code == 400


def test_register_verify_flow(smtp):
    email = _unique_email()
    resp = _register(email)
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"detail": "Verification code sent to your email.",
                           "email": email}
    # Upper-case email is stored lower-cased.
    assert db_manager.get_user_by_email(email.upper()) is not None

    # Wrong code -> 400, user stays unverified.
    assert _verify(email, "000000").status_code == 400
    assert _verify(email, "000000").json()["detail"] == "Incorrect verification code."
    assert db_manager.get_user_by_email(email)["is_verified"] is False

    # Correct code -> 200 + session cookie, then /api/me works.
    cookies = _register_and_verify_check(email, smtp)
    me = client.get("/api/me", cookies=cookies)
    assert me.status_code == 200, me.text
    assert me.json() == {"email": email, "is_owner": False, "name": "Test User"}


def _register_and_verify_check(email: str, captured):
    """Verify with the captured code (register already happened)."""
    code = captured[email]
    resp = _verify(email, code)
    assert resp.status_code == 200, resp.text
    assert SESSION_COOKIE in resp.cookies
    return resp.cookies


def test_verify_expired_code_is_400(smtp):
    email = _unique_email()
    assert _register(email).status_code == 200
    code = smtp[email]
    # Push the stored code's expiry into the past (dev fallback store).
    for stored in db_manager._codes.values():  # noqa: SLF001 - test-only store access
        if stored["email"] == email:
            stored["expires_at"] = datetime.now(timezone.utc) - timedelta(minutes=1)
    resp = _verify(email, code)
    assert resp.status_code == 400, resp.text
    assert "expired" in resp.json()["detail"]


def test_reregister_verified_email_is_409(smtp):
    email = _unique_email()
    _register_and_verify(email, smtp)
    resp = _register(email)
    assert resp.status_code == 409, resp.text


def test_reregister_unverified_updates_and_resends(smtp):
    email = _unique_email()
    assert _register(email, name="First Name", password="first-pass").status_code == 200
    first_code = smtp[email]
    _age_codes(email, 61)  # pass the 60s resend cooldown
    resp = _register(email, name="Second Name", password="second-pass")
    assert resp.status_code == 200, resp.text
    assert smtp[email] != first_code  # a fresh code was issued
    user = db_manager.get_user_by_email(email)
    assert user["name"] == "Second Name"
    # Old password no longer works; new one does (after verification).
    cookies = _register_and_verify_check(email, smtp)
    assert client.get("/api/me", cookies=cookies).status_code == 200
    resp = client.post("/api/auth/login",
                       json={"username": email, "password": "second-pass"})
    assert resp.status_code == 200, resp.text


def test_resend_within_60_seconds_is_429(smtp):
    email = _unique_email()
    assert _register(email).status_code == 200
    resp = client.post("/api/auth/resend-code", json={"email": email})
    assert resp.status_code == 429, resp.text


def test_resend_after_cooldown_works_and_hourly_limit(smtp):
    email = _unique_email()
    assert _register(email).status_code == 200  # code 1
    for _ in range(4):  # codes 2-5 via resend, ageing past the cooldown each time
        _age_codes(email, 61)
        resp = client.post("/api/auth/resend-code", json={"email": email})
        assert resp.status_code == 200, resp.text
    _age_codes(email, 61)
    resp = client.post("/api/auth/resend-code", json={"email": email})
    assert resp.status_code == 429, resp.text  # 6th code within an hour


def test_resend_unknown_or_verified_email_is_400(smtp):
    assert client.post("/api/auth/resend-code",
                       json={"email": _unique_email()}).status_code == 400
    email = _unique_email()
    _register_and_verify(email, smtp)
    assert client.post("/api/auth/resend-code", json={"email": email}).status_code == 400


def test_unverified_user_login_is_403_then_verified_login_works(smtp):
    email = _unique_email()
    assert _register(email, password="pass1234").status_code == 200
    resp = client.post("/api/auth/login",
                       json={"username": email, "password": "pass1234"})
    assert resp.status_code == 403, resp.text
    assert "verify" in resp.json()["detail"]
    cookies = _register_and_verify_check(email, smtp)
    assert client.get("/api/me", cookies=cookies).status_code == 200
    resp = client.post("/api/auth/login",
                       json={"username": email, "password": "pass1234"})
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"email": email, "name": "Test User", "is_owner": False}
    assert client.post("/api/auth/login",
                       json={"username": email, "password": "wrong"}).status_code == 401
    assert client.post("/api/auth/login",
                       json={"username": _unique_email(), "password": "pass1234"}).status_code == 401


def test_entries_are_isolated_between_users(smtp):
    email_a = _unique_email()
    email_b = _unique_email()
    cookies_a = _register_and_verify(email_a, smtp, name="User A")
    cookies_b = _register_and_verify(email_b, smtp, name="User B")

    created = client.post("/api/entries",
                          json={"title": "A private entry", "content": "only for A",
                                "mood": "happy", "tags": []},
                          cookies=cookies_a)
    assert created.status_code == 201, created.text
    entry_id = created.json()["id"]

    # B cannot see A's entry: not in list, not by id, cannot delete it.
    listed_b = client.get("/api/entries", cookies=cookies_b)
    assert listed_b.status_code == 200
    assert all(e["id"] != entry_id for e in listed_b.json())
    assert client.get(f"/api/entries/{entry_id}", cookies=cookies_b).status_code == 404
    assert client.delete(f"/api/entries/{entry_id}", cookies=cookies_b).status_code == 404

    # A still sees it, and the owner's entries are separate too.
    listed_a = client.get("/api/entries", cookies=cookies_a)
    assert any(e["id"] == entry_id for e in listed_a.json())
    # NOTE: verify-code responses stored a user session cookie in the
    # shared TestClient jar; clear it so the owner cookie below is the
    # one actually sent (per-request cookies do not override the jar
    # in this httpx version).
    client.cookies.clear()
    listed_owner = client.get("/api/entries", cookies=AUTH_COOKIES)
    assert all(e["id"] != entry_id for e in listed_owner.json())

    # Mood insights are scoped as well: B has no moods.
    assert client.get("/api/insights/moods", cookies=cookies_b).json() == []
    assert client.delete(f"/api/entries/{entry_id}", cookies=cookies_a).status_code == 200


def test_owner_user_id_password_login_still_works():
    # Clear the TestClient cookie jar first: earlier tests in this file
    # stored other users' session cookies there, and a per-request
    # cookies= dict does not override the jar in this httpx version.
    client.cookies.clear()
    # Set (or reset) the owner password via the owner session, then log in.
    resp = client.post("/api/auth/set-password", json={"new_password": "owner-pass-1"},
                       cookies=AUTH_COOKIES)
    assert resp.status_code == 200, resp.text
    resp = client.post("/api/auth/login",
                       json={"username": settings.admin_username, "password": "owner-pass-1"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["email"] == settings.admin_email
    assert resp.json()["is_owner"] is True
    me = client.get("/api/me", cookies=resp.cookies)
    assert me.status_code == 200
    assert me.json()["email"] == settings.admin_email
    assert me.json()["is_owner"] is True
    assert me.json()["name"] == "Mahmudul Hasan Walid"
