import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { hashPassword } from '../../src/auth/hash.ts';
import { closeTestApp, makeTestApp } from '../helpers/app.ts';
import {
  getGmailOAuthClient,
  setGmailOAuthClient,
} from '../../src/settings.ts';

async function seedUser(
  db: Database.Database,
  username: string,
  password: string,
  isAdmin: boolean,
): Promise<number> {
  const hash = await hashPassword(password);
  const r = db
    .prepare(
      'INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?) RETURNING id',
    )
    .get(username, hash, isAdmin ? 1 : 0) as { id: number };
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
  // Grab a fresh CSRF token for subsequent posts.
  const home = await app.inject({
    method: 'GET',
    url: '/',
    headers: { cookie, accept: 'text/html' },
  });
  const csrf = /name="_csrf" value="([^"]+)"/.exec(home.body)?.[1]!;
  return { cookie, csrf };
}

test('/admin/users rejects non-admin with 403', async () => {
  const ctx = await makeTestApp();
  try {
    await seedUser(ctx.db, 'user', 'pass1234', false);
    const { cookie } = await loginAs(ctx.app, 'user', 'pass1234');
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/admin/users',
      headers: { cookie },
    });
    assert.equal(res.statusCode, 403);
  } finally {
    await closeTestApp(ctx);
  }
});

test('/admin/users allows admin and lists users', async () => {
  const ctx = await makeTestApp();
  try {
    await seedUser(ctx.db, 'boss', 'admin1234', true);
    await seedUser(ctx.db, 'joe', 'joepass123', false);
    const { cookie } = await loginAs(ctx.app, 'boss', 'admin1234');
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/admin/users',
      headers: { cookie },
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /\bboss\b/);
    assert.match(res.body, /\bjoe\b/);
  } finally {
    await closeTestApp(ctx);
  }
});

test('admin cannot delete themselves via POST /admin/users/:id/delete', async () => {
  const ctx = await makeTestApp();
  try {
    const id = await seedUser(ctx.db, 'boss', 'admin1234', true);
    const { cookie, csrf } = await loginAs(ctx.app, 'boss', 'admin1234');
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/admin/users/${id}/delete`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: `_csrf=${encodeURIComponent(csrf)}`,
    });
    assert.equal(res.statusCode, 302);
    const still = ctx.db.prepare('SELECT id FROM users WHERE id = ?').get(id);
    assert.ok(still, 'self-user must still exist');
  } finally {
    await closeTestApp(ctx);
  }
});

test('admin can delete another user', async () => {
  const ctx = await makeTestApp();
  try {
    await seedUser(ctx.db, 'boss', 'admin1234', true);
    const victim = await seedUser(ctx.db, 'joe', 'pw', false);
    const { cookie, csrf } = await loginAs(ctx.app, 'boss', 'admin1234');
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/admin/users/${victim}/delete`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: `_csrf=${encodeURIComponent(csrf)}`,
    });
    assert.equal(res.statusCode, 302);
    const row = ctx.db.prepare('SELECT id FROM users WHERE id = ?').get(victim);
    assert.equal(row, undefined);
  } finally {
    await closeTestApp(ctx);
  }
});

test('admin POST without CSRF token is rejected', async () => {
  const ctx = await makeTestApp();
  try {
    await seedUser(ctx.db, 'boss', 'admin1234', true);
    const { cookie } = await loginAs(ctx.app, 'boss', 'admin1234');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/admin/users',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'username=sneaky',
    });
    assert.equal(res.statusCode, 403);
  } finally {
    await closeTestApp(ctx);
  }
});

test('GET /admin/destinations/gmail shows config UI for admin', async () => {
  const ctx = await makeTestApp();
  try {
    await seedUser(ctx.db, 'boss', 'admin1234', true);
    const { cookie } = await loginAs(ctx.app, 'boss', 'admin1234');
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/admin/destinations/gmail',
      headers: { cookie },
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /client_id/);
    assert.match(res.body, /client_secret/);
  } finally {
    await closeTestApp(ctx);
  }
});

