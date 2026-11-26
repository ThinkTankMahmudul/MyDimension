"""DiaryManager: the business logic for diary entries.

It sits between the API routes and the DatabaseManager: routes handle
HTTP, DiaryManager handles the rules (validation, search, filtering),
and DatabaseManager handles storage. That separation keeps each class
small and easy to explain in a lab demo.

Multi-user: a manager is optionally bound to one ``user_id`` (passed
by the route from ``require_user``); every method is then scoped to
that user, so one user can never see or touch another user's entries.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from ..models.models import DiaryEntry

# Fix B (2026-11-26): entry dates are the owner's local date, Asia/Dhaka
# (UTC+6, no DST). Timestamps are stored in UTC; truncating them in UTC
# moved a late-evening Dhaka entry to the next UTC day, so the calendar
# dot and the trend spike landed on the wrong date.
DHAKA = ZoneInfo("Asia/Dhaka")


def dhaka_date(value: datetime) -> str:
    """Return the YYYY-MM-DD date of *value* in Asia/Dhaka."""
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(DHAKA).strftime("%Y-%m-%d")
from .database_manager import DatabaseManager, db_manager


def _is_uuid(value: str) -> bool:
    try:
        uuid.UUID(str(value))
        return True
    except (ValueError, TypeError):
        return False


class DiaryManager:
    """CRUD + search/filter for diary entries, scoped to one user."""

    def __init__(self, db: DatabaseManager | None = None,
                 user_id: str | None = None) -> None:
        self.db = db or db_manager
        self.user_id = user_id

    def _scope(self, user_id: str | None) -> str | None:
        """Explicit argument wins, else the manager's bound user."""
        return user_id if user_id is not None else self.user_id

    def create_entry(self, title: str, content: str, mood: str | None = None,
                     tags: list[str] | None = None,
                     user_id: str | None = None,
                     theme: str | None = None) -> DiaryEntry:
        entry = DiaryEntry(title=title, content=content, mood=mood, tags=tags,
                           user_id=self._scope(user_id), theme=theme)
        return self.db.create_entry(entry, user_id=self._scope(user_id))

    def get_entry(self, entry_id: str, user_id: str | None = None) -> DiaryEntry | None:
        if not _is_uuid(entry_id):
            return None
        return self.db.get_entry(entry_id, user_id=self._scope(user_id))

    def list_entries(self, search: str | None = None, mood: str | None = None,
                     month: str | None = None,
                     user_id: str | None = None) -> list[DiaryEntry]:
        """List entries, optionally filtered by text, mood, or YYYY-MM month."""
        entries = self.db.list_entries(search=search, mood=mood,
                                       user_id=self._scope(user_id))
        if month:
            entries = [e for e in entries if dhaka_date(e.created_at)[:7] == month]
        return entries

    def update_entry(self, entry_id: str, user_id: str | None = None, **changes) -> DiaryEntry | None:
        entry = self.get_entry(entry_id, user_id=self._scope(user_id))
        if entry is None:
            return None
        if "title" in changes and changes["title"] is not None:
            entry.title = changes["title"]  # validated property setter
        if "content" in changes and changes["content"] is not None:
            entry.content = changes["content"]
        if "mood" in changes:
            entry.mood = changes["mood"]
        if "tags" in changes and changes["tags"] is not None:
            entry.tags = list(changes["tags"])
        if "summary" in changes:
            entry.summary = changes["summary"]
        if "theme" in changes and changes["theme"] is not None:
            from ..models.models import normalise_theme

            entry.theme = normalise_theme(changes["theme"])
        return self.db.update_entry(entry, user_id=self._scope(user_id))

    def delete_entry(self, entry_id: str, user_id: str | None = None) -> bool:
        if not _is_uuid(entry_id):
            return False
        return self.db.delete_entry(entry_id, user_id=self._scope(user_id))

    def days_with_entries(self, year: int, month: int,
                          user_id: str | None = None) -> dict[str, int]:
        """Map YYYY-MM-DD -> entry count for one calendar month."""
        counts: dict[str, int] = {}
        for entry in self.db.list_entries(limit=1000, user_id=self._scope(user_id)):
            day = dhaka_date(entry.created_at)
            if day[:4] == f"{year:04d}" and day[5:7] == f"{month:02d}":
                counts[day] = counts.get(day, 0) + 1
        return counts
