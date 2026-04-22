import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/index.ts';
import {
  ImportError,
  MAX_MESSAGE_BYTES,
  importOne,
  type ImportContext,
} from '../../src/sync/import_flow.ts';
import type { Destination, ProbeResult } from '../../src/destinations/types.ts';
import { hashPassword } from '../../src/auth/hash.ts';

type Stub = {
  destination: Destination;
  ensureTagCalls: number;
  importCalls: Array<{ tagId: string; bytes: number; date: Date }>;
  nextImportId: string;
  throwOnImport?: string;
};

function makeStub(): Stub {
  const s: Stub = {
    ensureTagCalls: 0,
    importCalls: [],
    nextImportId: 'dest-1',
    destination: undefined as unknown as Destination,
  };
  s.destination = {
    type: 'fake',
    async ensureTag(name: string): Promise<string> {
      s.ensureTagCalls += 1;
      return 'label-' + name;
    },
    async importMessage(raw: Buffer, tagId: string, originalDate: Date): Promise<string> {
      if (s.throwOnImport) throw new Error(s.throwOnImport);
      s.importCalls.push({ tagId, bytes: raw.length, date: originalDate });
      return s.nextImportId;
    },
    async probe(): Promise<ProbeResult> {
      return { ok: true, email: 'x@x' };
    },
  };
  return s;
}

type Collected = Array<{ level: string; msg: string; meta?: Record<string, unknown> }>;

