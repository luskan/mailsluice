import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateAddress, assertPublicHost, PrivateHostError } from '../../src/sources/host_policy.ts';

test('isPrivateAddress recognises loopback and RFC1918', () => {
  for (const ip of [
    '127.0.0.1', '127.1.2.3',
    '10.0.0.1', '10.255.255.254',
    '172.16.0.1', '172.31.255.254',
    '192.168.0.1', '192.168.1.100',
    '169.254.169.254',
    '100.64.0.1',
    '::1', '::',
    'fe80::1', 'fd12::ab', 'fc00::1',
    '::ffff:10.0.0.1', '::ffff:192.168.1.1',
  ]) {
    assert.equal(isPrivateAddress(ip), true, `expected ${ip} private`);
  }
});

test('isPrivateAddress leaves public IPs alone', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
    assert.equal(isPrivateAddress(ip), false, `expected ${ip} public`);
  }
});

test('assertPublicHost rejects literal private IP when not allowed', async () => {
  await assert.rejects(() => assertPublicHost('127.0.0.1', false), PrivateHostError);
  await assert.rejects(() => assertPublicHost('10.1.2.3', false), PrivateHostError);
  await assert.rejects(() => assertPublicHost('::1', false), PrivateHostError);
});

test('assertPublicHost passes when allowPrivate=true', async () => {
  await assertPublicHost('127.0.0.1', true);
  await assertPublicHost('10.1.2.3', true);
});

test('assertPublicHost accepts public literal', async () => {
  await assertPublicHost('8.8.8.8', false);
});
