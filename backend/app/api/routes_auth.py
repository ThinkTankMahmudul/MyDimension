"""Authentication routes: Google OAuth login, callback, logout, /api/me,
plus User ID + Password login (POST /api/auth/login) and password setup
(POST /api/auth/set-password), plus email-verification sign-up for new
users (POST /api/auth/register, /api/auth/verify-code, /api/auth/resend-code).

Google OAuth stays available as an alternative. The password login
checks a PBKDF2 hash stored in the database (never a plain-text
password, never an env var) and issues the same signed HttpOnly
session cookie, so ``require_admin`` works identically for both
login methods. No public registration existed before; the new
register endpoints create unverified users and email them a 6-digit
code (see services/email_service.py). Verified users sign in with
their email + password and use ``require_user`` for data routes.
"""
from __future__ import annotations

import re
import secrets
import urllib.parse
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field

from ..core.config import settings
from ..core.security import SESSION_COOKIE, create_session_token, require_admin, require_user
from ..services.auth_service import AuthError, auth_service
from ..services.database_manager import db_manager
from ..services.email_service import (
    CODE_TTL_MINUTES,
    EmailNotConfiguredError,
    EmailSendError,
    email_service,
)
from ..services.password_auth import (
    hash_password,
    login_rate_limiter,
    verify_password,
)

router = APIRouter(tags=["auth"])

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"

# Registration / verification limits.
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
MAX_CODES_PER_HOUR = 5
RESEND_COOLDOWN_SECONDS = 60
MAX_CODE_ATTEMPTS = 5


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _normalise_email(email: str) -> str:
    return (email or "").strip().lower()


@router.get("/auth/google/login")
def google_login(request: Request):
    """Redirect the owner to Google's sign-in screen."""
    if not settings.google_client_id:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                            detail="Google sign-in is not configured yet.")
    redirect_uri = str(request.url_for("google_callback"))
    params = {
        "client_id": settings.google_client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": "openid email profile",
        "access_type": "offline",
        "prompt": "select_account",
    }
    return RedirectResponse(f"{GOOGLE_AUTH_URL}?{urllib.parse.urlencode(params)}")


@router.get("/auth/google/callback", name="google_callback")
async def google_callback(request: Request, code: str | None = None):
    """Exchange the OAuth code for tokens, verify the ID token, set a session."""
    if not code:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail="Google sign-in was cancelled or failed.")
    if not settings.google_client_id or not settings.google_client_secret:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                            detail="Google sign-in is not configured yet.")
    import httpx

    redirect_uri = str(request.url_for("google_callback"))
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            token_resp = await client.post(GOOGLE_TOKEN_URL, data={
                "code": code, "client_id": settings.google_client_id,
                "client_secret": settings.google_client_secret,
                "redirect_uri": redirect_uri, "grant_type": "authorization_code",
            })
        token_resp.raise_for_status()
        id_token = token_resp.json().get("id_token")
        if not id_token:
            raise AuthError("Google did not return an identity token.")
        claims = auth_service.verify_id_token(id_token)
    except AuthError as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY,
                            detail="Google sign-in failed. Please try again.") from exc

    response = RedirectResponse(url=settings.frontend_origin, status_code=303)
    response.set_cookie(SESSION_COOKIE, auth_service.create_session(claims["email"]),
                        httponly=True, secure=settings.is_production,
                        samesite="lax", max_age=7 * 24 * 3600, path="/")
    return response


@router.post("/auth/logout")
def logout(response: Response):
    """Clear the session cookie."""
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"detail": "Signed out."}


class PasswordLoginRequest(BaseModel):
    """User ID + Password login body. No hint is ever given about which
    field was wrong — both failures return the same generic 401."""

    username: str = Field(min_length=1, max_length=100)
    password: str = Field(min_length=1, max_length=200)


class SetPasswordRequest(BaseModel):
    """Set (first time) or change the owner password. Minimum 4 chars."""

    new_password: str = Field(min_length=4, max_length=200)


class RegisterRequest(BaseModel):
    """Sign-up body. Validated manually (400s) so the contract stays exact."""

    name: str = ""
    email: str = ""
    password: str = ""


class VerifyCodeRequest(BaseModel):
    """Email + 6-digit code body."""

    email: str = ""
    code: str = ""


class ResendCodeRequest(BaseModel):
    """Resend-code body."""

    email: str = ""


