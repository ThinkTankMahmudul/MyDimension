"""Per-user Google Drive OAuth: connect, token exchange, encryption.

Why per-user OAuth (not a service account): a service account has no
Drive storage quota of its own, so every upload it creates fails with
Google's 403 ``storageQuotaExceeded`` — even into a folder shared with
it by the owner (found live 25 Nov 2026). Files must be created with
the *user's own* Google account, so they count against that user's
15 GB free Drive storage.

How it works:
- Each signed-in user taps "Connect Google Drive" in Settings. Google
  asks once for the ``drive.file`` scope (the app can only see files
  it creates itself) with offline access, and returns a long-lived
  refresh token. The owner uses the exact same flow for their own
  Drive — there is no separate owner path.
- The refresh token is encrypted (Fernet; key derived from
  SESSION_SECRET via HKDF, so no extra secret has to be managed) and
  stored per user in PostgreSQL (``drive_tokens``). The access token
  is never stored — ``google-auth`` refreshes it automatically.
- Refresh tokens issued while the Google app is in Testing mode
  expire after 7 days, so the OAuth consent screen must be published
  (Production) for this to be set-and-forget. Publishing without full
  verification shows an "unverified app" warning the user clicks
  through; that is fine for a small private circle.
- The callback's ``state`` is the user id signed with HMAC
  (SESSION_SECRET), so a callback can never be replayed for another
  user. The session user must also match the state.
"""
from __future__ import annotations

import base64
import hashlib
import hmac as hmac_mod
import json
import logging
import urllib.parse

from ..core.config import settings

logger = logging.getLogger("mydimension.drive_auth")

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke"
DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file"


class DriveAuthError(Exception):
    """Google Drive connect / token exchange failed (friendly message)."""


def get_drive_redirect_uri() -> str:
    """Callback URL — register exactly this in Google Cloud Console."""
    return settings.frontend_origin.rstrip("/") + "/auth/drive/callback"


def build_drive_auth_url(state: str) -> str:
    """Google consent URL for Drive (drive.file scope, offline access)."""
    if not settings.google_client_id:
        raise DriveAuthError("Google sign-in is not configured yet.")
    params = {
        "client_id": settings.google_client_id,
        "redirect_uri": get_drive_redirect_uri(),
        "response_type": "code",
        "scope": DRIVE_FILE_SCOPE,
        "access_type": "offline",  # long-lived refresh token
        "prompt": "consent",  # always return a refresh token
        "include_granted_scopes": "true",
        "state": state,
    }
    return f"{GOOGLE_AUTH_URL}?{urllib.parse.urlencode(params)}"


def make_state(user_id: str) -> str:
    """Sign the user id so the callback can prove who connected."""
    sig = hmac_mod.new(settings.session_secret.encode(), user_id.encode(),
                       hashlib.sha256).hexdigest()
    return f"{user_id}.{sig}"


def verify_state(state: str) -> str | None:
    """Return the user id if the state signature is valid, else None."""
    if not state or "." not in state:
        return None
    user_id, sig = state.rsplit(".", 1)
    expected = hmac_mod.new(settings.session_secret.encode(), user_id.encode(),
                            hashlib.sha256).hexdigest()
    if not hmac_mod.compare_digest(sig, expected):
        return None
    return user_id


def exchange_code_for_tokens(code: str, redirect_uri: str) -> dict:
    """Exchange an OAuth code for tokens (must include a refresh token)."""
    import httpx

    try:
        resp = httpx.post(GOOGLE_TOKEN_URL, data={
            "code": code,
            "client_id": settings.google_client_id,
            "client_secret": settings.google_client_secret,
            "redirect_uri": redirect_uri,
            "grant_type": "authorization_code",
        }, timeout=15)
        resp.raise_for_status()
        tokens = resp.json()
    except Exception as exc:
        raise DriveAuthError(
            "Google Drive could not be connected. Please try again.") from exc
    if not tokens.get("refresh_token"):
        raise DriveAuthError(
            "Google did not return a lasting Drive connection. "
            "Please try connecting again.")
    return tokens


def revoke_refresh_token(refresh_token: str) -> None:
    """Best-effort revoke at Google (failures are ignored)."""
    import httpx

    try:
        httpx.post(GOOGLE_REVOKE_URL, data={"token": refresh_token},
                   timeout=10)
    except Exception as exc:  # never fail a disconnect on this
        logger.warning("Drive token revoke failed (ignored): %s", exc)


# -- refresh-token encryption -------------------------------------------
# Fernet key derived from SESSION_SECRET (HKDF) — no extra secret to
# manage, and the Drive key is cryptographically separate from the
# session-signing key. Refresh tokens never appear in logs or responses.

def _fernet():
    from cryptography.fernet import Fernet
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF

    key = HKDF(algorithm=hashes.SHA256(), length=32, salt=None,
               info=b"mydimension-drive-refresh-token-v1").derive(
        settings.session_secret.encode())
    return Fernet(base64.urlsafe_b64encode(key))


def encrypt_refresh_token(refresh_token: str) -> str:
    return _fernet().encrypt(refresh_token.encode()).decode()


def decrypt_refresh_token(encrypted: str) -> str:
    from cryptography.fernet import InvalidToken

    try:
        return _fernet().decrypt(encrypted.encode()).decode()
    except InvalidToken as exc:
        raise DriveAuthError(
            "The saved Drive connection is unreadable. "
            "Please reconnect Google Drive in Settings.") from exc


def drive_credentials_from_refresh_token(refresh_token: str):
    """google-auth Credentials that refresh themselves when needed."""
    from google.oauth2.credentials import Credentials

    return Credentials(
        token=None,
        refresh_token=refresh_token,
        token_uri=GOOGLE_TOKEN_URL,
        client_id=settings.google_client_id,
        client_secret=settings.google_client_secret,
        scopes=[DRIVE_FILE_SCOPE],
    )
