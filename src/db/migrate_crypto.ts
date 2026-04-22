import type { Db } from './index.ts';
import { encrypt, isLegacyBlob, legacyDecryptV0, type KeySet } from '../crypto.ts';
import { GMAIL_OAUTH_KEY, settingsAad } from '../settings.ts';

export type MigrationResult = { upgraded: number };

export function migrateLegacyCiphertexts(
  db: Db,
  keys: KeySet,
): MigrationResult {
  let count = 0;

  const tx = db.transaction(() => {
    const sources = db
      .prepare('SELECT id, password_encrypted FROM sources')
      .all() as { id: number; password_encrypted: Buffer }[];
    for (const r of sources) {
      if (!r.password_encrypted || r.password_encrypted.length === 0) continue;
      if (!isLegacyBlob(r.password_encrypted)) continue;
      const pt = legacyDecryptV0(r.password_encrypted, keys);
      const enc = encrypt(pt, keys, `sources.password:${r.id}`);
      db.prepare('UPDATE sources SET password_encrypted = ? WHERE id = ?').run(enc, r.id);
      count += 1;
    }

    const destinations = db
      .prepare('SELECT id, credentials_encrypted FROM destinations')
      .all() as { id: number; credentials_encrypted: Buffer }[];
    for (const r of destinations) {
      if (!r.credentials_encrypted || r.credentials_encrypted.length === 0) continue;
      if (!isLegacyBlob(r.credentials_encrypted)) continue;
      const pt = legacyDecryptV0(r.credentials_encrypted, keys);
      const enc = encrypt(pt, keys, `destinations.credentials:${r.id}`);
      db.prepare('UPDATE destinations SET credentials_encrypted = ? WHERE id = ?').run(enc, r.id);
      count += 1;
    }

    const encryptedSettingKeys = [GMAIL_OAUTH_KEY];
    for (const k of encryptedSettingKeys) {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(k) as
        | { value: string }
        | undefined;
      if (!row) continue;
      let blob: Buffer;
      try {
        blob = Buffer.from(row.value, 'base64');
      } catch {
        continue;
      }
      if (!isLegacyBlob(blob)) continue;
      const pt = legacyDecryptV0(blob, keys);
      const enc = encrypt(pt, keys, settingsAad(k));
      db.prepare(
        "UPDATE settings SET value = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE key = ?",
      ).run(enc.toString('base64'), k);
      count += 1;
    }
  });
  tx();

  return { upgraded: count };
}
