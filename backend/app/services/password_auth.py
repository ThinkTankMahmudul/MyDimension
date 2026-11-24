"""Password authentication for the owner (User ID + Password login).

Google OAuth stays available as an alternative; this module adds a
password login so the owner is not dependent on Google sign-in.

Security design:
- Passwords are never stored in plain text and never in an environment
  variable. Only a PBKDF2-HMAC-SHA256 hash (``salt$hash``, hex-encoded,
  200,000 iterations) is stored, in the database's ``auth_settings``
  key/value table under the key ``password_hash``.
- Verification uses ``hmac.compare_digest`` (constant time) and the
  stored hash is never logged or returned to any client.
- Brute-force protection: a small in-memory counter blocks a
  username+IP after 5 consecutive failures for 15 minutes. This is a
  single-owner app behind one deployment, so an in-memory limiter is
  enough; it resets on restart, which only ever helps the owner.
"""
from __future__ import annotations

import hashlib
import hmac
import secrets
import time

# PBKDF2 parameters (hashlib only — no new dependency).
_HASH_ALGORITHM = "sha256"
_HASH_ITERATIONS = 200_000
_SALT_BYTES = 32
_HASH_BYTES = 32

# Brute-force protection.
MAX_FAILED_ATTEMPTS = 5
BLOCK_SECONDS = 15 * 60  # 15 minutes


def hash_password(password: str) -> str:
    """Hash *password* -> ``"<hex salt>$<hex hash>"`` (never reversible)."""
    salt = secrets.token_bytes(_SALT_BYTES)
    digest = hashlib.pbkdf2_hmac(_HASH_ALGORITHM, password.encode("utf-8"),
                                 salt, _HASH_ITERATIONS, dklen=_HASH_BYTES)
    return f"{salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str | None) -> bool:
    """Constant-time check of *password* against a stored ``salt$hash``."""
    if not password or not stored:
        return False
    try:
        salt_hex, expected_hex = stored.split("$", 1)
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(expected_hex)
    except (ValueError, TypeError):
        return False
    digest = hashlib.pbkdf2_hmac(_HASH_ALGORITHM, password.encode("utf-8"),
                                 salt, _HASH_ITERATIONS, dklen=len(expected))
    return hmac.compare_digest(digest, expected)


class LoginRateLimiter:
    """In-memory failed-login counter, keyed by ``username|ip``.

    After ``MAX_FAILED_ATTEMPTS`` consecutive failures the key is
    blocked for ``BLOCK_SECONDS``. A successful login clears the key.
    """

    def __init__(self, max_attempts: int = MAX_FAILED_ATTEMPTS,
                 block_seconds: int = BLOCK_SECONDS) -> None:
        self.max_attempts = max_attempts
        self.block_seconds = block_seconds
        self._failures: dict[str, list[float]] = {}
        self._blocked_until: dict[str, float] = {}

    def _prune(self, key: str, now: float) -> None:
        window_start = now - self.block_seconds
        self._failures[key] = [t for t in self._failures.get(key, []) if t > window_start]
        if self._blocked_until.get(key, 0) <= now:
            self._blocked_until.pop(key, None)

    def is_blocked(self, key: str) -> bool:
        now = time.monotonic()
        self._prune(key, now)
        return self._blocked_until.get(key, 0) > now

    def record_failure(self, key: str) -> None:
        now = time.monotonic()
        self._prune(key, now)
        attempts = self._failures.setdefault(key, [])
        attempts.append(now)
        if len(attempts) >= self.max_attempts:
            self._blocked_until[key] = now + self.block_seconds

    def record_success(self, key: str) -> None:
        self._failures.pop(key, None)
        self._blocked_until.pop(key, None)


# One shared limiter for the app lifetime.
login_rate_limiter = LoginRateLimiter()
