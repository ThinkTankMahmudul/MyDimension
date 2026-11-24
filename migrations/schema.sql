-- MyDimension PostgreSQL schema (Neon / managed PostgreSQL).
-- Run once on a fresh database, e.g. `psql "$DATABASE_URL" -f migrations/schema.sql`.
-- All timestamps are stored in UTC (timestamptz); display them in the
-- owner's local timezone in the frontend.
-- Safe: use CREATE TABLE IF NOT EXISTS so re-running is harmless.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

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

CREATE INDEX IF NOT EXISTS idx_entries_created_at ON diary_entries (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entries_mood ON diary_entries (mood);
CREATE INDEX IF NOT EXISTS idx_entries_search ON diary_entries USING gin (to_tsvector('english', title || ' ' || content));
CREATE INDEX IF NOT EXISTS idx_mood_records_recorded_at ON mood_records (recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_files_entry_id ON memory_files (entry_id);
CREATE INDEX IF NOT EXISTS idx_memory_files_created_at ON memory_files (created_at DESC);