test('GET /admin/destinations/gmail is 403 for non-admin', async () => {
  const ctx = await makeTestApp();
  try {
    await seedUser(ctx.db, 'user', 'pass1234', false);
    const { cookie } = await loginAs(ctx.app, 'user', 'pass1234');
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/admin/destinations/gmail',
      headers: { cookie },
    });
    assert.equal(res.statusCode, 403);
  } finally {
    await closeTestApp(ctx);
  }
});

test('POST /admin/destinations/gmail stores encrypted config and never echoes secret', async () => {
  const ctx = await makeTestApp();
  try {
    await seedUser(ctx.db, 'boss', 'admin1234', true);
    const { cookie, csrf } = await loginAs(ctx.app, 'boss', 'admin1234');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/admin/destinations/gmail',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: `_csrf=${encodeURIComponent(csrf)}&client_id=abc123.apps.googleusercontent.com&client_secret=super-secret-xxyy&redirect_uri=`,
    });
    assert.equal(res.statusCode, 302);

    const cfg = getGmailOAuthClient(ctx.db, ctx.cfg.encryptionKeys);
    assert.ok(cfg);
    assert.equal(cfg!.client_id, 'abc123.apps.googleusercontent.com');
    assert.equal(cfg!.client_secret, 'super-secret-xxyy');

    const raw = ctx.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get('gmail_oauth_client') as { value: string };
    assert.doesNotMatch(raw.value, /super-secret-xxyy/);

    const get = await ctx.app.inject({
      method: 'GET',
      url: '/admin/destinations/gmail',
      headers: { cookie },
    });
    assert.doesNotMatch(get.body, /super-secret-xxyy/);
    assert.match(get.body, /\.\.\.xxyy/);
  } finally {
    await closeTestApp(ctx);
  }
});

test('POST /admin/destinations/gmail with blank client_secret keeps the stored one', async () => {
  const ctx = await makeTestApp();
  try {
    await seedUser(ctx.db, 'boss', 'admin1234', true);
    setGmailOAuthClient(ctx.db, ctx.cfg.encryptionKeys, {
      client_id: 'old-cid.apps',
      client_secret: 'keep-this-secret',
      redirect_uri: 'http://localhost:3000/destinations/gmail/callback',
    });
    const { cookie, csrf } = await loginAs(ctx.app, 'boss', 'admin1234');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/admin/destinations/gmail',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        _csrf: csrf,
        client_id: 'new-cid.apps',
        client_secret: '',
        redirect_uri: 'http://localhost:3000/destinations/gmail/callback',
      }).toString(),
    });
    assert.equal(res.statusCode, 302);
    const cfg = getGmailOAuthClient(ctx.db, ctx.cfg.encryptionKeys);
    assert.ok(cfg);
    assert.equal(cfg!.client_id, 'new-cid.apps');
    assert.equal(cfg!.client_secret, 'keep-this-secret');
  } finally {
    await closeTestApp(ctx);
  }
});

test('POST /admin/destinations/gmail rejects first save without client_secret', async () => {
  const ctx = await makeTestApp();
  try {
    await seedUser(ctx.db, 'boss', 'admin1234', true);
    const { cookie, csrf } = await loginAs(ctx.app, 'boss', 'admin1234');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/admin/destinations/gmail',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        _csrf: csrf,
        client_id: 'cid.apps',
        client_secret: '',
      }).toString(),
    });
    assert.equal(res.statusCode, 302);
    assert.equal(getGmailOAuthClient(ctx.db, ctx.cfg.encryptionKeys), null);
  } finally {
    await closeTestApp(ctx);
  }
});

test('POST /admin/destinations/gmail/clear removes stored config', async () => {
  const ctx = await makeTestApp();
  try {
    await seedUser(ctx.db, 'boss', 'admin1234', true);
    setGmailOAuthClient(ctx.db, ctx.cfg.encryptionKeys, {
      client_id: 'cid',
      client_secret: 'sec',
    });
    const { cookie, csrf } = await loginAs(ctx.app, 'boss', 'admin1234');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/admin/destinations/gmail/clear',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: `_csrf=${encodeURIComponent(csrf)}`,
    });
    assert.equal(res.statusCode, 302);
    assert.equal(getGmailOAuthClient(ctx.db, ctx.cfg.encryptionKeys), null);
  } finally {
    await closeTestApp(ctx);
  }
});
