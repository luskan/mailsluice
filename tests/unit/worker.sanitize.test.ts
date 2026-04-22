import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeError } from '../../src/sync/worker.ts';

test('collapses newlines', () => {
  assert.equal(sanitizeError('line1\nline2\r\nline3'), 'line1 line2 line3');
});

test('redacts password=value', () => {
  assert.match(sanitizeError('Error: password=hunter2 was wrong'), /password=\[redacted\]/);
  assert.doesNotMatch(sanitizeError('Error: password=hunter2'), /hunter2/);
});

test('redacts token=value and Bearer', () => {
  const out = sanitizeError('auth error: token=abc123xyz, bearer=more-secret');
  assert.doesNotMatch(out, /abc123xyz/);
  assert.doesNotMatch(out, /more-secret/);
});

test('redacts protocol tokens like LOGIN, PASS, AUTH', () => {
  assert.match(
    sanitizeError('server echoed: LOGIN me@example.com myRealPassword123'),
    /LOGIN \[redacted\]/,
  );
  assert.doesNotMatch(
    sanitizeError('PASS hunter2'),
    /hunter2/,
  );
});

test('truncates long messages', () => {
  const big = 'x'.repeat(2000);
  const out = sanitizeError(big);
  assert.ok(out.length <= 504, 'expected truncation');
  assert.ok(out.endsWith('...'));
});
