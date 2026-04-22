import { z } from 'zod';
import type { KeySet } from './crypto.ts';
import { pickKeyProvider, type KeyProvider } from './key_provider.ts';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  APP_PORT: z.coerce.number().int().positive().default(3000),
  APP_HOST: z.string().default('0.0.0.0'),
  APP_DATABASE_PATH: z.string().default('data/mailsluice.db'),
  APP_ENCRYPTION_KEY: z.string().optional(),
  APP_ENCRYPTION_KEY_PREV: z.string().optional(),
  APP_ENCRYPTION_KEY_FILE: z.string().optional(),
  APP_ENCRYPTION_KEY_PREV_FILE: z.string().optional(),
  APP_SESSION_SECRET: z
    .string()
    .min(32, 'APP_SESSION_SECRET must be at least 32 chars'),
  // Empty = trust no peer. Set to an IP/CIDR, comma-separated list, or hop
  // count. "true" is accepted but trusts any peer -- don't.
  APP_TRUST_PROXY: z.string().default(''),
  APP_COOKIE_SECURE: z.enum(['auto', 'true', 'false']).default('auto'),
  APP_EVENT_LOG_MAX_ROWS: z.coerce.number().int().min(100).max(1_000_000).default(10_000),
  // Optional HTTP Basic Auth wrapper, user:password. When set, every request
  // except /health is 401'd until the browser sends the matching credential.
  APP_HTTP_AUTH: z.string().optional(),
  // Optional fixed public base URL. When set, OAuth redirect_uri and similar
  // absolute URLs are derived from this instead of request headers (which an
  // attacker can spoof). Example: https://mailsluice.example.com
  APP_PUBLIC_BASE_URL: z.string().optional(),
  // When false (default), source hosts that resolve to loopback / RFC1918 /
  // link-local / CGNAT addresses are rejected (SSRF hardening). Flip to "1"
  // if you actually need to fetch mail from a LAN / private host.
  APP_ALLOW_PRIVATE_SOURCES: z.enum(['0', '1', 'false', 'true']).default('0'),
});

export type Config = z.infer<typeof schema> & {
  encryptionKey: Buffer;
  encryptionKeys: KeySet;
  keyProviderName: string;
};

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<Config> {
  const parsed = schema.parse(env);
  const provider: KeyProvider = pickKeyProvider(env);
  const keys = await provider.loadKeys();
  return {
    ...parsed,
    encryptionKey: keys.primary,
    encryptionKeys: keys,
    keyProviderName: provider.name,
  };
}

