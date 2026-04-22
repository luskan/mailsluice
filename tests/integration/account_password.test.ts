import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { hashPassword, verifyPassword } from '../../src/auth/hash.ts';
import { closeTestApp, makeTestApp } from '../helpers/app.ts';

async function seedUser(
  db: Database.Database,
  username: string,
  password: string,
): Promise<number> {
  const hash = await hashPassword(password);
  const r = db
    .prepare(
      'INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, 0) RETURNING id',
    )
    .get(username, hash) as { id: number };
  return r.id;
}

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
): Promise<{ cookie: string; csrf: string }> {
  const get = await app.inject({ method: 'GET', url: '/login' });
  const preCookie = pickCookie(get.headers, 'mailsluice.sid')!;
  const preCsrf = /name="_csrf" value="([^"]+)"/.exec(get.body)?.[1]!;
  const post = await app.inject({
    method: 'POST',
    url: '/login',
    headers: { cookie: preCookie, 'content-type': 'application/x-www-form-urlencoded' },
    payload: `_csrf=${encodeURIComponent(preCsrf)}&username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`,
  });
  const cookie = pickCookie(post.headers, 'mailsluice.sid')!;
  const page = await app.inject({
    method: 'GET',
    url: '/account/password',
    headers: { cookie, accept: 'text/html' },
  });
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page.body)?.[1]!;
  return { cookie, csrf };
}

const CURRENT = 'correct-horse-battery-staple';

test('GET /account/password anonymous -> /login', async () => {
  const ctx = await makeTestApp();
  try {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/account/password',
      headers: { accept: 'text/html' },
    });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/login');
  } finally {
    await closeTestApp(ctx);
  }
});

test('POST /account/password without CSRF is 403', async () => {
  const ctx = await makeTestApp();
  try {
    await seedUser(ctx.db, 'alice', CURRENT);
    const { cookie } = await loginAs(ctx.app, 'alice', CURRENT);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/account/password',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'nope=1',
    });
    assert.equal(res.statusCode, 403);
  } finally {
    await closeTestApp(ctx);
  }
});

test('wrong current password rejected without changing the hash', async () => {
  const ctx = await makeTestApp();
  try {
    const uid = await seedUser(ctx.db, 'alice', CURRENT);
    const { cookie, csrf } = await loginAs(ctx.app, 'alice', CURRENT);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/account/password',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        _csrf: csrf,
        current_password: 'wrong-one-here',
        new_password: 'long-enough-and-varied-42',
        confirm_password: 'long-enough-and-varied-42',
      }).toString(),
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /Current password is incorrect/);
    const row = ctx.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(uid) as { password_hash: string };
    assert.equal(await verifyPassword(row.password_hash, CURRENT), true);
  } finally {
    await closeTestApp(ctx);
  }
});

test('mismatched confirmation rejected', async () => {
  const ctx = await makeTestApp();
  try {
    await seedUser(ctx.db, 'alice', CURRENT);
    const { cookie, csrf } = await loginAs(ctx.app, 'alice', CURRENT);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/account/password',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        _csrf: csrf,
        current_password: CURRENT,
        new_password: 'long-enough-and-varied-42',
        confirm_password: 'long-enough-and-varied-43',
      }).toString(),
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /do not match/);
  } finally {
    await closeTestApp(ctx);
  }
});

test('weak new password rejected by policy', async () => {
  const ctx = await makeTestApp();
  try {
    await seedUser(ctx.db, 'alice', CURRENT);
    const { cookie, csrf } = await loginAs(ctx.app, 'alice', CURRENT);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/account/password',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        _csrf: csrf,
        current_password: CURRENT,
        new_password: 'short',
        confirm_password: 'short',
      }).toString(),
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /at least/);
  } finally {
    await closeTestApp(ctx);
  }
});

test('common password rejected', async () => {
  const ctx = await makeTestApp();
  try {
    await seedUser(ctx.db, 'alice', CURRENT);
    const { cookie, csrf } = await loginAs(ctx.app, 'alice', CURRENT);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/account/password',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        _csrf: csrf,
        current_password: CURRENT,
        new_password: 'changeme1234',
        confirm_password: 'changeme1234',
      }).toString(),
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /common/);
  } finally {
    await closeTestApp(ctx);
  }
});

test('happy path: changes password, rotates session, keeps user logged in', async () => {
  const ctx = await makeTestApp();
  try {
    const uid = await seedUser(ctx.db, 'alice', CURRENT);
    const { cookie, csrf } = await loginAs(ctx.app, 'alice', CURRENT);
    const newPw = 'vault-42-lobster-dance-umbrella';
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/account/password',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        _csrf: csrf,
        current_password: CURRENT,
        new_password: newPw,
        confirm_password: newPw,
      }).toString(),
    });
    assert.equal(res.statusCode, 302);

    // Session ID rotated.
    const newCookie = pickCookie(res.headers, 'mailsluice.sid')!;
    assert.notEqual(newCookie, cookie);

    // Old password no longer works.
    const oldRow = ctx.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(uid) as { password_hash: string };
    assert.equal(await verifyPassword(oldRow.password_hash, CURRENT), false);
    assert.equal(await verifyPassword(oldRow.password_hash, newPw), true);

    // Old session cookie is invalid post-regenerate.
    const replay = await ctx.app.inject({
      method: 'GET',
      url: '/',
      headers: { cookie, accept: 'text/html' },
    });
    assert.equal(replay.statusCode, 302);
    assert.equal(replay.headers.location, '/login');

    // New session still authenticated.
    const home = await ctx.app.inject({
      method: 'GET',
      url: '/',
      headers: { cookie: newCookie, accept: 'text/html' },
    });
    assert.equal(home.statusCode, 200);
  } finally {
    await closeTestApp(ctx);
  }
});

test('new password equal to current is rejected', async () => {
  const ctx = await makeTestApp();
  try {
    await seedUser(ctx.db, 'alice', CURRENT);
    const { cookie, csrf } = await loginAs(ctx.app, 'alice', CURRENT);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/account/password',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        _csrf: csrf,
        current_password: CURRENT,
        new_password: CURRENT,
        confirm_password: CURRENT,
      }).toString(),
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /differ/);
  } finally {
    await closeTestApp(ctx);
  }
});
