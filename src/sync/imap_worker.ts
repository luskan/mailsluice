import { ImapFlow, type FetchMessageObject } from 'imapflow';
import { simpleParser } from 'mailparser';
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

type ImapConfig = {
  host: string;
  port: number;
  useTls: boolean;
  username: string;
  password: string;
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
        if (!this.running) return;
        this.lastError = err instanceof Error ? err.message : String(err);
        recordLastError(this.deps.db, this.sourceId, err);
        this.deps.log('error', 'imap worker error, backing off', {
          sourceId: this.sourceId,
          error: this.lastError,
        });
        const delay = this.backoff.nextDelayMs();
        await new Promise<void>((resolve) => {
          this.retryTimer = this.deps.clock.setTimeout(resolve, delay);
        });
        this.retryTimer = null;
      }
    }
  }

  private async connectAndStream(): Promise<void> {
    this.client = new ImapFlow({
      host: this.imap.host,
      port: this.imap.port,
      secure: this.imap.useTls,
      auth: { user: this.imap.username, pass: this.imap.password },
      logger: false,
      socketTimeout: 60_000,
      connectionTimeout: 15_000,
    });
    // Unhandled 'error' on the EventEmitter crashes Node. We still see the
    // failure via the awaited connect() rejection and the close handler below.
    this.client.on('error', (err) => {
      if (this.running) {
        this.lastError = err instanceof Error ? err.message : String(err);
        recordLastError(this.deps.db, this.sourceId, err as Error);
      }
    });

    await this.client.connect();
    this.deps.log('info', 'imap connected', {
      sourceId: this.sourceId,
      host: this.imap.host,
      port: this.imap.port,
      tls: this.imap.useTls,
    });

    this.client.on('close', () => {
      if (this.running) {
        // surface via error loop
        const err = new Error('imap connection closed');
        this.lastError = err.message;
        recordLastError(this.deps.db, this.sourceId, err);
      }
    });

    const mailbox = await this.client.mailboxOpen('INBOX', { readOnly: false });
    await this.reconcileUidValidity(mailbox.uidValidity);

    await this.catchUp();
    recordLastSuccess(this.deps.db, this.sourceId);
    this.lastSyncAt = new Date().toISOString();

    while (this.running && this.client?.authenticated) {
      try {
        await this.client.idle();
      } catch (err) {
        if (!this.running) return;
        throw err;
      }
      if (!this.running) return;
      await this.catchUp();
      recordLastSuccess(this.deps.db, this.sourceId);
      this.lastSyncAt = new Date().toISOString();
    }
  }

  private async reconcileUidValidity(current: bigint | number | undefined): Promise<void> {
    const row = this.deps.db
      .prepare('SELECT uidvalidity, last_uid FROM sync_state WHERE source_id = ?')
      .get(this.sourceId) as { uidvalidity: number | null; last_uid: number | null } | undefined;
    const cur = Number(current ?? 0);
    if (!row) {
      this.deps.db
        .prepare(
          "INSERT INTO sync_state (source_id, uidvalidity, last_uid, updated_at) VALUES (?, ?, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
        )
        .run(this.sourceId, cur);
      return;
    }
    if ((row.uidvalidity ?? 0) !== cur) {
      this.deps.log('warn', 'UIDVALIDITY changed; resetting last_uid (Message-ID dedup will prevent re-imports)', {
        sourceId: this.sourceId,
        was: row.uidvalidity,
        now: cur,
      });
      this.deps.db
        .prepare(
          "UPDATE sync_state SET uidvalidity = ?, last_uid = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE source_id = ?",
        )
        .run(cur, this.sourceId);
    }
  }

  private async catchUp(): Promise<void> {
    if (!this.client) return;
    const row = this.deps.db
      .prepare('SELECT last_uid FROM sync_state WHERE source_id = ?')
      .get(this.sourceId) as { last_uid: number | null } | undefined;
    const lastUid = row?.last_uid ?? 0;

    const searchResult = await this.client.search({ uid: `${lastUid + 1}:*` }, { uid: true });
    const uids: number[] = Array.isArray(searchResult) ? searchResult : [];

    let imported = 0;
    let skipped = 0;
    for (const uid of uids) {
      if (!this.running) return;
      const outcome = await this.fetchAndImport(uid);
      if (outcome === 'imported') imported += 1;
      else if (outcome === 'skipped') skipped += 1;
    }
    if (uids.length > 0) {
      this.deps.log('info', 'imap catch-up done', {
        sourceId: this.sourceId,
        seen: uids.length,
        imported,
        skipped,
      });
    }
  }

  private async fetchAndImport(uid: number): Promise<'imported' | 'skipped' | 'deduplicated' | 'nothing'> {
    if (!this.client) return 'nothing';
    let msg: FetchMessageObject | undefined;
    const iter = this.client.fetch(
      `${uid}`,
      { source: true, size: true, uid: true, envelope: true },
      { uid: true },
    );
    for await (const m of iter) {
      msg = m;
      break;
    }
    if (!msg || !msg.source) {
      return 'nothing';
    }

    const size = Number(msg.size ?? msg.source.length);
    const raw = Buffer.isBuffer(msg.source) ? msg.source : Buffer.from(msg.source as unknown as Uint8Array);
    if (size > MAX_MESSAGE_BYTES) {
      this.deps.db.prepare('UPDATE sources SET skipped_count = skipped_count + 1 WHERE id = ?').run(this.sourceId);
      this.deps.log('warn', 'imap message over size limit, skipped', {
        sourceId: this.sourceId,
        uid,
        size,
      });
      // Advance last_uid so we do not re-fetch this message next cycle; Message-ID dedup
      // remains our authoritative guard if the same message appears via another route.
      this.deps.db
        .prepare(
          "UPDATE sync_state SET last_uid = MAX(last_uid, ?), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE source_id = ?",
        )
        .run(uid, this.sourceId);
      return 'skipped';
    }

    const parsed = await simpleParser(raw);
    const messageIdHeader = parsed.messageId ?? null;
    const dateHeader = parsed.date ?? null;

    const ctx = this.importContext();
    const outcome = await importOne(ctx, {
      raw,
      messageIdHeader,
      dateHeader,
      externalUid: String(uid),
    });

    const current = this.deps.db
      .prepare('SELECT last_uid FROM sync_state WHERE source_id = ?')
      .get(this.sourceId) as { last_uid: number | null } | undefined;
    const prev = current?.last_uid ?? 0;
    if (uid > prev) {
      this.deps.db
        .prepare(
          "UPDATE sync_state SET last_uid = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE source_id = ?",
        )
        .run(uid, this.sourceId);
    }
    recordActivity(this.deps.db, this.sourceId);
    this.lastSyncAt = new Date().toISOString();

    if (outcome.kind === 'imported') return 'imported';
    if (outcome.kind === 'deduplicated') return 'deduplicated';
    if (outcome.kind === 'skipped-too-large' || outcome.kind === 'skipped-no-message-id') return 'skipped';
    return 'nothing';
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
