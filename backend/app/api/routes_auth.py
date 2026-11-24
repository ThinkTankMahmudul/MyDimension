"""Authentication routes: Google OAuth login, callback, logout, /api/me.

Note: the OAuth *login* step redirects to Google's official consent
screen; the *callback* verifies the returned ID token on the backend
(see AuthService). No password or public registration exists.
"""
from __future__ import annotations

import urllib.parse

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import RedirectResponse

from ..core.config import settings
from ..core.security import SESSION_COOKIE, require_admin
from ..services.auth_service import AuthError, auth_service

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


@router.get("/api/me")
def me(email: str = Depends(require_admin)):
    """Return the signed-in owner's email (only after authentication)."""
    return {"email": email, "is_owner": True}
