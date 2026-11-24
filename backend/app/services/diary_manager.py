"""DiaryManager: the business logic for diary entries.

It sits between the API routes and the DatabaseManager: routes handle
HTTP, DiaryManager handles the rules (validation, search, filtering),
and DatabaseManager handles storage. That separation keeps each class
small and easy to explain in a lab demo.
"""
from __future__ import annotations

import uuid

from ..models.models import DiaryEntry
from .database_manager import DatabaseManager, db_manager


def _is_uuid(value: str) -> bool:
    try:
        uuid.UUID(str(value))
        return True
    except (ValueError, TypeError):
        return False


class DiaryManager:
    """CRUD + search/filter for diary entries."""

    def __init__(self, db: DatabaseManager | None = None) -> None:
        self.db = db or db_manager

    def create_entry(self, title: str, content: str, mood: str | None = None,
                     tags: list[str] | None = None) -> DiaryEntry:
        entry = DiaryEntry(title=title, content=content, mood=mood, tags=tags)
        return self.db.create_entry(entry)

    def get_entry(self, entry_id: str) -> DiaryEntry | None:
        if not _is_uuid(entry_id):
            return None
        return self.db.get_entry(entry_id)

    def list_entries(self, search: str | None = None, mood: str | None = None,
                     month: str | None = None) -> list[DiaryEntry]:
        """List entries, optionally filtered by text, mood, or YYYY-MM month."""
        entries = self.db.list_entries(search=search, mood=mood)
        if month:
            entries = [e for e in entries if e.created_at.strftime("%Y-%m") == month]
        return entries

    def update_entry(self, entry_id: str, **changes) -> DiaryEntry | None:
        entry = self.get_entry(entry_id)
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
        return self.db.update_entry(entry)

    def delete_entry(self, entry_id: str) -> bool:
        if not _is_uuid(entry_id):
            return False
        return self.db.delete_entry(entry_id)

    def days_with_entries(self, year: int, month: int) -> dict[str, int]:
        """Map YYYY-MM-DD -> entry count for one calendar month."""
        counts: dict[str, int] = {}
        for entry in self.db.list_entries(limit=1000):
            if entry.created_at.year == year and entry.created_at.month == month:
                day = entry.created_at.strftime("%Y-%m-%d")
                counts[day] = counts.get(day, 0) + 1
        return counts
