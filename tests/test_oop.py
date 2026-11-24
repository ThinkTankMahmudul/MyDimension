"""Tests for the five OOP concepts (spec section 7).

1. Classes and Objects -- DiaryEntry / MoodRecord / MediaFile instances.
2. Encapsulation -- DiaryEntry keeps __title/__content private; its
   property setters validate (empty title is rejected).
3. Inheritance -- GeminiAIService and OfflineAIService are subclasses
   of BaseAIService (isinstance checks).
4. Polymorphism -- both AI services share process_text(); they behave
   differently (Gemini needs a key / calls the API, Offline raises the
   friendly AINotConfiguredError).
5. Abstraction -- BaseAIService is an ABC and cannot be instantiated.
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app.models.models import DiaryEntry, MediaFile, MoodRecord  # noqa: E402
from app.services.ai_service import (  # noqa: E402
    AINotConfiguredError, BaseAIService, GeminiAIService, OfflineAIService,
)


def test_classes_and_objects():
    entry = DiaryEntry(title="A quiet day", content="It rained all afternoon.", mood="calm")
    assert entry.title == "A quiet day"
    assert entry.mood == "calm"
    assert entry.id  # every object gets its own id
    mood = MoodRecord(mood="calm", entry_id=entry.id)
    assert mood.entry_id == entry.id


def test_encapsulation_private_fields_and_validation():
    entry = DiaryEntry(title="Hello", content="World")
    # Private attributes are name-mangled: no plain `entry.__title`.
    assert not hasattr(entry, "__title")
    assert entry._DiaryEntry__title == "Hello"
    # The property setter validates: an empty title is rejected.
    with pytest.raises(ValueError):
        DiaryEntry(title="   ", content="no title")
    with pytest.raises(ValueError):
        entry.title = ""
    # A valid change through the setter works.
    entry.title = "New title"
    assert entry.title == "New title"


def test_media_file_drive_id_is_read_only():
    media = MediaFile(drive_file_id="abc123", file_name="photo.jpg",
                      mime_type="image/jpeg", media_type="photo")
    assert media.drive_file_id == "abc123"
    with pytest.raises(AttributeError):
        media.drive_file_id = "something-else"


def test_abstraction_base_cannot_be_instantiated():
    with pytest.raises(TypeError):
        BaseAIService()


def test_inheritance_and_polymorphism():
    gemini = GeminiAIService(api_key="test-key")
    offline = OfflineAIService()
    # Inheritance: both are BaseAIService instances.
    assert isinstance(gemini, BaseAIService)
    assert isinstance(offline, BaseAIService)
    # Polymorphism: same method name, different behaviour.
    assert hasattr(gemini, "process_text") and hasattr(offline, "process_text")
    assert hasattr(gemini, "transcribe_audio") and hasattr(offline, "transcribe_audio")
    with pytest.raises(AINotConfiguredError):
        offline.process_text("some text", "summary")
    with pytest.raises(AINotConfiguredError):
        offline.transcribe_audio(b"audio", "audio/mpeg")


def test_mood_validation():
    with pytest.raises(ValueError):
        MoodRecord(mood="not-a-mood")
