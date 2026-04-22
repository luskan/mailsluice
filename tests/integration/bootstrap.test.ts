import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../src/db/index.ts';
import { bootstrapAdmin } from '../../src/auth/bootstrap.ts';
import { verifyPassword } from '../../src/auth/hash.ts';

test('first run creates exactly one admin and logs credentials', async () => {
  const db = openDb(':memory:');
  const logs: string[] = [];
  const res = await bootstrapAdmin(db, (m) => logs.push(m));
  assert.equal(res.created, true);
  assert.equal(res.username, 'admin');

  const users = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
  assert.equal(users.n, 1);

  const banner = logs.join('\n');
  assert.match(banner, /username: admin/);
  assert.match(banner, /password: [A-Za-z0-9]{20}/);

  const marker = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get('bootstrap_done') as { value: string };
  assert.equal(marker.value, '1');

  db.close();
});

test('second run is a no-op even if users table emptied', async () => {
  const db = openDb(':memory:');
  await bootstrapAdmin(db, () => {});

  db.prepare('DELETE FROM users').run();

  const logs: string[] = [];
  const res = await bootstrapAdmin(db, (m) => logs.push(m));
  assert.equal(res.created, false);
  assert.equal(logs.length, 0);

  const users = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
  assert.equal(users.n, 0);

  db.close();
});

test('generated password verifies against stored hash', async () => {
  const db = openDb(':memory:');
  let banner = '';
  await bootstrapAdmin(db, (m) => {
    banner = m;
  });
  const pw = /password: (\S+)/.exec(banner)?.[1];
  assert.ok(pw && pw.length >= 20);

  const row = db
    .prepare('SELECT password_hash, is_admin FROM users WHERE username = ?')
    .get('admin') as { password_hash: string; is_admin: number };
  assert.equal(row.is_admin, 1);
  assert.equal(await verifyPassword(row.password_hash, pw!), true);
  assert.equal(await verifyPassword(row.password_hash, 'wrong'), false);

  db.close();
});
