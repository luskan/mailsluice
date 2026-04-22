import Pop3Command from 'node-pop3';
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
import { importOne } from './import_flow.ts';

export type PopConfig = {
  host: string;
  port: number;
  useTls: boolean;
  username: string;
  password: string;
  pollIntervalSeconds: number;
};

export class PopSourceWorker implements SourceWorker {
  readonly sourceId: number;
  private stopping = false;
  private running = false;
  private lastError: string | null = null;
  private lastSyncAt: string | null = null;
  private loop: Promise<void> | null = null;
  private waitTimer: { clear: () => void } | null = null;
  private readonly backoff = newBackoff();

  constructor(
    private readonly deps: WorkerDeps,
    private readonly pop: PopConfig,
  ) {
    this.sourceId = deps.sourceId;
  }

  status(): SourceStatus {
    return {
      id: this.sourceId,
      connected: false,
      lastError: this.lastError,
      lastSyncAt: this.lastSyncAt,
    };
  }

  async start(): Promise<void> {
    if (this.running || this.stopping) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.running = false;
    if (this.waitTimer) {
      this.waitTimer.clear();
      this.waitTimer = null;
    }
    if (this.loop) {
      try {
        await this.loop;
      } catch {
        /* swallow */
      }
    }
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        await this.pollOnce();
        this.backoff.reset();
        if (!this.running) return;
        await this.sleep(this.pop.pollIntervalSeconds * 1000);
      } catch (err) {
        if (!this.running) return;
        this.lastError = err instanceof Error ? err.message : String(err);
        recordLastError(this.deps.db, this.sourceId, err);
        this.deps.log('error', 'pop worker error, backing off', {
          sourceId: this.sourceId,
          error: this.lastError,
        });
        await this.sleep(this.backoff.nextDelayMs());
      }
    }
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      this.waitTimer = this.deps.clock.setTimeout(resolve, ms);
    });
    this.waitTimer = null;
  }

  private async pollOnce(): Promise<void> {
    const client = new Pop3Command({
      host: this.pop.host,
      port: this.pop.port,
      tls: this.pop.useTls,
      user: this.pop.username,
      password: this.pop.password,
      timeout: 30_000,
    });
    try {
      await client._connect();

      let list: string[][];
      try {
        const uidl = await client.UIDL();
        list = normalizeUidlResponse(uidl);
      } catch (err) {
        throw new Error(
          `server does not support UIDL or refused the request: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      this.deps.log('info', 'pop connected', {
        sourceId: this.sourceId,
        host: this.pop.host,
        port: this.pop.port,
        listed: list.length,
      });

      if (list.length === 0) {
        recordLastSuccess(this.deps.db, this.sourceId);
        this.lastSyncAt = new Date().toISOString();
        return;
      }

      const knownRows = this.deps.db
        .prepare(
          'SELECT external_uid FROM imported_messages WHERE source_id = ? AND external_uid IS NOT NULL',
        )
        .all(this.sourceId) as { external_uid: string }[];
      const seen = new Set(knownRows.map((r) => r.external_uid));
      let imported = 0;
      let skipped = 0;

      for (const pair of list) {
        if (!this.running) return;
        const msgNum = Number.parseInt(pair[0] ?? '', 10);
        const uidl = pair[1];
        if (!Number.isInteger(msgNum) || !uidl) continue;
        if (seen.has(uidl)) continue;

        let raw: Buffer;
        try {
          const resp = await client.RETR(msgNum);
          raw = Buffer.from(resp, 'utf8');
        } catch (err) {
          this.deps.log('warn', 'pop RETR failed; likely deleted between LIST and RETR', {
            sourceId: this.sourceId,
            msgNum,
            uidl,
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }

        const parsed = await simpleParser(raw);
        const messageIdHeader = parsed.messageId ?? null;
        const dateHeader = parsed.date ?? null;

        const outcome = await importOne(
          {
            db: this.deps.db,
            destination: this.deps.destination,
            destinationTag: this.deps.destinationTag,
            sourceId: this.sourceId,
            tagCache: this.deps.tagCache,
            log: this.deps.log,
          },
          {
            raw,
            messageIdHeader,
            dateHeader,
            externalUid: uidl,
          },
        );
        if (outcome.kind === 'imported') imported += 1;
        if (outcome.kind === 'skipped-too-large' || outcome.kind === 'skipped-no-message-id') skipped += 1;
        recordActivity(this.deps.db, this.sourceId);
        this.lastSyncAt = new Date().toISOString();
      }

      if (imported > 0 || skipped > 0) {
        this.deps.log('info', 'pop poll done', {
          sourceId: this.sourceId,
          listed: list.length,
          imported,
          skipped,
        });
      }
      recordLastSuccess(this.deps.db, this.sourceId);
      this.lastSyncAt = new Date().toISOString();
    } finally {
      try {
        await client.QUIT();
      } catch {
        // Best effort.
      }
    }
  }
}

function normalizeUidlResponse(r: string[][] | string[]): string[][] {
  if (!Array.isArray(r) || r.length === 0) return [];
  if (Array.isArray(r[0])) return r as string[][];
  // Single-message response is [msgNum, uid].
  return [r as string[]];
}
