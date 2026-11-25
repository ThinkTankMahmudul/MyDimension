"""Pydantic schemas: what the API accepts and returns.

These are separate from the domain models in ``models.py``: schemas
validate HTTP input/output, while ``DiaryEntry`` etc. hold the business
rules. Keeping them apart keeps both layers simple.
"""
from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class EntryCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    content: str = Field(default="", max_length=100_000)
    mood: str | None = None
    tags: list[str] = Field(default_factory=list)
    theme: str = "default"


class EntryUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    content: str | None = Field(default=None, max_length=100_000)
    mood: str | None = None
    tags: list[str] | None = None
    summary: str | None = None
    theme: str | None = None


class EntryResponse(BaseModel):
    id: str
    title: str
    content: str
    mood: str | None = None
    tags: list[str] = []
    summary: str | None = None
    theme: str = "default"
    created_at: datetime
    updated_at: datetime


class MediaResponse(BaseModel):
    id: str
    drive_file_id: str
    file_name: str
    mime_type: str
    media_type: str
    file_size: int = 0
    entry_id: str | None = None
    caption: str | None = None
    transcript: str | None = None
    created_at: datetime


class AIRequest(BaseModel):
    text: str = Field(min_length=1, max_length=100_000)
    entry_id: str | None = None


class AIResponse(BaseModel):
    result: str
    model: str | None = None
    note: str | None = None


class CalendarDay(BaseModel):
    date: str  # YYYY-MM-DD
    entry_count: int = 0
    has_entry: bool = False


class MoodSummary(BaseModel):
    mood: str
    count: int
