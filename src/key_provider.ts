import type { KeySet } from './crypto.ts';
import { envKeyProvider } from './key_providers/env.ts';
import { fileKeyProvider } from './key_providers/file.ts';

export type KeyProvider = {
  name: string;
  loadKeys(): Promise<KeySet>;
};

export class KeyProviderConfigError extends Error {}

function nonEmpty(v: string | undefined): v is string {
  return typeof v === 'string' && v.length > 0;
}

export function pickKeyProvider(env: NodeJS.ProcessEnv): KeyProvider {
  const primaryEnv = nonEmpty(env.APP_ENCRYPTION_KEY) ? env.APP_ENCRYPTION_KEY : undefined;
  const primaryFile = nonEmpty(env.APP_ENCRYPTION_KEY_FILE) ? env.APP_ENCRYPTION_KEY_FILE : undefined;
  const prevEnv = nonEmpty(env.APP_ENCRYPTION_KEY_PREV) ? env.APP_ENCRYPTION_KEY_PREV : undefined;
  const prevFile = nonEmpty(env.APP_ENCRYPTION_KEY_PREV_FILE) ? env.APP_ENCRYPTION_KEY_PREV_FILE : undefined;

  if (primaryEnv && primaryFile) {
    throw new KeyProviderConfigError(
      'set APP_ENCRYPTION_KEY or APP_ENCRYPTION_KEY_FILE, not both',
    );
  }
  if (prevEnv && prevFile) {
    throw new KeyProviderConfigError(
      'set APP_ENCRYPTION_KEY_PREV or APP_ENCRYPTION_KEY_PREV_FILE, not both',
    );
  }
  // Don't allow mixing sources across primary and previous: it hides which
  // file/env var holds which role and confuses rotation.
  if (primaryEnv && prevFile) {
    throw new KeyProviderConfigError(
      'APP_ENCRYPTION_KEY uses env; APP_ENCRYPTION_KEY_PREV must also be env (not _PREV_FILE)',
    );
  }
  if (primaryFile && prevEnv) {
    throw new KeyProviderConfigError(
      'APP_ENCRYPTION_KEY_FILE uses file; APP_ENCRYPTION_KEY_PREV must also be a file (_PREV_FILE)',
    );
  }
  // PREV set without a primary makes no sense.
  if (!primaryEnv && !primaryFile && (prevEnv || prevFile)) {
    throw new KeyProviderConfigError(
      'previous encryption key set without a primary; set APP_ENCRYPTION_KEY or APP_ENCRYPTION_KEY_FILE',
    );
  }

  if (primaryFile) {
    return fileKeyProvider({
      primaryPath: primaryFile,
      ...(prevFile ? { previousPath: prevFile } : {}),
    });
  }
  if (primaryEnv) {
    return envKeyProvider(env);
  }
  throw new KeyProviderConfigError(
    'no encryption key source configured: set APP_ENCRYPTION_KEY or APP_ENCRYPTION_KEY_FILE',
  );
}
