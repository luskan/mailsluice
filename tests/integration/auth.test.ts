import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword } from '../../src/auth/hash.ts';
import { buildApp } from '../../src/app.ts';
import { closeTestApp, makeTestApp } from '../helpers/app.ts';

async function seedUser(
  db: import('better-sqlite3').Database,
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

async function getLoginTokenAndCookie(app: Awaited<ReturnType<typeof makeTestApp>>['app']) {
  const res = await app.inject({ method: 'GET', url: '/login' });
  const cookie = pickCookie(res.headers, 'mailsluice.sid');
  const token = /name="_csrf" value="([^"]+)"/.exec(res.body)?.[1];
  assert.ok(cookie, 'expected session cookie');
  assert.ok(token, 'expected csrf token in form');
  return { cookie: cookie!, token: token! };
}

test('GET / redirects anonymous users to /login', async () => {
  const ctx = await makeTestApp();
  try {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/',
      headers: { accept: 'text/html' },
    });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/login');
  } finally {
    await closeTestApp(ctx);
  }
});

test('POST /login without CSRF token is rejected', async () => {
  const ctx = await makeTestApp();
  try {
    await seedUser(ctx.db, 'u1', 'hunter2!');
    const { cookie } = await getLoginTokenAndCookie(ctx.app);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/login',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'username=u1&password=hunter2!',
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().code, 'FST_CSRF_INVALID_TOKEN');
  } finally {
    await closeTestApp(ctx);
  }
});

test('a login form opened before a restart recovers without authenticating the stale submission', async () => {
  const ctx = await makeTestApp();
  try {
    await seedUser(ctx.db, 'u1', 'hunter2!');
    const { cookie, token } = await getLoginTokenAndCookie(ctx.app);

    // The database and signing secret survive a restart; the session store does not.
    await ctx.app.close();
    ctx.app = await buildApp(ctx.cfg, ctx.db);
    const stale = await ctx.app.inject({
      method: 'POST',
      url: '/login',
      headers: { cookie, accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ _csrf: token, username: 'u1', password: 'hunter2!' }).toString(),
    });
    assert.equal(stale.statusCode, 403);
    assert.match(String(stale.headers['content-type']), /text\/html/);
    assert.equal(stale.headers['cache-control'], 'no-store');
    assert.match(stale.body, /sign-in form expired or your session cookie is missing/i);
    assert.doesNotMatch(stale.body, /hunter2!/);

    const recoveryCookie = pickCookie(stale.headers, 'mailsluice.sid');
    const recoveryToken = /name="_csrf" value="([^"]+)"/.exec(stale.body)?.[1];
    assert.ok(recoveryCookie, 'recovery must issue a new session cookie');
    assert.ok(recoveryToken, 'recovery must issue a fresh csrf token');
    assert.notEqual(recoveryCookie, cookie);
    const anonymous = await ctx.app.inject({
      url: '/', headers: { cookie: recoveryCookie, accept: 'text/html' },
    });
    assert.equal(anonymous.statusCode, 302);
    assert.equal(anonymous.headers.location, '/login');

    const retry = await ctx.app.inject({
      method: 'POST',
      url: '/login',
      headers: { cookie: recoveryCookie, accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ _csrf: recoveryToken, username: 'u1', password: 'hunter2!' }).toString(),
    });
    assert.equal(retry.statusCode, 302);
    assert.equal(retry.headers.location, '/');
    const loggedInCookie = pickCookie(retry.headers, 'mailsluice.sid');
    assert.ok(loggedInCookie);
    const home = await ctx.app.inject({
      url: '/', headers: { cookie: loggedInCookie, accept: 'text/html' },
    });
    assert.equal(home.statusCode, 200);
    assert.match(home.body, /Welcome, u1/);
  } finally {
    await closeTestApp(ctx);
  }
});

test('browser login with a missing or mismatched CSRF token returns a fresh form and stays anonymous', async () => {
  const ctx = await makeTestApp();
  try {
    await seedUser(ctx.db, 'u1', 'hunter2!');
    const { token: otherSessionToken } = await getLoginTokenAndCookie(ctx.app);
    for (const token of ['', otherSessionToken]) {
      const { cookie } = await getLoginTokenAndCookie(ctx.app);
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/login',
        headers: { cookie, accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ _csrf: token, username: 'u1', password: 'hunter2!' }).toString(),
      });
      assert.equal(res.statusCode, 403);
      assert.match(String(res.headers['content-type']), /text\/html/);
      assert.ok(/name="_csrf" value="([^"]+)"/.exec(res.body)?.[1]);
      const home = await ctx.app.inject({
        url: '/', headers: { cookie, accept: 'text/html' },
      });
      assert.equal(home.statusCode, 302);
      assert.equal(home.headers.location, '/login');
    }
  } finally {
    await closeTestApp(ctx);
  }
});

