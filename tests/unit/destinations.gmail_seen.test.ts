import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GmailDestination } from '../../src/destinations/gmail.ts';

type StubGmailCall = { kind: 'import'; labelIds?: string[] };

function makeDestWithStubApi(): { dest: GmailDestination; calls: StubGmailCall[] } {
  const calls: StubGmailCall[] = [];
  const dest = new GmailDestination(
    { client_id: 'cid', client_secret: 'sec' },
    { refresh_token: 'rt', access_token: 'at', expiry_date: Date.now() + 3_600_000 },
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (dest as any).api = {
    users: {
      messages: {
        import: async (arg: { requestBody: { labelIds?: string[] } }) => {
          calls.push({ kind: 'import', ...(arg.requestBody.labelIds ? { labelIds: arg.requestBody.labelIds } : {}) });
          return { data: { id: 'mid-1' } };
        },
      },
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (dest as any).ensureValidToken = async () => undefined;
  return { dest, calls };
}

test('importMessage applies INBOX + UNREAD + tag by default', async () => {
  const { dest, calls } = makeDestWithStubApi();
  await dest.importMessage(Buffer.from('raw'), 'Label_1', new Date());
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.kind, 'import');
  assert.deepEqual(calls[0]!.labelIds, ['Label_1', 'INBOX', 'UNREAD']);
});

test('importMessage with alreadySeen=true omits UNREAD', async () => {
  const { dest, calls } = makeDestWithStubApi();
  await dest.importMessage(Buffer.from('raw'), 'Label_1', new Date(), { alreadySeen: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.labelIds, ['Label_1', 'INBOX']);
});

test('importMessage returns the id from the response', async () => {
  const { dest } = makeDestWithStubApi();
  const id = await dest.importMessage(Buffer.from('raw'), 'Label_1', new Date());
  assert.equal(id, 'mid-1');
});
