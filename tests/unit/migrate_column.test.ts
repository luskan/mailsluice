import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrate } from '../../src/db/migrate.ts';

test('migrate is idempotent', () => {
  const db = new Database(':memory:');
  migrate(db);
  migrate(db);
  const cols = db.prepare("PRAGMA table_info(sources)").all() as Array<{ name: string }>;
  assert.ok(cols.find((c) => c.name === 'post_import_action'), 'post_import_action present');
  assert.ok(cols.find((c) => c.name === 'destination_tag'), 'destination_tag present');
  db.close();
});

test('migrate adds post_import_action on pre-existing DB without it', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      destination_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      use_tls INTEGER NOT NULL DEFAULT 1,
      username TEXT NOT NULL,
      password_encrypted BLOB NOT NULL,
      destination_tag TEXT NOT NULL,
      poll_interval_seconds INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_error TEXT,
      last_sync_at TEXT,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
  let cols = db.prepare("PRAGMA table_info(sources)").all() as Array<{ name: string }>;
  assert.equal(cols.find((c) => c.name === 'post_import_action'), undefined);
  migrate(db);
  cols = db.prepare("PRAGMA table_info(sources)").all() as Array<{ name: string }>;
  const pia = cols.find((c) => c.name === 'post_import_action') as unknown as { name: string; dflt_value: string | null };
  assert.ok(pia, 'column added');
  db.close();
});

test('source_folders table is created by migrate', () => {
  const db = new Database(':memory:');
  migrate(db);
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='source_folders'").all() as Array<{ name: string }>;
  assert.equal(rows.length, 1);
  const cols = db.prepare("PRAGMA table_info(source_folders)").all() as Array<{ name: string }>;
  const names = cols.map((c) => c.name).sort();
  assert.deepEqual(names, ['enabled', 'folder_path', 'label_name', 'last_uid', 'source_id', 'uidvalidity', 'updated_at']);
  db.close();
});
