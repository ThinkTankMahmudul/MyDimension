"""Email service: send sign-up verification codes via Gmail SMTP.

Uses only the standard library (``smtplib`` + ``email``) — no new
dependency. The service never crashes the app: if SMTP is not
configured it raises ``EmailNotConfiguredError`` (the route turns it
into a friendly 503), and any send failure raises ``EmailSendError``.
No password or code is ever logged.
"""
from __future__ import annotations

import logging
import smtplib
import ssl
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

from ..core.config import settings

logger = logging.getLogger("mydimension.email")

CODE_TTL_MINUTES = 10


class EmailNotConfiguredError(Exception):
    """SMTP credentials are not set (SMTP_USER / SMTP_PASSWORD missing)."""


class EmailSendError(Exception):
    """The verification email could not be sent."""


class EmailService:
    """Send verification codes through Gmail SMTP (STARTTLS, 10s timeout)."""

    def __init__(self, host: str | None = None, port: int | None = None) -> None:
        # Host/port are read from settings on every send, not snapshotted
        # here, so tests (and env changes) can reconfigure at runtime.
        self._host_override = host
        self._port_override = port

    @property
    def is_configured(self) -> bool:
        """True only when both SMTP_USER and SMTP_PASSWORD are set."""
        return bool(settings.smtp_user and settings.smtp_password)

    def _require_configured(self) -> None:
        if not self.is_configured:
            raise EmailNotConfiguredError(
                "Email is not configured yet. Please try again later."
            )

    def send_verification_code(self, to_email: str, name: str, code: str) -> None:
        """Send the 6-digit verification code to *to_email*.

        Bilingual (Bangla + English) plain-text + HTML mail; the code is
        shown large in the HTML part and is valid for 10 minutes.
        """
        self._require_configured()
        host = self._host_override or settings.smtp_host
        port = self._port_override or settings.smtp_port
        sender = settings.smtp_user or ""

        subject = "MyDimension — Your verification code / যাচাইকরণ কোড"

        text_body = (
            f"Hello {name},\n\n"
            f"Your MyDimension verification code is: {code}\n\n"
            f"This code is valid for {CODE_TTL_MINUTES} minutes. "
            "Enter it in the app to verify your email address.\n\n"
            f"আসসালামু আলাইকুম {name},\n"
            f"আপনার MyDimension যাচাইকরণ কোড: {code}\n\n"
            f"এই কোডটি {CODE_TTL_MINUTES} মিনিটের জন্য বৈধ। "
            "আপনার ইমেইল যাচাই করতে অ্যাপে কোডটি লিখুন।\n\n"
            "If you did not request this, please ignore this email.\n"
            "— MyDimension"
        )

        html_body = (
            "<html><body style=\"font-family: Arial, sans-serif; color: #1f2937;\">"
            f"<p>Hello {name},</p>"
            "<p>Your MyDimension verification code is:</p>"
            f"<p style=\"font-size: 32px; font-weight: bold; letter-spacing: 6px; "
            "color: #0F766E;\">"
            f"{code}</p>"
            f"<p>This code is valid for {CODE_TTL_MINUTES} minutes. "
            "Enter it in the app to verify your email address.</p>"
            f"<p>আসসালামু আলাইকুম {name},<br>"
            f"আপনার MyDimension যাচাইকরণ কোড: <b>{code}</b><br>"
            f"এই কোডটি {CODE_TTL_MINUTES} মিনিটের জন্য বৈধ।</p>"
            "<p style=\"color: #6b7280; font-size: 13px;\">"
            "If you did not request this, please ignore this email.<br>"
            "— MyDimension</p>"
            "</body></html>"
        )

        message = MIMEMultipart("alternative")
        message["Subject"] = subject
        message["From"] = sender
        message["To"] = to_email
        message.attach(MIMEText(text_body, "plain", "utf-8"))
        message.attach(MIMEText(html_body, "html", "utf-8"))

        try:
            context = ssl.create_default_context()
            with smtplib.SMTP(host, port, timeout=10) as server:
                server.starttls(context=context)
                server.login(sender, settings.smtp_password or "")
                server.sendmail(sender, [to_email], message.as_string())
        except EmailNotConfiguredError:
            raise
        except Exception as exc:  # SMTP / network / auth failure: never crash
            logger.warning("Failed to send verification email to %s: %s",
                           to_email, type(exc).__name__)
            raise EmailSendError(
                "The verification email could not be sent. Please try again later."
            ) from exc


# One shared service for the app lifetime. Tests monkeypatch
# ``email_service.send_verification_code`` to capture the code.
email_service = EmailService()
