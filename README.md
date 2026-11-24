# MyDimension — AI-Powered Personal Diary & Memory Vault

> “You are nothing but a number of days; whenever a day passes, a part of you is gone.”
> — Imam Hasan al-Basri

**MyDimension** is a private, single-owner, cloud-first personal diary web
application. It is a Python OOP Lab project (DIU, 2–3 member team) that is
also meant to be genuinely usable: write daily entries, record or upload
voice memories, attach photos, see a calendar and mood insights, and use
Google Gemini for summaries, mood suggestions, writing help, and
voice-to-text transcription.

- **Owner only:** Google sign-in, backend-verified, only the configured
  `ADMIN_EMAIL` (`technicalmahmudull@gmail.com`) can access anything.
  No public registration, no other users.
- **No local setup to use it:** the finished app runs in a browser
  (desktop + mobile, installable as a PWA). You do not need Python,
  Node.js, or VS Code on your own PC to use the deployed app.
- **Data:** structured diary data in managed PostgreSQL (Neon);
  photos/audio in the owner's private Google Drive folder
  (`MyDimension Memories`); only Drive file IDs live in PostgreSQL.
- **AI:** Google Gemini, backend only, only for content the owner
  explicitly selects. Diary features keep working without a Gemini key.

> **Status:** the code in this repository is complete and tested locally
> (see Testing below). **Deployment is NOT done and NOT claimed** — it
> needs the owner's Google / Neon / Vercel authorisation and secrets.
> See [DEPLOYMENT.md](DEPLOYMENT.md) for the exact remaining steps.

## Repository structure

```text
mydimension/
├── frontend/                 # HTML + CSS + vanilla JS (no build step)
│   ├── index.html            # SPA: login + all 8 screens (hash routing)
│   ├── css/styles.css        # Mint/teal/lavender palette, responsive
│   ├── js/app.js             # Router, dashboard, calendar, insights, settings
│   ├── js/api.js             # fetch wrapper (cookies, 401 → login)
│   ├── js/auth.js            # Google login / logout / session check
│   ├── js/journal.js         # Entry CRUD, search, mood/date filter
│   ├── js/media.js           # MediaRecorder, photo/audio upload, gallery
│   ├── js/ai.js              # Mood / summary / improve / transcribe UI
│   ├── manifest.webmanifest  # PWA manifest
│   ├── service-worker.js     # App-shell cache ONLY (never private data)
│   └── assets/logo.svg
├── backend/                  # Python FastAPI (OOP services)
│   ├── app/main.py           # FastAPI app, /health, error handling
│   ├── app/core/config.py    # Env-only settings (ADMIN_EMAIL etc.)
│   ├── app/core/security.py  # Signed HttpOnly session cookie, require_admin
│   ├── app/models/models.py  # DiaryEntry, MediaFile, MoodRecord
│   ├── app/services/         # DiaryManager, DatabaseManager,
│   │                         # GoogleDriveService, BaseAIService (abstract),
│   │                         # GeminiAIService, OfflineAIService, AuthService
│   ├── app/api/              # Routes: auth, entries, media, ai, calendar
│   ├── app/schemas/          # Pydantic request/response models
│   └── requirements.txt
├── migrations/schema.sql      # PostgreSQL tables
├── tests/                    # test_oop.py, test_api.py (pytest)
├── docs/architecture.md
├── .env.example              # Placeholders only — copy to .env, never commit .env
├── .gitignore
├── README.md
├── OOP_CONCEPTS.md
├── DEPLOYMENT.md
└── LAB_DEMO_GUIDE.md
```

## Screens

Dashboard, My Journal, Calendar, Mood Insights, Voice Memories,
Photo Memories, AI Assistant (AI Reflection), Settings.
Moods: Happy, Calm, Grateful, Excited, Tired, Sad, Anxious, Angry,
Stressed, Thoughtful.

## Architecture (short)

```text
Browser (desktop / phone, PWA)
        │  HTML/CSS/JS, fetch with cookies
        ▼
FastAPI backend (Python OOP services)
   ├── PostgreSQL (Neon) — entries, moods, Drive file IDs, transcripts
   ├── Google Drive      — photo/audio bytes (private folder)
   └── Gemini API        — mood, summary, writing, transcription
```

Full diagram + decisions: [docs/architecture.md](docs/architecture.md).

## Run locally (development only)

```bash
cd backend
python -m venv .venv
# Windows PowerShell: .\.venv\Scripts\Activate.ps1
# macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
cp ../.env.example ../.env   # then fill in real values in .env
uvicorn app.main:app --reload --port 8000
```

Without `DATABASE_URL` the backend starts with a clearly labelled
in-memory dev fallback (not production persistence) so the UI and API
can be tried without a database. Without `GEMINI_API_KEY` / Drive
credentials, AI and media-upload endpoints answer with a friendly
`503` instead of crashing.

Serve the frontend from the same origin in development, e.g.
`python -m http.server 8080 --directory ../frontend` and open
`http://localhost:8080`, or let the deployment serve `frontend/`
as static files. The frontend calls relative `/api/...` paths.

## Environment variables

See `.env.example`. Required for full operation:

| Variable | Purpose |
|---|---|
| `ADMIN_EMAIL` | Only Gmail allowed in (`technicalmahmudull@gmail.com`) |
| `DATABASE_URL` | Neon PostgreSQL connection string (secret) |
| `GEMINI_API_KEY` | Gemini API key, backend only (secret) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth web client (secret) |
| `GOOGLE_REDIRECT_URI` | e.g. `https://<your-domain>/auth/google/callback` |
| `SESSION_SECRET` | Long random value for session cookies |
| `FRONTEND_ORIGIN` | Frontend origin for CORS |
| `GEMINI_MODEL` | Model name, default `gemini-2.0-flash` |

Never put secrets in code, in Git, or in chat. Never paste passwords,
OTPs, recovery codes, or tokens in chat.

## API (all private routes need the owner session)

- Auth: `GET /auth/google/login`, `GET /auth/google/callback`,
  `POST /auth/logout`, `GET /api/me`
- Entries: `GET/POST /api/entries`, `GET/PUT/DELETE /api/entries/{id}`
- Media: `POST /api/media/upload`, `GET /api/media`,
  `GET /api/media/{id}` (metadata), `GET /api/media/{id}/file` (bytes),
  `DELETE /api/media/{id}`
- AI: `POST /api/ai/mood`, `/api/ai/summary`, `/api/ai/improve`,
  `/api/ai/transcribe`
- Calendar/insights: `GET /api/calendar`, `GET /api/insights/moods`
- Health: `GET /health`

## Testing

```bash
pip install pytest httpx
python -m pytest tests/ -v
```

14 tests, all passing at handover (13 original + 1 for the media
`/file` route): OOP concepts (encapsulation, inheritance,
polymorphism, abstraction), health, unauthenticated 401s, full entry
CRUD on the dev fallback, friendly AI 503 without a Gemini key,
calendar/insights, media upload 503 without Drive, media file route
401/404. Run with `python -m py_compile backend/app/**/*.py` to check
syntax. **Not tested live:** real Neon PostgreSQL, Google OAuth,
Google Drive, Gemini, and the deployed URL — all blocked on owner
authorisation/secrets (see [DEPLOYMENT.md](DEPLOYMENT.md)).

## Privacy

- Private by default; only the owner account can sign in.
- Uploads to Drive and sends to Gemini happen only when the owner
  presses Save/Upload or an AI button, for the selected item only.
- AI output is a suggestion, never a medical/psychological diagnosis,
  and never overwrites the owner's original text automatically.
- Diary content is never logged. Secrets are never in the frontend.
