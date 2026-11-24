# OOP Concepts in MyDimension — exact code map

This file is for the lab report and viva. Every concept below is
demonstrated in real code, not just in comments.

## 1. Classes and Objects

Real classes with real objects created at runtime:

| Class | File | What an object represents |
|---|---|---|
| `DiaryEntry` | `backend/app/models/models.py` | One diary entry (title, content, mood, dates, summary) |
| `MediaFile` | `backend/app/models/models.py` | One photo/audio file (Drive file ID + metadata) |
| `MoodRecord` | `backend/app/models/models.py` | One mood check-in |
| `DiaryManager` | `backend/app/services/diary_manager.py` | Business logic for entries (create/list/search/filter) |
| `DatabaseManager` | `backend/app/services/database_manager.py` | All PostgreSQL persistence |
| `GoogleDriveService` | `backend/app/services/drive_service.py` | Drive upload/download/delete |
| `GeminiAIService` / `OfflineAIService` | `backend/app/services/ai_service.py` | AI behaviour |
| `AuthService` | `backend/app/services/auth_service.py` | Google token verification + sessions |

Example: `DiaryManager().create_entry(title="...", content="...")`
creates a `DiaryEntry` object and saves it through `DatabaseManager`.

## 2. Encapsulation — `DiaryEntry`, `MediaFile`

Private attributes + validating properties:

- `DiaryEntry.__title` / `DiaryEntry.__content` (`models.py`):
  the title setter rejects an empty title and titles over 200 chars;
  the content setter enforces the length limit. Outside code cannot
  bypass the rules by assigning the attribute directly (Python name
  mangling keeps `__title` private to the class).
- `MediaFile.__drive_file_id` (`models.py`): read-only property —
  the Drive file ID is set once at upload and can never be edited
  afterwards, so a file reference cannot silently point somewhere else.

Viva line: *“Data and the rules for changing it live together inside
the class; callers must go through the property.”*

## 3. Inheritance — `BaseAIService` → `GeminiAIService` / `OfflineAIService`

`backend/app/services/ai_service.py`:

```python
class BaseAIService(ABC): ...          # abstract parent
class GeminiAIService(BaseAIService): ...   # real Gemini API
class OfflineAIService(BaseAIService): ...  # friendly fallback
```

Both children inherit the shared interface (`process_text`,
`transcribe_audio`, `is_configured`) and reuse the parent's helper
behaviour. No invented `PremiumUser` — the hierarchy exists because
the app genuinely needs two ways to answer an AI request.

## 4. Polymorphism — same method, different behaviour

The same call works for either service:

```python
service = get_ai_service()          # Gemini if a key exists, else Offline
result = service.process_text(text, task="mood")
```

- `GeminiAIService.process_text()` calls the Gemini API.
- `OfflineAIService.process_text()` returns a friendly
  “AI is not available” message instead of crashing.

The routes (`backend/app/api/routes_ai.py`) never check which service
they have — they just call `process_text()`. Swapping the implementation
changes the behaviour without changing the caller. That is polymorphism.
`isinstance(service, BaseAIService)` is `True` for both.

## 5. Abstraction — `BaseAIService` (abc)

`backend/app/services/ai_service.py` uses Python's `abc` module:

```python
class BaseAIService(ABC):
    @abstractmethod
    def process_text(self, text, task): ...

    @abstractmethod
    def transcribe_audio(self, data, mime_type): ...
```

`BaseAIService()` cannot be instantiated — Python raises `TypeError`.
It defines *what* an AI service must do, not *how*. Each subclass
supplies the “how”. The rest of the app depends only on the abstraction.

## Test evidence

`tests/test_oop.py` proves all five: encapsulation (invalid title
raises `ValueError`, private attribute not directly settable),
abstraction (`BaseAIService()` raises `TypeError`), inheritance
(`isinstance(GeminiAIService(...), BaseAIService)`), polymorphism
(same `process_text` interface, different results), and
classes/objects (a `DiaryEntry` round-trips through `to_dict` /
`from_dict`). Run: `python -m pytest tests/test_oop.py -v`.
