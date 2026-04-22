import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Backoff } from '../../src/sync/backoff.ts';

test('delays follow the configured schedule and cap', () => {
  const b = new Backoff({ baseMs: 1000, maxMs: 300_000 });
  const delays: number[] = [];
  for (let i = 0; i < 12; i++) delays.push(b.nextDelayMs());
  assert.deepEqual(delays.slice(0, 4), [1000, 2000, 4000, 8000]);
  assert.equal(delays[delays.length - 1], 300_000);
  assert.ok(delays.every((d, i) => i === 0 || d >= delays[i - 1]!));
});

test('reset goes back to base delay', () => {
  const b = new Backoff({ baseMs: 100, maxMs: 10_000 });
  b.nextDelayMs();
  b.nextDelayMs();
  b.nextDelayMs();
  b.reset();
  assert.equal(b.nextDelayMs(), 100);
});

test('factor=3 uses the given factor', () => {
  const b = new Backoff({ baseMs: 1, maxMs: 100_000, factor: 3 });
  assert.equal(b.nextDelayMs(), 1);
  assert.equal(b.nextDelayMs(), 3);
  assert.equal(b.nextDelayMs(), 9);
  assert.equal(b.nextDelayMs(), 27);
});
