import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  CryptoKeyError,
  DecryptError,
  decrypt,
  decryptJson,
  encrypt,
  encryptJson,
  isLegacyBlob,
  legacyDecryptV0,
  loadKey,
  loadKeySet,
  type KeySet,
} from '../../src/crypto.ts';

const validKey = () => randomBytes(32);
const keySet = (): KeySet => ({ primary: validKey() });

const AAD = 'test:row:1';

test('round-trips arbitrary bytes with matching AAD', () => {
  const ks = keySet();
  const payloads = [
    Buffer.from(''),
    Buffer.from('hello'),
    Buffer.from('Zażółć gęślą jaźń', 'utf8'),
    randomBytes(1024),
  ];
  for (const p of payloads) {
    const out = decrypt(encrypt(p, ks, AAD), ks, AAD);
    assert.deepEqual(out, p);
  }
});

test('wrong AAD fails', () => {
  const ks = keySet();
  const blob = encrypt('secret', ks, 'aad-a');
  assert.throws(() => decrypt(blob, ks, 'aad-b'), DecryptError);
});

test('wrong key fails', () => {
  const ks = keySet();
  const blob = encrypt('secret', ks, AAD);
  const other = keySet();
  assert.throws(() => decrypt(blob, other, AAD), DecryptError);
});

test('tampered ciphertext fails', () => {
  const ks = keySet();
  const blob = encrypt('secret', ks, AAD);
  const tampered = Buffer.from(blob);
  const lastByte = tampered.length - 1;
  tampered[lastByte] = tampered[lastByte]! ^ 0xff;
  assert.throws(() => decrypt(tampered, ks, AAD), DecryptError);
});

test('IV uniqueness across repeated encrypts', () => {
  const ks = keySet();
  const N = 30;
  const seen = new Set<string>();
  for (let i = 0; i < N; i++) {
    const blob = encrypt('same-plaintext', ks, AAD);
    const iv = blob.subarray(1, 13).toString('hex');
    assert.equal(seen.has(iv), false);
    seen.add(iv);
  }
  assert.equal(seen.size, N);
});

test('version byte is 1', () => {
  const ks = keySet();
  const blob = encrypt('x', ks, AAD);
  assert.equal(blob[0], 1);
});

test('prev-key fallback: blob encrypted under prev decrypts via previous key', () => {
  const prev = validKey();
  const primary = validKey();
  const writerKs: KeySet = { primary: prev };
  const readerKs: KeySet = { primary, previous: prev };
  const blob = encrypt('old-data', writerKs, AAD);
  assert.equal(decrypt(blob, readerKs, AAD).toString('utf8'), 'old-data');
});

test('prev-key fallback: blob encrypted under primary still decrypts', () => {
  const primary = validKey();
  const prev = validKey();
  const readerKs: KeySet = { primary, previous: prev };
  const blob = encrypt('new-data', readerKs, AAD);
  assert.equal(decrypt(blob, readerKs, AAD).toString('utf8'), 'new-data');
});

test('loadKeySet with previous', () => {
  const a = randomBytes(32).toString('base64');
  const b = randomBytes(32).toString('base64');
  const ks = loadKeySet(a, b);
  assert.equal(ks.primary.length, 32);
  assert.equal(ks.previous?.length, 32);
});

test('loadKeySet without previous', () => {
  const a = randomBytes(32).toString('base64');
  const ks = loadKeySet(a);
  assert.equal(ks.primary.length, 32);
  assert.equal(ks.previous, undefined);
});

test('loadKey rejects wrong-length', () => {
  assert.throws(() => loadKey(randomBytes(16).toString('base64')), CryptoKeyError);
});

test('encryptJson / decryptJson round-trip', () => {
  const ks = keySet();
  const obj = { refresh_token: 'rt', access_token: 'at', expiry_date: 12345 };
  assert.deepEqual(decryptJson(encryptJson(obj, ks, AAD), ks, AAD), obj);
});

test('legacyDecryptV0 reads pre-v1 blobs', async () => {
  // Build a legacy blob: [iv:12][tag:16][ct].
  const { createCipheriv } = await import('node:crypto');
  const k = validKey();
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k, iv);
  const enc = Buffer.concat([c.update('hello-legacy'), c.final()]);
  const tag = c.getAuthTag();
  const legacy = Buffer.concat([iv, tag, enc]);
  assert.equal(isLegacyBlob(legacy), true);
  const out = legacyDecryptV0(legacy, k);
  assert.equal(out.toString('utf8'), 'hello-legacy');
});

test('decrypt rejects a v1 blob that is too short', () => {
  const ks = keySet();
  assert.throws(() => decrypt(Buffer.from([1]), ks, AAD), DecryptError);
});

test('decrypt rejects unknown version', () => {
  const ks = keySet();
  const blob = Buffer.concat([Buffer.from([99]), Buffer.alloc(30)]);
  assert.throws(() => decrypt(blob, ks, AAD), DecryptError);
});
