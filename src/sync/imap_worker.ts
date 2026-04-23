import { ImapFlow, type FetchMessageObject } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { Db } from '../db/index.ts';
import {
  type SourceWorker,
  type SourceStatus,
  type WorkerDeps,
  newBackoff,
  recordActivity,
  recordLastError,
  recordLastSuccess,
} from './worker.ts';
import { importOne, type ImportContext, MAX_MESSAGE_BYTES } from './import_flow.ts';

export function seedInboxFolderIfMissing(db: Db, sourceId: number): { label: string } | null {
  const seed = db.transaction(() => {
    const n = db
      .prepare('SELECT COUNT(*) AS n FROM source_folders WHERE source_id = ?')
      .get(sourceId) as { n: number };
    if (n.n > 0) return null;
    const src = db
      .prepare('SELECT destination_tag FROM sources WHERE id = ?')
      .get(sourceId) as { destination_tag: string } | undefined;
    const label = src?.destination_tag && src.destination_tag.length > 0 ? src.destination_tag : 'INBOX';
    const ss = db
      .prepare('SELECT uidvalidity, last_uid FROM sync_state WHERE source_id = ?')
      .get(sourceId) as { uidvalidity: number | null; last_uid: number | null } | undefined;
    db.prepare(
      "INSERT OR IGNORE INTO source_folders (source_id, folder_path, label_name, enabled, uidvalidity, last_uid, updated_at) VALUES (?, 'INBOX', ?, 1, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
    ).run(sourceId, label, ss?.uidvalidity ?? null, ss?.last_uid ?? 0);
    return { label };
  });
  return seed();
}

type ImapConfig = {
  host: string;
  port: number;
  useTls: boolean;
  username: string;
  password: string;
  postImportAction: 'none' | 'mark_read' | 'delete';
};

type FolderSpec = {
  path: string;
  label: string;
};

type FolderStateRow = {
  folder_path: string;
  label_name: string;
  enabled: number;
  uidvalidity: number | null;
  last_uid: number;
};

export class ImapSourceWorker implements SourceWorker {
  readonly sourceId: number;
  private client: ImapFlow | null = null;
  private running = false;
  private stopping = false;
  private lastError: string | null = null;
  private lastSyncAt: string | null = null;
  private readonly backoff = newBackoff();
  private retryTimer: { clear: () => void } | null = null;
  private loopPromise: Promise<void> | null = null;

  constructor(
    private readonly deps: WorkerDeps,
    private readonly imap: ImapConfig,
  ) {
    this.sourceId = deps.sourceId;
  }

  status(): SourceStatus {
    return {
      id: this.sourceId,
      connected: this.client?.authenticated === true,
      lastError: this.lastError,
      lastSyncAt: this.lastSyncAt,
    };
  }

