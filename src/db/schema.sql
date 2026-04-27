-- Mailsluice SQLite schema. Forward-only; no down migrations.

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS users (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  username            TEXT NOT NULL UNIQUE,
  password_hash       TEXT NOT NULL,
  is_admin            INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
  risk_acked_version  TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS destinations (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type                  TEXT NOT NULL,
  account_identifier    TEXT,
  credentials_encrypted BLOB NOT NULL,
  enabled               INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, type, account_identifier)
);

CREATE TABLE IF NOT EXISTS sources (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  destination_id        INTEGER NOT NULL REFERENCES destinations(id) ON DELETE RESTRICT,
  name                  TEXT NOT NULL,
  type                  TEXT NOT NULL CHECK (type IN ('imap', 'pop')),
  host                  TEXT NOT NULL,
  port                  INTEGER NOT NULL,
  use_tls               INTEGER NOT NULL DEFAULT 1 CHECK (use_tls IN (0, 1)),
  username              TEXT NOT NULL,
  password_encrypted    BLOB NOT NULL,
  destination_tag       TEXT NOT NULL,
  poll_interval_seconds INTEGER,
  enabled               INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  last_error            TEXT,
  last_sync_at          TEXT,
  skipped_count         INTEGER NOT NULL DEFAULT 0,
  post_import_action    TEXT NOT NULL DEFAULT 'none',
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_sources_user ON sources(user_id);

CREATE TABLE IF NOT EXISTS sync_state (
  source_id   INTEGER PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
  uidvalidity INTEGER,
  last_uid    INTEGER,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS source_folders (
  source_id    INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  folder_path  TEXT NOT NULL,
  label_name   TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  uidvalidity  INTEGER,
  last_uid     INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (source_id, folder_path)
);

CREATE INDEX IF NOT EXISTS idx_source_folders_source ON source_folders(source_id);

CREATE TABLE IF NOT EXISTS imported_messages (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id               INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  message_id_header       TEXT NOT NULL,
  external_uid            TEXT,
  destination_message_id  TEXT,
  imported_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (source_id, message_id_header)
);

CREATE INDEX IF NOT EXISTS idx_imported_source ON imported_messages(source_id);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id   INTEGER,
  actor_username  TEXT,
  action          TEXT NOT NULL,
  target_type     TEXT,
  target_id       TEXT,
  details         TEXT,
  ip              TEXT,
  user_agent      TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_action  ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_actor   ON audit_log(actor_user_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

CREATE TABLE IF NOT EXISTS event_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  level           TEXT NOT NULL CHECK (level IN ('info','warn','error')),
  message         TEXT NOT NULL,
  source_id       INTEGER,
  destination_id  INTEGER,
  user_id         INTEGER,
  details         TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_events_created ON event_log(created_at);
CREATE INDEX IF NOT EXISTS idx_events_level   ON event_log(level);
CREATE INDEX IF NOT EXISTS idx_events_source  ON event_log(source_id);
