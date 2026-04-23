import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireLogin } from '../auth/middleware.ts';
import { encrypt, decrypt } from '../crypto.ts';
import { relativeTime } from '../ui/time.ts';
import { audit } from '../audit.ts';
import { assertPublicHost, PrivateHostError } from './host_policy.ts';

function allowPrivate(v: string): boolean {
  return v === '1' || v === 'true';
}

type SourceRow = {
  id: number;
  user_id: number;
  destination_id: number;
  name: string;
  type: 'imap' | 'pop';
  host: string;
  port: number;
  use_tls: number;
  username: string;
  password_encrypted: Buffer;
  destination_tag: string;
  poll_interval_seconds: number | null;
  enabled: number;
  last_error: string | null;
  last_sync_at: string | null;
  skipped_count: number;
  post_import_action: string;
  created_at: string;
};

type FolderRow = {
  source_id: number;
  folder_path: string;
  label_name: string;
  enabled: number;
  uidvalidity: number | null;
  last_uid: number;
};

const PostImportAction = z.enum(['none', 'mark_read', 'delete']);

const PATH_CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const FolderEntry = z.object({
  path: z
    .string()
    .min(1)
    .max(512)
    .refine((s) => !PATH_CONTROL_CHARS.test(s), { message: 'folder path contains control characters' }),
  label: z
    .string()
    .min(1)
    .max(256)
    .refine((s) => !PATH_CONTROL_CHARS.test(s), { message: 'label contains control characters' }),
  enabled: z.union([z.boolean(), z.literal('1'), z.literal('0'), z.literal('true'), z.literal('false')]).transform((v) => v === true || v === '1' || v === 'true'),
});

const FoldersJson = z.array(FolderEntry).min(1).max(100);

const SourceInput = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(['imap', 'pop']),
  host: z.string().min(1),
  port: z.coerce.number().int().positive().max(65535),
  use_tls: z.union([z.literal('1'), z.literal('on'), z.literal('true'), z.literal(''), z.literal('0')]).optional(),
  username: z.string().min(1),
  password: z.string().optional(),
  destination_tag: z.string().min(1),
  destination_id: z.coerce.number().int().positive(),
  poll_interval_seconds: z.coerce.number().int().positive().max(86400).optional(),
  folders_json: z.string().optional(),
  post_import_action: PostImportAction.optional(),
});

const TestInput = z.object({
  type: z.enum(['imap', 'pop']),
  host: z.string().min(1),
  port: z.coerce.number().int().positive().max(65535),
  use_tls: z.union([z.literal('1'), z.literal('on'), z.literal('true'), z.literal(''), z.literal('0')]).optional(),
  username: z.string().min(1),
  password: z.string().optional(),
  source_id: z.coerce.number().int().positive().optional(),
});

const DiscoverInput = TestInput;

type ParsedFolder = { path: string; label: string; enabled: boolean };

function parseFolders(raw: unknown): { ok: true; folders: ParsedFolder[] } | { ok: false; error: string } {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, error: 'no folders provided' };
  }
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'folders payload is not valid JSON' };
  }
  const parsed = FoldersJson.safeParse(arr);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid folders' };
  }
  const seen = new Set<string>();
  const out: ParsedFolder[] = [];
  let anyEnabled = false;
  for (const f of parsed.data) {
    const path = f.path.trim();
    const label = f.label.trim();
    if (!path || !label) {
      return { ok: false, error: 'folder path and label are required' };
    }
    if (seen.has(path)) {
      return { ok: false, error: `duplicate folder: ${path}` };
    }
    seen.add(path);
    if (f.enabled) anyEnabled = true;
    out.push({ path, label, enabled: f.enabled });
  }
  if (!anyEnabled) {
    return { ok: false, error: 'at least one folder must be enabled' };
  }
  // Must include INBOX and it must be enabled.
  const inbox = out.find((f) => f.path === 'INBOX');
  if (!inbox) {
    return { ok: false, error: 'INBOX mapping is required' };
  }
  if (!inbox.enabled) {
    return { ok: false, error: 'INBOX must be enabled' };
  }
  return { ok: true, folders: out };
}

function loadUser(
  app: FastifyInstance,
  id: number,
): { id: number; username: string; isAdmin: boolean } {
  const row = app.db
    .prepare('SELECT id, username, is_admin FROM users WHERE id = ?')
    .get(id) as { id: number; username: string; is_admin: number };
  return { id: row.id, username: row.username, isAdmin: row.is_admin === 1 };
}

