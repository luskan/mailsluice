import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearRegistry,
  getDestinationFactory,
  listDestinationTypes,
  registerDestination,
} from '../../src/destinations/registry.ts';
import type { DestinationFactory } from '../../src/destinations/types.ts';

function makeFake(type: string): DestinationFactory {
  return {
    type,
    createAuthStarter: () => ({
      type,
      authUrl: () => 'https://example.test/auth',
      handleCallback: async () => ({ userCredentials: {}, accountIdentifier: '' }),
    }),
    createDestination: () => ({
      type,
      ensureTag: async () => 'id',
      importMessage: async () => 'msgid',
      probe: async () => ({ ok: true, email: 'x@x' }),
    }),
  };
}

test('register and retrieve by type', () => {
  clearRegistry();
  registerDestination(makeFake('fake'));
  const f = getDestinationFactory('fake');
  assert.ok(f);
  assert.equal(f!.type, 'fake');
});

test('list types returns registered set', () => {
  clearRegistry();
  registerDestination(makeFake('a'));
  registerDestination(makeFake('b'));
  assert.deepEqual(listDestinationTypes().sort(), ['a', 'b']);
});

test('overwriting the same type replaces', () => {
  clearRegistry();
  registerDestination(makeFake('gmail'));
  const replacement = makeFake('gmail');
  registerDestination(replacement);
  assert.equal(getDestinationFactory('gmail'), replacement);
});

test('missing type returns undefined', () => {
  clearRegistry();
  assert.equal(getDestinationFactory('none'), undefined);
});
