import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { makeTestApp, closeTestApp, sessionCookie } from '../helpers/app.ts';
import { seedUser, seedDestination, seedSource } from '../helpers/seed.ts';
import { setGmailOAuthClient } from '../../src/settings.ts';
import { recordLastError } from '../../src/sync/worker.ts';
import { importOne } from '../../src/sync/import_flow.ts';
import { rethrowGmailRefreshError } from '../../src/destinations/gmail_errors.ts';

const base = 'https://mailsluice.example.co.uk';
const basic = 'Basic ' + Buffer.from('gate:gate-password').toString('base64');
const secrets = {
  client_id: 'private-client-id.apps.googleusercontent.com',
  client_secret: 'private-client-secret',
};

async function login(ctx: Awaited<ReturnType<typeof makeTestApp>>, admin = true, unacked = false) {
  const userId = await seedUser(ctx.db, 'private-user', 'correct-horse-battery-staple', admin, { riskAcked: !unacked });
  const headers = ctx.cfg.APP_HTTP_AUTH ? { authorization: basic } : {};
  const page = await ctx.app.inject({ url: '/login', headers });
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page.body)![1]!;
  const response = await ctx.app.inject({
    method: 'POST', url: '/login',
    headers: { ...headers, cookie: sessionCookie(page)!, 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ username: 'private-user', password: 'correct-horse-battery-staple', _csrf: csrf }).toString(),
  });
  assert.equal(response.statusCode, 302);
  return { userId, headers: { ...headers, cookie: sessionCookie(response)! } };
}

