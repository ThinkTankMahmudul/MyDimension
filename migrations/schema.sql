-- MyDimension PostgreSQL schema (Neon / managed PostgreSQL).
-- Run once on a fresh database, e.g. `psql "$DATABASE_URL" -f migrations/schema.sql`.
-- All timestamps are stored in UTC (timestamptz); display them in the
-- owner's local timezone in the frontend.
-- Safe: use CREATE TABLE IF NOT EXISTS so re-running is harmless.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Registered users (email verification sign-up). The owner also gets
-- a row here (created on first sign-in via require_user) so every
-- diary entry / mood / media row can be scoped by user_id.
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    is_verified BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Email codes, both for sign-up verification (purpose 'verify') and
-- password reset (purpose 'reset'). The purpose keeps the two kinds
-- of code apart: a sign-up code can never reset a password, and a
-- reset code can never verify an account.
CREATE TABLE IF NOT EXISTS email_verification_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    purpose TEXT NOT NULL DEFAULT 'verify',
    expires_at TIMESTAMPTZ NOT NULL,
    attempts INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);
CREATE INDEX IF NOT EXISTS idx_verification_codes_email ON email_verification_codes (email);
CREATE INDEX IF NOT EXISTS idx_verification_codes_expires_at ON email_verification_codes (expires_at);

CREATE TABLE IF NOT EXISTS diary_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    mood TEXT,
    tags TEXT[] NOT NULL DEFAULT '{}',
    summary TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mood_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entry_id UUID REFERENCES diary_entries(id) ON DELETE CASCADE,
    mood TEXT NOT NULL,
    note TEXT,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memory_files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entry_id UUID REFERENCES diary_entries(id) ON DELETE SET NULL,
    media_type TEXT NOT NULL CHECK (media_type IN ('photo', 'audio')),
    drive_file_id TEXT NOT NULL,
    file_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    file_size BIGINT NOT NULL DEFAULT 0,
    caption TEXT,
    transcript TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_email TEXT NOT NULL,
    theme TEXT NOT NULL DEFAULT 'light',
    ai_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Owner credentials, as generic key/value pairs. Only the password
-- *hash* is stored here (key 'password_hash', value 'salt$hash' from
-- PBKDF2-HMAC-SHA256); a plain-text password is never stored anywhere.
-- user_settings has no key/value columns, so this dedicated table holds
-- the login credential instead of overloading that table.
CREATE TABLE IF NOT EXISTS auth_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_entries_created_at ON diary_entries (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entries_mood ON diary_entries (mood);
CREATE INDEX IF NOT EXISTS idx_entries_search ON diary_entries USING gin (to_tsvector('english', title || ' ' || content));
CREATE INDEX IF NOT EXISTS idx_mood_records_recorded_at ON mood_records (recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_files_entry_id ON memory_files (entry_id);
CREATE INDEX IF NOT EXISTS idx_memory_files_created_at ON memory_files (created_at DESC);

-- Multi-user scoping: every data row belongs to one user. The columns
-- are added idempotently so re-running this schema on a live database
-- is safe. Rows created before this change have user_id NULL; they
-- belong to the owner and are backfilled to the owner's user id by
-- require_user on the owner's next sign-in (see core/security.py).
ALTER TABLE diary_entries ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE mood_records ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE memory_files ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE email_verification_codes ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'verify';
-- Purpose index lives here (after the ALTER): creating it earlier failed
-- on live databases whose codes table predates the purpose column, and
-- one failed statement used to abort the whole schema initialisation.
CREATE INDEX IF NOT EXISTS idx_verification_codes_purpose ON email_verification_codes (email, purpose);

CREATE INDEX IF NOT EXISTS idx_entries_user_id ON diary_entries (user_id);
CREATE INDEX IF NOT EXISTS idx_mood_records_user_id ON mood_records (user_id);
CREATE INDEX IF NOT EXISTS idx_memory_files_user_id ON memory_files (user_id);
