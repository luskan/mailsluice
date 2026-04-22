import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeTestApp, makeTestApp } from '../helpers/app.ts';
import { APP_VERSION } from '../../src/version.ts';

test('APP_VERSION is a non-empty semver-ish string', () => {
  assert.match(APP_VERSION, /^\d+\.\d+\.\d+/);
});

test('login page footer renders the app version', async () => {
  const ctx = await makeTestApp();
  try {
    const res = await ctx.app.inject({ method: 'GET', url: '/login' });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, new RegExp(`Mailsluice v${APP_VERSION.replace(/\./g, '\\.')}`));
  } finally {
    await closeTestApp(ctx);
  }
});