for (const auth of [false, true]) {
  test(`public info is anonymous, self-contained and secret-free (Basic Auth ${auth})`, async () => {
    const ctx = await makeTestApp(auth ? { APP_HTTP_AUTH: 'gate:gate-password', NODE_ENV: 'production' } : {});
    try {
      setGmailOAuthClient(ctx.db, ctx.cfg.encryptionKeys, secrets);
      const { userId, headers } = await login(ctx, true, true);
      const credentials = { refresh_token: 'private-refresh-token', access_token: 'private-access-token' };
      const dest = seedDestination(ctx.db, userId, ctx.cfg.encryptionKeys, 'private-mailbox@example.org', credentials);
      seedSource(ctx.db, { userId, destinationId: dest, keys: ctx.cfg.encryptionKeys, name: 'private-source', host: 'private-imap.example.org', password: 'private-source-password' });
      for (const path of ['/oauth-info', '/privacy']) {
        for (const requestHeaders of [{}, { cookie: headers.cookie }, { authorization: 'Basic invalid' }]) {
          const res = await ctx.app.inject({ url: `${path}?check=1`, headers: requestHeaders });
          assert.equal(res.statusCode, 200);
          assert.equal(res.headers['www-authenticate'], undefined);
          assert.match(res.body, /Mailsluice/);
          assert.match(res.body, /href="\/privacy"/);
          assert.doesNotMatch(res.body, /<script|rel="stylesheet"|<form|_csrf|Logout|\/admin\//);
          assert.match(res.body, /<link rel="icon" href="data:,">/);
          for (const value of [...Object.values(secrets), ...Object.values(credentials), 'private-user', 'private-source', 'private-imap.example.org', 'private-mailbox@example.org', 'private-source-password', 'gate-password']) {
            assert.ok(!res.body.includes(value), `leaked ${value}`);
          }
          const css = /<style>([\s\S]*?)<\/style>/.exec(res.body)![1]!;
          const hash = createHash('sha256').update(css).digest('base64');
          assert.ok(String(res.headers['content-security-policy']).includes(`'sha256-${hash}'`));
          assert.doesNotMatch(String(res.headers['content-security-policy']), /unsafe-inline/);
          assert.equal(res.headers['x-content-type-options'], 'nosniff');
        }
        const head = await ctx.app.inject({ method: 'HEAD', url: path });
        assert.equal(head.statusCode, 200);
        assert.equal(head.body, '');
      }
      if (auth) {
        for (const path of ['/', '/login', '/admin/destinations/gmail', '/sources', '/destinations', '/destinations/gmail/callback', '/public/styles.css', '/privacy/admin', '/oauth-info-extra']) {
          assert.equal((await ctx.app.inject({ url: path })).statusCode, 401, path);
        }
        for (const path of ['/privacy', '/oauth-info']) {
          assert.equal((await ctx.app.inject({ method: 'POST', url: path })).statusCode, 401);
        }
        const blocked = await ctx.app.inject({ url: '/', headers: { ...headers, accept: 'text/html' } });
        assert.equal(blocked.headers.location, '/acknowledge');
      }
      for (const path of ['/', '/sources', '/destinations', '/admin/destinations/gmail']) {
        const res = await ctx.app.inject({ url: path, headers: { ...(auth ? { authorization: basic } : {}), accept: 'text/html' } });
        assert.equal(res.statusCode, 302);
        assert.equal(res.headers.location, '/login');
      }
    } finally { await closeTestApp(ctx); }
  });
}

test('both setup entry points show public URLs, exact effective redirect and production checklist', async () => {
  const ctx = await makeTestApp({ APP_PUBLIC_BASE_URL: `${base}/` });
  try {
    const { headers } = await login(ctx);
    for (const override of ['', 'https://callback.example.org/destinations/gmail/callback']) {
      setGmailOAuthClient(ctx.db, ctx.cfg.encryptionKeys, { ...secrets, ...(override ? { redirect_uri: override } : {}) });
      for (const path of ['/destinations', '/admin/destinations/gmail']) {
        const res = await ctx.app.inject({ url: path, headers: { ...headers, host: 'forged.example', 'x-forwarded-proto': 'http' } });
        assert.equal(res.statusCode, 200);
        for (const value of [`${base}/oauth-info`, `${base}/privacy`, 'mailsluice.example.co.uk', override || `${base}/destinations/gmail/callback`, 'In production', 'after 7 days', 'Publish App', 'personally known', '13464323', '15549945', 'Restricted Gmail scope', 'Non-sensitive Gmail scope', 'App domain', 'Application privacy policy link']) {
          assert.ok(res.body.includes(value), `missing ${value} on ${path}`);
        }
        assert.doesNotMatch(res.body, /forged\.example|private-client-secret|sensitive scopes --|while the app stays in Testing/);
        assert.match(res.body, /Authorized JavaScript origins:<\/strong> not required/);
        assert.match(res.body, /Mailsluice does not calculate this value/);
        assert.ok(res.body.indexOf('Publish the app in Audience') < res.body.indexOf('Create the OAuth client'));
        if (path === '/destinations') {
          assert.match(res.body, /Google hasn't verified this app/);
          assert.match(res.body, /Do not switch back to Testing/);
          assert.match(res.body, /Mailsluice cannot check this setting/);
          assert.ok(res.body.indexOf('Expected Google warning') > res.body.indexOf('</details>'));
        }
      }
    }
  } finally { await closeTestApp(ctx); }
});

test('ordinary users see warning at Connect and Reconnect without admin secrets', async () => {
  const ctx = await makeTestApp();
  try {
    setGmailOAuthClient(ctx.db, ctx.cfg.encryptionKeys, secrets);
    const { userId, headers } = await login(ctx, false);
    for (const connected of [false, true]) {
      if (connected) seedDestination(ctx.db, userId, ctx.cfg.encryptionKeys);
      const res = await ctx.app.inject({ url: '/destinations', headers });
      assert.match(res.body, /Google hasn't verified this app/);
      assert.match(res.body, /In production/);
      assert.match(res.body, connected ? />Reconnect<\/button>/ : />Connect Gmail<\/a>/);
      for (const secret of Object.values(secrets)) assert.ok(!res.body.includes(secret));
    }
    assert.equal((await ctx.app.inject({ url: '/admin/destinations/gmail', headers })).statusCode, 403);
  } finally { await closeTestApp(ctx); }
});

test('nested import refresh failure is visible on Home and Sources and remains unimported', async () => {
  const ctx = await makeTestApp();
  try {
    const { userId, headers } = await login(ctx);
    const destinationId = seedDestination(ctx.db, userId, ctx.cfg.encryptionKeys);
    const sourceId = seedSource(ctx.db, { userId, destinationId, keys: ctx.cfg.encryptionKeys });
    await assert.rejects(importOne({
      db: ctx.db, sourceId, destinationTag: 'Imported', tagCache: new Map(), log() {},
      destination: {
        type: 'gmail', async ensureTag() { return 'Label_1'; }, async probe() { return { ok: true, email: 'test@example.org' }; },
        async importMessage() { rethrowGmailRefreshError(new Error('invalid_grant: Token has been expired or revoked.')); },
      },
    }, { raw: Buffer.from('message'), messageIdHeader: 'message-1', externalUid: '1', dateHeader: new Date() }), (err) => {
      recordLastError(ctx.db, sourceId, err);
      return true;
    });
    assert.equal((ctx.db.prepare('SELECT COUNT(*) AS n FROM imported_messages').get() as { n: number }).n, 0);
    for (const path of ['/', '/sources']) {
      const res = await ctx.app.inject({ url: path, headers });
      assert.match(res.body, /invalid_grant/);
      assert.match(res.body, /Google Auth Platform/);
      assert.match(res.body, /In production/);
      assert.match(res.body, /Reconnect/);
    }
  } finally { await closeTestApp(ctx); }
});
