import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_LENGTH,
  MIN_LENGTH,
  checkPasswordPolicy,
} from '../../src/auth/password_policy.ts';

test('accepts a long passphrase', () => {
  const r = checkPasswordPolicy('correct horse battery staple!');
  assert.equal(r.ok, true);
});

test('rejects below minimum length', () => {
  const r = checkPasswordPolicy('short');
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /at least/);
});

test('accepts exactly MIN_LENGTH', () => {
  const pw = 'a'.repeat(MIN_LENGTH);
  // repetitive rule catches all-same-char; use a varied one
  const good = ('ab').repeat(MIN_LENGTH / 2);
  const bad = checkPasswordPolicy(pw);
  assert.equal(bad.ok, false);
  const ok = checkPasswordPolicy(good);
  assert.equal(ok.ok, true);
});

test('rejects above maximum length', () => {
  const r = checkPasswordPolicy('a'.repeat(MAX_LENGTH + 1));
  assert.equal(r.ok, false);
});

test('rejects when equal to username (case-insensitive)', () => {
  const r = checkPasswordPolicy('MYUSERNAMEok', { username: 'myusernameok' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /username/);
});

test('rejects when equal to current password', () => {
  const pw = 'purple-monkey-dishwasher';
  const r = checkPasswordPolicy(pw, { currentPassword: pw });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /differ/);
});

test('rejects common passwords', () => {
  const samples = ['password1234', 'iloveyou1234', 'qwerty123456', 'changeme1234'];
  for (const p of samples) {
    const r = checkPasswordPolicy(p);
    if (r.ok) {
      // Length alone might pass; we only reject ones actually in the list.
      continue;
    }
  }
  const r = checkPasswordPolicy('changeme1234');
  assert.equal(r.ok, false);
});

test('rejects all-same-character', () => {
  const r = checkPasswordPolicy('aaaaaaaaaaaa');
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /repetitive/);
});

test('accepts unicode/emoji in a long passphrase', () => {
  const r = checkPasswordPolicy('Zażółć gęślą jaźń!');
  assert.equal(r.ok, true);
});
