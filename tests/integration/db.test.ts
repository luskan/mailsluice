import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/db/index.ts';

test('migrate creates all expected tables', () => {
  const db = openDb(':memory:');
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as { name: string }[];
  const names = rows.map((r) => r.name);
  for (const t of [
    'users',
    'destinations',
    'sources',
    'sync_state',
    'imported_messages',
    'settings',
  ]) {
    assert.ok(names.includes(t), `missing table: ${t}`);
  }
  db.close();
});

test('migrate is idempotent across reopens', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mailsluice-'));
  try {
    const path = join(dir, 'db.sqlite');
    const db1 = openDb(path);
    db1.prepare(
      "INSERT INTO users (username, password_hash, is_admin) VALUES ('u1', 'h', 0)",
    ).run();
    db1.close();

    const db2 = openDb(path);
    const count = db2
      .prepare('SELECT COUNT(*) as n FROM users')
      .get() as { n: number };
    assert.equal(count.n, 1);
    db2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('users table enforces unique username', () => {
  const db = openDb(':memory:');
  db.prepare(
    "INSERT INTO users (username, password_hash, is_admin) VALUES ('admin', 'hash', 1)",
  ).run();
  assert.throws(() =>
    db
      .prepare(
        "INSERT INTO users (username, password_hash, is_admin) VALUES ('admin', 'hash2', 0)",
      )
      .run(),
  );
  db.close();
});

test('imported_messages enforces (source_id, message_id_header) uniqueness', () => {
  const db = openDb(':memory:');
  const u = db
    .prepare(
      "INSERT INTO users (username, password_hash, is_admin) VALUES ('u1', 'h', 0) RETURNING id",
    )
    .get() as { id: number };
  const d = db
    .prepare(
      "INSERT INTO destinations (user_id, type, credentials_encrypted) VALUES (?, 'gmail', x'00') RETURNING id",
    )
    .get(u.id) as { id: number };
  const s = db
    .prepare(
      "INSERT INTO sources (user_id, destination_id, name, type, host, port, username, password_encrypted, destination_tag) VALUES (?, ?, 's', 'imap', 'host', 993, 'user', x'00', 'tag') RETURNING id",
    )
    .get(u.id, d.id) as { id: number };

  db.prepare(
    'INSERT INTO imported_messages (source_id, message_id_header) VALUES (?, ?)',
  ).run(s.id, '<abc@example.com>');
  assert.throws(() =>
    db
      .prepare(
        'INSERT INTO imported_messages (source_id, message_id_header) VALUES (?, ?)',
      )
      .run(s.id, '<abc@example.com>'),
  );
  db.close();
});

test('settings table can store bootstrap_done marker', () => {
  const db = openDb(':memory:');
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
    'bootstrap_done',
    '1',
  );
  const row = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get('bootstrap_done') as { value: string };
  assert.equal(row.value, '1');
  db.close();
});

test('sources CHECK constraint rejects unknown type', () => {
  const db = openDb(':memory:');
  const u = db
    .prepare(
      "INSERT INTO users (username, password_hash, is_admin) VALUES ('u1', 'h', 0) RETURNING id",
    )
    .get() as { id: number };
  const d = db
    .prepare(
      "INSERT INTO destinations (user_id, type, credentials_encrypted) VALUES (?, 'gmail', x'00') RETURNING id",
    )
    .get(u.id) as { id: number };
  assert.throws(() =>
    db
      .prepare(
        "INSERT INTO sources (user_id, destination_id, name, type, host, port, username, password_encrypted, destination_tag) VALUES (?, ?, 's', 'smtp', 'h', 25, 'u', x'00', 'tag')",
      )
      .run(u.id, d.id),
  );
  db.close();
});
