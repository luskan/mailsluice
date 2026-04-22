import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeTestApp, makeTestApp } from '../helpers/app.ts';
import { seedUser } from '../helpers/seed.ts';
import {
  eventCount,
  listEvents,
  pruneToMax,
  recordEvent,
  setEventLogMaxRows,
} from '../../src/events.ts';

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
): Promise<{ cookie: string }> {
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
  return { cookie };
}

test('recordEvent persists row with timestamp', async () => {
  const ctx = await makeTestApp();
  try {
    recordEvent(ctx.db, { level: 'info', message: 'hello', sourceId: 5, details: { k: 1 } });
    const list = listEvents(ctx.db);
    assert.equal(list.length, 1);
    assert.equal(list[0]!.message, 'hello');
    assert.equal(list[0]!.source_id, 5);
    assert.match(list[0]!.details ?? '', /"k":1/);
    assert.match(list[0]!.created_at, /\d{4}-\d{2}-\d{2}T/);
  } finally {
    await closeTestApp(ctx);
  }
});

test('listEvents filters by level and source', async () => {
  const ctx = await makeTestApp();
  try {
    recordEvent(ctx.db, { level: 'info', message: 'a', sourceId: 1 });
    recordEvent(ctx.db, { level: 'warn', message: 'b', sourceId: 1 });
    recordEvent(ctx.db, { level: 'error', message: 'c', sourceId: 2 });

    const warns = listEvents(ctx.db, { level: 'warn' });
    assert.equal(warns.length, 1);
    assert.equal(warns[0]!.message, 'b');

    const s1 = listEvents(ctx.db, { sourceId: 1 });
    assert.equal(s1.length, 2);
    assert.deepEqual(s1.map((e) => e.message).sort(), ['a', 'b']);

    const s2warn = listEvents(ctx.db, { sourceId: 2, level: 'warn' });
    assert.equal(s2warn.length, 0);
  } finally {
    await closeTestApp(ctx);
  }
});

test('pruneToMax enforces cap', async () => {
  const ctx = await makeTestApp();
  try {
    setEventLogMaxRows(100);
    for (let i = 0; i < 150; i++) {
      recordEvent(ctx.db, { level: 'info', message: `m${i}` });
    }
    pruneToMax(ctx.db);
    assert.equal(eventCount(ctx.db), 100);
    // Oldest should be gone: the earliest surviving message is m50 or later.
    const oldest = ctx.db
      .prepare('SELECT message FROM event_log ORDER BY id ASC LIMIT 1')
      .get() as { message: string };
    assert.equal(oldest.message, 'm50');
  } finally {
    await closeTestApp(ctx);
    setEventLogMaxRows(10_000);
  }
});

test('/admin/events requires admin', async () => {
  const ctx = await makeTestApp();
  try {
    await seedUser(ctx.db, 'user', 'pass1234');
    const { cookie } = await loginAs(ctx.app, 'user', 'pass1234');
    const res = await ctx.app.inject({ method: 'GET', url: '/admin/events', headers: { cookie } });
    assert.equal(res.statusCode, 403);
  } finally {
    await closeTestApp(ctx);
  }
});

test('/admin/events renders entries for admin, with level filter applied', async () => {
  const ctx = await makeTestApp();
  try {
    await seedUser(ctx.db, 'boss', 'admin1234', true);
    recordEvent(ctx.db, { level: 'info', message: 'pop poll done' });
    recordEvent(ctx.db, { level: 'error', message: 'imap worker error' });
    const { cookie } = await loginAs(ctx.app, 'boss', 'admin1234');

    const all = await ctx.app.inject({ method: 'GET', url: '/admin/events', headers: { cookie } });
    assert.equal(all.statusCode, 200);
    assert.match(all.body, /pop poll done/);
    assert.match(all.body, /imap worker error/);

    const onlyErr = await ctx.app.inject({
      method: 'GET',
      url: '/admin/events?level=error',
      headers: { cookie },
    });
    assert.equal(onlyErr.statusCode, 200);
    assert.match(onlyErr.body, /imap worker error/);
    assert.doesNotMatch(onlyErr.body, /pop poll done/);
  } finally {
    await closeTestApp(ctx);
  }
});
