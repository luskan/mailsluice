import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyRequest } from 'fastify';
import type { Config } from '../../src/config.ts';
import { gmailSetupUrls } from '../../src/ui/oauth_setup.ts';

const req = { headers: { host: 'localhost:3000' }, hostname: 'localhost', protocol: 'http' } as unknown as FastifyRequest;
test('setup URLs handle local/invalid hosts without guessing an authorized domain', () => {
  for (const base of ['http://localhost:3000', 'https://127.0.0.1', 'https://[::1]', 'https://mail.local', 'not a URL', 'javascript:alert(1)']) {
    const result = gmailSetupUrls(req, { APP_PUBLIC_BASE_URL: base } as Config);
    assert.equal(result.oauth_setup.publicHttps, false, base);
  }
  const fallback = gmailSetupUrls(req, {} as Config);
  assert.equal(fallback.oauth_setup.pinned, false);
  assert.equal(fallback.oauth_setup.homepage, 'http://localhost:3000/oauth-info');
  const shared = gmailSetupUrls(req, { APP_PUBLIC_BASE_URL: 'https://tenant.github.io' } as Config);
  assert.equal(shared.oauth_setup.hostname, 'tenant.github.io');
});
