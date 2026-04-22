import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { hashPassword } from '../../src/auth/hash.ts';
import { closeTestApp, makeTestApp } from '../helpers/app.ts';
import { seedDestination as seedDestinationHelper, seedSource } from '../helpers/seed.ts';
import type { KeySet } from '../../src/crypto.ts';

async function seedUser(
  db: Database.Database,
  username: string,
  password: string,
  isAdmin = false,
): Promise<number> {
  const hash = await hashPassword(password);
  const r = db
    .prepare(
      'INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?) RETURNING id',
    )
    .get(username, hash, isAdmin ? 1 : 0) as { id: number };
  return r.id;
}

function seedDestination(
  db: Database.Database,
  userId: number,
  keys: KeySet | Buffer,
  accountId = 'user@x.com',
): number {
  return seedDestinationHelper(db, userId, keys, accountId);
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
    url: '/sources',
    headers: { cookie, accept: 'text/html' },
  });
  const csrf = /name="_csrf" value="([^"]+)"/.exec(home.body)?.[1]!;
  return { cookie, csrf };
}

test('anonymous GET /sources -> /login', async () => {
  const ctx = await makeTestApp();
  try {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/sources',
      headers: { accept: 'text/html' },
    });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/login');
  } finally {
    await closeTestApp(ctx);
  }
});

test('create POP source happy path', async () => {
  const ctx = await makeTestApp();
  try {
    const uid = await seedUser(ctx.db, 'u', 'pw');
    const did = seedDestination(ctx.db, uid, ctx.cfg.encryptionKeys);
    const { cookie, csrf } = await loginAs(ctx.app, 'u', 'pw');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/sources',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        _csrf: csrf,
        name: 'yahoo',
        type: 'pop',
        host: 'pop.yahoo.com',
        port: '995',
        use_tls: '1',
        username: 'me@yahoo.com',
        password: 'hunter2',
        destination_id: String(did),
        destination_tag: 'External/Yahoo',
        poll_interval_seconds: '600',
      }).toString(),
    });
    assert.equal(res.statusCode, 302);
    const rows = ctx.db.prepare('SELECT id, name, host, username FROM sources').all() as Array<{
      id: number; name: string; host: string; username: string;
    }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.name, 'yahoo');
    assert.equal(rows[0]!.host, 'pop.yahoo.com');
  } finally {
    await closeTestApp(ctx);
  }
});

test('cannot attach source to another user\'s destination', async () => {
  const ctx = await makeTestApp();
  try {
    const me = await seedUser(ctx.db, 'u', 'pw');
    const other = await seedUser(ctx.db, 'other', 'pw');
    const otherDest = seedDestination(ctx.db, other, ctx.cfg.encryptionKeys, 'other@x');
    const { cookie, csrf } = await loginAs(ctx.app, 'u', 'pw');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/sources',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        _csrf: csrf,
        name: 'steal',
        type: 'pop',
        host: 'x',
        port: '110',
        username: 'a',
        password: 'b',
        destination_id: String(otherDest),
        destination_tag: 't',
      }).toString(),
    });
    assert.equal(res.statusCode, 302);
    const count = ctx.db
      .prepare('SELECT COUNT(*) AS n FROM sources WHERE user_id = ?')
      .get(me) as { n: number };
    assert.equal(count.n, 0);
  } finally {
    await closeTestApp(ctx);
  }
});

test('GET /sources/:id 404 for another user\'s source', async () => {
  const ctx = await makeTestApp();
  try {
    await seedUser(ctx.db, 'u', 'pw');
    const other = await seedUser(ctx.db, 'other', 'pw');
    const otherDest = seedDestination(ctx.db, other, ctx.cfg.encryptionKeys, 'other@x');
    const rId = seedSource(ctx.db, {
      userId: other,
      destinationId: otherDest,
      keys: ctx.cfg.encryptionKeys,
      name: 'x',
    });
    const { cookie } = await loginAs(ctx.app, 'u', 'pw');
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/sources/${rId}`,
      headers: { cookie },
    });
    assert.equal(res.statusCode, 404);
  } finally {
    await closeTestApp(ctx);
  }
});

test('delete source requires CSRF', async () => {
  const ctx = await makeTestApp();
  try {
    const uid = await seedUser(ctx.db, 'u', 'pw');
    const did = seedDestination(ctx.db, uid, ctx.cfg.encryptionKeys);
    const rId = seedSource(ctx.db, { userId: uid, destinationId: did, keys: ctx.cfg.encryptionKeys });
    const { cookie } = await loginAs(ctx.app, 'u', 'pw');
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/sources/${rId}/delete`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'a=1',
    });
    assert.equal(res.statusCode, 403);
  } finally {
    await closeTestApp(ctx);
  }
});

test('CSRF-rejected JSON POST (content-type independence)', async () => {
  const ctx = await makeTestApp();
  try {
    const uid = await seedUser(ctx.db, 'u', 'pw');
    seedDestination(ctx.db, uid, ctx.cfg.encryptionKeys);
    const { cookie } = await loginAs(ctx.app, 'u', 'pw');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/sources',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'x' }),
    });
    assert.equal(res.statusCode, 403);
  } finally {
    await closeTestApp(ctx);
  }
});

