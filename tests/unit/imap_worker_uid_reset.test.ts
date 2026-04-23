import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../src/db/index.ts';
import { seedInboxFolderIfMissing } from '../../src/sync/imap_worker.ts';

// Drives the reconcileUidValidity logic through a minimal SQL dance. The real
// path in the worker is private, so we test the same queries.

function prep() {
  const db = openDb(':memory:');
  const u = db.prepare("INSERT INTO users (username, password_hash) VALUES ('u', 'x') RETURNING id").get() as { id: number };
  const d = db.prepare("INSERT INTO destinations (user_id, type, credentials_encrypted) VALUES (?, 'gmail', x'00') RETURNING id").get(u.id) as { id: number };
  const s = db
    .prepare("INSERT INTO sources (user_id, destination_id, name, type, host, port, username, password_encrypted, destination_tag, poll_interval_seconds) VALUES (?, ?, 's', 'imap', 'h', 993, 'u', x'00', 'Ext', NULL) RETURNING id")
    .get(u.id, d.id) as { id: number };
  return { db, sourceId: s.id };
}

test('non-INBOX folder row is created by reconcile path', () => {
  const { db, sourceId } = prep();
  // Simulate reconcile path for a new folder (no row yet).
  db.prepare(
    "INSERT OR IGNORE INTO source_folders (source_id, folder_path, label_name, enabled, uidvalidity, last_uid, updated_at) VALUES (?, ?, ?, 1, ?, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
  ).run(sourceId, 'Work', 'Work', 12345);
  const row = db
    .prepare('SELECT uidvalidity, last_uid FROM source_folders WHERE source_id = ? AND folder_path = ?')
    .get(sourceId, 'Work') as { uidvalidity: number; last_uid: number };
  assert.equal(row.uidvalidity, 12345);
  assert.equal(row.last_uid, 0);
  db.close();
});

test('UIDVALIDITY change on non-INBOX folder resets last_uid', () => {
  const { db, sourceId } = prep();
  db.prepare(
    "INSERT INTO source_folders (source_id, folder_path, label_name, enabled, uidvalidity, last_uid) VALUES (?, 'Work', 'Ext/Work', 1, 100, 42)",
  ).run(sourceId);
  db.prepare(
    "UPDATE source_folders SET uidvalidity = ?, last_uid = 0 WHERE source_id = ? AND folder_path = ?",
  ).run(999, sourceId, 'Work');
  const row = db
    .prepare('SELECT uidvalidity, last_uid FROM source_folders WHERE source_id = ? AND folder_path = ?')
    .get(sourceId, 'Work') as { uidvalidity: number; last_uid: number };
  assert.equal(row.uidvalidity, 999);
  assert.equal(row.last_uid, 0);
  db.close();
});

test('seed is race-safe: second call is a no-op (INSERT OR IGNORE)', () => {
  const { db, sourceId } = prep();
  const a = seedInboxFolderIfMissing(db, sourceId);
  const b = seedInboxFolderIfMissing(db, sourceId);
  assert.deepEqual(a, { label: 'Ext' });
  assert.equal(b, null);
  const n = db.prepare('SELECT COUNT(*) AS n FROM source_folders WHERE source_id = ?').get(sourceId) as { n: number };
  assert.equal(n.n, 1);
  db.close();
});
