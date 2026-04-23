import type { Db } from '../db/index.ts';
import type { Config } from '../config.ts';
import { decrypt, decryptJson, encryptJson } from '../crypto.ts';
import { getDestinationFactory } from '../destinations/registry.ts';
import { getGmailOAuthClient } from '../settings.ts';
import { realClock, type Clock } from './backoff.ts';
import { ImapSourceWorker } from './imap_worker.ts';
import { PopSourceWorker } from './pop_worker.ts';
import { type SourceWorker, type SourceStatus, type WorkerLogger, recordLastError } from './worker.ts';

type SourceRow = {
  id: number;
  user_id: number;
  destination_id: number;
  type: 'imap' | 'pop';
  host: string;
  port: number;
  use_tls: number;
  username: string;
  password_encrypted: Buffer;
  destination_tag: string;
  poll_interval_seconds: number | null;
  post_import_action: string | null;
  enabled: number;
};

type DestinationRow = {
  id: number;
  user_id: number;
  type: string;
  account_identifier: string | null;
  credentials_encrypted: Buffer;
};

export type SyncManagerDeps = {
  db: Db;
  config: Config;
  log: WorkerLogger;
  clock?: Clock;
};

export class SyncManager {
  private readonly db: Db;
  private readonly config: Config;
  private readonly log: WorkerLogger;
  private readonly clock: Clock;
  private readonly workers = new Map<number, SourceWorker>();
  private readonly stopping1 = new Map<number, Promise<void>>();
  private readonly destinations = new Map<number, import('../destinations/types.ts').Destination>();
  private readonly destRefs = new Map<number, Set<number>>();
  private readonly sourceToDest = new Map<number, number>();
  private readonly tagCachePerSource = new Map<number, Map<string, string>>();
  private stopping = false;

  constructor(deps: SyncManagerDeps) {
    this.db = deps.db;
    this.config = deps.config;
    this.log = deps.log;
    this.clock = deps.clock ?? realClock;
  }

  async startAll(): Promise<void> {
    const rows = this.db
      .prepare(
        'SELECT id, user_id, destination_id, type, host, port, use_tls, username, password_encrypted, destination_tag, poll_interval_seconds, post_import_action, enabled FROM sources WHERE enabled = 1',
      )
      .all() as SourceRow[];
    for (const row of rows) {
      try {
        await this.startOne(row);
      } catch (err) {
        this.log('error', 'failed to start worker for source', {
          sourceId: row.id,
          error: err instanceof Error ? err.message : String(err),
        });
        recordLastError(this.db, row.id, err);
      }
    }
  }

  async reloadSource(sourceId: number): Promise<void> {
    if (this.stopping) return;
    await this.stopOne(sourceId);
    const row = this.db
      .prepare(
        'SELECT id, user_id, destination_id, type, host, port, use_tls, username, password_encrypted, destination_tag, poll_interval_seconds, post_import_action, enabled FROM sources WHERE id = ?',
      )
      .get(sourceId) as SourceRow | undefined;
    if (!row || row.enabled !== 1) return;
    try {
      await this.startOne(row);
    } catch (err) {
      this.log('error', 'failed to reload worker', {
        sourceId,
        error: err instanceof Error ? err.message : String(err),
      });
      recordLastError(this.db, sourceId, err);
    }
  }

  async stopOne(sourceId: number): Promise<void> {
    const existing = this.stopping1.get(sourceId);
    if (existing) return existing;
    const w = this.workers.get(sourceId);
    if (!w) return;
    const p = (async () => {
      try {
        await w.stop();
      } finally {
        if (this.workers.get(sourceId) === w) this.workers.delete(sourceId);
        this.releaseDestinationFor(sourceId);
        this.stopping1.delete(sourceId);
      }
    })();
    this.stopping1.set(sourceId, p);
    return p;
  }

  private releaseDestinationFor(sourceId: number): void {
    const destId = this.sourceToDest.get(sourceId);
    if (destId === undefined) return;
    this.sourceToDest.delete(sourceId);
    const refs = this.destRefs.get(destId);
    if (!refs) return;
    refs.delete(sourceId);
    if (refs.size === 0) {
      const inst = this.destinations.get(destId);
      void inst?.dispose?.();
      this.destinations.delete(destId);
      this.destRefs.delete(destId);
    }
  }

