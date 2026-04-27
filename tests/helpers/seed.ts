import type Database from 'better-sqlite3';
import { encrypt, encryptJson, type KeySet } from '../../src/crypto.ts';
import { hashPassword } from '../../src/auth/hash.ts';
import { RISK_ACK_VERSION } from '../../src/risk_ack.ts';

export async function seedUser(
  db: Database.Database,
  username: string,
  password: string,
  isAdmin = false,
  opts: { riskAcked?: boolean } = {},
): Promise<number> {
  const hash = await hashPassword(password);
  const ack = opts.riskAcked === false ? null : RISK_ACK_VERSION;
  const r = db
    .prepare(
      'INSERT INTO users (username, password_hash, is_admin, risk_acked_version) VALUES (?, ?, ?, ?) RETURNING id',
    )
    .get(username, hash, isAdmin ? 1 : 0, ack) as { id: number };
  return r.id;
}

export function seedDestination(
  db: Database.Database,
  userId: number,
  keys: KeySet | Buffer,
  accountId = 'user@x.com',
  credentials: unknown = { refresh_token: 'rt' },
): number {
  const tx = db.transaction((): number => {
    const res = db
      .prepare(
        'INSERT INTO destinations (user_id, type, account_identifier, credentials_encrypted) VALUES (?, ?, ?, ?)',
      )
      .run(userId, 'gmail', accountId, Buffer.alloc(0));
    const id = Number(res.lastInsertRowid);
    const enc = encryptJson(credentials, keys, `destinations.credentials:${id}`);
    db.prepare('UPDATE destinations SET credentials_encrypted = ? WHERE id = ?').run(enc, id);
    return id;
  });
  return tx();
}

export type SeedSourceArgs = {
  userId: number;
  destinationId: number;
  keys: KeySet | Buffer;
  name?: string;
  type?: 'imap' | 'pop';
  host?: string;
  port?: number;
  useTls?: boolean;
  username?: string;
  password?: string;
  destinationTag?: string;
  pollIntervalSeconds?: number | null;
};

export function seedSource(db: Database.Database, args: SeedSourceArgs): number {
  const a = {
    name: 's1',
    type: 'pop' as const,
    host: 'h',
    port: 110,
    useTls: true,
    username: 'u',
    password: 'pw',
    destinationTag: 't',
    pollIntervalSeconds: 300 as number | null,
    ...args,
  };
  const tx = db.transaction((): number => {
    const res = db
      .prepare(
        'INSERT INTO sources (user_id, destination_id, name, type, host, port, use_tls, username, password_encrypted, destination_tag, poll_interval_seconds) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        a.userId,
        a.destinationId,
        a.name,
        a.type,
        a.host,
        a.port,
        a.useTls ? 1 : 0,
        a.username,
        Buffer.alloc(0),
        a.destinationTag,
        a.pollIntervalSeconds,
      );
    const id = Number(res.lastInsertRowid);
    const enc = encrypt(a.password, a.keys, `sources.password:${id}`);
    db.prepare('UPDATE sources SET password_encrypted = ? WHERE id = ?').run(enc, id);
    return id;
  });
  return tx();
}
