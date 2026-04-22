import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function load(): string {
  try {
    const p = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(p, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const APP_VERSION = load();