  async stopAll(): Promise<void> {
    this.stopping = true;
    const ids = [...this.workers.keys()];
    await Promise.all(ids.map((id) => this.stopOne(id)));
  }

  async stopDestinationWorkers(destinationId: number): Promise<void> {
    const rows = this.db
      .prepare('SELECT id FROM sources WHERE destination_id = ?')
      .all(destinationId) as { id: number }[];
    await Promise.all(rows.map((r) => this.stopOne(r.id)));
  }

  async stopUserWorkers(userId: number): Promise<void> {
    const rows = this.db
      .prepare('SELECT id FROM sources WHERE user_id = ?')
      .all(userId) as { id: number }[];
    await Promise.all(rows.map((r) => this.stopOne(r.id)));
  }

  statuses(): Record<number, SourceStatus> {
    const out: Record<number, SourceStatus> = {};
    for (const [id, w] of this.workers) out[id] = w.status();
    return out;
  }

  private getTagCache(sourceId: number): Map<string, string> {
    let c = this.tagCachePerSource.get(sourceId);
    if (!c) {
      c = new Map();
      this.tagCachePerSource.set(sourceId, c);
    }
    return c;
  }

  private async startOne(row: SourceRow): Promise<void> {
    const dest = this.db
      .prepare(
        'SELECT id, user_id, type, account_identifier, credentials_encrypted FROM destinations WHERE id = ?',
      )
      .get(row.destination_id) as DestinationRow | undefined;
    if (!dest) throw new Error(`source ${row.id} references missing destination ${row.destination_id}`);

    const factory = getDestinationFactory(dest.type);
    if (!factory) throw new Error(`no factory for destination type ${dest.type}`);

    let adminConfig: unknown = null;
    if (dest.type === 'gmail') {
      adminConfig = getGmailOAuthClient(this.db, this.config.encryptionKeys);
      if (!adminConfig) {
        throw new Error('Gmail admin OAuth client not configured; ask an admin to set it');
      }
    }
    const userCreds = decryptJson<unknown>(
      dest.credentials_encrypted,
      this.config.encryptionKeys,
      `destinations.credentials:${dest.id}`,
    );

    const destinationId = dest.id;
    let destination = this.destinations.get(destinationId);
    if (!destination) {
      destination = factory.createDestination({
        adminConfig,
        userCredentials: userCreds,
        onCredentialsRefreshed: (newCreds) => {
          try {
            const enc = encryptJson(
              newCreds,
              this.config.encryptionKeys,
              `destinations.credentials:${destinationId}`,
            );
            this.db
              .prepare('UPDATE destinations SET credentials_encrypted = ? WHERE id = ?')
              .run(enc, destinationId);
          } catch (err) {
            this.log('error', 'failed to persist refreshed credentials', {
              destinationId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        },
      });
      this.destinations.set(destinationId, destination);
    }
    let refs = this.destRefs.get(destinationId);
    if (!refs) {
      refs = new Set();
      this.destRefs.set(destinationId, refs);
    }
    refs.add(row.id);
    this.sourceToDest.set(row.id, destinationId);

    const password = decrypt(
      row.password_encrypted,
      this.config.encryptionKeys,
      `sources.password:${row.id}`,
    ).toString('utf8');

    const tagCache = this.getTagCache(row.id);

    const deps = {
      db: this.db,
      destination,
      destinationTag: row.destination_tag,
      sourceId: row.id,
      clock: this.clock,
      log: this.log,
      tagCache,
    };

    let worker: SourceWorker;
    if (row.type === 'imap') {
      worker = new ImapSourceWorker(deps, {
        host: row.host,
        port: row.port,
        useTls: row.use_tls === 1,
        username: row.username,
        password,
        postImportAction: coercePostImportAction(row.post_import_action),
      });
    } else {
      worker = new PopSourceWorker(deps, {
        host: row.host,
        port: row.port,
        useTls: row.use_tls === 1,
        username: row.username,
        password,
        pollIntervalSeconds: row.poll_interval_seconds ?? 300,
      });
    }

    this.workers.set(row.id, worker);
    await worker.start();
  }
}

function coercePostImportAction(raw: string | null): 'none' | 'mark_read' | 'delete' {
  if (raw === 'mark_read' || raw === 'delete') return raw;
  return 'none';
}
