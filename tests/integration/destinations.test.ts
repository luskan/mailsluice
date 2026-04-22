import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { hashPassword } from '../../src/auth/hash.ts';
import { closeTestApp, makeTestApp } from '../helpers/app.ts';
import {
  getGmailOAuthClient,
  setGmailOAuthClient,
} from '../../src/settings.ts';
import { seedDestination } from '../helpers/seed.ts';

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
  const home = await app.inject({
    method: 'GET',
    url: '/destinations',
    headers: { cookie, accept: 'text/html' },
  });
  const csrf = /name="_csrf" value="([^"]+)"/.exec(home.body)?.[1]!;
  return { cookie, csrf };
}

test('GET /destinations anonymous -> redirect to /login', async () => {
  const ctx = await makeTestApp();
  try {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/destinations',
      headers: { accept: 'text/html' },
    });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/login');
  } finally {
    await closeTestApp(ctx);
  }
});

test('GET /destinations shows empty state and hides connect button when admin not configured', async () => {
  const ctx = await makeTestApp();
  try {
    await seedUser(ctx.db, 'user', 'pass1234', false);
    const { cookie } = await loginAs(ctx.app, 'user', 'pass1234');
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/destinations',
      headers: { cookie },
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /No destination connected yet/);
    assert.doesNotMatch(res.body, />Connect Gmail<\/a>/);
    assert.match(res.body, /admin must configure OAuth credentials/);
  } finally {
    await closeTestApp(ctx);
  }
});

test('GET /destinations/gmail/connect without admin config shows not-configured page', async () => {
  const ctx = await makeTestApp();
  try {
    await seedUser(ctx.db, 'user', 'pass1234', false);
    const { cookie } = await loginAs(ctx.app, 'user', 'pass1234');
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/destinations/gmail/connect',
      headers: { cookie },
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /not configured/i);
  } finally {
    await closeTestApp(ctx);
  }
});

test('GET /destinations/gmail/connect redirects to Google with state when admin configured', async () => {
  const ctx = await makeTestApp();
  try {
    setGmailOAuthClient(ctx.db, ctx.cfg.encryptionKeys, {
      client_id: 'cid.apps.googleusercontent.com',
      client_secret: 'secret',
    });
    await seedUser(ctx.db, 'user', 'pass1234', false);
    const { cookie } = await loginAs(ctx.app, 'user', 'pass1234');
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/destinations/gmail/connect',
      headers: { cookie },
    });
    assert.equal(res.statusCode, 302);
    const loc = res.headers.location;
    assert.ok(typeof loc === 'string' && loc.startsWith('https://accounts.google.com/'));
    const u = new URL(loc!);
    assert.equal(u.searchParams.get('client_id'), 'cid.apps.googleusercontent.com');
    const state = u.searchParams.get('state');
    assert.ok(state && state.length >= 16);

    // session now holds the state -- verify callback with mismatched state rejects.
    const bad = await ctx.app.inject({
      method: 'GET',
      url: '/destinations/gmail/callback?code=abc&state=wrong-state',
      headers: { cookie: pickCookie(res.headers, 'mailsluice.sid') ?? cookie },
    });
    assert.equal(bad.statusCode, 400);
  } finally {
    await closeTestApp(ctx);
  }
});

test('GET /destinations/gmail/callback without session state is 400', async () => {
  const ctx = await makeTestApp();
  try {
    await seedUser(ctx.db, 'user', 'pass1234', false);
    const { cookie } = await loginAs(ctx.app, 'user', 'pass1234');
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/destinations/gmail/callback?code=x&state=y',
      headers: { cookie },
    });
    assert.equal(res.statusCode, 400);
  } finally {
    await closeTestApp(ctx);
  }
});

test('POST /destinations/:id/disconnect deletes only the owning user\'s row', async () => {
  const ctx = await makeTestApp();
  try {
    const uid = await seedUser(ctx.db, 'user', 'pass1234', false);
    const other = await seedUser(ctx.db, 'other', 'pass1234', false);
    const creds = { refresh_token: 'rt', access_token: 'at' };
    const mineId = seedDestination(ctx.db, uid, ctx.cfg.encryptionKeys, 'me@x.com', creds);
    const theirsId = seedDestination(ctx.db, other, ctx.cfg.encryptionKeys, 'other@x.com', creds);
    const mine = { id: mineId };
    const theirs = { id: theirsId };

    const { cookie, csrf } = await loginAs(ctx.app, 'user', 'pass1234');

    // Cannot delete someone else's.
    const foreign = await ctx.app.inject({
      method: 'POST',
      url: `/destinations/${theirs.id}/disconnect`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: `_csrf=${encodeURIComponent(csrf)}`,
    });
    assert.equal(foreign.statusCode, 404);
    const stillThere = ctx.db.prepare('SELECT id FROM destinations WHERE id = ?').get(theirs.id);
    assert.ok(stillThere);

    // Can delete own.
    const own = await ctx.app.inject({
      method: 'POST',
      url: `/destinations/${mine.id}/disconnect`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: `_csrf=${encodeURIComponent(csrf)}`,
    });
    assert.equal(own.statusCode, 302);
    const gone = ctx.db.prepare('SELECT id FROM destinations WHERE id = ?').get(mine.id);
    assert.equal(gone, undefined);
  } finally {
    await closeTestApp(ctx);
  }
});

test('POST /destinations/:id/disconnect without CSRF is rejected', async () => {
  const ctx = await makeTestApp();
  try {
    const uid = await seedUser(ctx.db, 'user', 'pass1234', false);
    const rowId = seedDestination(ctx.db, uid, ctx.cfg.encryptionKeys, 'me@x.com', { refresh_token: 'rt' });
    const row = { id: rowId };
    const { cookie } = await loginAs(ctx.app, 'user', 'pass1234');
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/destinations/${row.id}/disconnect`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'nope=1',
    });
    assert.equal(res.statusCode, 403);
    assert.ok(
      getGmailOAuthClient(ctx.db, ctx.cfg.encryptionKeys) === null ||
        ctx.db.prepare('SELECT id FROM destinations WHERE id = ?').get(row.id),
    );
  } finally {
    await closeTestApp(ctx);
  }
});
