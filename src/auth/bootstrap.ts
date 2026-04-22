import { randomBytes } from 'node:crypto';
import type { Db } from '../db/index.ts';
import { hashPassword } from './hash.ts';

const BOOTSTRAP_KEY = 'bootstrap_done';
const PASSWORD_LEN = 20;

function randomPassword(): string {
  const alphabet =
    'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = randomBytes(PASSWORD_LEN);
  let out = '';
  for (let i = 0; i < PASSWORD_LEN; i++) {
    out += alphabet[bytes[i]! % alphabet.length];
  }
  return out;
}

export async function bootstrapAdmin(
  db: Db,
  log: (msg: string) => void = console.log,
): Promise<{ created: boolean; username?: string }> {
  const username = 'admin';
  const password = randomPassword();
  const hash = await hashPassword(password);

  // Race-safe: concurrent starts fight over the INSERT OR IGNORE, only the
  // winner creates the admin row.
  const claimed = db.transaction((): boolean => {
    const res = db
      .prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
      .run(BOOTSTRAP_KEY, '1');
    if (res.changes !== 1) return false;
    try {
      db.prepare(
        'INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, 1)',
      ).run(username, hash);
      return true;
    } catch (err) {
      db.prepare('DELETE FROM settings WHERE key = ?').run(BOOTSTRAP_KEY);
      throw err;
    }
  })();

  if (!claimed) return { created: false };

  const banner = [
    '',
    '========================================================',
    ' MAILSLUICE FIRST-RUN ADMIN CREDENTIALS',
    '   username: ' + username,
    '   password: ' + password,
    ' This is shown ONCE. Copy it now.',
    '========================================================',
    '',
  ].join('\n');
  log(banner);

  return { created: true, username };
}
