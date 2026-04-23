import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../src/db/index.ts';
import { seedInboxFolderIfMissing } from '../../src/sync/imap_worker.ts';

function prep() {
  const db = openDb(':memory:');
  const u = db
    .prepare("INSERT INTO users (username, password_hash) VALUES ('u', 'x') RETURNING id")
    .get() as { id: number };
  const d = db
    .prepare("INSERT INTO destinations (user_id, type, credentials_encrypted) VALUES (?, 'gmail', x'00') RETURNING id")
    .get(u.id) as { id: number };
  return { db, userId: u.id, destinationId: d.id };
}

test('seedInboxFolderIfMissing creates an INBOX row with destination_tag label', () => {
  const { db, userId, destinationId } = prep();
  const s = db
    .prepare(
      "INSERT INTO sources (user_id, destination_id, name, type, host, port, username, password_encrypted, destination_tag, poll_interval_seconds) VALUES (?, ?, 's', 'imap', 'h', 993, 'u', x'00', 'LegacyLabel', NULL) RETURNING id",
    )
    .get(userId, destinationId) as { id: number };
  const res = seedInboxFolderIfMissing(db, s.id);
  assert.deepEqual(res, { label: 'LegacyLabel' });
  const rows = db
    .prepare('SELECT folder_path, label_name, enabled, uidvalidity, last_uid FROM source_folders WHERE source_id = ?')
    .all(s.id) as Array<{ folder_path: string; label_name: string; enabled: number; uidvalidity: number | null; last_uid: number }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.folder_path, 'INBOX');
  assert.equal(rows[0]!.label_name, 'LegacyLabel');
  assert.equal(rows[0]!.enabled, 1);
  db.close();
});

test('seedInboxFolderIfMissing carries over old sync_state cursor', () => {
  const { db, userId, destinationId } = prep();
  const s = db
    .prepare(
      "INSERT INTO sources (user_id, destination_id, name, type, host, port, username, password_encrypted, destination_tag, poll_interval_seconds) VALUES (?, ?, 's', 'imap', 'h', 993, 'u', x'00', 'Ext', NULL) RETURNING id",
    )
    .get(userId, destinationId) as { id: number };
  db.prepare("INSERT INTO sync_state (source_id, uidvalidity, last_uid) VALUES (?, 4242, 99)").run(s.id);
  seedInboxFolderIfMissing(db, s.id);
  const row = db
    .prepare('SELECT uidvalidity, last_uid FROM source_folders WHERE source_id = ? AND folder_path = ?')
    .get(s.id, 'INBOX') as { uidvalidity: number; last_uid: number };
  assert.equal(row.uidvalidity, 4242);
  assert.equal(row.last_uid, 99);
  db.close();
});

test('seedInboxFolderIfMissing is a no-op when rows exist', () => {
  const { db, userId, destinationId } = prep();
  const s = db
    .prepare(
      "INSERT INTO sources (user_id, destination_id, name, type, host, port, username, password_encrypted, destination_tag, poll_interval_seconds) VALUES (?, ?, 's', 'imap', 'h', 993, 'u', x'00', 'Ext', NULL) RETURNING id",
    )
    .get(userId, destinationId) as { id: number };
  db.prepare(
    "INSERT INTO source_folders (source_id, folder_path, label_name, enabled) VALUES (?, 'INBOX', 'ExistingLabel', 1)",
  ).run(s.id);
  const res = seedInboxFolderIfMissing(db, s.id);
  assert.equal(res, null);
  const rows = db.prepare('SELECT label_name FROM source_folders WHERE source_id = ?').all(s.id) as Array<{ label_name: string }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.label_name, 'ExistingLabel');
  db.close();
});
