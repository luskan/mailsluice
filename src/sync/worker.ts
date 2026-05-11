import type { Db } from '../db/index.ts';
import type { Destination } from '../destinations/types.ts';
import type { Clock } from './backoff.ts';
import { Backoff } from './backoff.ts';

export type SourceStatus = {
  id: number;
  connected: boolean;
  lastError: string | null;
  lastSyncAt: string | null;
};

export type WorkerLogger = (
  level: 'info' | 'warn' | 'error',
  msg: string,
  meta?: Record<string, unknown>,
) => void;

export type WorkerDeps = {
  db: Db;
  destination: Destination;
  destinationTag: string;
  sourceId: number;
  clock: Clock;
  log: WorkerLogger;
  tagCache: Map<string, string>;
};

export interface SourceWorker {
  readonly sourceId: number;
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): SourceStatus;
}

export function sanitizeError(raw: string): string {
  let s = raw.replace(/\r?\n/g, ' ');
  // Common credential-bearing tokens in IMAP/POP protocol traces.
  s = s.replace(/\b(PASS|LOGIN|AUTHENTICATE|AUTH|PLAIN|APOP)\b[^\n]*/gi, '$1 [redacted]');
  s = s.replace(/\b(password|token|bearer|secret)\s*[:=]\s*\S+/gi, '$1=[redacted]');
  if (s.length > 500) s = s.slice(0, 500) + '...';
  return s;
}

export function recordLastError(db: Db, sourceId: number, err: unknown): void {
  const raw = err instanceof Error ? err.message : String(err);
  db.prepare('UPDATE sources SET last_error = ? WHERE id = ?').run(
    sanitizeError(raw),
    sourceId,
  );
}

export function recordLastSuccess(db: Db, sourceId: number): void {
  db.prepare(
    "UPDATE sources SET last_error = NULL, last_sync_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
  ).run(sourceId);
}

// Per-import heartbeat. Doesn't clear last_error; that only clears after a
// full cycle drains without throwing.
export function recordActivity(db: Db, sourceId: number): void {
  db.prepare(
    "UPDATE sources SET last_sync_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
  ).run(sourceId);
}

export function newBackoff(): Backoff {
  return new Backoff({ baseMs: 1_000, maxMs: 300_000 });
}

// Returns true if start() settled (resolve or reject), false if the timer won.
// Rejection is swallowed, so don't use this when the caller needs the error.
export async function settleWithin(
  start: () => Promise<unknown>,
  ms: number,
): Promise<boolean> {
  let settled = false;
  const tracked = Promise.resolve().then(start).then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await Promise.race([
    tracked,
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms).unref();
    }),
  ]);
  return settled;
}
