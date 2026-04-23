import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../src/db/index.ts';
import { importOne, type ImportContext } from '../../src/sync/import_flow.ts';
import type { Destination, ImportOptions, ProbeResult } from '../../src/destinations/types.ts';

function makeStub() {
  const state = {
    ensureTagCalls: [] as string[],
    imports: [] as Array<{ tagId: string; options?: ImportOptions }>,
    nextImportId: 'dest-1',
  };
  const destination: Destination = {
    type: 'fake',
    async ensureTag(name: string): Promise<string> {
      state.ensureTagCalls.push(name);
      return 'label-' + name;
    },
    async importMessage(_raw: Buffer, tagId: string, _date: Date, options?: ImportOptions): Promise<string> {
      state.imports.push({ tagId, ...(options ? { options } : {}) });
      return state.nextImportId;
    },
    async probe(): Promise<ProbeResult> {
      return { ok: true, email: 'x@x' };
    },
  };
  return { state, destination };
}

function makeCtx(db: ReturnType<typeof openDb>, sourceId: number, destination: Destination): ImportContext {
  return {
    db,
    destination,
    destinationTag: 'DefaultLabel',
    sourceId,
    tagCache: new Map(),
    log: () => {},
  };
}

function prepDb() {
  const db = openDb(':memory:');
  const u = db
    .prepare("INSERT INTO users (username, password_hash) VALUES ('u', 'x') RETURNING id")
    .get() as { id: number };
  const d = db
    .prepare("INSERT INTO destinations (user_id, type, credentials_encrypted) VALUES (?, 'gmail', x'00') RETURNING id")
    .get(u.id) as { id: number };
  const s = db
    .prepare("INSERT INTO sources (user_id, destination_id, name, type, host, port, username, password_encrypted, destination_tag, poll_interval_seconds) VALUES (?, ?, 's', 'imap', 'h', 993, 'u', x'00', 'DefaultLabel', NULL) RETURNING id")
    .get(u.id, d.id) as { id: number };
  return { db, sourceId: s.id };
}

test('labelOverride wins over context destinationTag', async () => {
  const { db, sourceId } = prepDb();
  const { state, destination } = makeStub();
  await importOne(makeCtx(db, sourceId, destination), {
    raw: Buffer.from('hi'),
    messageIdHeader: '<a@x>',
    dateHeader: null,
    externalUid: 'INBOX:1',
    labelOverride: 'Ext/Work',
  });
  assert.deepEqual(state.ensureTagCalls, ['Ext/Work']);
  assert.equal(state.imports[0]!.tagId, 'label-Ext/Work');
  db.close();
});

test('alreadySeen propagates to importMessage', async () => {
  const { db, sourceId } = prepDb();
  const { state, destination } = makeStub();
  await importOne(makeCtx(db, sourceId, destination), {
    raw: Buffer.from('hi'),
    messageIdHeader: '<b@x>',
    dateHeader: null,
    externalUid: 'INBOX:2',
    alreadySeen: true,
    labelOverride: 'Ext',
  });
  assert.equal(state.imports[0]!.options?.alreadySeen, true);
  db.close();
});

test('no labelOverride -> falls back to destinationTag', async () => {
  const { db, sourceId } = prepDb();
  const { state, destination } = makeStub();
  await importOne(makeCtx(db, sourceId, destination), {
    raw: Buffer.from('hi'),
    messageIdHeader: '<c@x>',
    dateHeader: null,
    externalUid: 'INBOX:3',
  });
  assert.deepEqual(state.ensureTagCalls, ['DefaultLabel']);
  db.close();
});