def _set_session_cookie(response: Response, email: str) -> None:
    """Set the signed HttpOnly session cookie for any verified user.

    Uses ``create_session_token`` directly (not ``auth_service``,
    which only issues sessions for the owner).
    """
    response.set_cookie(SESSION_COOKIE, create_session_token(email),
                        httponly=True, secure=settings.is_production,
                        samesite="lax", max_age=7 * 24 * 3600, path="/")


def _send_new_code(email: str, name: str) -> None:
    """Create a fresh 6-digit code (hashed, 10-minute expiry) and email it."""
    code = f"{secrets.randbelow(1_000_000):06d}"  # may start with 0
    expires_at = _utcnow() + timedelta(minutes=CODE_TTL_MINUTES)
    db_manager.create_verification_code(email, hash_password(code), expires_at)
    email_service.send_verification_code(email, name, code)


def _check_code_limit(email: str) -> None:
    """At most MAX_CODES_PER_HOUR codes per email in the last hour (429)."""
    since = _utcnow() - timedelta(hours=1)
    if db_manager.count_recent_codes(email, since) >= MAX_CODES_PER_HOUR:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many verification codes sent. Please try again later.")


@router.post("/api/auth/register")
def register(payload: RegisterRequest):
    """Sign up a new user and email them a 6-digit verification code.

    - Bad name / email / password -> 400.
    - Email is not configured -> 503 (nothing is saved).
    - Already verified (or the owner's email) -> 409.
    - An unverified user re-registering gets their name/password
      updated and a fresh code.
    - More than 5 codes in an hour for the email -> 429.
    """
    name = (payload.name or "").strip()
    email = _normalise_email(payload.email)
    password = payload.password or ""
    if not 1 <= len(name) <= 100:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail="Name must be between 1 and 100 characters.")
    if not EMAIL_RE.match(email):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail="Please enter a valid email address.")
    if len(password) < 4:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail="Password must be at least 4 characters.")
    existing = db_manager.get_user_by_email(email)
    if (existing and existing.get("is_verified")) or email == settings.admin_email:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                            detail="This email is already registered. Please sign in.")
    if not email_service.is_configured:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                            detail="Email is not configured yet. Please try again later.")
    _check_code_limit(email)
    password_hash = hash_password(password)
    if existing:
        db_manager.update_user(email, name=name, password_hash=password_hash)
    else:
        db_manager.create_user(name, email, password_hash)
    try:
        _send_new_code(email, name)
    except (EmailNotConfiguredError, EmailSendError) as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                            detail=str(exc)) from exc
    return {"detail": "Verification code sent to your email.", "email": email}


@router.post("/api/auth/verify-code")
def verify_code(payload: VerifyCodeRequest, response: Response):
    """Verify the emailed code, mark the user verified, and sign them in.

    - No (unexpired) code -> 400 "expired or was not found".
    - 5 wrong attempts on the same code -> 429 (blocked 15 minutes;
      request a new code).
    - Wrong code -> attempts + 1, 400 "Incorrect verification code."
    - Correct code -> user verified, codes deleted, session cookie set.
    """
    email = _normalise_email(payload.email)
    code = (payload.code or "").strip()
    if not EMAIL_RE.match(email) or not code:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail="Please enter your email and the verification code.")
    latest = db_manager.get_latest_verification_code(email)
    if latest is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail="Verification code has expired or was not found. Please request a new code.")
    expires_at = latest["expires_at"]
    if isinstance(expires_at, str):
        expires_at = datetime.fromisoformat(expires_at)
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if expires_at <= _utcnow():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail="Verification code has expired or was not found. Please request a new code.")
    if latest.get("attempts", 0) >= MAX_CODE_ATTEMPTS:
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                            detail="Too many incorrect attempts. Please wait 15 minutes and request a new code.")
    if not verify_password(code, latest.get("code_hash")):
        db_manager.increment_code_attempts(str(latest["id"]))
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail="Incorrect verification code.")
    user = db_manager.get_user_by_email(email)
    if user is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail="Verification code has expired or was not found. Please request a new code.")
    db_manager.set_user_verified(email)
    db_manager.delete_verification_codes(email)
    _set_session_cookie(response, email)
    return {"email": email, "name": user["name"], "is_owner": False}


