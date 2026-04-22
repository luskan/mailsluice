import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;
const VERSION = 1;

export class CryptoKeyError extends Error {}
export class DecryptError extends Error {}

export type KeySet = {
  primary: Buffer;
  previous?: Buffer;
};

export function loadKey(raw: string): Buffer {
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_LEN) {
    throw new CryptoKeyError(
      `encryption key must decode to ${KEY_LEN} bytes (got ${key.length}); generate one with \`openssl rand -base64 32\``,
    );
  }
  return key;
}

export function loadKeySet(primaryRaw: string, previousRaw?: string | null | undefined): KeySet {
  const primary = loadKey(primaryRaw);
  if (previousRaw && previousRaw.length > 0) {
    return { primary, previous: loadKey(previousRaw) };
  }
  return { primary };
}

function toKeySet(keys: KeySet | Buffer): KeySet {
  return Buffer.isBuffer(keys) ? { primary: keys } : keys;
}

function aadBuf(aad: string | Buffer): Buffer {
  return typeof aad === 'string' ? Buffer.from(aad, 'utf8') : aad;
}

function encryptV1(plaintext: Buffer, key: Buffer, aad: Buffer): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  cipher.setAAD(aad);
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION]), iv, tag, enc]);
}

function decryptV1(blob: Buffer, key: Buffer, aad: Buffer): Buffer {
  const iv = blob.subarray(1, 1 + IV_LEN);
  const tag = blob.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
  const enc = blob.subarray(1 + IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

export function encrypt(
  plaintext: Buffer | string,
  keys: KeySet | Buffer,
  aad: string | Buffer,
): Buffer {
  const ks = toKeySet(keys);
  if (ks.primary.length !== KEY_LEN) throw new CryptoKeyError(`key must be ${KEY_LEN} bytes`);
  const body = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
  return encryptV1(body, ks.primary, aadBuf(aad));
}

export function decrypt(
  blob: Buffer,
  keys: KeySet | Buffer,
  aad: string | Buffer,
): Buffer {
  if (blob.length < 1 + IV_LEN + TAG_LEN) throw new DecryptError('ciphertext truncated');
  if (blob[0] !== VERSION) throw new DecryptError(`unknown ciphertext version ${blob[0]}`);
  const ks = toKeySet(keys);
  const tried: Buffer[] = [ks.primary];
  if (ks.previous) tried.push(ks.previous);
  const a = aadBuf(aad);
  for (const k of tried) {
    if (k.length !== KEY_LEN) continue;
    try {
      return decryptV1(blob, k, a);
    } catch {
      // try next key
    }
  }
  throw new DecryptError('authentication failed: wrong key, wrong AAD, or tampered ciphertext');
}

// Pre-v1 ciphertexts: [iv:12][tag:16][enc...], no AAD. Reached only by the
// one-time startup migration. Never expose this decrypt path at runtime.
export function legacyDecryptV0(blob: Buffer, keys: KeySet | Buffer): Buffer {
  if (blob.length < IV_LEN + TAG_LEN) throw new DecryptError('legacy ciphertext truncated');
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = blob.subarray(IV_LEN + TAG_LEN);
  const ks = toKeySet(keys);
  const candidates: Buffer[] = [ks.primary];
  if (ks.previous) candidates.push(ks.previous);
  for (const k of candidates) {
    if (k.length !== KEY_LEN) continue;
    const decipher = createDecipheriv(ALGO, k, iv);
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(enc), decipher.final()]);
    } catch {
      // try next
    }
  }
  throw new DecryptError('legacy decrypt failed with all known keys');
}

export function isLegacyBlob(blob: Buffer): boolean {
  return blob.length >= IV_LEN + TAG_LEN && blob[0] !== VERSION;
}

export function encryptJson(
  obj: unknown,
  keys: KeySet | Buffer,
  aad: string | Buffer,
): Buffer {
  return encrypt(JSON.stringify(obj), keys, aad);
}

export function decryptJson<T>(
  blob: Buffer,
  keys: KeySet | Buffer,
  aad: string | Buffer,
): T {
  return JSON.parse(decrypt(blob, keys, aad).toString('utf8')) as T;
}
