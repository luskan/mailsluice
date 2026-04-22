import { loadKeySet, type KeySet } from '../crypto.ts';
import type { KeyProvider } from '../key_provider.ts';

export function envKeyProvider(env: NodeJS.ProcessEnv): KeyProvider {
  return {
    name: 'env',
    async loadKeys(): Promise<KeySet> {
      const primary = env.APP_ENCRYPTION_KEY;
      if (!primary) {
        throw new Error('APP_ENCRYPTION_KEY not set');
      }
      const previous = env.APP_ENCRYPTION_KEY_PREV && env.APP_ENCRYPTION_KEY_PREV.length > 0
        ? env.APP_ENCRYPTION_KEY_PREV
        : undefined;
      return loadKeySet(primary, previous);
    },
  };
}
