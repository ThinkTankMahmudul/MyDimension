"""Authentication routes: Google OAuth login, callback, logout, /api/me,
plus User ID + Password login (POST /api/auth/login) and password setup
(POST /api/auth/set-password).

Google OAuth stays available as an alternative. The password login
checks a PBKDF2 hash stored in the database (never a plain-text
password, never an env var) and issues the same signed HttpOnly
session cookie, so ``require_admin`` works identically for both
login methods. No public registration exists.
"""
from __future__ import annotations

import urllib.parse

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field

from ..core.config import settings
from ..core.security import SESSION_COOKIE, require_admin
from ..services.auth_service import AuthError, auth_service
from ..services.database_manager import db_manager
from ..services.password_auth import (
    hash_password,
    login_rate_limiter,
    verify_password,
)

router = APIRouter(tags=["auth"])

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"


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
    """Set (first time) or change the owner password. Minimum 8 chars."""

    new_password: str = Field(min_length=8, max_length=200)


def _set_session_cookie(response: Response, email: str) -> None:
    """Set the same signed HttpOnly session cookie as Google login."""
    response.set_cookie(SESSION_COOKIE, auth_service.create_session(email),
                        httponly=True, secure=settings.is_production,
                        samesite="lax", max_age=7 * 24 * 3600, path="/")


@router.get("/api/auth/password-status")
def password_status():
    """Whether a password login is set up (boolean only, no secrets).

    The login screen uses this to tell the owner to sign in with Google
    first if no password exists yet.
    """
    return {"password_set": db_manager.get_password_hash() is not None}


@router.post("/api/auth/login")
def password_login(payload: PasswordLoginRequest, request: Request, response: Response):
    """Sign in with User ID + Password. Issues the standard session cookie.

    - No password set yet -> 409: sign in with Google and set one in Settings.
    - Wrong username OR wrong password -> identical generic 401 (no leak
      about which field was wrong).
    - 5 consecutive failures for the same username+IP -> 429, blocked
      for 15 minutes.
    """
    username = payload.username.strip()
    client_ip = request.client.host if request.client else "unknown"
    limiter_key = f"{username.lower()}|{client_ip}"
    if login_rate_limiter.is_blocked(limiter_key):
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                            detail="Too many failed sign-in attempts. Please wait a while and try again.")
    stored_hash = db_manager.get_password_hash()
    if stored_hash is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                            detail="Password sign-in is not set up yet. Sign in with Google, then set a password in Settings.")
    if username.lower() != settings.admin_username.lower() or not verify_password(payload.password, stored_hash):
        login_rate_limiter.record_failure(limiter_key)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="User ID or password is incorrect. Please try again.")
    login_rate_limiter.record_success(limiter_key)
    _set_session_cookie(response, settings.admin_email)
    return {"email": settings.admin_email, "is_owner": True}


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
def me(email: str = Depends(require_admin)):
    """Return the signed-in owner's email (only after authentication)."""
    return {"email": email, "is_owner": True}
