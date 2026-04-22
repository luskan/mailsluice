import argon2 from 'argon2';

// OWASP 2024 stronger recommendation (stronger than the baseline 19MiB profile).
// 47104 KiB = ~46 MiB memory, t=2 iterations, p=1 lane.
const OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 47104,
  timeCost: 2,
  parallelism: 1,
};

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, OPTIONS);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

export function needsRehash(hash: string): boolean {
  try {
    return argon2.needsRehash(hash, OPTIONS);
  } catch {
    // Unknown format -> treat as needing a rehash on next successful verify.
    return true;
  }
}
