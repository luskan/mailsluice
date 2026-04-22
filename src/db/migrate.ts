import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';

const schemaPath = join(dirname(fileURLToPath(import.meta.url)), 'schema.sql');

export function migrate(db: Database.Database): void {
  const sql = readFileSync(schemaPath, 'utf8');
  db.exec(sql);
}
