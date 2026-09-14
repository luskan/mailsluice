import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GmailDestination, GmailAuthStarter } from '../../src/destinations/gmail.ts';
import { rethrowGmailRefreshError } from '../../src/destinations/gmail_errors.ts';
import { ActionableError, formatError } from '../../src/ui/errors.ts';
import { OAuth2Client } from 'google-auth-library';

test('refresh error preserves Google diagnostics and original cause', () => {
  for (const original of [
    new Error('invalid_grant'),
    new Error('Token has been expired or revoked.'),
    Object.assign(new Error('Request failed'), { response: { data: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } } }),
  ]) {
    assert.throws(() => rethrowGmailRefreshError(original), (err) => {
      assert.ok(err instanceof ActionableError);
      assert.equal(err.cause, original);
      const text = formatError(new Error('import failed', { cause: err }));
      assert.ok(text.includes(original.message));
      assert.match(text, /One common cause/);
      assert.match(text, /Google Auth Platform → Audience/);
      assert.match(text, /In production/);
      assert.match(text, /Reconnect/);
      assert.ok(text.length <= 500);
      assert.throws(() => rethrowGmailRefreshError(err), (again) => again === err);
      return true;
    });
  }
});

test('unrelated errors pass through and cyclic causes do not loop', () => {
  for (const err of [new Error('invalid_client'), new Error('insufficient_scope'), new Error('ECONNRESET'), { response: { status: 503 } }, null]) {
    assert.throws(() => rethrowGmailRefreshError(err), (actual) => actual === err);
  }
  const cycle = new Error('ordinary error'); cycle.cause = cycle;
  assert.equal(formatError(cycle), 'ordinary error');
});

test('long diagnostics cannot redact or truncate the recovery hint', () => {
  assert.throws(() => rethrowGmailRefreshError(new Error('invalid_grant token=private-value ' + 'x'.repeat(1000))), (err) => {
    const text = formatError(err);
    assert.doesNotMatch(text, /private-value/);
    assert.match(text, /invalid_grant/);
    assert.match(text, /Google Auth Platform → Audience/);
    assert.match(text, /In production/);
    assert.match(text, /Reconnect/);
    assert.ok(text.length <= 500);
    return true;
  });
});

test('concurrent refresh callers share rejection; retry and probe get guidance', async (t) => {
  let calls = 0;
  const original = new Error('invalid_grant');
  t.mock.method(OAuth2Client.prototype, 'getAccessToken', async () => { calls++; throw original; });
  const dest = new GmailDestination({ client_id: 'id', client_secret: 'secret' }, { refresh_token: 'rt' });
  const results = await Promise.allSettled([dest.ensureValidToken(), dest.ensureValidToken()]);
  assert.equal(calls, 1);
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[1].status, 'rejected');
  if (results[0].status === 'rejected' && results[1].status === 'rejected') assert.equal(results[0].reason, results[1].reason);
  const probe = await dest.probe();
  assert.ok(!probe.ok);
  assert.match(probe.error, /In production/);
  assert.equal(calls, 2);
});

test('implicit API refresh failures get guidance and are not retried as label conflicts', async (t) => {
  t.mock.method(OAuth2Client.prototype, 'getAccessToken', async () => ({ token: 'access' }));
  const original = Object.assign(new Error('invalid_grant'), {
    response: { status: 400, data: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } },
  });
  const dest = new GmailDestination({ client_id: 'id', client_secret: 'secret' }, { refresh_token: 'rt' });
  let lists = 0;
  const fail = async () => { throw original; };
  // Stub the Gmail SDK, exercising refresh failures after ensureValidToken succeeds.
  (dest as unknown as { api: unknown }).api = {
    users: {
      labels: { list: async () => { lists++; return { data: { labels: [] } }; }, create: fail },
      messages: { import: fail }, getProfile: fail,
    },
  };
  for (const operation of [() => dest.ensureTag('Imported'), () => dest.importMessage(Buffer.from('mail'), 'Label_1', new Date())]) {
    await assert.rejects(operation(), (err) => {
      assert.ok(err instanceof ActionableError);
      assert.equal(err.cause, original);
      assert.match(formatError(err), /In production/);
      return true;
    });
  }
  assert.equal(lists, 1, 'refresh rejection must not trigger label-conflict retry');
  const probe = await dest.probe();
  assert.ok(!probe.ok);
  assert.match(probe.error, /In production/);
});

test('invalid authorization code does not acquire a Testing refresh-token diagnosis', async (t) => {
  const original = new Error('invalid_grant');
  t.mock.method(OAuth2Client.prototype, 'getToken', async () => { throw original; });
  const starter = new GmailAuthStarter({ client_id: 'id', client_secret: 'secret' }, 'http://localhost/callback');
  await assert.rejects(starter.handleCallback(new URLSearchParams({ code: 'bad-code' })), (err) => err === original);
});
