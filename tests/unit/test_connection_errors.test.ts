// Drives friendlyError via testConnection against unreachable hosts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testConnection } from '../../src/sources/test_connection.ts';

test('ENOTFOUND maps to a hostname hint', async () => {
  const r = await testConnection({
    type: 'imap',
    host: 'definitely-not-a-real-host.invalid',
    port: 993,
    useTls: true,
    username: 'u',
    password: 'p',
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /could not be resolved/i);
});
