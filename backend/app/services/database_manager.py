"""Database access: PostgreSQL in production, in-memory dev fallback.

Production path: managed PostgreSQL (Neon) via ``psycopg`` with
parameterized queries (``%s`` placeholders) -- never string-formatted SQL.
Schema is created from ``migrations/schema.sql`` on startup when a
``DATABASE_URL`` is configured.

Dev fallback: when ``DATABASE_URL`` is unset the app still starts with a
simple in-memory store, clearly labelled as such. Data in the fallback
is lost on restart and it must NEVER be presented as production
persistence. This exists only so the app and its tests can run locally
without a real database.

Multi-user scoping: entries, moods and media rows carry a ``user_id``.
Every read/write method accepts an optional ``user_id``; when given,
only that user's rows are visible or touched. ``user_id=None`` keeps
the old unscoped behaviour (used by tests / internal callers that do
not act for a specific user).
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from pathlib import Path

from ..core.config import settings
from ..models.models import DiaryEntry, MediaFile

logger = logging.getLogger("mydimension.db")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _normalise_email(email: str) -> str:
    """Emails are always stored and looked up lower-cased."""
    return (email or "").strip().lower()


class DatabaseManager:
    """Owns all persistence for users, verification codes, entries, media and moods."""

    def __init__(self, database_url: str | None = None) -> None:
        self.database_url = database_url if database_url is not None else settings.database_url
        # DEV FALLBACK ONLY: plain dicts, lost on restart.
        self._entries: dict[str, dict] = {}
        self._media: dict[str, dict] = {}
        self._moods: list[dict] = []
        self._settings: dict[str, str] = {}
        self._users: dict[str, dict] = {}  # keyed by lower-cased email
        self._codes: dict[str, dict] = {}  # keyed by code id

    @property
    def using_postgres(self) -> bool:
        return bool(self.database_url)

    @property
    def is_dev_fallback(self) -> bool:
        """True when running on the in-memory store (not production)."""
        return not self.using_postgres

    # -- connections / schema -------------------------------------------
    def _connect(self):
        """Open a PostgreSQL connection (psycopg is imported lazily)."""
        import psycopg  # only needed when DATABASE_URL is set
        return psycopg.connect(self.database_url, autocommit=True)

    def init_schema(self) -> None:
        """Create tables from migrations/schema.sql (PostgreSQL only).

        The schema file is idempotent (CREATE TABLE IF NOT EXISTS /
        ADD COLUMN IF NOT EXISTS), so this is safe on a live database
        that already has data.
        """
        if not self.using_postgres:
            logger.info("Dev fallback store: no schema to create.")
            return
        schema_path = Path(__file__).resolve().parents[3] / "migrations" / "schema.sql"
        try:
            sql = schema_path.read_text(encoding="utf-8")
            with self._connect() as conn, conn.cursor() as cur:
                cur.execute(sql)
            logger.info("PostgreSQL schema initialised.")
        except Exception as exc:  # never crash startup on a DB problem
            logger.warning("Could not initialise PostgreSQL schema: %s", exc)

    # -- users ------------------------------------------------------------
    def create_user(self, name: str, email: str, password_hash: str) -> dict:
        """Create a user row (email is stored lower-cased). Returns the row dict."""
        email = _normalise_email(email)
        user_id = str(uuid.uuid4())
        created_at = _utcnow()
        if self.using_postgres:
            with self._connect() as conn, conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO users (id, name, email, password_hash, is_verified,"
                    " created_at) VALUES (%s, %s, %s, %s, FALSE, %s)",
                    (user_id, name, email, password_hash, created_at),
                )
        else:
            self._users[email] = {
                "id": user_id, "name": name, "email": email,
                "password_hash": password_hash, "is_verified": False,
                "created_at": created_at,
            }
        return self.get_user_by_email(email) or {
            "id": user_id, "name": name, "email": email,
            "password_hash": password_hash, "is_verified": False,
            "created_at": created_at,
        }

    def get_user_by_email(self, email: str) -> dict | None:
        email = _normalise_email(email)
        if self.using_postgres:
            with self._connect() as conn, conn.cursor() as cur:
                cur.execute("SELECT id, name, email, password_hash, is_verified,"
                            " created_at FROM users WHERE email = %s", (email,))
                row = cur.fetchone()
            return self._row_to_user(row) if row else None
        user = self._users.get(email)
        return dict(user) if user else None

    def get_user_by_id(self, user_id: str) -> dict | None:
        if self.using_postgres:
            with self._connect() as conn, conn.cursor() as cur:
                cur.execute("SELECT id, name, email, password_hash, is_verified,"
                            " created_at FROM users WHERE id = %s", (user_id,))
                row = cur.fetchone()
            return self._row_to_user(row) if row else None
        for user in self._users.values():
            if user["id"] == str(user_id):
                return dict(user)
        return None

    def set_user_verified(self, email: str) -> dict | None:
        """Mark the user verified. Returns the updated row, or None."""
        email = _normalise_email(email)
        if self.using_postgres:
            with self._connect() as conn, conn.cursor() as cur:
                cur.execute("UPDATE users SET is_verified = TRUE WHERE email = %s",
                            (email,))
        elif email in self._users:
            self._users[email]["is_verified"] = True
        return self.get_user_by_email(email)

    def update_user(self, email: str, name: str | None = None,
                    password_hash: str | None = None) -> dict | None:
        """Update a user's name and/or password hash. Returns the row, or None."""
        email = _normalise_email(email)
        if self.using_postgres:
            sets, params = [], []
            if name is not None:
                sets.append("name = %s")
                params.append(name)
            if password_hash is not None:
                sets.append("password_hash = %s")
                params.append(password_hash)
            if not sets:
                return self.get_user_by_email(email)
            params.append(email)
            with self._connect() as conn, conn.cursor() as cur:
                cur.execute(f"UPDATE users SET {', '.join(sets)} WHERE email = %s",
                            params)
        elif email in self._users:
            if name is not None:
                self._users[email]["name"] = name
            if password_hash is not None:
                self._users[email]["password_hash"] = password_hash
        return self.get_user_by_email(email)

    def update_user_password(self, email: str, password_hash: str) -> dict | None:
        """Update only the user's password hash. Returns the row, or None."""
        return self.update_user(email, password_hash=password_hash)

    def backfill_user_id(self, owner_id: str) -> None:
        """Give pre-multi-user rows (user_id NULL) to the owner, once.

        Idempotent: only NULL rows are touched, so it is safe to run on
        every owner sign-in.
        """
        if self.using_postgres:
            with self._connect() as conn, conn.cursor() as cur:
                for table in ("diary_entries", "mood_records", "memory_files"):
                    cur.execute(
                        f"UPDATE {table} SET user_id = %s WHERE user_id IS NULL",
                        (owner_id,),
                    )
        else:
            for row in self._entries.values():
                if row.get("user_id") is None:
                    row["user_id"] = owner_id
            for row in self._media.values():
                if row.get("user_id") is None:
                    row["user_id"] = owner_id
            for record in self._moods:
                if record.get("user_id") is None:
                    record["user_id"] = owner_id

    # -- email verification codes ----------------------------------------
    def create_verification_code(self, email: str, code_hash: str,
                                 expires_at: datetime) -> dict:
        """Store a hashed verification code. Returns the row dict."""
        email = _normalise_email(email)
        code_id = str(uuid.uuid4())
        created_at = _utcnow()
        if self.using_postgres:
            with self._connect() as conn, conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO email_verification_codes"
                    " (id, email, code_hash, expires_at, attempts, created_at)"
                    " VALUES (%s, %s, %s, %s, 0, %s)",
                    (code_id, email, code_hash, expires_at, created_at),
                )
        else:
            self._codes[code_id] = {
                "id": code_id, "email": email, "code_hash": code_hash,
                "expires_at": expires_at, "attempts": 0, "created_at": created_at,
            }
        return self._codes.get(code_id) or {
            "id": code_id, "email": email, "code_hash": code_hash,
            "expires_at": expires_at, "attempts": 0, "created_at": created_at,
        }

    def get_latest_verification_code(self, email: str) -> dict | None:
        """The newest code for *email* (any expiry — callers check it)."""
        email = _normalise_email(email)
        if self.using_postgres:
            with self._connect() as conn, conn.cursor() as cur:
                cur.execute(
                    "SELECT id, email, code_hash, expires_at, attempts, created_at"
                    " FROM email_verification_codes WHERE email = %s"
                    " ORDER BY created_at DESC LIMIT 1", (email,))
                row = cur.fetchone()
            return self._row_to_code(row) if row else None
        codes = [c for c in self._codes.values() if c["email"] == email]
        if not codes:
            return None
        return dict(max(codes, key=lambda c: c["created_at"]))

    def increment_code_attempts(self, code_id: str) -> dict | None:
        """Add one failed attempt to a code. Returns the row, or None."""
        if self.using_postgres:
            with self._connect() as conn, conn.cursor() as cur:
                cur.execute("UPDATE email_verification_codes SET attempts = attempts + 1"
                            " WHERE id = %s", (code_id,))
                cur.execute("SELECT id, email, code_hash, expires_at, attempts, created_at"
                            " FROM email_verification_codes WHERE id = %s", (code_id,))
                row = cur.fetchone()
            return self._row_to_code(row) if row else None
        code = self._codes.get(code_id)
        if code is None:
            return None
        code["attempts"] = code.get("attempts", 0) + 1
        return dict(code)

    def delete_verification_codes(self, email: str) -> None:
        """Delete every code for *email* (used after successful verification)."""
        email = _normalise_email(email)
        if self.using_postgres:
            with self._connect() as conn, conn.cursor() as cur:
                cur.execute("DELETE FROM email_verification_codes WHERE email = %s",
                            (email,))
        else:
            for code_id in [k for k, c in self._codes.items() if c["email"] == email]:
                del self._codes[code_id]

    def count_recent_codes(self, email: str, since: datetime) -> int:
        """How many codes were created for *email* at/after *since*."""
        email = _normalise_email(email)
        if self.using_postgres:
            with self._connect() as conn, conn.cursor() as cur:
                cur.execute("SELECT COUNT(*) FROM email_verification_codes"
                            " WHERE email = %s AND created_at >= %s", (email, since))
                row = cur.fetchone()
            return int(row[0]) if row else 0
        return sum(1 for c in self._codes.values()
                   if c["email"] == email and c["created_at"] >= since)

    # -- entries ---------------------------------------------------------
    def _matches_user(self, stored_user_id: str | None, user_id: str | None) -> bool:
        """Dev-fallback ownership check. ``user_id=None`` means unscoped.

        A legacy row with ``user_id`` NULL belongs to the owner, so it
        matches the owner's id (after backfill there are no NULL rows).
        """
        if user_id is None:
            return True
        if stored_user_id is None:
            owner = self._users.get(_normalise_email(settings.admin_email))
            return owner is not None and owner["id"] == str(user_id)
        return str(stored_user_id) == str(user_id)

    def create_entry(self, entry: DiaryEntry, user_id: str | None = None) -> DiaryEntry:
        entry.user_id = user_id if user_id is not None else entry.user_id
        if self.using_postgres:
            with self._connect() as conn, conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO diary_entries (id, title, content, mood, tags, summary,"
                    " user_id, created_at, updated_at) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
                    (entry.id, entry.title, entry.content, entry.mood, entry.tags,
                     entry.summary, entry.user_id, entry.created_at, entry.updated_at),
                )
        else:
            self._entries[entry.id] = entry.to_dict()
        return entry

    def get_entry(self, entry_id: str, user_id: str | None = None) -> DiaryEntry | None:
        if self.using_postgres:
            query = ("SELECT id, title, content, mood, tags, summary, user_id,"
                     " created_at, updated_at FROM diary_entries WHERE id = %s")
            params: list = [entry_id]
            if user_id is not None:
                query += " AND user_id = %s"
                params.append(user_id)
            with self._connect() as conn, conn.cursor() as cur:
                cur.execute(query, params)
                row = cur.fetchone()
            return self._row_to_entry(row) if row else None
        data = self._entries.get(entry_id)
        if data is None or not self._matches_user(data.get("user_id"), user_id):
            return None
        return DiaryEntry.from_dict(data)

    def list_entries(self, search: str | None = None, mood: str | None = None,
                     limit: int = 100, user_id: str | None = None) -> list[DiaryEntry]:
        if self.using_postgres:
            query = ("SELECT id, title, content, mood, tags, summary, user_id,"
                     " created_at, updated_at FROM diary_entries WHERE 1=1")
            params: list = []
            if user_id is not None:
                query += " AND user_id = %s"
                params.append(user_id)
            if search:
                query += " AND (title ILIKE %s OR content ILIKE %s)"
                params += [f"%{search}%", f"%{search}%"]
            if mood:
                query += " AND mood = %s"
                params.append(mood)
            query += " ORDER BY created_at DESC LIMIT %s"
            params.append(limit)
            with self._connect() as conn, conn.cursor() as cur:
                cur.execute(query, params)
                return [self._row_to_entry(r) for r in cur.fetchall()]
        entries = [DiaryEntry.from_dict(d) for d in self._entries.values()
                   if self._matches_user(d.get("user_id"), user_id)]
        if search:
            needle = search.lower()
            entries = [e for e in entries
                       if needle in e.title.lower() or needle in e.content.lower()]
        if mood:
            entries = [e for e in entries if e.mood == mood]
        entries.sort(key=lambda e: e.created_at, reverse=True)
        return entries[:limit]

    def update_entry(self, entry: DiaryEntry, user_id: str | None = None) -> DiaryEntry | None:
        entry.touch()
        if self.using_postgres:
            with self._connect() as conn, conn.cursor() as cur:
                if user_id is not None:
                    cur.execute(
                        "UPDATE diary_entries SET title=%s, content=%s, mood=%s, tags=%s,"
                        " summary=%s, user_id=%s, updated_at=%s WHERE id=%s AND user_id=%s",
                        (entry.title, entry.content, entry.mood, entry.tags,
                         entry.summary, entry.user_id or user_id, entry.updated_at,
                         entry.id, user_id),
                    )
                else:
                    cur.execute(
                        "UPDATE diary_entries SET title=%s, content=%s, mood=%s, tags=%s,"
                        " summary=%s, user_id=%s, updated_at=%s WHERE id=%s",
                        (entry.title, entry.content, entry.mood, entry.tags,
                         entry.summary, entry.user_id, entry.updated_at, entry.id),
                    )
                if cur.rowcount == 0:
                    return None
        elif entry.id not in self._entries:
            return None
        elif not self._matches_user(self._entries[entry.id].get("user_id"), user_id):
            return None
        else:
            if user_id is not None:
                entry.user_id = user_id
            self._entries[entry.id] = entry.to_dict()
        return entry

    def delete_entry(self, entry_id: str, user_id: str | None = None) -> bool:
        if self.using_postgres:
            with self._connect() as conn, conn.cursor() as cur:
                if user_id is not None:
                    cur.execute("DELETE FROM diary_entries WHERE id = %s AND user_id = %s",
                                (entry_id, user_id))
                else:
                    cur.execute("DELETE FROM diary_entries WHERE id = %s", (entry_id,))
                return cur.rowcount > 0
        data = self._entries.get(entry_id)
        if data is None or not self._matches_user(data.get("user_id"), user_id):
            return False
        del self._entries[entry_id]
        return True

    # -- media -----------------------------------------------------------
    def create_media(self, media: MediaFile, user_id: str | None = None) -> MediaFile:
        media.user_id = user_id if user_id is not None else media.user_id
        if self.using_postgres:
            with self._connect() as conn, conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO memory_files (id, entry_id, media_type, drive_file_id,"
                    " file_name, mime_type, file_size, caption, transcript, user_id, created_at)"
                    " VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                    (media.id, media.entry_id, media.media_type, media.drive_file_id,
                     media.file_name, media.mime_type, media.file_size,
                     media.caption, media.transcript, media.user_id, media.created_at),
                )
        else:
            self._media[media.id] = media.to_dict()
        return media

    def list_media(self, media_type: str | None = None,
                   user_id: str | None = None) -> list[MediaFile]:
        if self.using_postgres:
            query = ("SELECT id, entry_id, media_type, drive_file_id, file_name,"
                     " mime_type, file_size, caption, transcript, user_id, created_at"
                     " FROM memory_files")
            params: list = []
            clauses = []
            if media_type:
                clauses.append("media_type = %s")
                params.append(media_type)
            if user_id is not None:
                clauses.append("user_id = %s")
                params.append(user_id)
            if clauses:
                query += " WHERE " + " AND ".join(clauses)
            query += " ORDER BY created_at DESC"
            with self._connect() as conn, conn.cursor() as cur:
                cur.execute(query, params)
                return [self._row_to_media(r) for r in cur.fetchall()]
        items = [self._row_to_media_dict(d) for d in self._media.values()
                 if self._matches_user(d.get("user_id"), user_id)]
        if media_type:
            items = [m for m in items if m.media_type == media_type]
        items.sort(key=lambda m: m.created_at, reverse=True)
        return items

    def get_media(self, media_id: str, user_id: str | None = None) -> MediaFile | None:
        if self.using_postgres:
            query = ("SELECT id, entry_id, media_type, drive_file_id, file_name,"
                     " mime_type, file_size, caption, transcript, user_id, created_at"
                     " FROM memory_files WHERE id = %s")
            params: list = [media_id]
            if user_id is not None:
                query += " AND user_id = %s"
                params.append(user_id)
            with self._connect() as conn, conn.cursor() as cur:
                cur.execute(query, params)
                row = cur.fetchone()
            return self._row_to_media(row) if row else None
        data = self._media.get(media_id)
        if data is None or not self._matches_user(data.get("user_id"), user_id):
            return None
        return self._row_to_media_dict(data)

    def delete_media(self, media_id: str, user_id: str | None = None) -> MediaFile | None:
        media = self.get_media(media_id, user_id=user_id)
        if media is None:
            return None
        if self.using_postgres:
            with self._connect() as conn, conn.cursor() as cur:
                if user_id is not None:
                    cur.execute("DELETE FROM memory_files WHERE id = %s AND user_id = %s",
                                (media_id, user_id))
                else:
                    cur.execute("DELETE FROM memory_files WHERE id = %s", (media_id,))
        else:
            self._media.pop(media_id, None)
        return media

    # -- owner settings (key/value, e.g. the password hash) --------------
    def get_setting(self, key: str) -> str | None:
        """Return the value for *key* from ``auth_settings``, else ``None``."""
        if self.using_postgres:
            with self._connect() as conn, conn.cursor() as cur:
                cur.execute("SELECT value FROM auth_settings WHERE key = %s", (key,))
                row = cur.fetchone()
            return row[0] if row else None
        return self._settings.get(key)

    def set_setting(self, key: str, value: str) -> None:
        """Upsert *key* in ``auth_settings`` (PostgreSQL or dev fallback)."""
        if self.using_postgres:
            with self._connect() as conn, conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO auth_settings (key, value, updated_at)"
                    " VALUES (%s, %s, now())"
                    " ON CONFLICT (key) DO UPDATE"
                    " SET value = EXCLUDED.value, updated_at = now()",
                    (key, value),
                )
        else:
            self._settings[key] = value

    def get_password_hash(self) -> str | None:
        """The stored password hash, or ``None`` if no password is set."""
        return self.get_setting("password_hash")

    def set_password_hash(self, password_hash: str) -> None:
        self.set_setting("password_hash", password_hash)

    # -- moods -----------------------------------------------------------
    def record_mood(self, mood: str, entry_id: str | None = None,
                    user_id: str | None = None) -> dict:
        record = {"mood": mood, "entry_id": entry_id, "user_id": user_id,
                  "recorded_at": _utcnow()}
        if self.using_postgres:
            with self._connect() as conn, conn.cursor() as cur:
                cur.execute("INSERT INTO mood_records (id, entry_id, mood, user_id, recorded_at)"
                            " VALUES (%s, %s, %s, %s, %s)",
                            (str(uuid.uuid4()), entry_id, mood, user_id, record["recorded_at"]))
        else:
            self._moods.append(record)
        return record

    def mood_counts(self, user_id: str | None = None) -> list[dict]:
        if self.using_postgres:
            with self._connect() as conn, conn.cursor() as cur:
                if user_id is not None:
                    cur.execute("SELECT mood, COUNT(*) FROM mood_records"
                                " WHERE user_id = %s GROUP BY mood ORDER BY COUNT(*) DESC",
                                (user_id,))
                else:
                    cur.execute("SELECT mood, COUNT(*) FROM mood_records GROUP BY mood"
                                " ORDER BY COUNT(*) DESC")
                return [{"mood": m, "count": c} for m, c in cur.fetchall()]
        counts: dict[str, int] = {}
        for record in self._moods:
            if self._matches_user(record.get("user_id"), user_id):
                counts[record["mood"]] = counts.get(record["mood"], 0) + 1
        # Also count moods stored on entries themselves.
        for entry in self._entries.values():
            if entry.get("mood") and self._matches_user(entry.get("user_id"), user_id):
                counts[entry["mood"]] = counts.get(entry["mood"], 0) + 1
        return [{"mood": m, "count": c} for m, c in sorted(counts.items(), key=lambda kv: -kv[1])]

    # -- row helpers ------------------------------------------------------
    @staticmethod
    def _row_to_user(row) -> dict:
        keys = ("id", "name", "email", "password_hash", "is_verified", "created_at")
        data = dict(zip(keys, row))
        data["id"] = str(data["id"])
        return data

    @staticmethod
    def _row_to_code(row) -> dict:
        keys = ("id", "email", "code_hash", "expires_at", "attempts", "created_at")
        data = dict(zip(keys, row))
        data["id"] = str(data["id"])
        return data

    @staticmethod
    def _row_to_entry(row) -> DiaryEntry:
        keys = ("id", "title", "content", "mood", "tags", "summary", "user_id",
                "created_at", "updated_at")
        return DiaryEntry.from_dict(dict(zip(keys, row)))

    @staticmethod
    def _row_to_media(row) -> MediaFile:
        keys = ("id", "entry_id", "media_type", "drive_file_id", "file_name",
                "mime_type", "file_size", "caption", "transcript", "user_id", "created_at")
        data = dict(zip(keys, row))
        return MediaFile(drive_file_id=data["drive_file_id"], file_name=data["file_name"],
                         mime_type=data["mime_type"], media_type=data["media_type"],
                         file_size=data["file_size"] or 0, entry_id=data["entry_id"],
                         caption=data["caption"], transcript=data["transcript"],
                         media_id=data["id"], created_at=data["created_at"],
                         user_id=data.get("user_id"))

    @staticmethod
    def _row_to_media_dict(data: dict) -> MediaFile:
        created_at = data["created_at"]
        if isinstance(created_at, str):
            created_at = datetime.fromisoformat(created_at)
        return MediaFile(drive_file_id=data["drive_file_id"], file_name=data["file_name"],
                         mime_type=data["mime_type"], media_type=data["media_type"],
                         file_size=data["file_size"] or 0, entry_id=data["entry_id"],
                         caption=data.get("caption"), transcript=data.get("transcript"),
                         media_id=data["id"], created_at=created_at,
                         user_id=data.get("user_id"))


# One shared manager for the app lifetime, so the dev fallback store
# keeps entries between requests in the same process.
db_manager = DatabaseManager()