@router.post("/api/auth/resend-code")
def resend_code(payload: ResendCodeRequest):
    """Send a fresh verification code to an unverified user.

    - No user, or already verified -> 400.
    - Email not configured -> 503.
    - Within 60 seconds of the last code, or more than 5 codes in an
      hour -> 429.
    """
    email = _normalise_email(payload.email)
    user = db_manager.get_user_by_email(email) if EMAIL_RE.match(email) else None
    if user is None or user.get("is_verified"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail="This email is not waiting for verification.")
    if not email_service.is_configured:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                            detail="Email is not configured yet. Please try again later.")
    latest = db_manager.get_latest_verification_code(email)
    if latest is not None:
        created_at = latest["created_at"]
        if isinstance(created_at, str):
            created_at = datetime.fromisoformat(created_at)
        if created_at.tzinfo is None:
            created_at = created_at.replace(tzinfo=timezone.utc)
        if (_utcnow() - created_at).total_seconds() < RESEND_COOLDOWN_SECONDS:
            raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                                detail="Please wait a minute before requesting a new code.")
    _check_code_limit(email)
    try:
        _send_new_code(email, user["name"])
    except (EmailNotConfiguredError, EmailSendError) as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                            detail=str(exc)) from exc
    return {"detail": "A new verification code has been sent."}


@router.get("/api/auth/password-status")
def password_status():
    """Whether a password login is set up (boolean only, no secrets).

    The login screen uses this to tell the owner to sign in with Google
    first if no password exists yet.
    """
    return {"password_set": db_manager.get_password_hash() is not None}


@router.post("/api/auth/login")
def password_login(payload: PasswordLoginRequest, request: Request, response: Response):
    """Sign in with User ID + Password (owner), or email + password (registered users).

    Owner path (username == ADMIN_USERNAME) is unchanged:
    - No password set yet -> 409: sign in with Google and set one in Settings.
    - Wrong username OR wrong password -> identical generic 401 (no leak
      about which field was wrong).
    - 5 consecutive failures for the same username+IP -> 429, blocked
      for 15 minutes.

    Registered-user path (any other username, treated as an email):
    - Unknown email or wrong password -> generic 401.
    - Unverified user -> 403 "Please verify your email first."
    - Correct credentials -> session cookie + {"email", "name", "is_owner": false}.
    """
    username = payload.username.strip()
    client_ip = request.client.host if request.client else "unknown"
    limiter_key = f"{username.lower()}|{client_ip}"
    if login_rate_limiter.is_blocked(limiter_key):
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                            detail="Too many failed sign-in attempts. Please wait a while and try again.")
    if username.lower() == settings.admin_username.lower():
        stored_hash = db_manager.get_password_hash()
        if stored_hash is None:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                                detail="Password sign-in is not set up yet. Sign in with Google, then set a password in Settings.")
        if not verify_password(payload.password, stored_hash):
            login_rate_limiter.record_failure(limiter_key)
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                                detail="User ID or password is incorrect. Please try again.")
        login_rate_limiter.record_success(limiter_key)
        _set_session_cookie(response, settings.admin_email)
        return {"email": settings.admin_email, "is_owner": True}
    # Registered-user path: the username is their email address.
    email = _normalise_email(username)
    user = db_manager.get_user_by_email(email) if EMAIL_RE.match(email) else None
    if user is None:
        login_rate_limiter.record_failure(limiter_key)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="User ID or password is incorrect. Please try again.")
    if not user.get("is_verified"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                            detail="Please verify your email first.")
    if not verify_password(payload.password, user.get("password_hash")):
        login_rate_limiter.record_failure(limiter_key)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="User ID or password is incorrect. Please try again.")
    login_rate_limiter.record_success(limiter_key)
    _set_session_cookie(response, email)
    return {"email": email, "name": user["name"], "is_owner": False}


@router.post("/api/auth/set-password")
def set_password(payload: SetPasswordRequest, email: str = Depends(require_admin)):
    """Set or change the owner password (signed-in admin only).

    First-time setup: sign in with Google, then call this from Settings.
    Afterwards the same endpoint changes the password. The plain-text
    password is hashed immediately and never stored or logged.
    """
    db_manager.set_password_hash(hash_password(payload.new_password))
    return {"detail": "Password saved. You can now sign in with your User ID and password."}


@router.get("/api/me")
def me(user: dict = Depends(require_user)):
    """Return the signed-in user's email, name and owner flag."""
    return {"email": user["email"], "is_owner": user["is_owner"], "name": user["name"]}
