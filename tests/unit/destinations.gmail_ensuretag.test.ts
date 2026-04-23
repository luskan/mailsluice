import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GmailDestination } from '../../src/destinations/gmail.ts';

function makeDestWithLabelsStub(labels: Array<{ id: string; name: string }>) {
  const state = {
    listCalls: 0,
    createCalls: [] as Array<{ name: string }>,
    labels: [...labels],
    createError: null as null | { code?: number; status?: number; message: string },
  };
  const dest = new GmailDestination(
    { client_id: 'cid', client_secret: 'sec' },
    { refresh_token: 'rt', access_token: 'at', expiry_date: Date.now() + 3_600_000 },
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (dest as any).api = {
    users: {
      labels: {
        list: async () => {
          state.listCalls += 1;
          return { data: { labels: state.labels } };
        },
        create: async (arg: { requestBody: { name: string } }) => {
          state.createCalls.push({ name: arg.requestBody.name });
          if (state.createError) {
            const e = new Error(state.createError.message);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (e as any).code = state.createError.code;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (e as any).status = state.createError.status;
            throw e;
          }
          const id = 'Label_' + (state.labels.length + 1);
          state.labels.push({ id, name: arg.requestBody.name });
          return { data: { id } };
        },
      },
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (dest as any).ensureValidToken = async () => undefined;
  return { dest, state };
}

test('ensureTag matches existing label with different case', async () => {
  const { dest, state } = makeDestWithLabelsStub([
    { id: 'Label_17', name: 'External/Work' },
  ]);
  const id = await dest.ensureTag('external/work');
  assert.equal(id, 'Label_17');
  assert.equal(state.createCalls.length, 0, 'must not attempt to create');
});

test('ensureTag recovers from 409 by re-listing case-insensitively', async () => {
  const { dest, state } = makeDestWithLabelsStub([
    { id: 'Label_9', name: 'EXTERNAL' },
  ]);
  // Force the initial list to appear empty so create is attempted.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const origList = (dest as any).api.users.labels.list;
  let listN = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (dest as any).api.users.labels.list = async () => {
    listN += 1;
    if (listN === 1) return { data: { labels: [] } };
    return origList();
  };
  state.createError = { code: 409, message: 'Label name exists or conflicts' };

  const id = await dest.ensureTag('external');
  assert.equal(id, 'Label_9');
  assert.equal(state.createCalls.length, 1, 'create was attempted');
  assert.equal(listN, 2, 'list ran twice (initial + retry)');
});

test('ensureTag surfaces a helpful error when 409 cannot be resolved', async () => {
  const { dest, state } = makeDestWithLabelsStub([]);
  state.createError = { code: 409, message: 'Label name exists or conflicts' };
  await assert.rejects(
    () => dest.ensureTag('INBOX'),
    /Gmail rejected label "INBOX"/,
  );
  // Tried: initial list (empty), create (409), retry list (still no match).
  assert.equal(state.createCalls.length, 1);
});

test('ensureTag creates a new label when none exist', async () => {
  const { dest, state } = makeDestWithLabelsStub([]);
  const id = await dest.ensureTag('Fresh/Label');
  assert.equal(id, 'Label_1');
  assert.equal(state.createCalls.length, 1);
  assert.equal(state.createCalls[0]!.name, 'Fresh/Label');
});

test('ensureTag caches, second call does not hit the API', async () => {
  const { dest, state } = makeDestWithLabelsStub([
    { id: 'Label_3', name: 'Ext' },
  ]);
  await dest.ensureTag('ext');
  const before = state.listCalls;
  await dest.ensureTag('ext');
  assert.equal(state.listCalls, before, 'second ensureTag is cached');
});

test('ensureTag retries on GaxiosError-shaped 409 (err.response.status)', async () => {
  const { dest, state } = makeDestWithLabelsStub([
    { id: 'Label_99', name: 'Ext' },
  ]);
  // Make the first list appear empty so create is attempted.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const origList = (dest as any).api.users.labels.list;
  let listN = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (dest as any).api.users.labels.list = async () => {
    listN += 1;
    return listN === 1 ? { data: { labels: [] } } : origList();
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (dest as any).api.users.labels.create = async () => {
    const err = new Error('Label name exists or conflicts');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (err as any).response = { status: 409 };
    throw err;
  };
  const id = await dest.ensureTag('ext');
  assert.equal(id, 'Label_99');
  assert.equal(listN, 2);
  void state;
});

test('ensureTag normalizes Unicode / whitespace (NFC + trim + collapse)', async () => {
  // "Café" in decomposed form (C + a + f + e + combining acute).
  const decomposed = 'Café'.normalize('NFD');
  const { dest } = makeDestWithLabelsStub([
    { id: 'Label_7', name: 'Café'.normalize('NFC') },
  ]);
  const id = await dest.ensureTag(decomposed);
  assert.equal(id, 'Label_7');
});

test('ensureTag preserves underlying error via cause when final failure', async () => {
  const { dest, state } = makeDestWithLabelsStub([]);
  state.createError = { code: 409, message: 'Label name exists or conflicts' };
  try {
    await dest.ensureTag('INBOX');
    assert.fail('should have thrown');
  } catch (err) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cause = (err as any).cause;
    assert.ok(cause, 'cause must be preserved for upstream diagnostics');
    assert.match(String((cause as Error).message), /Label name exists/);
  }
});