function listForUser(app: FastifyInstance, userId: number): Array<SourceRow & { imported_count: number }> {
  return app.db
    .prepare(
      `SELECT s.id, s.user_id, s.destination_id, s.name, s.type, s.host, s.port, s.use_tls, s.username,
              s.password_encrypted, s.destination_tag, s.poll_interval_seconds, s.enabled, s.last_error,
              s.last_sync_at, s.skipped_count, s.post_import_action, s.created_at,
              (SELECT COUNT(*) FROM imported_messages WHERE source_id = s.id) AS imported_count
       FROM sources s WHERE s.user_id = ? ORDER BY s.id`,
    )
    .all(userId) as Array<SourceRow & { imported_count: number }>;
}

function takeFlash(req: { session: { flash?: string } }): string | null {
  const f = req.session.flash ?? null;
  if (f != null) delete req.session.flash;
  return f;
}

function userDestinations(
  app: FastifyInstance,
  userId: number,
): Array<{ id: number; type: string; account_identifier: string | null }> {
  return app.db
    .prepare(
      'SELECT id, type, account_identifier FROM destinations WHERE user_id = ? ORDER BY id',
    )
    .all(userId) as Array<{ id: number; type: string; account_identifier: string | null }>;
}

function folderRowsForSource(app: FastifyInstance, sourceId: number): FolderRow[] {
  return app.db
    .prepare(
      'SELECT source_id, folder_path, label_name, enabled, uidvalidity, last_uid FROM source_folders WHERE source_id = ? ORDER BY folder_path',
    )
    .all(sourceId) as FolderRow[];
}

function writeFolderMapping(
  app: FastifyInstance,
  sourceId: number,
  folders: ParsedFolder[],
): void {
  const prior = folderRowsForSource(app, sourceId);
  const priorByPath = new Map(prior.map((r) => [r.folder_path, r]));
  const tx = app.db.transaction(() => {
    app.db.prepare('DELETE FROM source_folders WHERE source_id = ?').run(sourceId);
    const ins = app.db.prepare(
      "INSERT INTO source_folders (source_id, folder_path, label_name, enabled, uidvalidity, last_uid, updated_at) VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
    );
    for (const f of folders) {
      const old = priorByPath.get(f.path);
      ins.run(
        sourceId,
        f.path,
        f.label,
        f.enabled ? 1 : 0,
        old?.uidvalidity ?? null,
        old?.last_uid ?? 0,
      );
    }
  });
  tx();
}

