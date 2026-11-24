# DEPLOYMENT.md — MyDimension deployment guide

> **Deployment is NOT complete.** Nothing here claims a live URL,
> a connected database, or a verified Google integration. This guide
> lists the exact owner-only steps that remain, in order.

## ⚠️ Vercel + FastAPI — read this first

The frontend (static HTML/CSS/JS) deploys to Vercel without problems.
The Python FastAPI backend is the risk: Vercel's Python runtime is a
serverless-functions model with limits (cold starts, request-duration
limits, no persistent local filesystem, function size limits) that
change over time. **Before assuming the whole app lives on Vercel:**

1. Check the current Vercel Python runtime docs and confirm a FastAPI
   app of this size deploys and stays within the free/hobby limits.
2. If it does: deploy the backend as Vercel Python functions
   (see layout below) and set all env vars in Vercel Project Settings.
3. If it does **not** work reliably: keep the frontend on Vercel and
   host the FastAPI backend on a compatible Python host (for example
   Render, Railway, or Fly.io — pick one, check its free tier and
   limits), point `FRONTEND_ORIGIN` / the frontend's API base at that
   host, and **ask the owner for approval before adding the extra
   provider**. Never pretend an unsupported deployment works, and never
   create a paid plan without explicit approval.

The code is written to be host-agnostic (plain FastAPI + `uvicorn`),
so moving the backend does not require rewriting it.

## Step 0 — What the owner must have / do

- GitHub account, signed in (a private repo named `mydimension`).
- Vercel account, signed in.
- Google account `technicalmahmudull@gmail.com` — the ONLY admin
  account. It is used for app login, Drive authorisation, and Gemini
  setup (same account, three separate permissions/consents).
- Never paste passwords, OTPs, recovery codes, or tokens in chat.
  All authorisation happens on the provider's own screens.

## Step 1 — GitHub repository

1. Create a **private** repository named `mydimension`.
2. Push this folder's contents (the agent/owner pushes from a machine
   with Git access; do not commit `.env`, `credentials.json`,
   `token.json`, or any secret — `.gitignore` already excludes them).
3. Confirm the repo contains `README.md`, `.env.example`,
   `.gitignore`, `frontend/`, `backend/`, `migrations/`, `tests/`.

## Step 2 — Neon PostgreSQL (preferred route: Vercel Marketplace)

1. In Vercel: project → Marketplace / Storage / Integrations →
   **Neon** → Add/Install. Sign in / create a Neon account through
   the official flow and approve the integration.
2. Create a Neon project/database named `mydimension`.
3. The integration exposes the connection string as an environment
   variable (or copy it from Neon Console → **Connect**).
4. If the Marketplace integration is unavailable, create the project
   directly at <https://neon.tech/>, open **Connect**, pick the
   branch/database/role, and copy the connection string.
5. Set it as `DATABASE_URL` in Vercel Environment Variables.
   Use the pooled connection string with `sslmode=require` where
   Neon offers it. **Never** post the connection string in chat or
   commit it to GitHub.
6. Apply the schema: run `migrations/schema.sql` against the Neon
   database once (from `psql`, Neon SQL Editor, or a one-off script).
7. Verify: create/read/update/delete one test diary entry, then
   delete the test data.

## Step 3 — Google Cloud: OAuth + Drive API

1. Go to Google Cloud Console, create/select a project.
2. Enable the **Google Drive API**.
3. Configure the **OAuth consent screen** (External, app name
   MyDimension; test users must include
   `technicalmahmudull@gmail.com` while the app is in testing mode).
4. Create OAuth client credentials of type **Web application**.
5. Authorised redirect URI: `https://<your-vercel-domain>/auth/google/callback`
   (and `http://localhost:8000/auth/google/callback` for local dev).
6. Request only the scopes the app needs (OpenID/email/profile for
   login; the narrowest Drive scope for the file workflow —
   `drive.file` — explained to the owner before consent).
7. Put `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in Vercel
   Environment Variables (never in code or Git).
8. First sign-in authorises Drive access; the backend stores tokens
   server-side only. Provide reconnect from Settings if access is
   revoked (the app shows a friendly message and a reconnect action).

## Step 4 — Gemini API key

1. Go to Google AI Studio with the same Google account, create a
   Gemini API key.
2. Set `GEMINI_API_KEY` in Vercel Environment Variables only.
3. The backend uses model `gemini-2.0-flash` (one constant in
   `backend/app/core/config.py`); if Google retires/renames it, change
   that one constant and re-check audio-transcription support.

## Step 5 — Vercel project

1. Vercel → Add New Project → Import the `mydimension` GitHub repo.
2. Framework: the frontend is static. The backend is exposed to
   Vercel through `api/index.py`, which re-exports the FastAPI app
   from `backend/app/main.py`; `vercel.json` sets `maxDuration` to
   60 seconds for that function (checked against current Vercel
   FastAPI docs on 25 Nov 2026). If Vercel still cannot host the
   backend reliably, follow the warning at the top instead.
3. Set **all** environment variables in Vercel Project Settings
   (Production + Preview): `ADMIN_EMAIL`,
   `technicalmahmudull@gmail.com` is already the default, but set it
   explicitly; `DATABASE_URL`, `GEMINI_API_KEY`,
   `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
   `GOOGLE_REDIRECT_URI`, `SESSION_SECRET` (long random value),
   `FRONTEND_ORIGIN`, `GEMINI_MODEL`.
4. Deploy. Open the deployed URL and check: login works only for the
   owner Gmail; another Gmail gets Access Denied; an entry can be
   created and survives a redeploy; a photo/voice upload reaches
   Drive; Gemini actions work when configured.
5. **Do not report success until the live URL has actually been
   opened and tested.** If any step fails, note it as blocked with
   the exact error and the owner action needed.

## Step 6 — PWA

The manifest (`frontend/manifest.webmanifest`) and service worker
are included. After deployment, on a supported phone browser use
“Add to Home Screen”. The service worker caches only the app shell
(static files) — never diary data, media, or tokens. Installation
availability varies by browser/device; do not claim it works
everywhere.

## Environment variable checklist (never show values)

- [ ] `ADMIN_EMAIL` = technicalmahmudull@gmail.com
- [ ] `DATABASE_URL` (Neon)
- [ ] `GEMINI_API_KEY`
- [ ] `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
- [ ] `GOOGLE_REDIRECT_URI` matches the deployed domain
- [ ] `SESSION_SECRET`
- [ ] `FRONTEND_ORIGIN`
- [ ] GitHub repo connected to Vercel
- [ ] Schema applied (`migrations/schema.sql`)
- [ ] Live URL opened and login tested

## Rollback / safety notes

- Secrets live only in Vercel env vars. Rotating a secret means
  updating it there and redeploying — no code change.
- The backend never stores media bytes; deleting a Drive file from
  the app also deletes its database record, and vice versa.
- Export (Settings → Export) downloads entries as JSON from the API.
