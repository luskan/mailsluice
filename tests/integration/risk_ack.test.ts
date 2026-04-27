import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword } from '../../src/auth/hash.ts';
import { closeTestApp, makeTestApp } from '../helpers/app.ts';
import { RISK_ACK_VERSION } from '../../src/risk_ack.ts';

const PASS = 'correct-horse-battery-staple';

function pickCookie(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const raw = headers['set-cookie'];
  if (!raw) return undefined;
  const list = Array.isArray(raw) ? raw : [raw];
  for (const line of list) {
    const m = new RegExp(`^${name}=([^;]+)`).exec(line);
    if (m) return `${name}=${m[1]}`;
  }
  return undefined;
}

async function loginAs(
  app: Awaited<ReturnType<typeof makeTestApp>>['app'],
  username: string,
  password: string,
): Promise<string> {
  const get = await app.inject({ method: 'GET', url: '/login' });
  const preCookie = pickCookie(get.headers, 'mailsluice.sid')!;
  const csrf = /name="_csrf" value="([^"]+)"/.exec(get.body)?.[1]!;
  const post = await app.inject({
    method: 'POST',
    url: '/login',
    headers: { cookie: preCookie, 'content-type': 'application/x-www-form-urlencoded' },
    payload: `_csrf=${encodeURIComponent(csrf)}&username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`,
  });
  return pickCookie(post.headers, 'mailsluice.sid')!;
}

async function seedUnacked(db: Awaited<ReturnType<typeof makeTestApp>>['db']): Promise<void> {
  const hash = await hashPassword(PASS);
  db.prepare(
    'INSERT INTO users (username, password_hash, is_admin, risk_acked_version) VALUES (?, ?, 0, NULL)',
  ).run('alice', hash);
}

test('un-acked user is redirected to /acknowledge from /', async () => {
  const ctx = await makeTestApp({ NODE_ENV: 'production' });
  try {
    await seedUnacked(ctx.db);
    const cookie = await loginAs(ctx.app, 'alice', PASS);
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/',
      headers: { cookie, accept: 'text/html' },
    });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/acknowledge');
  } finally {
    await closeTestApp(ctx);
  }
});

test('acknowledge page renders for logged-in user', async () => {
  const ctx = await makeTestApp({ NODE_ENV: 'production' });
  try {
    await seedUnacked(ctx.db);
    const cookie = await loginAs(ctx.app, 'alice', PASS);
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/acknowledge',
      headers: { cookie, accept: 'text/html' },
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /Beta/i);
    assert.match(res.body, /Delete from source/);
    assert.match(res.body, /name="_csrf"/);
  } finally {
    await closeTestApp(ctx);
  }
});

test('POST /acknowledge clears the gate', async () => {
  const ctx = await makeTestApp({ NODE_ENV: 'production' });
  try {
    await seedUnacked(ctx.db);
    const cookie = await loginAs(ctx.app, 'alice', PASS);
    const ack = await ctx.app.inject({
      method: 'GET',
      url: '/acknowledge',
      headers: { cookie, accept: 'text/html' },
    });
    const csrf = /name="_csrf" value="([^"]+)"/.exec(ack.body)?.[1]!;
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/acknowledge',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: `_csrf=${encodeURIComponent(csrf)}`,
    });
    assert.equal(post.statusCode, 302);
    assert.equal(post.headers.location, '/');

    const row = ctx.db
      .prepare('SELECT risk_acked_version FROM users WHERE username = ?')
      .get('alice') as { risk_acked_version: string };
    assert.equal(row.risk_acked_version, RISK_ACK_VERSION);

    const home = await ctx.app.inject({
      method: 'GET',
      url: '/',
      headers: { cookie, accept: 'text/html' },
    });
    assert.equal(home.statusCode, 200);
  } finally {
    await closeTestApp(ctx);
  }
});

test('logout is reachable without acknowledging', async () => {
  const ctx = await makeTestApp({ NODE_ENV: 'production' });
  try {
    await seedUnacked(ctx.db);
    const cookie = await loginAs(ctx.app, 'alice', PASS);
    const get = await ctx.app.inject({
      method: 'GET',
      url: '/acknowledge',
      headers: { cookie, accept: 'text/html' },
    });
    const csrf = /name="_csrf" value="([^"]+)"/.exec(get.body)?.[1]!;
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/logout',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: `_csrf=${encodeURIComponent(csrf)}`,
    });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/login');
  } finally {
    await closeTestApp(ctx);
  }
});
