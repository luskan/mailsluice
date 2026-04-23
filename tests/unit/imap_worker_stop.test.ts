import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../src/db/index.ts';
import { ImapSourceWorker } from '../../src/sync/imap_worker.ts';
import type { Destination, ProbeResult } from '../../src/destinations/types.ts';

// Fake clock whose setTimeout never fires on its own; we observe whether the
// worker correctly resolves the awaited promise when clear() is called.
type FakeTimer = { clear: () => void; fire: () => void; delay: number };

function makeClock() {
  const timers: FakeTimer[] = [];
  return {
    clock: {
      now: () => 0,
      setTimeout(handler: () => void, ms: number): { clear: () => void } {
        const t: FakeTimer = {
          delay: ms,
          fire: () => handler(),
          clear: () => {},
        };
        timers.push(t);
        return { clear: () => t.clear() };
      },
    },
    timers,
  };
}

function stubDestination(): Destination {
  return {
    type: 'fake',
    async ensureTag(): Promise<string> { return 'id'; },
    async importMessage(): Promise<string> { return 'mid'; },
    async probe(): Promise<ProbeResult> { return { ok: true, email: 'x' }; },
  };
}

function prepDb() {
  const db = openDb(':memory:');
  const u = db.prepare("INSERT INTO users (username, password_hash) VALUES ('u', 'x') RETURNING id").get() as { id: number };
  const d = db.prepare("INSERT INTO destinations (user_id, type, credentials_encrypted) VALUES (?, 'gmail', x'00') RETURNING id").get(u.id) as { id: number };
  const s = db
    .prepare("INSERT INTO sources (user_id, destination_id, name, type, host, port, username, password_encrypted, destination_tag, poll_interval_seconds) VALUES (?, ?, 's', 'imap', '0.0.0.0', 1, 'u', x'00', 'Ext', NULL) RETURNING id")
    .get(u.id, d.id) as { id: number };
  return { db, sourceId: s.id };
}

test('stop() unblocks from backoff sleep without hanging', async () => {
  const { db, sourceId } = prepDb();
  const { clock } = makeClock();
  const worker = new ImapSourceWorker(
    {
      db,
      destination: stubDestination(),
      destinationTag: 'Ext',
      sourceId,
      clock,
      log: () => {},
      tagCache: new Map(),
    },
    {
      host: '0.0.0.0',
      port: 1,
      useTls: true,
      username: 'u',
      password: 'p',
      postImportAction: 'none',
    },
  );
  await worker.start();
  // Give the loop a moment to hit the connect failure and enter sleep.
  await new Promise((r) => setTimeout(r, 50));
  // stop() must complete even though the timer handler was never fired.
  const stopP = worker.stop();
  const withTimeout = Promise.race([
    stopP.then(() => 'stopped'),
    new Promise<string>((r) => setTimeout(() => r('timeout'), 2000)),
  ]);
  const outcome = await withTimeout;
  assert.equal(outcome, 'stopped');
  db.close();
});
