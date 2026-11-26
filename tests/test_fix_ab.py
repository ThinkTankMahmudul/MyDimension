"""Fix A + Fix B regression tests (2026-11-26).

Fix A: Insights mood counts must come from the same diary entries list
as the Dashboard, not from the separate mood_records table.
Fix B: entry dates are the owner's local date in Asia/Dhaka, not UTC.
"""
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app.models.models import DiaryEntry  # noqa: E402
from app.services.database_manager import DatabaseManager  # noqa: E402
from app.services.diary_manager import DiaryManager, dhaka_date  # noqa: E402


def test_mood_counts_come_from_entries_not_mood_records():
    # Dev fallback (no DATABASE_URL): a standalone mood record must NOT
    # count, and an entry's mood must count exactly once.
    db = DatabaseManager(database_url=None)
    user = "user-1"
    db.record_mood("Sad", entry_id=None, user_id=user)
    entry = DiaryEntry(title="Bismillah", content="x", mood="Happy",
                       user_id=user)
    db.create_entry(entry, user_id=user)
    assert db.mood_counts(user_id=user) == [{"mood": "Happy", "count": 1}]


def test_dhaka_date_crosses_midnight():
    # 2026-11-25 19:00 UTC is 2026-11-26 01:00 in Dhaka (+06:00).
    assert dhaka_date(datetime(2026, 11, 25, 19, 0, tzinfo=timezone.utc)) == "2026-11-26"
    # 2026-11-25 13:30 UTC is 2026-11-25 19:30 in Dhaka.
    assert dhaka_date(datetime(2026, 11, 25, 13, 30, tzinfo=timezone.utc)) == "2026-11-25"


def test_days_with_entries_uses_dhaka_date():
    db = DatabaseManager(database_url=None)
    user = "user-1"
    # Created 2026-11-25 19:00 UTC -> Dhaka 2026-11-26, so it belongs
    # to 26 Nov, not 25 Nov, in the calendar.
    entry = DiaryEntry(title="Late night", content="x", mood="Happy",
                       user_id=user,
                       created_at=datetime(2026, 11, 25, 19, 0, tzinfo=timezone.utc))
    db.create_entry(entry, user_id=user)
    manager = DiaryManager(db=db, user_id=user)
    assert manager.days_with_entries(2026, 11) == {"2026-11-26": 1}
    assert manager.list_entries(month="2026-11")
    assert manager.list_entries(month="2026-10") == []
