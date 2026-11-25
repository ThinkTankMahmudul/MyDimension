"""Settings loaded from environment variables only.

No secrets are stored in code. ``ADMIN_EMAIL`` defaults to the owner's
confirmed Gmail, ``technicalmahmudull@gmail.com`` (confirmed by the
owner on 25 Nov 2026) -- the single account used for login, Google
Drive, and Gemini setup, each under a separate permission/consent.
It can still be overridden with the ``ADMIN_EMAIL`` environment
variable. No other account is ever allowed.

Missing optional keys only produce a warning; the app must still start
so the owner can see a friendly "not configured" message instead of a crash.
"""
from __future__ import annotations

import logging
import os

from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger("mydimension.config")

# One place for the Gemini model name, so it is easy to change later.
# gemini-2.0-flash was retired by Google on 1 Jun 2026 (every call 404s,
# which the API surfaced as 502 "AI service could not be reached").
# Default is gemini-3.5-flash (GA, available until May 2027 or later);
# override with the GEMINI_MODEL env var when Google retires it.
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.5-flash")


class Settings:
    """Simple settings holder read from the environment."""

    def __init__(self) -> None:
        self.admin_email: str = os.getenv("ADMIN_EMAIL", "technicalmahmudull@gmail.com")
        # User ID for password login (optional). Defaults to the local part
        # of ADMIN_EMAIL, e.g. "technicalmahmudull". No password is ever
        # stored in an environment variable — the password hash lives in
        # the database (see services/password_auth.py).
        self.admin_username: str = (
            os.getenv("ADMIN_USERNAME") or self.admin_email.split("@")[0]
        )
        self.database_url: str | None = os.getenv("DATABASE_URL") or None
        self.gemini_api_key: str | None = os.getenv("GEMINI_API_KEY") or None
        self.google_client_id: str | None = os.getenv("GOOGLE_CLIENT_ID") or None
        self.google_client_secret: str | None = os.getenv("GOOGLE_CLIENT_SECRET") or None
        self.session_secret: str = os.getenv("SESSION_SECRET", "dev-only-change-me")
        self.frontend_origin: str = os.getenv("FRONTEND_ORIGIN", "http://localhost:8000")
        self.environment: str = os.getenv("ENVIRONMENT", "development")
        # Email (Gmail SMTP) for verification codes. SMTP_USER / SMTP_PASSWORD
        # are empty unless configured; the app must still start without them
        # and registration then returns a friendly 503 (see email_service).
        self.smtp_host: str = os.getenv("SMTP_HOST", "smtp.gmail.com")
        self.smtp_port: int = int(os.getenv("SMTP_PORT", "587") or 587)
        self.smtp_user: str | None = os.getenv("SMTP_USER") or None
        self.smtp_password: str | None = os.getenv("SMTP_PASSWORD") or None
        # From address for verification mail. Brevo authenticates SMTP with
        # its own login (e.g. xxx@smtp-brevo.com) but the From header must
        # be a verified sender (the owner's Gmail). Defaults to SMTP_USER
        # (Gmail SMTP), so existing setups are unchanged.
        self.smtp_from: str | None = os.getenv("SMTP_FROM") or self.smtp_user

        if not os.getenv("ADMIN_EMAIL"):
            logger.info("ADMIN_EMAIL not set in the environment; using the confirmed owner email.")
        if not self.database_url:
            logger.warning(
                "DATABASE_URL is not set: using the in-memory DEV fallback store. "
                "This is NOT production persistence."
            )
        if not self.gemini_api_key:
            logger.warning("GEMINI_API_KEY is not set: AI features will report unavailable.")
        if not self.google_client_id or not self.google_client_secret:
            logger.warning("Google OAuth is not fully configured: login will report unavailable.")
        if self.session_secret == "dev-only-change-me" and self.environment == "production":
            logger.warning("SESSION_SECRET is still the dev default; set a strong secret in production.")

    @property
    def is_production(self) -> bool:
        return self.environment.lower() == "production"


# Single shared settings object for the whole app.
settings = Settings()
