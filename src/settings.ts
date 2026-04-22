import type { Db } from './db/index.ts';
import { decryptJson, encryptJson, type KeySet } from './crypto.ts';

export function getSettingRaw(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSettingRaw(db: Db, key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now')) " +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  ).run(key, value);
}

export function deleteSetting(db: Db, key: string): void {
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}

export function settingsAad(key: string): string {
  return `settings:${key}`;
}

export function getEncryptedJson<T>(
  db: Db,
  key: string,
  keys: KeySet | Buffer,
): T | null {
  const b64 = getSettingRaw(db, key);
  if (!b64) return null;
  return decryptJson<T>(Buffer.from(b64, 'base64'), keys, settingsAad(key));
}

export function setEncryptedJson(
  db: Db,
  key: string,
  value: unknown,
  keys: KeySet | Buffer,
): void {
  const enc = encryptJson(value, keys, settingsAad(key));
  setSettingRaw(db, key, enc.toString('base64'));
}

export type GmailOAuthClient = {
  client_id: string;
  client_secret: string;
  redirect_uri?: string;
};

export const GMAIL_OAUTH_KEY = 'gmail_oauth_client';

export function getGmailOAuthClient(
  db: Db,
  keys: KeySet | Buffer,
): GmailOAuthClient | null {
  return getEncryptedJson<GmailOAuthClient>(db, GMAIL_OAUTH_KEY, keys);
}

export function setGmailOAuthClient(
  db: Db,
  keys: KeySet | Buffer,
  config: GmailOAuthClient,
): void {
  setEncryptedJson(db, GMAIL_OAUTH_KEY, config, keys);
}

export function clearGmailOAuthClient(db: Db): void {
  deleteSetting(db, GMAIL_OAUTH_KEY);
}

export function maskSecret(secret: string): string {
  if (secret.length <= 6) return '...';
  return `...${secret.slice(-4)}`;
}
