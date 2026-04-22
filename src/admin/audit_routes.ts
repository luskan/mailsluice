import type { FastifyInstance } from 'fastify';
import { requireAdmin } from '../auth/middleware.ts';
import { listAudit } from '../audit.ts';
import { relativeTime } from '../ui/time.ts';

export async function registerAdminAuditRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { offset?: string } }>(
    '/admin/audit',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const offset = Math.max(Number.parseInt(req.query.offset ?? '0', 10) || 0, 0);
      const limit = 100;
      const entries = listAudit(app.db, { limit, offset }).map((e) => ({
        ...e,
        created_at_display: relativeTime(e.created_at),
        details_parsed: e.details ? safeParse(e.details) : null,
      }));
      const me = app.db
        .prepare('SELECT id, username, is_admin FROM users WHERE id = ?')
        .get(req.session.userId!) as { id: number; username: string; is_admin: number };

      return reply.view('admin/audit.ejs', {
        user: { id: me.id, username: me.username, isAdmin: me.is_admin === 1 },
        csrfToken: await reply.generateCsrf(),
        entries,
        offset,
        nextOffset: entries.length === limit ? offset + limit : null,
        prevOffset: offset >= limit ? offset - limit : null,
      });
    },
  );
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
