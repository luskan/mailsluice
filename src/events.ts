import type { Db } from './db/index.ts';

export type EventLevel = 'info' | 'warn' | 'error';

export type RecordArgs = {
  level: EventLevel;
  message: string;
  sourceId?: number | null;
  destinationId?: number | null;
  userId?: number | null;
  details?: Record<string, unknown>;
};

let maxRows = 10_000;

export function setEventLogMaxRows(n: number): void {
  maxRows = Math.max(100, Math.floor(n));
}

export function getEventLogMaxRows(): number {
  return maxRows;
}

export function recordEvent(db: Db, a: RecordArgs): void {
  try {
    const res = db
      .prepare(
        'INSERT INTO event_log (level, message, source_id, destination_id, user_id, details) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        a.level,
        a.message,
        a.sourceId ?? null,
        a.destinationId ?? null,
        a.userId ?? null,
        a.details ? JSON.stringify(a.details) : null,
      );
    // Prune periodically, not every insert, to keep the hot path cheap.
    if (Number(res.lastInsertRowid) % 50 === 0) {
      pruneToMax(db);
    }
  } catch {
    // Event logging is best effort -- never break the caller.
  }
}

export function pruneToMax(db: Db): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM event_log').get() as { n: number };
  if (row.n <= maxRows) return 0;
  const excess = row.n - maxRows;
  const r = db
    .prepare(
      'DELETE FROM event_log WHERE id IN (SELECT id FROM event_log ORDER BY id ASC LIMIT ?)',
    )
    .run(excess);
  return r.changes;
}

export type EventEntry = {
  id: number;
  level: EventLevel;
  message: string;
  source_id: number | null;
  destination_id: number | null;
  user_id: number | null;
  details: string | null;
  created_at: string;
};

export function listEvents(
  db: Db,
  opts: {
    limit?: number;
    offset?: number;
    level?: EventLevel;
    sourceId?: number;
  } = {},
): EventEntry[] {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  const parts: string[] = [];
  const args: (string | number)[] = [];
  if (opts.level) {
    parts.push('level = ?');
    args.push(opts.level);
  }
  if (typeof opts.sourceId === 'number') {
    parts.push('source_id = ?');
    args.push(opts.sourceId);
  }
  const where = parts.length ? ' WHERE ' + parts.join(' AND ') : '';
  return db
    .prepare(
      `SELECT id, level, message, source_id, destination_id, user_id, details, created_at FROM event_log${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
    )
    .all(...args, limit, offset) as EventEntry[];
}

export function eventCount(db: Db): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM event_log').get() as { n: number };
  return row.n;
}
