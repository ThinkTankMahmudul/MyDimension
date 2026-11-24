"""Session-cookie handling and the ``require_admin`` guard.

Sessions are a signed (HMAC) token stored in an HttpOnly cookie named
``mydimension_session``. The token carries only the owner's email and an
expiry timestamp -- never a password or an API key. The backend checks the
signature and that the email exactly matches ``ADMIN_EMAIL`` on every
protected request, so a modified frontend can never grant access.
"""
from __future__ import annotations

import hashlib
import hmac
import time
from typing import Annotated

from fastapi import Cookie, Depends, HTTPException, status

from .config import settings

SESSION_COOKIE = "mydimension_session"
SESSION_TTL_SECONDS = 7 * 24 * 60 * 60  # 7 days


def _signature(email: str, expires_at: int) -> str:
    """HMAC signature for a session payload."""
    message = f"{email}|{expires_at}".encode()
    return hmac.new(settings.session_secret.encode(), message, hashlib.sha256).hexdigest()


def create_session_token(email: str) -> str:
    """Create a signed session token for *email* (``email|expiry|signature``)."""
    expires_at = int(time.time()) + SESSION_TTL_SECONDS
    return f"{email}|{expires_at}|{_signature(email, expires_at)}"


def verify_session_token(token: str | None) -> str | None:
    """Return the email inside a valid, unexpired token, else ``None``."""
    if not token:
        return None
    try:
        email, expires_at, signature = token.split("|")
        if int(expires_at) < int(time.time()):
            return None
        if not hmac.compare_digest(signature, _signature(email, int(expires_at))):
            return None
        return email
    except (ValueError, TypeError):
        return None


def require_admin(
    session: Annotated[str | None, Cookie(alias=SESSION_COOKIE)] = None,
) -> str:
    """FastAPI dependency: allow only the verified owner (ADMIN_EMAIL).

    Raises 401 for a missing/invalid session and 403 for any other email.
    Unchanged: password setup (``set-password``) still uses this.
    """
    email = verify_session_token(session)
    if email is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="Please sign in to continue.")
    if email != settings.admin_email:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                            detail="This account is not the owner of MyDimension.")
    return email


OWNER_NAME = "Mahmudul Hasan Walid"


def _ensure_owner_user() -> dict:
    """Return the owner's ``users`` row, creating it on first use.

    The owner has no sign-up row (they sign in with Google / User ID +
    Password), so the first authenticated owner request creates one,
    reusing the owner's password hash when one is set. Legacy rows
    (``user_id`` NULL, created before multi-user scoping) are backfilled
    to this owner id here.
    """
    from ..services.database_manager import db_manager
    from ..services.password_auth import hash_password

    owner_email = settings.admin_email
    user = db_manager.get_user_by_email(owner_email)
    if user is None:
        password_hash = db_manager.get_password_hash()
        if not password_hash:
            import secrets

            password_hash = hash_password(secrets.token_hex(32))
        user = db_manager.create_user(OWNER_NAME, owner_email, password_hash)
        if not user.get("is_verified"):
            user = db_manager.set_user_verified(owner_email) or user
    db_manager.backfill_user_id(str(user["id"]))
    return user


def require_user(
    session: Annotated[str | None, Cookie(alias=SESSION_COOKIE)] = None,
) -> dict:
    """FastAPI dependency: allow any verified user (owner or registered).

    Verifies the session token, then loads the user row. The owner gets
    a row created on first use (see ``_ensure_owner_user``). An
    unverified user gets 403; an unknown email gets 401.

    Returns ``{"id", "email", "name", "is_owner"}`` for the routes to
    scope data by ``user_id``.
    """
    email = verify_session_token(session)
    if email is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="Please sign in to continue.")
    from ..services.database_manager import db_manager

    if email == settings.admin_email:
        user = _ensure_owner_user()
    else:
        user = db_manager.get_user_by_email(email)
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="Please sign in to continue.")
    if not user.get("is_verified"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                            detail="Please verify your email first.")
    return {
        "id": str(user["id"]),
        "email": user["email"],
        "name": user["name"],
        "is_owner": user["email"] == settings.admin_email,
    }