test('login without a session keeps the CSRF JSON error for non-browser clients', async () => {
  const ctx = await makeTestApp();
  try {
    const res = await ctx.app.inject({
      method: 'POST', url: '/login', headers: { accept: 'application/json' },
      payload: { username: 'u1', password: 'hunter2!', _csrf: 'stale' },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().code, 'FST_CSRF_MISSING_SECRET');
  } finally {
    await closeTestApp(ctx);
  }
});

test('POST /login with CSRF token and good creds establishes session', async () => {
  const ctx = await makeTestApp();
  try {
    const uid = await seedUser(ctx.db, 'u1', 'hunter2!');
    const { cookie, token } = await getLoginTokenAndCookie(ctx.app);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/login',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: `_csrf=${encodeURIComponent(token)}&username=u1&password=${encodeURIComponent('hunter2!')}`,
    });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/');

    const newCookie = pickCookie(res.headers, 'mailsluice.sid');
    assert.ok(newCookie, 'expected session cookie on successful login');
    assert.notEqual(newCookie, cookie, 'session id must rotate on login');

    const home = await ctx.app.inject({
      method: 'GET',
      url: '/',
      headers: { cookie: newCookie!, accept: 'text/html' },
    });
    assert.equal(home.statusCode, 200);
    assert.match(home.body, new RegExp(`Welcome, u1`));
    assert.equal(uid > 0, true);
  } finally {
    await closeTestApp(ctx);
  }
});

test('POST /login with wrong password returns 401 and no session', async () => {
  const ctx = await makeTestApp();
  try {
    await seedUser(ctx.db, 'u1', 'hunter2!');
    const { cookie, token } = await getLoginTokenAndCookie(ctx.app);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/login',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: `_csrf=${encodeURIComponent(token)}&username=u1&password=wrong`,
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.match(res.body, /Invalid username or password/);

    const home = await ctx.app.inject({
      method: 'GET',
      url: '/',
      headers: { cookie, accept: 'text/html' },
    });
    assert.equal(home.statusCode, 302);
    assert.equal(home.headers.location, '/login');
  } finally {
    await closeTestApp(ctx);
  }
});

test('POST /login with unknown user returns 401 and does not crash', async () => {
  const ctx = await makeTestApp();
  try {
    const { cookie, token } = await getLoginTokenAndCookie(ctx.app);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/login',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: `_csrf=${encodeURIComponent(token)}&username=nobody&password=x`,
    });
    assert.equal(res.statusCode, 401);
  } finally {
    await closeTestApp(ctx);
  }
});

test('logout destroys session: replayed cookie is rejected server-side', async () => {
  const ctx = await makeTestApp();
  try {
    await seedUser(ctx.db, 'u1', 'hunter2!');
    const { cookie, token } = await getLoginTokenAndCookie(ctx.app);
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/login',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: `_csrf=${encodeURIComponent(token)}&username=u1&password=${encodeURIComponent('hunter2!')}`,
    });
    const loggedIn = pickCookie(login.headers, 'mailsluice.sid')!;

    // Get a new CSRF token while logged in.
    const homeRes = await ctx.app.inject({
      method: 'GET',
      url: '/',
      headers: { cookie: loggedIn, accept: 'text/html' },
    });
    const logoutToken = /name="_csrf" value="([^"]+)"/.exec(homeRes.body)?.[1];
    assert.ok(logoutToken, 'home page must expose a csrf token for logout');

    const logout = await ctx.app.inject({
      method: 'POST',
      url: '/logout',
      headers: { cookie: loggedIn, 'content-type': 'application/x-www-form-urlencoded' },
      payload: `_csrf=${encodeURIComponent(logoutToken!)}`,
    });
    assert.equal(logout.statusCode, 302);

    const replay = await ctx.app.inject({
      method: 'GET',
      url: '/',
      headers: { cookie: loggedIn, accept: 'text/html' },
    });
    assert.equal(replay.statusCode, 302);
    assert.equal(replay.headers.location, '/login');
  } finally {
    await closeTestApp(ctx);
  }
});

test('login is rate-limited on repeated failures for same (username, ip)', async () => {
  const ctx = await makeTestApp();
  try {
    await seedUser(ctx.db, 'u1', 'hunter2!');
    let last = 401;
    for (let i = 0; i < 6; i++) {
      const { cookie, token } = await getLoginTokenAndCookie(ctx.app);
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/login',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        payload: `_csrf=${encodeURIComponent(token)}&username=u1&password=wrong`,
      });
      last = res.statusCode;
      if (last === 429) break;
    }
    assert.equal(last, 429, 'expected 429 within first 6 attempts');
  } finally {
    await closeTestApp(ctx);
  }
});

test('per-IP cap catches username-cycling beyond 20 attempts', async () => {
  const ctx = await makeTestApp();
  try {
    let last = 0;
    for (let i = 0; i < 25; i++) {
      const { cookie, token } = await getLoginTokenAndCookie(ctx.app);
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/login',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        payload: `_csrf=${encodeURIComponent(token)}&username=user${i}&password=x`,
      });
      last = res.statusCode;
      if (last === 429) break;
    }
    assert.equal(last, 429, 'per-IP cap should trip before 25 distinct-username attempts');
  } finally {
    await closeTestApp(ctx);
  }
});
