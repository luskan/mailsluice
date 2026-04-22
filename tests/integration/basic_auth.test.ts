import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp, closeTestApp } from '../helpers/app.ts';

function basic(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`, 'utf8').toString('base64');
}

test('basic auth: 401 without credentials', async () => {
  const ctx = await makeTestApp({ APP_HTTP_AUTH: 'gate:secret' });
  try {
    const res = await ctx.app.inject({ method: 'GET', url: '/login' });
    assert.equal(res.statusCode, 401);
    assert.match(res.headers['www-authenticate'] as string, /^Basic realm="mailsluice"/);
  } finally {
    await closeTestApp(ctx);
  }
});

test('basic auth: 401 with wrong password', async () => {
  const ctx = await makeTestApp({ APP_HTTP_AUTH: 'gate:secret' });
  try {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/login',
      headers: { authorization: basic('gate', 'wrong') },
    });
    assert.equal(res.statusCode, 401);
  } finally {
    await closeTestApp(ctx);
  }
});

test('basic auth: correct credentials pass through', async () => {
  const ctx = await makeTestApp({ APP_HTTP_AUTH: 'gate:secret' });
  try {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/login',
      headers: { authorization: basic('gate', 'secret') },
    });
    assert.equal(res.statusCode, 200);
  } finally {
    await closeTestApp(ctx);
  }
});

test('basic auth: /health bypasses the gate', async () => {
  const ctx = await makeTestApp({ APP_HTTP_AUTH: 'gate:secret' });
  try {
    const res = await ctx.app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);
  } finally {
    await closeTestApp(ctx);
  }
});

test('basic auth: disabled when APP_HTTP_AUTH unset', async () => {
  const ctx = await makeTestApp();
  try {
    const res = await ctx.app.inject({ method: 'GET', url: '/login' });
    assert.equal(res.statusCode, 200);
  } finally {
    await closeTestApp(ctx);
  }
});

test('basic auth: malformed header yields 401 (no crash)', async () => {
  const ctx = await makeTestApp({ APP_HTTP_AUTH: 'gate:secret' });
  try {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/login',
      headers: { authorization: 'Basic not-base64-at-all-@@@' },
    });
    assert.equal(res.statusCode, 401);
  } finally {
    await closeTestApp(ctx);
  }
});

test('basic auth: password containing colons is preserved', async () => {
  const ctx = await makeTestApp({ APP_HTTP_AUTH: 'gate:a:b:c' });
  try {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/login',
      headers: { authorization: basic('gate', 'a:b:c') },
    });
    assert.equal(res.statusCode, 200);
  } finally {
    await closeTestApp(ctx);
  }
});

test('basic auth: /health still open with query string', async () => {
  const ctx = await makeTestApp({ APP_HTTP_AUTH: 'gate:secret' });
  try {
    const res = await ctx.app.inject({ method: 'GET', url: '/health?probe=1' });
    assert.equal(res.statusCode, 200);
  } finally {
    await closeTestApp(ctx);
  }
});

test('basic auth: HEAD /health works without credentials', async () => {
  const ctx = await makeTestApp({ APP_HTTP_AUTH: 'gate:secret' });
  try {
    const res = await ctx.app.inject({ method: 'HEAD', url: '/health' });
    assert.equal(res.statusCode, 200);
  } finally {
    await closeTestApp(ctx);
  }
});

test('basic auth: static assets are gated', async () => {
  const ctx = await makeTestApp({ APP_HTTP_AUTH: 'gate:secret' });
  try {
    const res = await ctx.app.inject({ method: 'GET', url: '/public/styles.css' });
    assert.equal(res.statusCode, 401);
  } finally {
    await closeTestApp(ctx);
  }
});

test('basic auth: rate-limits floods of bad credentials', async () => {
  const ctx = await makeTestApp({ APP_HTTP_AUTH: 'gate:secret' });
  try {
    let saw429 = false;
    for (let i = 0; i < 80; i++) {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/login',
        headers: { authorization: basic('gate', `wrong-${i}`) },
      });
      if (res.statusCode === 429) {
        saw429 = true;
        break;
      }
    }
    assert.equal(saw429, true, 'expected 429 after repeated bad credentials');
  } finally {
    await closeTestApp(ctx);
  }
});