test('POST /sources/test without CSRF is rejected', async () => {
  const ctx = await makeTestApp();
  try {
    await seedUser(ctx.db, 'u', 'pw');
    const { cookie } = await loginAs(ctx.app, 'u', 'pw');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/sources/test',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'a=1',
    });
    assert.equal(res.statusCode, 403);
  } finally {
    await closeTestApp(ctx);
  }
});

test('POST /sources/test returns {ok:true} when testConnection succeeds', async () => {
  const ctx = await makeTestApp();
  try {
    await seedUser(ctx.db, 'u', 'pw');
    const { cookie, csrf } = await loginAs(ctx.app, 'u', 'pw');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/sources/test',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        _csrf: csrf,
        type: 'pop',
        host: 'pop.example.com',
        port: '995',
        use_tls: '1',
        username: 'me',
        password: 'pw',
      }).toString(),
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true });
  } finally {
    await closeTestApp(ctx);
  }
});

test('POST /sources/test surfaces failure from app.testConnection', async () => {
  const ctx = await makeTestApp();
  try {
    await seedUser(ctx.db, 'u', 'pw');
    ctx.app.testConnection = async () => ({ ok: false, error: 'auth failed' });
    const { cookie, csrf } = await loginAs(ctx.app, 'u', 'pw');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/sources/test',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        _csrf: csrf,
        type: 'imap',
        host: 'imap.x',
        port: '993',
        use_tls: '1',
        username: 'a',
        password: 'b',
      }).toString(),
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'auth failed' });
  } finally {
    await closeTestApp(ctx);
  }
});

test('POST /sources/test without password asks for one (new-source case)', async () => {
  const ctx = await makeTestApp();
  try {
    await seedUser(ctx.db, 'u', 'pw');
    const { cookie, csrf } = await loginAs(ctx.app, 'u', 'pw');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/sources/test',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        _csrf: csrf,
        type: 'imap',
        host: 'imap.x',
        port: '993',
        use_tls: '1',
        username: 'a',
      }).toString(),
    });
    const body = JSON.parse(res.body) as { ok: boolean; error?: string };
    assert.equal(body.ok, false);
    assert.match(body.error ?? '', /password/i);
  } finally {
    await closeTestApp(ctx);
  }
});

test('POST /sources/test with source_id falls back to stored password (edit case)', async () => {
  const ctx = await makeTestApp();
  try {
    const uid = await seedUser(ctx.db, 'u', 'pw');
    const did = seedDestination(ctx.db, uid, ctx.cfg.encryptionKeys);
    const srcId = seedSource(ctx.db, {
      userId: uid, destinationId: did, keys: ctx.cfg.encryptionKeys,
      password: 'stored-password',
    });

    let capturedPassword = '';
    ctx.app.testConnection = async (a) => {
      capturedPassword = a.password;
      return { ok: true };
    };

    const { cookie, csrf } = await loginAs(ctx.app, 'u', 'pw');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/sources/test',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        _csrf: csrf,
        source_id: String(srcId),
        type: 'pop',
        host: 'h',
        port: '110',
        use_tls: '1',
        username: 'u',
      }).toString(),
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true });
    assert.equal(capturedPassword, 'stored-password');
  } finally {
    await closeTestApp(ctx);
  }
});

test('POST /sources/test with foreign source_id does not leak stored password', async () => {
  const ctx = await makeTestApp();
  try {
    await seedUser(ctx.db, 'u', 'pw');
    const other = await seedUser(ctx.db, 'other', 'pw');
    const otherDest = seedDestination(ctx.db, other, ctx.cfg.encryptionKeys, 'other@x');
    const srcId = seedSource(ctx.db, {
      userId: other, destinationId: otherDest, keys: ctx.cfg.encryptionKeys,
      password: 'secret',
    });

    let capturedPassword = '<not-called>';
    ctx.app.testConnection = async (a) => {
      capturedPassword = a.password;
      return { ok: true };
    };

    const { cookie, csrf } = await loginAs(ctx.app, 'u', 'pw');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/sources/test',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        _csrf: csrf,
        source_id: String(srcId),
        type: 'pop',
        host: 'h',
        port: '110',
        use_tls: '1',
        username: 'u',
      }).toString(),
    });
    const body = JSON.parse(res.body) as { ok: boolean; error?: string };
    assert.equal(body.ok, false);
    assert.match(body.error ?? '', /password/i);
    assert.equal(capturedPassword, '<not-called>');
  } finally {
    await closeTestApp(ctx);
  }
});

test('toggle enable/disable flips the flag', async () => {
  const ctx = await makeTestApp();
  try {
    const uid = await seedUser(ctx.db, 'u', 'pw');
    const did = seedDestination(ctx.db, uid, ctx.cfg.encryptionKeys);
    const rId = seedSource(ctx.db, { userId: uid, destinationId: did, keys: ctx.cfg.encryptionKeys });
    const { cookie, csrf } = await loginAs(ctx.app, 'u', 'pw');
    await ctx.app.inject({
      method: 'POST',
      url: `/sources/${rId}/toggle`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: `_csrf=${encodeURIComponent(csrf)}`,
    });
    const after = ctx.db
      .prepare('SELECT enabled FROM sources WHERE id = ?')
      .get(rId) as { enabled: number };
    assert.equal(after.enabled, 0);
  } finally {
    await closeTestApp(ctx);
  }
});
