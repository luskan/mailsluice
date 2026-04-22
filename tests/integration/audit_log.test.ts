import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeTestApp, makeTestApp } from '../helpers/app.ts';
import { seedUser } from '../helpers/seed.ts';
import { listAudit } from '../../src/audit.ts';

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
  const page = await app.inject({ method: 'GET', url: '/', headers: { cookie, accept: 'text/html' } });
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page.body)?.[1]!;
  return { cookie, csrf };
}

test('login success and failure both audit', async () => {
  const ctx = await makeTestApp();
  try {
    await seedUser(ctx.db, 'alice', 'correct-horse-battery-staple');

    // Bad login
    const pre = await ctx.app.inject({ method: 'GET', url: '/login' });
    const preCookie = pickCookie(pre.headers, 'mailsluice.sid')!;
    const preCsrf = /name="_csrf" value="([^"]+)"/.exec(pre.body)?.[1]!;
    await ctx.app.inject({
      method: 'POST',
      url: '/login',
      headers: { cookie: preCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: `_csrf=${encodeURIComponent(preCsrf)}&username=alice&password=nope`,
    });

    // Good login
    await loginAs(ctx.app, 'alice', 'correct-horse-battery-staple');

    const entries = listAudit(ctx.db).map((e) => e.action);
    assert.ok(entries.includes('auth.login.failure'), 'login.failure not audited');
    assert.ok(entries.includes('auth.login.success'), 'login.success not audited');
  } finally {
    await closeTestApp(ctx);
  }
});

test('unknown user login failure is audited with reason=unknown_user', async () => {
  const ctx = await makeTestApp();
  try {
    const pre = await ctx.app.inject({ method: 'GET', url: '/login' });
    const preCookie = pickCookie(pre.headers, 'mailsluice.sid')!;
    const preCsrf = /name="_csrf" value="([^"]+)"/.exec(pre.body)?.[1]!;
    await ctx.app.inject({
      method: 'POST',
      url: '/login',
      headers: { cookie: preCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: `_csrf=${encodeURIComponent(preCsrf)}&username=ghost&password=anything`,
    });
    const entries = listAudit(ctx.db);
    const hit = entries.find((e) => e.action === 'auth.login.failure');
    assert.ok(hit);
    assert.match(hit!.details ?? '', /unknown_user/);
  } finally {
    await closeTestApp(ctx);
  }
});

test('logout audited', async () => {
  const ctx = await makeTestApp();
  try {
    await seedUser(ctx.db, 'alice', 'correct-horse-battery-staple');
    const { cookie, csrf } = await loginAs(ctx.app, 'alice', 'correct-horse-battery-staple');
    await ctx.app.inject({
      method: 'POST',
      url: '/logout',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: `_csrf=${encodeURIComponent(csrf)}`,
    });
    const actions = listAudit(ctx.db).map((e) => e.action);
    assert.ok(actions.includes('auth.logout'));
  } finally {
    await closeTestApp(ctx);
  }
});

test('password change audited', async () => {
  const ctx = await makeTestApp();
  try {
    await seedUser(ctx.db, 'alice', 'correct-horse-battery-staple');
    const { cookie, csrf } = await loginAs(ctx.app, 'alice', 'correct-horse-battery-staple');
    await ctx.app.inject({
      method: 'POST',
      url: '/account/password',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        _csrf: csrf,
        current_password: 'correct-horse-battery-staple',
        new_password: 'vault-42-lobster-dance-umbrella',
        confirm_password: 'vault-42-lobster-dance-umbrella',
      }).toString(),
    });
    const actions = listAudit(ctx.db).map((e) => e.action);
    assert.ok(actions.includes('auth.password.changed'));
  } finally {
    await closeTestApp(ctx);
  }
});

test('admin user create/delete audited', async () => {
  const ctx = await makeTestApp();
  try {
    await seedUser(ctx.db, 'boss', 'admin1234', true);
    const { cookie, csrf } = await loginAs(ctx.app, 'boss', 'admin1234');
    await ctx.app.inject({
      method: 'POST',
      url: '/admin/users',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ _csrf: csrf, username: 'joe' }).toString(),
    });
    const created = listAudit(ctx.db).find((e) => e.action === 'admin.user.created');
    assert.ok(created);
    const newUserId = Number(created!.target_id);

    await ctx.app.inject({
      method: 'POST',
      url: `/admin/users/${newUserId}/delete`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: `_csrf=${encodeURIComponent(csrf)}`,
    });
    const actions = listAudit(ctx.db).map((e) => e.action);
    assert.ok(actions.includes('admin.user.deleted'));
  } finally {
    await closeTestApp(ctx);
  }
});

test('/admin/audit requires admin', async () => {
  const ctx = await makeTestApp();
  try {
    await seedUser(ctx.db, 'user', 'pass1234');
    const { cookie } = await loginAs(ctx.app, 'user', 'pass1234');
    const res = await ctx.app.inject({ method: 'GET', url: '/admin/audit', headers: { cookie } });
    assert.equal(res.statusCode, 403);
  } finally {
    await closeTestApp(ctx);
  }
});

test('/admin/audit renders entries for admin', async () => {
  const ctx = await makeTestApp();
  try {
    await seedUser(ctx.db, 'boss', 'admin1234', true);
    const { cookie } = await loginAs(ctx.app, 'boss', 'admin1234');
    const res = await ctx.app.inject({ method: 'GET', url: '/admin/audit', headers: { cookie } });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /auth\.login\.success/);
    assert.match(res.body, /Audit log/);
  } finally {
    await closeTestApp(ctx);
  }
});
