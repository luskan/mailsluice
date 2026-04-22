import { randomBytes } from 'node:crypto';
import { openDb } from '../db/index.ts';
import { loadConfig } from '../config.ts';
import { hashPassword } from '../auth/hash.ts';

const PASSWORD_LEN = 20;

function randomPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = randomBytes(PASSWORD_LEN);
  let out = '';
  for (let i = 0; i < PASSWORD_LEN; i++) {
    out += alphabet[bytes[i]! % alphabet.length];
  }
  return out;
}

async function main(): Promise<void> {
  const username = process.argv[2];
  if (!username) {
    console.error('Usage: reset_password <username>');
    process.exit(2);
  }

  const cfg = await loadConfig();
  const db = openDb(cfg.APP_DATABASE_PATH);

  const row = db
    .prepare('SELECT id, is_admin FROM users WHERE username = ?')
    .get(username) as { id: number; is_admin: number } | undefined;
  if (!row) {
    console.error(`No user named "${username}".`);
    db.close();
    process.exit(1);
  }

  const password = randomPassword();
  const hash = await hashPassword(password);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, row.id);
  db.close();

  console.log('');
  console.log('========================================================');
  console.log(' Password reset');
  console.log('   username: ' + username + (row.is_admin ? ' (admin)' : ''));
  console.log('   password: ' + password);
  console.log(' Sign in and change it in the UI under "Password".');
  console.log('========================================================');
  console.log('');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
