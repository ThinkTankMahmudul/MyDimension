"""AuthService: verify Google sign-in and create owner sessions.

Flow: Google OAuth returns an ID token -> verify it with ``google-auth``
(signature, audience, expiry) -> require ``email_verified`` -> allow
only the exact ``ADMIN_EMAIL``. Any other account is rejected here, on
the backend, even if the frontend is modified.
"""
from __future__ import annotations

import logging

from ..core.config import settings
from ..core.security import create_session_token

logger = logging.getLogger("mydimension.auth")


class AuthError(Exception):
    """Friendly authentication failure (shown to the owner, no internals)."""


class AuthService:
    """Google ID-token verification + session creation."""

    def __init__(self, admin_email: str | None = None,
                 google_client_id: str | None = None) -> None:
        self.admin_email = admin_email or settings.admin_email
        self.google_client_id = google_client_id or settings.google_client_id

    def verify_id_token(self, id_token: str) -> dict:
        """Verify a Google ID token and return its claims (email, name...)."""
        if not self.google_client_id:
            raise AuthError("Google sign-in is not configured yet.")
        try:
            from google.auth.transport import requests as google_requests
            from google.oauth2 import id_token as google_id_token

            claims = google_id_token.verify_oauth2_token(
                id_token, google_requests.Request(), self.google_client_id)
        except Exception as exc:  # invalid signature / expired / wrong audience
            logger.warning("Google ID token verification failed.")
            raise AuthError("Google sign-in could not be verified. Please try again.") from exc
        if not claims.get("email_verified"):
            raise AuthError("Your Google email is not verified.")
        if claims.get("email") != self.admin_email:
            raise AuthError("This Google account is not the owner of MyDimension.")
        return claims

    def create_session(self, email: str) -> str:
        """Create a signed session token for the verified owner email."""
        if email != self.admin_email:
            raise AuthError("This Google account is not the owner of MyDimension.")
        return create_session_token(email)


auth_service = AuthService()
