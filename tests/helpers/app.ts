import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.ts';
import { openDb, type Db } from '../../src/db/index.ts';
import type { Config } from '../../src/config.ts';

export type TestContext = {
  app: FastifyInstance;
  db: Db;
  cfg: Config;
};

export async function makeTestApp(
  overrides: Partial<Config> = {},
): Promise<TestContext> {
  const db = openDb(':memory:');
  const key = randomBytes(32);
  const cfg: Config = {
    NODE_ENV: 'test',
    APP_PORT: 0,
    APP_HOST: '127.0.0.1',
    APP_DATABASE_PATH: ':memory:',
    APP_ENCRYPTION_KEY: key.toString('base64'),
    APP_SESSION_SECRET: 'a'.repeat(32),
    APP_TRUST_PROXY: '',
    APP_COOKIE_SECURE: 'auto',
    APP_EVENT_LOG_MAX_ROWS: 10_000,
    APP_ALLOW_PRIVATE_SOURCES: '1',
    encryptionKey: key,
    encryptionKeys: { primary: key },
    keyProviderName: 'test',
    ...overrides,
  };
  const app = await buildApp(cfg, db);
  // Tests don't hit a real IMAP/POP server by default; individual tests can
  // reassign `app.testConnection` to exercise error paths.
  app.testConnection = async () => ({ ok: true });
  return { app, db, cfg };
}

export async function closeTestApp(ctx: TestContext): Promise<void> {
  await ctx.app.close();
  ctx.db.close();
}

export function sessionCookie(res: { cookies: Array<{ name: string; value: string }> }): string | undefined {
  const c = res.cookies.find((x) => x.name === 'mailsluice.sid');
  return c ? `${c.name}=${c.value}` : undefined;
}
