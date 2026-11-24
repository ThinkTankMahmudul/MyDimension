# Architecture — MyDimension

## Diagram

```text
Owner's browser (desktop / phone, PWA)
        │  HTML + CSS + vanilla JS
        │  fetch, cookies (HttpOnly session), relative /api/* paths
        ▼
FastAPI backend  (backend/app, Python OOP services)
        │
        ├── AuthService ── Google OAuth / ID-token verification
        │                 (ADMIN_EMAIL allowlist, email_verified)
        ├── DiaryManager ── entry business logic (CRUD, search, filter)
        ├── DatabaseManager ── PostgreSQL (Neon) via psycopg,
        │                 parameterised queries; dev-only in-memory
        │                 fallback when DATABASE_URL is unset
        ├── GoogleDriveService ── private folder "MyDimension Memories"
        │                 (Photos / Voice-Memories); file bytes only
        └── BaseAIService (ABC)
              ├── GeminiAIService  ── google-genai (mood, summary,
              │                       improve, transcribe)
              └── OfflineAIService ── friendly "AI unavailable" fallback
        │
        ├───────────────┬──────────────────┐
        ▼               ▼                  ▼
Managed PostgreSQL   Google Drive      Gemini API
diary_entries,       photos, audio     mood / summary /
mood_records,        (bytes)           writing / transcript
memory_files,
user_settings
```

## Key decisions

1. **Cloud-first, no desktop app.** The final spec overrides the
   earlier CustomTkinter/SQLite plan. The frontend is static
   HTML/CSS/JS so it can be hosted on Vercel; the backend is FastAPI
   so the lab's Python OOP requirement is met in real code.
2. **PostgreSQL, not SQLite, in production.** Vercel's filesystem is
   temporary — a SQLite file would not survive a redeploy. Neon
   (managed PostgreSQL, preferably via the Vercel Marketplace
   integration) is the persistent store. Schema:
   `migrations/schema.sql`.
3. **Drive is media storage, not a database.** File bytes go to the
   owner's private Drive folder; PostgreSQL stores the Drive file ID,
   filename, MIME type, size, caption, transcript, and entry link.
4. **Single owner, backend-enforced.** `ADMIN_EMAIL` is
   `technicalmahmudull@gmail.com` (confirmed by the owner).
   `AuthService` verifies the Google ID token and `email_verified`,
   then compares the email server-side. Every private route depends
   on `require_admin` (401 if not signed in, 403 if not the owner).
   Sessions are HMAC-signed HttpOnly cookies (`SameSite=Lax`,
   `Secure` in production). No secret ever reaches the frontend.
5. **Graceful degradation.** Missing Gemini key → AI endpoints return
   a friendly 503 via `OfflineAIService`. Missing Drive credentials
   → media upload returns 503 (`DriveNotConfiguredError`). Missing
   `DATABASE_URL` → a clearly labelled in-memory dev fallback so the
   app still starts (never presented as production persistence).
6. **PWA, safely.** Manifest + service worker cache only the static
   app shell. API responses, media, and tokens are never cached.
7. **Media file serving.** `GET /api/media/{id}` returns JSON
   metadata; `GET /api/media/{id}/file` streams the bytes (needed
   because `<img>` / `<audio>` tags need bytes, not JSON). The
   frontend uploads to `POST /api/media/upload` with the form field
   `media_type` (`photo` | `audio`).
8. **Vercel caveat.** The static frontend is safe on Vercel. The
   FastAPI backend must be checked against Vercel's current Python
   runtime limits; if it cannot be hosted there reliably, host it on
   a compatible Python host with the owner's approval (see
   DEPLOYMENT.md). The backend is plain FastAPI + uvicorn, so it is
   portable.

## Request flow examples

- **Create entry:** `POST /api/entries` → `require_admin` →
  `DiaryManager.create_entry` → `DiaryEntry` object (validated
  properties) → `DatabaseManager` → PostgreSQL.
- **Voice transcribe:** browser records with MediaRecorder →
  `POST /api/media/upload` (Drive) or `POST /api/ai/transcribe`
  (multipart audio) → `GeminiAIService.transcribe_audio` → transcript
  shown for review; saving it as an entry is a separate, explicit
  user action.
- **AI mood:** `POST /api/ai/mood` with the selected entry's text
  only → `get_ai_service().process_text(text, "mood")` → one mood
  from the supported list + reason; the owner accepts or ignores it.

## What is NOT in this architecture

No multi-user tables, no public registration, no social features,
no analytics, no CustomTkinter, no SQLite in production, no secrets
in the repository or frontend.