  async start(): Promise<void> {
    if (this.running || this.stopping) return;
    this.running = true;
    this.loopPromise = this.runLoop();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.running = false;
    if (this.retryTimer) {
      this.retryTimer.clear();
      this.retryTimer = null;
    }
    if (this.client) {
      try {
        await this.client.logout();
      } catch {
        // Best effort on shutdown.
      }
      this.client = null;
    }
    if (this.loopPromise) {
      try {
        await this.loopPromise;
      } catch {
        /* swallow */
      }
    }
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.connectAndStream();
        this.backoff.reset();
      } catch (err) {
        // Cleanup any partially-connected client so FDs/sockets don't leak
        // across reconnect cycles.
        if (this.client) {
          try {
            await this.client.logout();
          } catch {
            /* best-effort */
          }
          this.client = null;
        }
        if (!this.running) return;
        this.lastError = err instanceof Error ? err.message : String(err);
        recordLastError(this.deps.db, this.sourceId, err);
        this.deps.log('error', 'imap worker error, backing off', {
          sourceId: this.sourceId,
          error: this.lastError,
        });
        const delay = this.backoff.nextDelayMs();
        await new Promise<void>((resolve) => {
          const t = this.deps.clock.setTimeout(() => {
            this.retryTimer = null;
            resolve();
          }, delay);
          // stop() calls clear() to abort the wait; make sure the awaited
          // promise resolves too, otherwise stop() hangs on loopPromise.
          this.retryTimer = {
            clear: () => {
              t.clear();
              this.retryTimer = null;
              resolve();
            },
          };
        });
      }
    }
  }

  private async connectAndStream(): Promise<void> {
    this.ensureFolderSeed();

    const client = new ImapFlow({
      host: this.imap.host,
      port: this.imap.port,
      secure: this.imap.useTls,
      auth: { user: this.imap.username, pass: this.imap.password },
      logger: false,
      socketTimeout: 60_000,
      connectionTimeout: 15_000,
      // idle() does not resolve on its own; without maxIdleTime our worker
      // would block in IDLE forever and never re-scan folders. 9 minutes is
      // safely under the 29-minute IDLE cap recommended by RFC 2177.
      maxIdleTime: 9 * 60 * 1000,
    });
    // Register both handlers before connect() so an immediate RST does not
    // escape to the process as an unhandled 'error'. Also skip during stop so
    // graceful logout() does not stamp last_error.
    client.on('error', (err) => {
      if (this.running && !this.stopping) {
        this.lastError = err instanceof Error ? err.message : String(err);
        recordLastError(this.deps.db, this.sourceId, err as Error);
      }
    });
    client.on('close', () => {
      if (this.running && !this.stopping) {
        const err = new Error('imap connection closed');
        this.lastError = err.message;
        recordLastError(this.deps.db, this.sourceId, err);
      }
    });
    this.client = client;

    await client.connect();
    this.deps.log('info', 'imap connected', {
      sourceId: this.sourceId,
      host: this.imap.host,
      port: this.imap.port,
      tls: this.imap.useTls,
    });

    await this.syncAllFolders();
    recordLastSuccess(this.deps.db, this.sourceId);
    this.lastSyncAt = new Date().toISOString();

    // IDLE on INBOX; on wake, re-scan every enabled folder.
    while (this.running && this.client?.authenticated) {
      const c = this.client;
      if (!c) return;
      await c.mailboxOpen('INBOX', { readOnly: false });
      try {
        await c.idle();
      } catch (err) {
        if (!this.running) return;
        throw err;
      }
      if (!this.running) return;
      await this.syncAllFolders();
      recordLastSuccess(this.deps.db, this.sourceId);
      this.lastSyncAt = new Date().toISOString();
    }
    // If the loop exited because authenticated flipped false (socket dropped
    // without the awaited call throwing), surface that to runLoop so backoff
    // kicks in instead of immediately reconnecting.
    if (this.running && this.client && !this.client.authenticated) {
      throw new Error('imap connection lost');
    }
  }

  private enabledFolders(): FolderSpec[] {
    const rows = this.deps.db
      .prepare(
        'SELECT folder_path, label_name, enabled, uidvalidity, last_uid FROM source_folders WHERE source_id = ? AND enabled = 1 ORDER BY CASE folder_path WHEN ? THEN 0 ELSE 1 END, folder_path',
      )
      .all(this.sourceId, 'INBOX') as FolderStateRow[];
    return rows.map((r) => ({ path: r.folder_path, label: r.label_name }));
  }

  private ensureFolderSeed(): void {
    const seeded = seedInboxFolderIfMissing(this.deps.db, this.sourceId);
    if (seeded) {
      this.deps.log('info', 'seeded source_folders row for legacy source', {
        sourceId: this.sourceId,
        label: seeded.label,
      });
    }
  }

  private async syncAllFolders(): Promise<void> {
    const client = this.client;
    if (!client) return;
    const folders = this.enabledFolders();
    let firstErr: unknown = null;
    for (const f of folders) {
      if (!this.running) return;
      try {
        await this.syncFolder(client, f);
      } catch (err) {
        // Per-folder isolation: one broken folder should not block INBOX and
        // other healthy folders. Record for the user but continue. Surface
        // the earliest error via the outer loop so reconnect kicks in only
        // after we tried everything.
        const msg = err instanceof Error ? err.message : String(err);
        this.deps.log('warn', 'imap folder sync failed', {
          sourceId: this.sourceId,
          folder: f.path,
          error: msg,
        });
        if (firstErr == null) firstErr = err;
        // Connection-level failures should short-circuit.
        if (!client.authenticated) break;
      }
    }
    if (firstErr != null) throw firstErr;
  }

  private async syncFolder(client: ImapFlow, f: FolderSpec): Promise<void> {
    const mailbox = await client.mailboxOpen(f.path, { readOnly: false });
    await this.reconcileUidValidity(f.path, mailbox.uidValidity);
    await this.catchUp(client, f);
  }

  private async reconcileUidValidity(folderPath: string, current: bigint | number | undefined): Promise<void> {
    const row = this.deps.db
      .prepare('SELECT uidvalidity, last_uid FROM source_folders WHERE source_id = ? AND folder_path = ?')
      .get(this.sourceId, folderPath) as { uidvalidity: number | null; last_uid: number | null } | undefined;
    const cur = Number(current ?? 0);
    if (!row) {
      this.deps.db
        .prepare(
          "INSERT OR IGNORE INTO source_folders (source_id, folder_path, label_name, enabled, uidvalidity, last_uid, updated_at) VALUES (?, ?, ?, 1, ?, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
        )
        .run(this.sourceId, folderPath, folderPath, cur);
      return;
    }
    if ((row.uidvalidity ?? 0) !== cur) {
      this.deps.log('warn', 'UIDVALIDITY changed for folder; resetting last_uid (Message-ID dedup will prevent re-imports)', {
        sourceId: this.sourceId,
        folder: folderPath,
        was: row.uidvalidity,
        now: cur,
      });
      this.deps.db
        .prepare(
          "UPDATE source_folders SET uidvalidity = ?, last_uid = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE source_id = ? AND folder_path = ?",
        )
        .run(cur, this.sourceId, folderPath);
    }
  }

  private async catchUp(client: ImapFlow, f: FolderSpec): Promise<void> {
    const row = this.deps.db
      .prepare('SELECT last_uid FROM source_folders WHERE source_id = ? AND folder_path = ?')
      .get(this.sourceId, f.path) as { last_uid: number | null } | undefined;
    const lastUid = row?.last_uid ?? 0;

    const searchResult = await client.search({ uid: `${lastUid + 1}:*` }, { uid: true });
    // Some servers return the highest-existing UID for N:* against an empty
    // tail, which would cause us to re-fetch the cursor row every cycle. Drop
    // anything we already passed.
    const uids: number[] = (Array.isArray(searchResult) ? searchResult : []).filter((u) => u > lastUid);

    let imported = 0;
    let skipped = 0;
    for (const uid of uids) {
      if (!this.running) return;
      const outcome = await this.fetchAndImport(client, f, uid);
      if (outcome === 'imported') imported += 1;
      else if (outcome === 'skipped') skipped += 1;
    }
    if (imported + skipped > 0) {
      this.deps.log('info', 'imap catch-up done', {
        sourceId: this.sourceId,
        folder: f.path,
        seen: uids.length,
        imported,
        skipped,
      });
    }
  }

  private async fetchAndImport(
    client: ImapFlow,
    f: FolderSpec,
    uid: number,
  ): Promise<'imported' | 'skipped' | 'deduplicated' | 'nothing'> {
    let msg: FetchMessageObject | undefined;
    const iter = client.fetch(
      `${uid}`,
      { source: true, size: true, uid: true, envelope: true, flags: true },
      { uid: true },
    );
    for await (const m of iter) {
      msg = m;
      break;
    }
    if (!msg || !msg.source) {
      // The UID was returned by SEARCH but the server produced no source for
      // it (expunge race, permission loss, etc). Advance past it so we don't
      // loop on a tombstone every cycle.
      this.advanceUid(f.path, uid);
      return 'nothing';
    }

    const size = Number(msg.size ?? msg.source.length);
    const raw = Buffer.isBuffer(msg.source) ? msg.source : Buffer.from(msg.source as unknown as Uint8Array);
    if (size > MAX_MESSAGE_BYTES) {
      this.deps.db.prepare('UPDATE sources SET skipped_count = skipped_count + 1 WHERE id = ?').run(this.sourceId);
      this.deps.log('warn', 'imap message over size limit, skipped', {
        sourceId: this.sourceId,
        folder: f.path,
        uid,
        size,
      });
      this.advanceUid(f.path, uid);
      return 'skipped';
    }

    const parsed = await simpleParser(raw);
    const messageIdHeader = parsed.messageId ?? null;
    const dateHeader = parsed.date ?? null;

    const alreadySeen = flagsHas(msg.flags, '\\Seen');

    const ctx = this.importContext();
    const outcome = await importOne(ctx, {
      raw,
      messageIdHeader,
      dateHeader,
      externalUid: `${f.path}:${uid}`,
      alreadySeen,
      labelOverride: f.label,
    });

    this.advanceUid(f.path, uid);
    recordActivity(this.deps.db, this.sourceId);
    this.lastSyncAt = new Date().toISOString();

    if (outcome.kind === 'imported') {
      await this.applyPostImportAction(client, uid);
      return 'imported';
    }
    if (outcome.kind === 'deduplicated') return 'deduplicated';
    if (outcome.kind === 'skipped-too-large' || outcome.kind === 'skipped-no-message-id') return 'skipped';
    return 'nothing';
  }

  private advanceUid(folderPath: string, uid: number): void {
    this.deps.db
      .prepare(
        "UPDATE source_folders SET last_uid = MAX(last_uid, ?), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE source_id = ? AND folder_path = ?",
      )
      .run(uid, this.sourceId, folderPath);
  }

  private async applyPostImportAction(client: ImapFlow, uid: number): Promise<void> {
    const action = this.imap.postImportAction;
    if (action === 'none') return;
    try {
      if (action === 'mark_read') {
        await client.messageFlagsAdd(`${uid}`, ['\\Seen'], { uid: true });
      } else if (action === 'delete') {
        // ImapFlow's messageDelete marks \Deleted and expunges the UID.
        await client.messageDelete(`${uid}`, { uid: true });
      }
    } catch (err) {
      this.deps.log('warn', 'post-import action failed', {
        sourceId: this.sourceId,
        action,
        uid,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private importContext(): ImportContext {
    return {
      db: this.deps.db,
      destination: this.deps.destination,
      destinationTag: this.deps.destinationTag,
      sourceId: this.sourceId,
      tagCache: this.deps.tagCache,
      log: this.deps.log,
    };
  }
}

function flagsHas(flags: unknown, name: string): boolean {
  if (!flags) return false;
  if (flags instanceof Set) return flags.has(name);
  if (Array.isArray(flags)) return flags.includes(name);
  const sym = (flags as { [Symbol.iterator]?: () => Iterator<string> })[Symbol.iterator];
  if (typeof sym === 'function') {
    const it = sym.call(flags);
    let step = it.next();
    while (!step.done) {
      if (step.value === name) return true;
      step = it.next();
    }
  }
  return false;
}
