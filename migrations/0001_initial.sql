-- xagent — initial schema (Cloudflare D1 / SQLite)
-- Embedding vectors live in Vectorize. D1 keeps users, sessions, document
-- metadata, chunk text (needed to build the prompt), sync runs and usage counters.
-- Chat history is NOT stored anywhere on the server.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT    NOT NULL,                 -- pbkdf2$sha256$<iter>$<salt_b64>$<hash_b64>
  role          TEXT    NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
  status        TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_login_at TEXT
);

-- id = SHA-256 of the random session token. The raw token only exists in the
-- user's HttpOnly cookie, so a database leak does not leak usable sessions.
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS documents (
  id                 TEXT PRIMARY KEY,            -- = Google document id
  google_document_id TEXT NOT NULL UNIQUE,
  name               TEXT NOT NULL DEFAULT '',
  document_type      TEXT NOT NULL DEFAULT 'handbook',
  url                TEXT,
  content_hash       TEXT,                        -- hash of the whole extracted document
  version            TEXT,                        -- detected OS version, if any
  revision_id        TEXT,                        -- Google Docs revisionId
  modified_time      TEXT,                        -- Google Drive modifiedTime
  chunk_count        INTEGER NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','syncing','synced','failed')),
  last_error         TEXT,
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_synced_at     TEXT
);

-- One row per indexed chunk. id is content-addressed (hash of doc id + section +
-- content + embedding model) and is also the Vectorize vector id, so unchanged
-- chunks are never re-embedded.
CREATE TABLE IF NOT EXISTS document_chunks (
  id            TEXT    PRIMARY KEY,
  document_id   TEXT    NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index   INTEGER NOT NULL,
  chunk_type    TEXT    NOT NULL DEFAULT 'text' CHECK (chunk_type IN ('text','code')),
  heading       TEXT,
  heading_id    TEXT,                             -- Google Docs heading anchor (deep link)
  section       TEXT,                             -- full heading path "A > B > C"
  content       TEXT    NOT NULL,
  content_hash  TEXT    NOT NULL,
  version       TEXT,
  file_name     TEXT,
  language      TEXT,
  class_name    TEXT,
  function_name TEXT,
  module        TEXT,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON document_chunks(document_id, chunk_index);

CREATE TABLE IF NOT EXISTS sync_runs (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_type        TEXT    NOT NULL DEFAULT 'manual' CHECK (trigger_type IN ('manual','scheduled')),
  started_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at        TEXT,
  status              TEXT    NOT NULL DEFAULT 'running' CHECK (status IN ('running','success','partial','failed')),
  documents_processed INTEGER NOT NULL DEFAULT 0,
  documents_failed    INTEGER NOT NULL DEFAULT 0,
  chunks_processed    INTEGER NOT NULL DEFAULT 0,  -- newly embedded chunks
  chunks_deleted      INTEGER NOT NULL DEFAULT 0,
  error_message       TEXT
);

-- Generic counters for rate limiting and the daily AI budget.
-- scope examples: 'ai:daily', 'chat:user:3', 'login:ip:1.2.3.4'
CREATE TABLE IF NOT EXISTS usage_counters (
  scope      TEXT    NOT NULL,
  bucket     TEXT    NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (scope, bucket)
);
