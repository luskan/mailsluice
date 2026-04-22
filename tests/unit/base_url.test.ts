import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyRequest } from 'fastify';
import type { Config } from '../../src/config.ts';
import { publicOrigin } from '../../src/ui/base_url.ts';

function req(headers: Record<string, string>, protocol = 'https'): FastifyRequest {
  return {
    headers,
    hostname: headers.host ?? 'fallback',
    protocol,
  } as unknown as FastifyRequest;
}

function cfg(publicBase?: string): Config {
  return ({ APP_PUBLIC_BASE_URL: publicBase } as unknown) as Config;
}

test('uses configured APP_PUBLIC_BASE_URL when set', () => {
  const r = req({ host: 'attacker.example' });
  assert.equal(publicOrigin(r, cfg('https://mailsluice.example.com')), 'https://mailsluice.example.com');
});

test('strips trailing slash from configured base', () => {
  const r = req({ host: 'x' });
  assert.equal(publicOrigin(r, cfg('https://mailsluice.example.com//')), 'https://mailsluice.example.com');
});

test('falls back to headers when unset', () => {
  const r = req({ host: 'mail.local:3000' }, 'http');
  assert.equal(publicOrigin(r, cfg()), 'http://mail.local:3000');
});

test('respects X-Forwarded-Proto when unset', () => {
  const r = req({ host: 'mail.local', 'x-forwarded-proto': 'https, http' }, 'http');
  assert.equal(publicOrigin(r, cfg()), 'https://mail.local');
});
