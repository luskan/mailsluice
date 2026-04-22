import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig } from './config.ts';
import { openDb } from './db/index.ts';
import { buildApp } from './app.ts';
import { bootstrapAdmin } from './auth/bootstrap.ts';
import { SyncManager } from './sync/manager.ts';
import { migrateLegacyCiphertexts } from './db/migrate_crypto.ts';
import { recordEvent, setEventLogMaxRows } from './events.ts';

async function main(): Promise<void> {
  const cfg = await loadConfig();

  if (cfg.APP_DATABASE_PATH !== ':memory:') {
    mkdirSync(dirname(cfg.APP_DATABASE_PATH), { recursive: true });
  }
  const db = openDb(cfg.APP_DATABASE_PATH);

  const migrationResult = migrateLegacyCiphertexts(db, cfg.encryptionKeys);
  if (migrationResult.upgraded > 0) {
    console.log(
      `Upgraded ${migrationResult.upgraded} legacy ciphertext(s) to v1 (AAD-bound).`,
    );
  }

  await bootstrapAdmin(db);

  const app = await buildApp(cfg, db);

  setEventLogMaxRows(cfg.APP_EVENT_LOG_MAX_ROWS);

  const syncManager = new SyncManager({
    db,
    config: cfg,
    log: (level, msg, meta) => {
      const logger = app.log as {
        info: (o: unknown, m?: string) => void;
        warn: (o: unknown, m?: string) => void;
        error: (o: unknown, m?: string) => void;
      };
      logger[level](meta ?? {}, msg);
      const m = (meta ?? {}) as Record<string, unknown>;
      recordEvent(db, {
        level,
        message: msg,
        sourceId: typeof m.sourceId === 'number' ? m.sourceId : null,
        destinationId: typeof m.destinationId === 'number' ? m.destinationId : null,
        ...(meta ? { details: meta } : {}),
      });
    },
  });
  app.syncManager = syncManager;

  const stop = async (signal: string) => {
    app.log.info({ signal }, 'shutdown requested');
    try {
      await syncManager.stopAll();
      await app.close();
      db.close();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));

  await app.listen({ port: cfg.APP_PORT, host: cfg.APP_HOST });
  await syncManager.startAll();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