export async function registerSourceRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/sources/test',
    {
      preHandler: [requireLogin, app.csrfProtection],
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const user = loadUser(app, req.session.userId!);
      const parsed = TestInput.safeParse(req.body);
      if (!parsed.success) {
        return reply.send({
          ok: false,
          error: parsed.error.issues[0]?.message ?? 'invalid form',
        });
      }
      const v = parsed.data;
      const useTls = v.use_tls === '1' || v.use_tls === 'on' || v.use_tls === 'true';

      let password = v.password && v.password.length > 0 ? v.password : '';
      if (!password && typeof v.source_id === 'number') {
        const row = app.db
          .prepare('SELECT user_id, password_encrypted FROM sources WHERE id = ?')
          .get(v.source_id) as { user_id: number; password_encrypted: Buffer } | undefined;
        if (row && row.user_id === user.id) {
          password = decrypt(
            row.password_encrypted,
            app.appConfig.encryptionKeys,
            `sources.password:${v.source_id}`,
          ).toString('utf8');
        }
      }
      if (!password) {
        return reply.send({
          ok: false,
          error: 'Enter the password to run a connection test.',
        });
      }

      try {
        await assertPublicHost(v.host, allowPrivate(app.appConfig.APP_ALLOW_PRIVATE_SOURCES));
      } catch (err) {
        if (err instanceof PrivateHostError) {
          return reply.send({ ok: false, error: err.message });
        }
        throw err;
      }

      const result = await app.testConnection({
        type: v.type,
        host: v.host,
        port: v.port,
        useTls,
        username: v.username,
        password,
      });
      return reply.send(result);
    },
  );

  app.post(
    '/sources/folders/discover',
    {
      preHandler: [requireLogin, app.csrfProtection],
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const user = loadUser(app, req.session.userId!);
      const parsed = DiscoverInput.safeParse(req.body);
      if (!parsed.success) {
        return reply.send({
          ok: false,
          error: parsed.error.issues[0]?.message ?? 'invalid form',
        });
      }
      const v = parsed.data;
      if (v.type !== 'imap') {
        return reply.send({ ok: false, error: 'folder discovery is only available for IMAP sources' });
      }
      const useTls = v.use_tls === '1' || v.use_tls === 'on' || v.use_tls === 'true';

      let password = v.password && v.password.length > 0 ? v.password : '';
      if (!password && typeof v.source_id === 'number') {
        const row = app.db
          .prepare('SELECT user_id, password_encrypted FROM sources WHERE id = ?')
          .get(v.source_id) as { user_id: number; password_encrypted: Buffer } | undefined;
        if (row && row.user_id === user.id) {
          password = decrypt(
            row.password_encrypted,
            app.appConfig.encryptionKeys,
            `sources.password:${v.source_id}`,
          ).toString('utf8');
        }
      }
      if (!password) {
        return reply.send({ ok: false, error: 'Enter the password to discover folders.' });
      }

      try {
        await assertPublicHost(v.host, allowPrivate(app.appConfig.APP_ALLOW_PRIVATE_SOURCES));
      } catch (err) {
        if (err instanceof PrivateHostError) {
          return reply.send({ ok: false, error: err.message });
        }
        throw err;
      }

      const result = await app.listImapFolders({
        host: v.host,
        port: v.port,
        useTls,
        username: v.username,
        password,
      });
      return reply.send(result);
    },
  );

  app.get('/sources', { preHandler: requireLogin }, async (req, reply) => {
    const user = loadUser(app, req.session.userId!);
    const token = await reply.generateCsrf();
    const rows = listForUser(app, user.id).map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      host: r.host,
      port: r.port,
      username: r.username,
      destination_tag: r.destination_tag,
      enabled: r.enabled === 1,
      last_sync_at: r.last_sync_at,
      last_sync_at_display: relativeTime(r.last_sync_at),
      last_error: r.last_error,
      skipped_count: r.skipped_count,
      imported_count: r.imported_count,
    }));
    return reply.view('sources/list.ejs', {
      user,
      csrfToken: token,
      flash: takeFlash(req),
      sources: rows,
    });
  });

  app.get('/sources/new', { preHandler: requireLogin }, async (req, reply) => {
    const user = loadUser(app, req.session.userId!);
    const token = await reply.generateCsrf();
    return reply.view('sources/form.ejs', {
      user,
      csrfToken: token,
      flash: takeFlash(req),
      source: null,
      folders: [],
      destinations: userDestinations(app, user.id),
      formError: null,
    });
  });

  app.post(
    '/sources',
    { preHandler: [requireLogin, app.csrfProtection] },
    async (req, reply) => {
      const user = loadUser(app, req.session.userId!);
      const parsed = SourceInput.safeParse(req.body);
      if (!parsed.success) {
        req.session.flash = `Validation error: ${parsed.error.issues[0]?.message ?? 'invalid input'}`;
        return reply.redirect('/sources/new');
      }
      const v = parsed.data;
      if (!v.password) {
        req.session.flash = 'Password is required when creating a source.';
        return reply.redirect('/sources/new');
      }
      const own = app.db
        .prepare('SELECT id FROM destinations WHERE id = ? AND user_id = ?')
        .get(v.destination_id, user.id);
      if (!own) {
        req.session.flash = 'Selected destination does not belong to you.';
        return reply.redirect('/sources/new');
      }

      let folders: ParsedFolder[] | null = null;
      if (v.type === 'imap') {
        const fr = parseFolders(v.folders_json);
        if (!fr.ok) {
          req.session.flash = `Folder mapping error: ${fr.error}`;
          return reply.redirect('/sources/new');
        }
        folders = fr.folders;
      }

      const useTls = v.use_tls === '1' || v.use_tls === 'on' || v.use_tls === 'true';
      try {
        await assertPublicHost(v.host, allowPrivate(app.appConfig.APP_ALLOW_PRIVATE_SOURCES));
      } catch (err) {
        if (err instanceof PrivateHostError) {
          req.session.flash = `Host rejected: ${err.message}`;
          return reply.redirect('/sources/new');
        }
        throw err;
      }
      const testResult = await app.testConnection({
        type: v.type,
        host: v.host,
        port: v.port,
        useTls,
        username: v.username,
        password: v.password,
      });
      if (!testResult.ok) {
        req.session.flash = `Connection test failed: ${testResult.error}`;
        return reply.redirect('/sources/new');
      }

      const postAction = v.post_import_action ?? 'none';

      const insertTx = app.db.transaction((): number => {
        const res = app.db
          .prepare(
            'INSERT INTO sources (user_id, destination_id, name, type, host, port, use_tls, username, password_encrypted, destination_tag, poll_interval_seconds, post_import_action) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            user.id,
            v.destination_id,
            v.name,
            v.type,
            v.host,
            v.port,
            useTls ? 1 : 0,
            v.username,
            Buffer.alloc(0),
            v.destination_tag,
            v.type === 'pop' ? (v.poll_interval_seconds ?? 300) : null,
            postAction,
          );
        const id = Number(res.lastInsertRowid);
        const enc = encrypt(
          v.password!,
          app.appConfig.encryptionKeys,
          `sources.password:${id}`,
        );
        app.db.prepare('UPDATE sources SET password_encrypted = ? WHERE id = ?').run(enc, id);
        if (folders) {
          const ins = app.db.prepare(
            "INSERT INTO source_folders (source_id, folder_path, label_name, enabled, uidvalidity, last_uid, updated_at) VALUES (?, ?, ?, ?, NULL, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
          );
          for (const f of folders) {
            ins.run(id, f.path, f.label, f.enabled ? 1 : 0);
          }
        }
        return id;
      });
      const newId = insertTx();
      await app.syncManager?.reloadSource(newId).catch(() => undefined);
      audit(app.db, {
        action: 'source.created',
        targetType: 'source',
        targetId: newId,
        details: {
          name: v.name,
          type: v.type,
          host: v.host,
          destination_id: v.destination_id,
          folder_count: folders?.length ?? 0,
          post_import_action: postAction,
        },
        req,
      });
      req.session.flash = `Source "${v.name}" added. Connection test passed.`;
      return reply.redirect('/sources');
    },
  );

  app.get<{ Params: { id: string } }>(
    '/sources/:id',
    { preHandler: requireLogin },
    async (req, reply) => {
      const user = loadUser(app, req.session.userId!);
      const id = Number.parseInt(req.params.id, 10);
      const row = app.db
        .prepare('SELECT * FROM sources WHERE id = ?')
        .get(id) as SourceRow | undefined;
      if (!row || row.user_id !== user.id) {
        return reply.code(404).send({ error: 'not found' });
      }
      const token = await reply.generateCsrf();
      const folders = folderRowsForSource(app, id).map((r) => ({
        path: r.folder_path,
        label: r.label_name,
        enabled: r.enabled === 1,
      }));
      return reply.view('sources/form.ejs', {
        user,
        csrfToken: token,
        flash: takeFlash(req),
        source: row,
        folders,
        destinations: userDestinations(app, user.id),
        formError: null,
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/sources/:id',
    { preHandler: [requireLogin, app.csrfProtection] },
    async (req, reply) => {
      const user = loadUser(app, req.session.userId!);
      const id = Number.parseInt(req.params.id, 10);
      const existing = app.db
        .prepare('SELECT id, user_id, password_encrypted FROM sources WHERE id = ?')
        .get(id) as { id: number; user_id: number; password_encrypted: Buffer } | undefined;
      if (!existing || existing.user_id !== user.id) {
        return reply.code(404).send({ error: 'not found' });
      }
      const parsed = SourceInput.safeParse(req.body);
      if (!parsed.success) {
        req.session.flash = `Validation error: ${parsed.error.issues[0]?.message ?? 'invalid input'}`;
        return reply.redirect(`/sources/${id}`);
      }
      const v = parsed.data;
      const own = app.db
        .prepare('SELECT id FROM destinations WHERE id = ? AND user_id = ?')
        .get(v.destination_id, user.id);
      if (!own) {
        req.session.flash = 'Selected destination does not belong to you.';
        return reply.redirect(`/sources/${id}`);
      }

      let folders: ParsedFolder[] | null = null;
      if (v.type === 'imap') {
        const fr = parseFolders(v.folders_json);
        if (!fr.ok) {
          req.session.flash = `Folder mapping error: ${fr.error}`;
          return reply.redirect(`/sources/${id}`);
        }
        folders = fr.folders;
      }

      const useTls = v.use_tls === '1' || v.use_tls === 'on' || v.use_tls === 'true';
      const password = v.password && v.password.length > 0
        ? v.password
        : decrypt(
            existing.password_encrypted,
            app.appConfig.encryptionKeys,
            `sources.password:${id}`,
          ).toString('utf8');

      try {
        await assertPublicHost(v.host, allowPrivate(app.appConfig.APP_ALLOW_PRIVATE_SOURCES));
      } catch (err) {
        if (err instanceof PrivateHostError) {
          req.session.flash = `Host rejected: ${err.message}`;
          return reply.redirect(`/sources/${id}`);
        }
        throw err;
      }
      const testResult = await app.testConnection({
        type: v.type,
        host: v.host,
        port: v.port,
        useTls,
        username: v.username,
        password,
      });
      if (!testResult.ok) {
        req.session.flash = `Connection test failed: ${testResult.error}`;
        return reply.redirect(`/sources/${id}`);
      }

      const postAction = v.post_import_action ?? 'none';

      const encPw = encrypt(
        password,
        app.appConfig.encryptionKeys,
        `sources.password:${id}`,
      );
      const updateTx = app.db.transaction(() => {
        app.db
          .prepare(
            'UPDATE sources SET destination_id = ?, name = ?, type = ?, host = ?, port = ?, use_tls = ?, username = ?, password_encrypted = ?, destination_tag = ?, poll_interval_seconds = ?, post_import_action = ? WHERE id = ?',
          )
          .run(
            v.destination_id,
            v.name,
            v.type,
            v.host,
            v.port,
            useTls ? 1 : 0,
            v.username,
            encPw,
            v.destination_tag,
            v.type === 'pop' ? (v.poll_interval_seconds ?? 300) : null,
            postAction,
            id,
          );
        if (folders) {
          writeFolderMapping(app, id, folders);
        } else {
          app.db.prepare('DELETE FROM source_folders WHERE source_id = ?').run(id);
        }
      });
      updateTx();
      await app.syncManager?.reloadSource(id).catch(() => undefined);
      audit(app.db, {
        action: 'source.updated',
        targetType: 'source',
        targetId: id,
        details: {
          name: v.name,
          type: v.type,
          host: v.host,
          password_changed: Boolean(v.password),
          folder_count: folders?.length ?? 0,
          post_import_action: postAction,
        },
        req,
      });
      req.session.flash = `Source "${v.name}" updated.`;
      return reply.redirect('/sources');
    },
  );

  app.post<{ Params: { id: string } }>(
    '/sources/:id/delete',
    { preHandler: [requireLogin, app.csrfProtection] },
    async (req, reply) => {
      const user = loadUser(app, req.session.userId!);
      const id = Number.parseInt(req.params.id, 10);
      const row = app.db
        .prepare('SELECT id, user_id, name FROM sources WHERE id = ?')
        .get(id) as { id: number; user_id: number; name: string } | undefined;
      if (!row || row.user_id !== user.id) {
        return reply.code(404).send({ error: 'not found' });
      }
      await app.syncManager?.stopOne(id).catch(() => undefined);
      app.db.prepare('DELETE FROM sources WHERE id = ?').run(id);
      audit(app.db, {
        action: 'source.deleted',
        targetType: 'source',
        targetId: id,
        details: { name: row.name },
        req,
      });
      req.session.flash = `Source "${row.name}" deleted.`;
      return reply.redirect('/sources');
    },
  );

  app.post<{ Params: { id: string }; Body: { enabled?: string } }>(
    '/sources/:id/toggle',
    { preHandler: [requireLogin, app.csrfProtection] },
    async (req, reply) => {
      const user = loadUser(app, req.session.userId!);
      const id = Number.parseInt(req.params.id, 10);
      const row = app.db
        .prepare('SELECT id, user_id, enabled FROM sources WHERE id = ?')
        .get(id) as { id: number; user_id: number; enabled: number } | undefined;
      if (!row || row.user_id !== user.id) {
        return reply.code(404).send({ error: 'not found' });
      }
      const next = row.enabled === 1 ? 0 : 1;
      app.db.prepare('UPDATE sources SET enabled = ? WHERE id = ?').run(next, id);
      if (next === 1) {
        await app.syncManager?.reloadSource(id).catch(() => undefined);
      } else {
        await app.syncManager?.stopOne(id).catch(() => undefined);
      }
      audit(app.db, {
        action: 'source.toggled',
        targetType: 'source',
        targetId: id,
        details: { enabled: next === 1 },
        req,
      });
      req.session.flash = next === 1 ? 'Source enabled.' : 'Source disabled.';
      return reply.redirect('/sources');
    },
  );
}
