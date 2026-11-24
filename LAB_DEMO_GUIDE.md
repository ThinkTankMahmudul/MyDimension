# LAB_DEMO_GUIDE.md — How to present MyDimension in the OOP lab

For a 2–3 member DIU team. Every member must be able to explain the
whole project; divide the demo, not the understanding.

## 1. One-minute pitch

“MyDimension is my private diary on the web. I write entries, record
voice memories, and attach photos. My photos and audio live in my own
Google Drive, my diary text lives in PostgreSQL, and Gemini helps me
summarise and reflect. Only my Gmail can sign in. The Python backend
is written with clear OOP — five concepts, each in real code.”

## 2. Live demo script (5–7 minutes)

1. **Login:** open the deployed URL → “Sign in with Google”.
   Sign in as the owner. Then show that another Gmail gets
   “Access Denied” (backend check, not just a hidden button).
2. **Write:** Dashboard → “+ New Entry” → title + text, pick a mood
   (e.g. Calm), Save. It appears in My Journal and on the Dashboard.
3. **Search/filter:** search for a word; filter by mood.
4. **Calendar:** open Calendar — today is highlighted and the day
   has a dot. Click the day to see the entry.
5. **Voice:** Voice Memories → Record (browser asks for the mic) →
   Stop → Preview → Save. Then “Transcribe with AI” and show the
   transcript as a draft — never auto-saved.
6. **Photo:** Photo Memories → upload a photo → it appears in the
   gallery (stored in Drive, only the file ID is in the database).
7. **AI:** AI Assistant → select the entry → “Summarize” and
   “Improve writing”. Point out the original is never overwritten.
8. **Mood Insights:** show the mood counts/bars.
9. **Settings:** show Drive connected, Gemini configured (key never
   shown), Export, Logout.

## 3. OOP explanation (the part examiners ask about)

Use [OOP_CONCEPTS.md](OOP_CONCEPTS.md) and these files:

- **Classes/Objects:** open `backend/app/models/models.py` —
  `DiaryEntry` is a class; every entry you saved is an object of it.
- **Encapsulation:** same file — `__title` / `__content` are
  private; the property setter rejects an empty title. Try creating
  `DiaryEntry(title="", ...)` in a test — it raises `ValueError`.
- **Inheritance:** open `backend/app/services/ai_service.py` —
  `GeminiAIService` and `OfflineAIService` both inherit from
  `BaseAIService`.
- **Polymorphism:** same file — both implement `process_text()`
  differently; the route just calls `service.process_text(...)`
  without knowing which one it is. If Gemini has no key, the
  Offline service answers politely instead of crashing.
- **Abstraction:** same file — `BaseAIService` is an `ABC` with
  `@abstractmethod process_text()`; it cannot be instantiated.
  Run `python -m pytest tests/test_oop.py -v` to prove all five.

## 4. Architecture in one breath

“Browser → FastAPI backend → PostgreSQL for diary text, Google Drive
for photo/audio bytes, Gemini for AI. The frontend never sees a
secret; the backend checks the owner's email on every private route.”

## 5. Team division (suggested)

- **Member 1:** Python OOP backend — FastAPI, models, DiaryManager,
  DatabaseManager, CRUD, tests.
- **Member 2:** Frontend + PWA — dashboard layout, responsive CSS,
  journal/calendar/insights pages, manifest + service worker.
- **Member 3:** Google OAuth + Drive + Gemini, deployment
  (GitHub/Vercel/Neon), testing and integration.

With two members: Member 1 takes backend + auth; Member 2 takes
frontend + Drive/Gemini integration and testing. Both must be able to
explain all five OOP concepts.

## 6. Likely viva questions (short answers)

- **Why PostgreSQL and not SQLite?** Production data must survive
  redeploys and be reachable by the hosted backend; SQLite is a local
  file and Vercel's filesystem is temporary.
- **Why is Drive not the database?** Drive stores file bytes; it
  cannot do structured queries. PostgreSQL stores text, dates, moods,
  and Drive file IDs.
- **How is only one user allowed?** The backend verifies the Google
  ID token, checks `email_verified`, and compares the email to
  `ADMIN_EMAIL` on the server. Frontend checks alone would be
  bypassable.
- **What if Gemini/Drive is down?** Diary CRUD still works. AI and
  upload endpoints return a friendly 503; the app never crashes.
- **Where is the API key?** Only in environment variables on the
  server (Vercel settings). It is never in the frontend or Git.
- **Can the desktop UI be deployed to Vercel?** No — that is why this
  version is a separate HTML/CSS/JS web frontend with a FastAPI
  backend, not CustomTkinter.
