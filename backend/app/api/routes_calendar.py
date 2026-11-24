"""Calendar + mood-insights routes (owner only)."""
from __future__ import annotations

import calendar as calmod
from datetime import date

from fastapi import APIRouter, Depends, Query

from ..core.security import require_admin
from ..schemas.schemas import CalendarDay, MoodSummary
from ..services.database_manager import db_manager
from ..services.diary_manager import DiaryManager

router = APIRouter(tags=["calendar"])


@router.get("/api/calendar", response_model=list[CalendarDay])
def get_calendar(year: int = Query(default=None), month: int = Query(default=None),
                 _email: str = Depends(require_admin)):
    today = date.today()
    year = year or today.year
    month = month or today.month
    if not 1 <= month <= 12:
        month = today.month
    counts = DiaryManager().days_with_entries(year, month)
    days = []
    for day in range(1, calmod.monthrange(year, month)[1] + 1):
        key = f"{year:04d}-{month:02d}-{day:02d}"
        count = counts.get(key, 0)
        days.append(CalendarDay(date=key, entry_count=count, has_entry=count > 0))
    return days


@router.get("/api/insights/moods", response_model=list[MoodSummary])
def mood_insights(_email: str = Depends(require_admin)):
    return [MoodSummary(**row) for row in db_manager.mood_counts()]
