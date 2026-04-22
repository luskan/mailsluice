import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relativeTime } from '../../src/ui/time.ts';

const NOW = Date.parse('2026-04-21T13:44:56.142Z');

test('null/undefined/empty -> "-"', () => {
  assert.equal(relativeTime(null, NOW), '-');
  assert.equal(relativeTime(undefined, NOW), '-');
  assert.equal(relativeTime('', NOW), '-');
});

test('invalid date -> "-"', () => {
  assert.equal(relativeTime('not-a-date', NOW), '-');
});

test('under 5s counts as "just now"', () => {
  assert.equal(relativeTime(new Date(NOW - 100).toISOString(), NOW), 'just now');
  assert.equal(relativeTime(new Date(NOW - 4999).toISOString(), NOW), 'just now');
});

test('seconds -> Ns ago', () => {
  assert.equal(relativeTime(new Date(NOW - 12_000).toISOString(), NOW), '12s ago');
  assert.equal(relativeTime(new Date(NOW - 59_000).toISOString(), NOW), '59s ago');
});

test('minutes -> Nm ago', () => {
  assert.equal(relativeTime(new Date(NOW - 60_000).toISOString(), NOW), '1m ago');
  assert.equal(relativeTime(new Date(NOW - 30 * 60_000).toISOString(), NOW), '30m ago');
});

test('hours -> Nh ago', () => {
  assert.equal(relativeTime(new Date(NOW - 3 * 3_600_000).toISOString(), NOW), '3h ago');
  assert.equal(relativeTime(new Date(NOW - 23 * 3_600_000).toISOString(), NOW), '23h ago');
});

test('days -> Nd ago', () => {
  assert.equal(relativeTime(new Date(NOW - 2 * 86_400_000).toISOString(), NOW), '2d ago');
  assert.equal(relativeTime(new Date(NOW - 29 * 86_400_000).toISOString(), NOW), '29d ago');
});

test('older than 30 days -> YYYY-MM-DD', () => {
  assert.equal(
    relativeTime(new Date(NOW - 100 * 86_400_000).toISOString(), NOW),
    new Date(NOW - 100 * 86_400_000).toISOString().slice(0, 10),
  );
});

test('future-dated value -> "just now" (clock skew tolerant)', () => {
  assert.equal(relativeTime(new Date(NOW + 5000).toISOString(), NOW), 'just now');
});
