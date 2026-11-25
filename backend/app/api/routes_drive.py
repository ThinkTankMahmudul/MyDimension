"""Per-user Google Drive connect routes.

- GET /api/drive/status — has this user connected Drive?
- GET /api/drive/connect — start the Google consent flow (any verified
  user; each user connects their *own* Drive).
- GET /auth/drive/callback — Google returns here; the refresh token is
  encrypted and stored for the session user, then the user is sent back
  to Settings. This URL must be registered in Google Cloud Console.
- POST /api/drive/disconnect — remove this user's Drive connection.

Only the token the user explicitly grants here is ever used, and only
for that user's own uploads/downloads/deletes.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import RedirectResponse

from ..core.config import settings
from ..core.security import require_user
from ..services.database_manager import db_manager
from ..services.drive_auth import (
    DriveAuthError,
    build_drive_auth_url,
    decrypt_refresh_token,
    encrypt_refresh_token,
    exchange_code_for_tokens,
    get_drive_redirect_uri,
    make_state,
    revoke_refresh_token,
    verify_state,
)

logger = logging.getLogger("mydimension.drive_routes")

router = APIRouter(tags=["drive"])


def _settings_url(result: str) -> str:
    """Back to Settings with the connect result in the query string."""
    return f"{settings.frontend_origin.rstrip('/')}/?drive={result}#/settings"


@router.get("/api/drive/status")
def drive_status(_user: dict = Depends(require_user)):
    return {"connected": db_manager.get_drive_token(_user["id"]) is not None}


@router.get("/api/drive/connect")
def drive_connect(_user: dict = Depends(require_user)):
    if not settings.google_client_id:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                            detail="Google sign-in is not configured yet.")
    try:
        url = build_drive_auth_url(make_state(_user["id"]))
    except DriveAuthError as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                            detail=str(exc)) from exc
    return RedirectResponse(url, status_code=303)


@router.get("/auth/drive/callback", name="drive_callback")
def drive_callback(request: Request, code: str | None = None,
                   state: str | None = None,
                   error: str | None = None):
    """Google returns here after consent; store the refresh token."""
    if error:
        logger.warning("Drive connect cancelled/failed at Google: %s", error)
        return RedirectResponse(_settings_url("error"), status_code=303)
    state_user_id = verify_state(state or "")
    if not state_user_id or not code:
        return RedirectResponse(_settings_url("error"), status_code=303)
    # The session user must be the user the state was signed for.
    from ..core.security import verify_session_token

    session = request.cookies.get("mydimension_session")
    email = verify_session_token(session) if session else None
    user = db_manager.get_user_by_email(email) if email else None
    if user is None or str(user["id"]) != state_user_id:
        logger.warning("Drive callback: session user does not match state.")
        return RedirectResponse(_settings_url("error"), status_code=303)
    try:
        tokens = exchange_code_for_tokens(code, get_drive_redirect_uri())
        db_manager.save_drive_token(state_user_id,
                                    encrypt_refresh_token(tokens["refresh_token"]))
    except DriveAuthError as exc:
        logger.warning("Drive connect failed: %s", exc)
        return RedirectResponse(_settings_url("error"), status_code=303)
    except Exception as exc:  # never leak a traceback to the browser
        logger.exception("Drive connect failed unexpectedly: %s", exc)
        return RedirectResponse(_settings_url("error"), status_code=303)
    return RedirectResponse(_settings_url("connected"), status_code=303)


@router.post("/api/drive/disconnect")
def drive_disconnect(_user: dict = Depends(require_user)):
    encrypted = db_manager.get_drive_token(_user["id"])
    if encrypted:
        try:
            revoke_refresh_token(decrypt_refresh_token(encrypted))
        except DriveAuthError:
            pass  # token already unreadable; still disconnect locally
        db_manager.delete_drive_token(_user["id"])
    return {"detail": "Google Drive disconnected."}
