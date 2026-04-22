import type { Db } from '../db/index.ts';
import type { Destination } from '../destinations/types.ts';

export const MAX_MESSAGE_BYTES = 35 * 1024 * 1024;

export type RawMessage = {
  raw: Buffer;
  messageIdHeader: string | null;
  dateHeader: Date | null;
  externalUid: string;
};

export type ImportOutcome =
  | { kind: 'imported'; destinationMessageId: string }
  | { kind: 'deduplicated' }
  | { kind: 'skipped-too-large' }
  | { kind: 'skipped-no-message-id' };

export class ImportError extends Error {
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    if (cause !== undefined) this.cause = cause;
  }
}

function dedupRow(
  db: Db,
  sourceId: number,
  messageId: string,
): boolean {
  const row = db
    .prepare(
      'SELECT 1 FROM imported_messages WHERE source_id = ? AND message_id_header = ?',
    )
    .get(sourceId, messageId);
  return row !== undefined;
}

function insertImported(
  db: Db,
  sourceId: number,
  messageId: string,
  externalUid: string,
  destinationMessageId: string,
): void {
  db.prepare(
    'INSERT INTO imported_messages (source_id, message_id_header, external_uid, destination_message_id) VALUES (?, ?, ?, ?)',
  ).run(sourceId, messageId, externalUid, destinationMessageId);
}

export function incrementSkipped(db: Db, sourceId: number, n = 1): void {
  db.prepare('UPDATE sources SET skipped_count = skipped_count + ? WHERE id = ?').run(
    n,
    sourceId,
  );
}

function resolveTagCacheKey(sourceId: number, tag: string): string {
  return `${sourceId}:${tag}`;
}

export type ImportContext = {
  db: Db;
  destination: Destination;
  destinationTag: string;
  sourceId: number;
  tagCache: Map<string, string>;
  log: (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void;
};

async function resolveTag(ctx: ImportContext): Promise<string> {
  const key = resolveTagCacheKey(ctx.sourceId, ctx.destinationTag);
  const cached = ctx.tagCache.get(key);
  if (cached) return cached;
  const id = await ctx.destination.ensureTag(ctx.destinationTag);
  ctx.tagCache.set(key, id);
  return id;
}

export async function importOne(
  ctx: ImportContext,
  msg: RawMessage,
): Promise<ImportOutcome> {
  if (!msg.messageIdHeader) {
    incrementSkipped(ctx.db, ctx.sourceId);
    ctx.log('warn', 'skipping message without Message-ID header', {
      sourceId: ctx.sourceId,
      externalUid: msg.externalUid,
    });
    return { kind: 'skipped-no-message-id' };
  }

  if (msg.raw.length > MAX_MESSAGE_BYTES) {
    incrementSkipped(ctx.db, ctx.sourceId);
    ctx.log('warn', 'skipping message over 35 MB', {
      sourceId: ctx.sourceId,
      bytes: msg.raw.length,
      messageId: msg.messageIdHeader,
    });
    return { kind: 'skipped-too-large' };
  }

  if (dedupRow(ctx.db, ctx.sourceId, msg.messageIdHeader)) {
    return { kind: 'deduplicated' };
  }

  const tagId = await resolveTag(ctx);
  const originalDate = msg.dateHeader ?? new Date();

  let destId: string;
  try {
    destId = await ctx.destination.importMessage(msg.raw, tagId, originalDate);
  } catch (err) {
    throw new ImportError(
      'destination.importMessage failed; message is NOT marked imported (will retry next cycle)',
      err,
    );
  }

  try {
    insertImported(
      ctx.db,
      ctx.sourceId,
      msg.messageIdHeader,
      msg.externalUid,
      destId,
    );
  } catch (err) {
    ctx.log(
      'error',
      'destination accepted message but imported_messages INSERT failed -- next cycle may create a destination-side duplicate of this Message-ID',
      {
        sourceId: ctx.sourceId,
        messageId: msg.messageIdHeader,
        destinationMessageId: destId,
        error: err instanceof Error ? err.message : String(err),
      },
    );
    throw new ImportError('post-import DB insert failed', err);
  }

  return { kind: 'imported', destinationMessageId: destId };
}
