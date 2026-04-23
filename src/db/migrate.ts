import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';

const schemaPath = join(dirname(fileURLToPath(import.meta.url)), 'schema.sql');

export function migrate(db: Database.Database): void {
  const sql = readFileSync(schemaPath, 'utf8');
  db.exec(sql);
  ensureColumn(db, 'sources', 'post_import_action', "TEXT NOT NULL DEFAULT 'none'");
}

function ensureColumn(
  db: Database.Database,
  table: string,
  column: string,
  typeAndDefault: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeAndDefault}`);
}
