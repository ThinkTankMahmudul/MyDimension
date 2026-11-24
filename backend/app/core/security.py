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
    """
    email = verify_session_token(session)
    if email is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="Please sign in to continue.")
    if email != settings.admin_email:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                            detail="This account is not the owner of MyDimension.")
    return email
