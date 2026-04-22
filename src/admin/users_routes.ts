import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { requireAdmin } from '../auth/middleware.ts';
import { hashPassword } from '../auth/hash.ts';
import { relativeTime } from '../ui/time.ts';
import { audit } from '../audit.ts';

type AdminUser = { id: number; username: string; is_admin: number; created_at: string };

function tempPassword(): string {
  const alphabet =
    'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) out += alphabet[bytes[i]! % alphabet.length];
  return out;
}

function listUsers(app: FastifyInstance): AdminUser[] {
  return app.db
    .prepare('SELECT id, username, is_admin, created_at FROM users ORDER BY id')
    .all() as AdminUser[];
}

function takeFlash(req: { session: { flash?: string } }): string | null {
  const f = req.session.flash ?? null;
  if (f != null) delete req.session.flash;
  return f;
}

export async function registerAdminUserRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/users', { preHandler: requireAdmin }, async (req, reply) => {
    const token = await reply.generateCsrf();
    const me = app.db
      .prepare('SELECT id, username, is_admin FROM users WHERE id = ?')
      .get(req.session.userId!) as { id: number; username: string; is_admin: number };
    return reply.view('admin/users.ejs', {
      user: { id: me.id, username: me.username, isAdmin: me.is_admin === 1 },
      users: listUsers(app).map((u) => ({ ...u, created_at_display: relativeTime(u.created_at) })),
      csrfToken: token,
      flash: takeFlash(req),
    });
  });

  app.post<{ Body: { username?: string; is_admin?: string; _csrf?: string } }>(
    '/admin/users',
    { preHandler: [requireAdmin, app.csrfProtection] },
    async (req, reply) => {
      const username = (req.body?.username ?? '').trim();
      const isAdmin = req.body?.is_admin === '1';
      if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) {
        req.session.flash = 'Username must be 3-32 chars (letters, digits, _ . -).';
        return reply.redirect('/admin/users');
      }
      const existing = app.db.prepare('SELECT id FROM users WHERE username = ?').get(username);
      if (existing) {
        req.session.flash = `User "${username}" already exists.`;
        return reply.redirect('/admin/users');
      }
      const pw = tempPassword();
      const hash = await hashPassword(pw);
      const res = app.db
        .prepare('INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)')
        .run(username, hash, isAdmin ? 1 : 0);
      audit(app.db, {
        action: 'admin.user.created',
        targetType: 'user',
        targetId: Number(res.lastInsertRowid),
        details: { username, is_admin: isAdmin },
        req,
      });
      req.session.flash = `Created ${username}. Temporary password: ${pw}`;
      return reply.redirect('/admin/users');
    },
  );

  app.post<{ Params: { id: string }; Body: { _csrf?: string } }>(
    '/admin/users/:id/delete',
    { preHandler: [requireAdmin, app.csrfProtection] },
    async (req, reply) => {
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad id' });
      if (id === req.session.userId) {
        req.session.flash = 'You cannot delete yourself.';
        return reply.redirect('/admin/users');
      }
      await app.syncManager?.stopUserWorkers(id).catch(() => undefined);
      const target = app.db.prepare('SELECT username FROM users WHERE id = ?').get(id) as { username: string } | undefined;
      app.db.prepare('DELETE FROM users WHERE id = ?').run(id);
      audit(app.db, {
        action: 'admin.user.deleted',
        targetType: 'user',
        targetId: id,
        details: { username: target?.username },
        req,
      });
      req.session.flash = `User ${id} deleted.`;
      return reply.redirect('/admin/users');
    },
  );

  app.post<{ Params: { id: string }; Body: { _csrf?: string } }>(
    '/admin/users/:id/reset-password',
    { preHandler: [requireAdmin, app.csrfProtection] },
    async (req, reply) => {
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad id' });
      const row = app.db.prepare('SELECT username FROM users WHERE id = ?').get(id) as
        | { username: string }
        | undefined;
      if (!row) {
        req.session.flash = `User ${id} not found.`;
        return reply.redirect('/admin/users');
      }
      const pw = tempPassword();
      const hash = await hashPassword(pw);
      app.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id);
      audit(app.db, {
        action: 'admin.user.password_reset',
        targetType: 'user',
        targetId: id,
        details: { username: row.username },
        req,
      });
      req.session.flash = `Reset password for ${row.username}. New temporary password: ${pw}`;
      return reply.redirect('/admin/users');
    },
  );
}
