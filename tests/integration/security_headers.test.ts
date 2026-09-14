import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
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

test('static assets work but non-canonical paths are rejected', async () => {
  const ctx = await makeTestApp();
  try {
    const source = await readFile(new URL('../../src/public/sources-form.js', import.meta.url), 'utf8');
    const res = await ctx.app.inject({ url: '/public/sources-form.js' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, source);
    assert.match(String(res.headers['content-type']), /javascript/);
    const head = await ctx.app.inject({ method: 'HEAD', url: '/public/sources-form.js' });
    assert.equal(head.statusCode, 200);
    assert.equal(head.body, '');
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address();
    assert.ok(address && typeof address !== 'string');
    for (const path of ['/public/x/../sources-form.js', '/public/x/%2E%2E/sources-form.js', '/public/./sources-form.js', '/public//sources-form.js']) {
      // inject() normalizes dot segments before dispatch; send the raw HTTP path.
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const req = request({ hostname: '127.0.0.1', port: address.port, path }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
          res.on('error', reject);
        });
        req.on('error', reject);
        req.end();
      });
      assert.equal(status, 403, path);
    }
  } finally { await closeTestApp(ctx); }
});
