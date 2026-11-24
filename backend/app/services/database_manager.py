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


class DatabaseManager:
    """Owns all persistence for entries, media and moods."""

    def __init__(self, database_url: str | None = None) -> None:
        self.database_url = database_url if database_url is not None else settings.database_url
        # DEV FALLBACK ONLY: plain dicts, lost on restart.
        self._entries: dict[str, dict] = {}
        self._media: dict[str, dict] = {}
        self._moods: list[dict] = []

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
        """Create tables from migrations/schema.sql (PostgreSQL only)."""
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

    # -- entries ---------------------------------------------------------
    def create_entry(self, entry: DiaryEntry) -> DiaryEntry:
        if self.using_postgres:
            with self._connect() as conn, conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO diary_entries (id, title, content, mood, tags, summary,"
                    " created_at, updated_at) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
                    (entry.id, entry.title, entry.content, entry.mood, entry.tags,
                     entry.summary, entry.created_at, entry.updated_at),
                )
        else:
            self._entries[entry.id] = entry.to_dict()
        return entry

    def get_entry(self, entry_id: str) -> DiaryEntry | None:
        if self.using_postgres:
            with self._connect() as conn, conn.cursor() as cur:
                cur.execute("SELECT id, title, content, mood, tags, summary, created_at,"
                            " updated_at FROM diary_entries WHERE id = %s", (entry_id,))
                row = cur.fetchone()
            return self._row_to_entry(row) if row else None
        data = self._entries.get(entry_id)
        return DiaryEntry.from_dict(data) if data else None

    def list_entries(self, search: str | None = None, mood: str | None = None,
                     limit: int = 100) -> list[DiaryEntry]:
        if self.using_postgres:
            query = ("SELECT id, title, content, mood, tags, summary, created_at,"
                     " updated_at FROM diary_entries WHERE 1=1")
            params: list = []
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
        entries = [DiaryEntry.from_dict(d) for d in self._entries.values()]
        if search:
            needle = search.lower()
            entries = [e for e in entries
                       if needle in e.title.lower() or needle in e.content.lower()]
        if mood:
            entries = [e for e in entries if e.mood == mood]
        entries.sort(key=lambda e: e.created_at, reverse=True)
        return entries[:limit]

    def update_entry(self, entry: DiaryEntry) -> DiaryEntry | None:
        entry.touch()
        if self.using_postgres:
            with self._connect() as conn, conn.cursor() as cur:
                cur.execute(
                    "UPDATE diary_entries SET title=%s, content=%s, mood=%s, tags=%s,"
                    " summary=%s, updated_at=%s WHERE id=%s",
                    (entry.title, entry.content, entry.mood, entry.tags,
                     entry.summary, entry.updated_at, entry.id),
                )
                if cur.rowcount == 0:
                    return None
        elif entry.id not in self._entries:
            return None
        else:
            self._entries[entry.id] = entry.to_dict()
        return entry

    def delete_entry(self, entry_id: str) -> bool:
        if self.using_postgres:
            with self._connect() as conn, conn.cursor() as cur:
                cur.execute("DELETE FROM diary_entries WHERE id = %s", (entry_id,))
                return cur.rowcount > 0
        return self._entries.pop(entry_id, None) is not None

    # -- media -----------------------------------------------------------
    def create_media(self, media: MediaFile) -> MediaFile:
        if self.using_postgres:
            with self._connect() as conn, conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO memory_files (id, entry_id, media_type, drive_file_id,"
                    " file_name, mime_type, file_size, caption, transcript, created_at)"
                    " VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                    (media.id, media.entry_id, media.media_type, media.drive_file_id,
                     media.file_name, media.mime_type, media.file_size,
                     media.caption, media.transcript, media.created_at),
                )
        else:
            self._media[media.id] = media.to_dict()
        return media

    def list_media(self, media_type: str | None = None) -> list[MediaFile]:
        if self.using_postgres:
            query = ("SELECT id, entry_id, media_type, drive_file_id, file_name,"
                     " mime_type, file_size, caption, transcript, created_at"
                     " FROM memory_files")
            params: list = []
            if media_type:
                query += " WHERE media_type = %s"
                params.append(media_type)
            query += " ORDER BY created_at DESC"
            with self._connect() as conn, conn.cursor() as cur:
                cur.execute(query, params)
                return [self._row_to_media(r) for r in cur.fetchall()]
        items = [self._row_to_media_dict(d) for d in self._media.values()]
        if media_type:
            items = [m for m in items if m.media_type == media_type]
        items.sort(key=lambda m: m.created_at, reverse=True)
        return items

    def get_media(self, media_id: str) -> MediaFile | None:
        if self.using_postgres:
            with self._connect() as conn, conn.cursor() as cur:
                cur.execute("SELECT id, entry_id, media_type, drive_file_id, file_name,"
                            " mime_type, file_size, caption, transcript, created_at"
                            " FROM memory_files WHERE id = %s", (media_id,))
                row = cur.fetchone()
            return self._row_to_media(row) if row else None
        data = self._media.get(media_id)
        return self._row_to_media_dict(data) if data else None

    def delete_media(self, media_id: str) -> MediaFile | None:
        media = self.get_media(media_id)
        if media is None:
            return None
        if self.using_postgres:
            with self._connect() as conn, conn.cursor() as cur:
                cur.execute("DELETE FROM memory_files WHERE id = %s", (media_id,))
        else:
            self._media.pop(media_id, None)
        return media

    # -- moods -----------------------------------------------------------
    def record_mood(self, mood: str, entry_id: str | None = None) -> dict:
        record = {"mood": mood, "entry_id": entry_id, "recorded_at": _utcnow()}
        if self.using_postgres:
            with self._connect() as conn, conn.cursor() as cur:
                cur.execute("INSERT INTO mood_records (id, entry_id, mood, recorded_at)"
                            " VALUES (%s, %s, %s, %s)",
                            (str(uuid.uuid4()), entry_id, mood, record["recorded_at"]))
        else:
            self._moods.append(record)
        return record

    def mood_counts(self) -> list[dict]:
        if self.using_postgres:
            with self._connect() as conn, conn.cursor() as cur:
                cur.execute("SELECT mood, COUNT(*) FROM mood_records GROUP BY mood"
                            " ORDER BY COUNT(*) DESC")
                return [{"mood": m, "count": c} for m, c in cur.fetchall()]
        counts: dict[str, int] = {}
        for record in self._moods:
            counts[record["mood"]] = counts.get(record["mood"], 0) + 1
        # Also count moods stored on entries themselves.
        for entry in self._entries.values():
            if entry.get("mood"):
                counts[entry["mood"]] = counts.get(entry["mood"], 0) + 1
        return [{"mood": m, "count": c} for m, c in sorted(counts.items(), key=lambda kv: -kv[1])]

    # -- row helpers ------------------------------------------------------
    @staticmethod
    def _row_to_entry(row) -> DiaryEntry:
        keys = ("id", "title", "content", "mood", "tags", "summary", "created_at", "updated_at")
        return DiaryEntry.from_dict(dict(zip(keys, row)))

    @staticmethod
    def _row_to_media(row) -> MediaFile:
        keys = ("id", "entry_id", "media_type", "drive_file_id", "file_name",
                "mime_type", "file_size", "caption", "transcript", "created_at")
        data = dict(zip(keys, row))
        return MediaFile(drive_file_id=data["drive_file_id"], file_name=data["file_name"],
                         mime_type=data["mime_type"], media_type=data["media_type"],
                         file_size=data["file_size"] or 0, entry_id=data["entry_id"],
                         caption=data["caption"], transcript=data["transcript"],
                         media_id=data["id"], created_at=data["created_at"])

    @staticmethod
    def _row_to_media_dict(data: dict) -> MediaFile:
        return MediaFile(drive_file_id=data["drive_file_id"], file_name=data["file_name"],
                         mime_type=data["mime_type"], media_type=data["media_type"],
                         file_size=data["file_size"] or 0, entry_id=data["entry_id"],
                         caption=data.get("caption"), transcript=data.get("transcript"),
                         media_id=data["id"],
                         created_at=datetime.fromisoformat(data["created_at"]))


# One shared manager for the app lifetime, so the dev fallback store
# keeps entries between requests in the same process.
db_manager = DatabaseManager()
