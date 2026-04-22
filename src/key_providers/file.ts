import { readFile } from 'node:fs/promises';
import { loadKeySet, type KeySet } from '../crypto.ts';
import { KeyProviderConfigError, type KeyProvider } from '../key_provider.ts';

export type FileKeyProviderOptions = {
  primaryPath: string;
  previousPath?: string;
};

async function readKeyFile(path: string, role: 'primary' | 'previous'): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'read error';
    throw new KeyProviderConfigError(
      `${role} encryption key file could not be read (${code}): ${path}`,
    );
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new KeyProviderConfigError(`${role} encryption key file is empty: ${path}`);
  }
  return trimmed;
}

export function fileKeyProvider(opts: FileKeyProviderOptions): KeyProvider {
  return {
    name: 'file',
    async loadKeys(): Promise<KeySet> {
      const primary = await readKeyFile(opts.primaryPath, 'primary');
      const previous = opts.previousPath
        ? await readKeyFile(opts.previousPath, 'previous')
        : undefined;
      return loadKeySet(primary, previous);
    },
  };
}
