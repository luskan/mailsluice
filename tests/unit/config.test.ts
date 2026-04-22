import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config.ts';
import { KeyProviderConfigError } from '../../src/key_provider.ts';

const validEnv = () => ({
  APP_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  APP_SESSION_SECRET: 'a'.repeat(32),
});

test('loads with defaults', async () => {
  const cfg = await loadConfig(validEnv());
  assert.equal(cfg.APP_PORT, 3000);
  assert.equal(cfg.APP_HOST, '0.0.0.0');
  assert.equal(cfg.NODE_ENV, 'development');
  assert.equal(cfg.encryptionKey.length, 32);
  assert.equal(cfg.keyProviderName, 'env');
});

test('rejects short session secret', async () => {
  await assert.rejects(() => loadConfig({ ...validEnv(), APP_SESSION_SECRET: 'short' }));
});

test('rejects missing encryption key', async () => {
  await assert.rejects(() =>
    loadConfig({ APP_SESSION_SECRET: 'a'.repeat(32) } as NodeJS.ProcessEnv),
  );
});

test('rejects wrong-length encryption key', async () => {
  await assert.rejects(() =>
    loadConfig({
      ...validEnv(),
      APP_ENCRYPTION_KEY: randomBytes(16).toString('base64'),
    }),
  );
});

test('coerces PORT from string', async () => {
  const cfg = await loadConfig({ ...validEnv(), APP_PORT: '8080' } as NodeJS.ProcessEnv);
  assert.equal(cfg.APP_PORT, 8080);
});

test('loads key from file provider', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mailsluice-key-'));
  const keyPath = join(dir, 'app.key');
  writeFileSync(keyPath, randomBytes(32).toString('base64') + '\n');
  const cfg = await loadConfig({
    APP_ENCRYPTION_KEY_FILE: keyPath,
    APP_SESSION_SECRET: 'a'.repeat(32),
  } as NodeJS.ProcessEnv);
  assert.equal(cfg.keyProviderName, 'file');
  assert.equal(cfg.encryptionKey.length, 32);
});

test('file provider rejects empty key file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mailsluice-key-'));
  const keyPath = join(dir, 'app.key');
  writeFileSync(keyPath, '   \n');
  await assert.rejects(() =>
    loadConfig({
      APP_ENCRYPTION_KEY_FILE: keyPath,
      APP_SESSION_SECRET: 'a'.repeat(32),
    } as NodeJS.ProcessEnv),
  );
});

test('rejects when both env and file key sources are set', async () => {
  await assert.rejects(
    () =>
      loadConfig({
        ...validEnv(),
        APP_ENCRYPTION_KEY_FILE: '/tmp/whatever',
      } as NodeJS.ProcessEnv),
    KeyProviderConfigError,
  );
});

test('rejects mixing env primary with file previous', async () => {
  await assert.rejects(
    () =>
      loadConfig({
        ...validEnv(),
        APP_ENCRYPTION_KEY_PREV_FILE: '/tmp/whatever',
      } as NodeJS.ProcessEnv),
    KeyProviderConfigError,
  );
});

test('rejects previous key without a primary', async () => {
  await assert.rejects(
    () =>
      loadConfig({
        APP_SESSION_SECRET: 'a'.repeat(32),
        APP_ENCRYPTION_KEY_PREV: randomBytes(32).toString('base64'),
      } as NodeJS.ProcessEnv),
    KeyProviderConfigError,
  );
});

test('file provider wraps ENOENT as KeyProviderConfigError', async () => {
  await assert.rejects(
    () =>
      loadConfig({
        APP_SESSION_SECRET: 'a'.repeat(32),
        APP_ENCRYPTION_KEY_FILE: '/nonexistent/mailsluice-key-does-not-exist',
      } as NodeJS.ProcessEnv),
    (err: Error) =>
      err instanceof KeyProviderConfigError && err.message.includes('ENOENT'),
  );
});
