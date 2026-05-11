import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settleWithin } from '../../src/sync/worker.ts';

test('returns true when the promise resolves before the timeout', async () => {
  const ok = await settleWithin(
    () => new Promise<void>((resolve) => setTimeout(resolve, 10)),
    1000,
  );
  assert.equal(ok, true);
});

test('returns true when the promise rejects before the timeout', async () => {
  const ok = await settleWithin(
    () => new Promise<void>((_, reject) => setTimeout(() => reject(new Error('x')), 10)),
    1000,
  );
  assert.equal(ok, true);
});

test('returns true when the thunk throws synchronously', async () => {
  const ok = await settleWithin(
    () => { throw new Error('sync'); },
    1000,
  );
  assert.equal(ok, true);
});

test('returns false when the timeout fires before the promise settles', async () => {
  const t0 = Date.now();
  const ok = await settleWithin(
    () => new Promise<void>(() => {}),
    50,
  );
  const elapsed = Date.now() - t0;
  assert.equal(ok, false);
  assert.ok(elapsed >= 40 && elapsed < 500, `elapsed=${elapsed}`);
});
