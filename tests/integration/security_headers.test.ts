import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp, closeTestApp } from '../helpers/app.ts';

test('helmet sets CSP and related headers on /login', async () => {
  const ctx = await makeTestApp();
  try {
    const res = await ctx.app.inject({ method: 'GET', url: '/login' });
    assert.equal(res.statusCode, 200);
    const csp = res.headers['content-security-policy'] as string | undefined;
    assert.ok(csp, 'CSP header missing');
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /object-src 'none'/);
    // Reconnect posts a form that redirects to Google's OAuth consent; the
    // browser blocks that hop unless accounts.google.com is in form-action.
    assert.match(csp, /form-action 'self' https:\/\/accounts\.google\.com/);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.match(
      res.headers['referrer-policy'] as string,
      /strict-origin-when-cross-origin/,
    );
  } finally {
    await closeTestApp(ctx);
  }
});