function makeLog(collected: Collected) {
  return (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => {
    const entry: Collected[number] = { level, msg, ...(meta ? { meta } : {}) };
    collected.push(entry);
  };
}

async function prepareDb(): Promise<{
  db: Database.Database;
  sourceId: number;
}> {
  const db = openDb(':memory:');
  const userHash = await hashPassword('pw');
  const u = db
    .prepare(
      "INSERT INTO users (username, password_hash, is_admin) VALUES ('u', ?, 0) RETURNING id",
    )
    .get(userHash) as { id: number };
  const d = db
    .prepare(
      "INSERT INTO destinations (user_id, type, credentials_encrypted) VALUES (?, 'gmail', x'00') RETURNING id",
    )
    .get(u.id) as { id: number };
  const s = db
    .prepare(
      "INSERT INTO sources (user_id, destination_id, name, type, host, port, username, password_encrypted, destination_tag, poll_interval_seconds) VALUES (?, ?, 's', 'pop', 'h', 110, 'u', x'00', 'External/Yahoo', 300) RETURNING id",
    )
    .get(u.id, d.id) as { id: number };
  return { db, sourceId: s.id };
}

function ctx(db: Database.Database, sourceId: number, stub: Stub, log: Collected): ImportContext {
  return {
    db,
    destination: stub.destination,
    destinationTag: 'External/Yahoo',
    sourceId,
    tagCache: new Map(),
    log: makeLog(log),
  };
}

test('imports a message and inserts dedup row', async () => {
  const { db, sourceId } = await prepareDb();
  const stub = makeStub();
  const log: Collected = [];

  const out = await importOne(ctx(db, sourceId, stub, log), {
    raw: Buffer.from('Subject: hi\r\n\r\nbody'),
    messageIdHeader: '<abc@x>',
    dateHeader: new Date('2026-04-01T00:00:00Z'),
    externalUid: '42',
  });
  assert.deepEqual(out, { kind: 'imported', destinationMessageId: 'dest-1' });
  assert.equal(stub.importCalls.length, 1);

  const row = db
    .prepare(
      'SELECT source_id, message_id_header, external_uid, destination_message_id FROM imported_messages',
    )
    .get() as { source_id: number; message_id_header: string; external_uid: string; destination_message_id: string };
  assert.equal(row.message_id_header, '<abc@x>');
  assert.equal(row.external_uid, '42');
  assert.equal(row.destination_message_id, 'dest-1');
  db.close();
});

test('dedup: re-running with same Message-ID does not import again', async () => {
  const { db, sourceId } = await prepareDb();
  const stub = makeStub();
  const log: Collected = [];

  const msg = {
    raw: Buffer.from('Subject: hi\r\n\r\nbody'),
    messageIdHeader: '<abc@x>',
    dateHeader: new Date(),
    externalUid: '7',
  };
  await importOne(ctx(db, sourceId, stub, log), msg);
  stub.nextImportId = 'dest-2';
  const second = await importOne(ctx(db, sourceId, stub, log), msg);
  assert.deepEqual(second, { kind: 'deduplicated' });
  assert.equal(stub.importCalls.length, 1, 'destination.importMessage should be called only once');
  db.close();
});

test('skips messages larger than 35 MB and bumps skipped_count', async () => {
  const { db, sourceId } = await prepareDb();
  const stub = makeStub();
  const log: Collected = [];
  const big = Buffer.alloc(MAX_MESSAGE_BYTES + 1);
  const out = await importOne(ctx(db, sourceId, stub, log), {
    raw: big,
    messageIdHeader: '<big@x>',
    dateHeader: null,
    externalUid: 'u1',
  });
  assert.deepEqual(out, { kind: 'skipped-too-large' });
  assert.equal(stub.importCalls.length, 0);
  const c = db
    .prepare('SELECT skipped_count FROM sources WHERE id = ?')
    .get(sourceId) as { skipped_count: number };
  assert.equal(c.skipped_count, 1);
  db.close();
});

test('skips messages with no Message-ID header', async () => {
  const { db, sourceId } = await prepareDb();
  const stub = makeStub();
  const log: Collected = [];
  const out = await importOne(ctx(db, sourceId, stub, log), {
    raw: Buffer.from('no id here'),
    messageIdHeader: null,
    dateHeader: null,
    externalUid: 'u1',
  });
  assert.deepEqual(out, { kind: 'skipped-no-message-id' });
  const c = db
    .prepare('SELECT skipped_count FROM sources WHERE id = ?')
    .get(sourceId) as { skipped_count: number };
  assert.equal(c.skipped_count, 1);
  db.close();
});

test('destination failure does NOT mark message imported', async () => {
  const { db, sourceId } = await prepareDb();
  const stub = makeStub();
  stub.throwOnImport = 'upstream exploded';
  const log: Collected = [];
  await assert.rejects(
    () =>
      importOne(ctx(db, sourceId, stub, log), {
        raw: Buffer.from('hi'),
        messageIdHeader: '<x@x>',
        dateHeader: null,
        externalUid: '1',
      }),
    ImportError,
  );
  const n = db
    .prepare('SELECT COUNT(*) AS n FROM imported_messages')
    .get() as { n: number };
  assert.equal(n.n, 0);
  db.close();
});

test('ensureTag is memoized within a context', async () => {
  const { db, sourceId } = await prepareDb();
  const stub = makeStub();
  const log: Collected = [];
  const c = ctx(db, sourceId, stub, log);

  await importOne(c, {
    raw: Buffer.from('a'),
    messageIdHeader: '<a@x>',
    dateHeader: null,
    externalUid: '1',
  });
  await importOne(c, {
    raw: Buffer.from('b'),
    messageIdHeader: '<b@x>',
    dateHeader: null,
    externalUid: '2',
  });
  assert.equal(stub.ensureTagCalls, 1);
  db.close();
});

test('when DB insert fails post-import, logs loudly and throws ImportError', async () => {
  const { db, sourceId } = await prepareDb();
  const stub = makeStub();
  const log: Collected = [];
  const c = ctx(db, sourceId, stub, log);

  const originalPrepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    if (sql.startsWith('INSERT INTO imported_messages')) {
      return {
        run: () => {
          throw new Error('simulated DB failure');
        },
      } as unknown as ReturnType<typeof originalPrepare>;
    }
    return originalPrepare(sql);
  }) as typeof db.prepare;

  await assert.rejects(
    () =>
      importOne(c, {
        raw: Buffer.from('a'),
        messageIdHeader: '<new@x>',
        dateHeader: null,
        externalUid: 'u1',
      }),
    ImportError,
  );
  db.prepare = originalPrepare;

  assert.equal(stub.importCalls.length, 1, 'destination.importMessage must have been called');
  const hit = log.find((e) => e.level === 'error');
  assert.ok(hit, 'expected a loud error log about post-import DB failure');

  db.close();
});
