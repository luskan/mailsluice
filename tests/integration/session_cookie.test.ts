import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeTestApp, makeTestApp } from '../helpers/app.ts';

function setCookieHeaders(
  headers: Record<string, string | string[] | undefined>,
): string[] {
  const raw = headers['set-cookie'];
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

test('session cookie has HttpOnly and SameSite=Lax in non-production', async () => {
  const ctx = await makeTestApp();
  try {
    const res = await ctx.app.inject({ method: 'GET', url: '/login' });
    const line = setCookieHeaders(res.headers).find((c) =>
      c.startsWith('mailsluice.sid='),
    );
    assert.ok(line, 'expected mailsluice.sid set-cookie line');
    assert.match(line!, /HttpOnly/i);
    assert.match(line!, /SameSite=Lax/i);
    assert.doesNotMatch(line!, /Secure/i);
  } finally {
    await closeTestApp(ctx);
  }
});

test('session cookie has no Secure flag in production over plain HTTP', async () => {
  // Regression: prebuilt image runs with NODE_ENV=production. Default 'auto'
  // must NOT set Secure on plain-HTTP requests, otherwise the browser drops
  // the cookie and login + CSRF break.
  const ctx = await makeTestApp({ NODE_ENV: 'production' });
  try {
    const res = await ctx.app.inject({ method: 'GET', url: '/login' });
    const line = setCookieHeaders(res.headers).find((c) =>
      c.startsWith('mailsluice.sid='),
    );
    assert.ok(line, 'expected mailsluice.sid set-cookie line');
    assert.doesNotMatch(line!, /Secure/i);
  } finally {
    await closeTestApp(ctx);
  }
});

test('session cookie gets Secure flag in production (behind HTTPS reverse proxy)', async () => {
  const ctx = await makeTestApp({ NODE_ENV: 'production', APP_TRUST_PROXY: '127.0.0.1' });
  try {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/login',
      headers: { 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.4' },
    });
    const line = setCookieHeaders(res.headers).find((c) =>
      c.startsWith('mailsluice.sid='),
    );
    assert.ok(line, 'expected mailsluice.sid set-cookie line');
    assert.match(line!, /Secure/i);
    assert.match(line!, /HttpOnly/i);
    assert.match(line!, /SameSite=Lax/i);
  } finally {
    await closeTestApp(ctx);
  }
});
