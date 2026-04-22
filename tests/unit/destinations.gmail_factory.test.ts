import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GMAIL_SCOPES,
  GmailFactory,
  OAuthConfigMissingError,
} from '../../src/destinations/gmail.ts';

test('createAuthStarter rejects when admin config is missing', () => {
  assert.throws(
    () =>
      GmailFactory.createAuthStarter({
        adminConfig: {},
        redirectUri: 'http://localhost/x',
      }),
    OAuthConfigMissingError,
  );
});

test('authUrl embeds state and required scopes', () => {
  const starter = GmailFactory.createAuthStarter({
    adminConfig: { client_id: 'cid.apps', client_secret: 'secret' },
    redirectUri: 'http://localhost:3000/destinations/gmail/callback',
  });
  const url = starter.authUrl('abc123');
  const u = new URL(url);
  assert.equal(u.hostname, 'accounts.google.com');
  assert.equal(u.searchParams.get('state'), 'abc123');
  assert.equal(u.searchParams.get('client_id'), 'cid.apps');
  assert.equal(u.searchParams.get('access_type'), 'offline');
  assert.equal(u.searchParams.get('prompt'), 'consent');
  const scope = u.searchParams.get('scope') ?? '';
  for (const s of GMAIL_SCOPES) {
    assert.ok(scope.includes(s), `missing scope: ${s}`);
  }
});

test('createDestination rejects when admin config is missing', () => {
  assert.throws(
    () =>
      GmailFactory.createDestination({
        adminConfig: {},
        userCredentials: { refresh_token: 'rt' },
      }),
    OAuthConfigMissingError,
  );
});
