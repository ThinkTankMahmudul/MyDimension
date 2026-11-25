"""Domain models for MyDimension.

OOP concept -- Classes and Objects + Encapsulation:
``DiaryEntry`` keeps its title/content in private attributes (``__title``,
``__content``) and exposes them only through properties. The setters
validate the data, so an entry can never hold an empty title or an
over-long body -- callers cannot bypass the rules by touching the
attributes directly (name mangling keeps them private to the class).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

MAX_TITLE_LENGTH = 200
MAX_CONTENT_LENGTH = 100_000

VALID_MOODS = {"happy", "calm", "grateful", "sad", "anxious", "tired", "excited", "angry",
               "stressed", "thoughtful"}  # spec §6.3 mood set (plus grateful/tired/anxious)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class DiaryEntry:
    """One diary entry. Encapsulation: private fields + validating properties."""

    def __init__(self, title: str, content: str, mood: str | None = None,
                 entry_id: str | None = None, tags: list[str] | None = None,
                 created_at: datetime | None = None,
                 updated_at: datetime | None = None,
                 summary: str | None = None,
                 user_id: str | None = None) -> None:
        # IDs coming back from PostgreSQL are uuid.UUID objects; Pydantic v2
        # rejects them for `str` fields, so coerce to str here (and again in
        # to_dict) — otherwise the entry list 500s as soon as one row exists.
        self.id: str = str(entry_id) if entry_id is not None else str(uuid.uuid4())
        self.user_id: str | None = str(user_id) if user_id is not None else None
        self.__title = ""      # private: set through the property below
        self.__content = ""    # private: set through the property below
        self.title = title     # goes through the validating setter
        self.content = content
        self.mood = mood
        self.tags: list[str] = list(tags or [])
        self.summary = summary
        now = _utcnow()
        self.created_at: datetime = created_at or now
        self.updated_at: datetime = updated_at or now

    # -- title: validated property (encapsulation) --
    @property
    def title(self) -> str:
        return self.__title

    @title.setter
    def title(self, value: str) -> None:
        value = (value or "").strip()
        if not value:
            raise ValueError("Title must not be empty.")
        if len(value) > MAX_TITLE_LENGTH:
            raise ValueError(f"Title must be at most {MAX_TITLE_LENGTH} characters.")
        self.__title = value

    # -- content: validated property (encapsulation) --
    @property
    def content(self) -> str:
        return self.__content

    @content.setter
    def content(self, value: str) -> None:
        value = value or ""
        if len(value) > MAX_CONTENT_LENGTH:
            raise ValueError(f"Content must be at most {MAX_CONTENT_LENGTH} characters.")
        self.__content = value

    def touch(self) -> None:
        """Refresh the updated timestamp (call after any edit)."""
        self.updated_at = _utcnow()

    def to_dict(self) -> dict:
        return {
            "id": str(self.id), "title": self.title, "content": self.content,
            "mood": self.mood, "tags": self.tags, "summary": self.summary,
            "user_id": str(self.user_id) if self.user_id is not None else None,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
        }

    @classmethod
    def from_dict(cls, data: dict) -> "DiaryEntry":
        def _parse(value):
            return datetime.fromisoformat(value) if isinstance(value, str) else value
        return cls(
            title=data["title"], content=data.get("content", ""),
            mood=data.get("mood"), entry_id=data.get("id"),
            tags=data.get("tags") or [],
            created_at=_parse(data.get("created_at")),
            updated_at=_parse(data.get("updated_at")),
            summary=data.get("summary"),
            user_id=data.get("user_id"),
        )


class MoodRecord:
    """One mood check-in, optionally linked to an entry."""

    def __init__(self, mood: str, entry_id: str | None = None,
                 note: str | None = None,
                 recorded_at: datetime | None = None) -> None:
        if mood not in VALID_MOODS:
            raise ValueError(f"Unknown mood: {mood!r}. Choose one of {sorted(VALID_MOODS)}.")
        self.mood = mood
        self.entry_id = str(entry_id) if entry_id is not None else None
        self.note = note
        self.recorded_at: datetime = recorded_at or _utcnow()

    def to_dict(self) -> dict:
        return {"mood": self.mood,
                "entry_id": str(self.entry_id) if self.entry_id is not None else None,
                "note": self.note,
                "recorded_at": self.recorded_at.isoformat()}


class MediaFile:
    """Metadata for one photo/audio file stored in Google Drive.

    Only the Drive file ID (a reference) is kept here / in PostgreSQL;
    the actual file lives in the owner's Google Drive.
    Encapsulation: the Drive file id is private and read-only.
    """

    def __init__(self, drive_file_id: str, file_name: str, mime_type: str,
                 media_type: str, file_size: int = 0,
                 entry_id: str | None = None, caption: str | None = None,
                 transcript: str | None = None,
                 media_id: str | None = None,
                 created_at: datetime | None = None,
                 user_id: str | None = None) -> None:
        if media_type not in ("photo", "audio"):
            raise ValueError("media_type must be 'photo' or 'audio'.")
        self.id: str = str(media_id) if media_id is not None else str(uuid.uuid4())
        self.user_id: str | None = str(user_id) if user_id is not None else None
        self.__drive_file_id = drive_file_id  # private, read-only
        self.file_name = file_name
        self.mime_type = mime_type
        self.media_type = media_type
        self.file_size = file_size
        self.entry_id = str(entry_id) if entry_id is not None else None
        self.caption = caption
        self.transcript = transcript
        self.created_at: datetime = created_at or _utcnow()

    @property
    def drive_file_id(self) -> str:
        """Read-only: the Drive id is set once at upload and never edited."""
        return self.__drive_file_id

    def to_dict(self) -> dict:
        return {
            "id": str(self.id), "drive_file_id": self.__drive_file_id,
            "file_name": self.file_name, "mime_type": self.mime_type,
            "media_type": self.media_type, "file_size": self.file_size,
            "entry_id": str(self.entry_id) if self.entry_id is not None else None,
            "caption": self.caption,
            "transcript": self.transcript,
            "user_id": str(self.user_id) if self.user_id is not None else None,
            "created_at": self.created_at.isoformat(),
        }
