import type { FastifyInstance } from 'fastify';
import { requireAdmin } from '../auth/middleware.ts';
import { eventCount, listEvents, type EventLevel } from '../events.ts';
import { relativeTime } from '../ui/time.ts';

const LIMIT = 100;

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export async function registerAdminEventsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { offset?: string; level?: string; source_id?: string } }>(
    '/admin/events',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const offset = Math.max(Number.parseInt(req.query.offset ?? '0', 10) || 0, 0);
      const levelRaw = req.query.level;
      const level: EventLevel | undefined =
        levelRaw === 'info' || levelRaw === 'warn' || levelRaw === 'error'
          ? levelRaw
          : undefined;
      const sourceId = Number.parseInt(req.query.source_id ?? '', 10);
      const entries = listEvents(app.db, {
        limit: LIMIT,
        offset,
        ...(level ? { level } : {}),
        ...(Number.isInteger(sourceId) && sourceId > 0 ? { sourceId } : {}),
      }).map((e) => ({
        ...e,
        created_at_display: relativeTime(e.created_at),
        details_parsed: e.details ? safeParse(e.details) : null,
      }));

      const me = app.db
        .prepare('SELECT id, username, is_admin FROM users WHERE id = ?')
        .get(req.session.userId!) as { id: number; username: string; is_admin: number };

      return reply.view('admin/events.ejs', {
        user: { id: me.id, username: me.username, isAdmin: me.is_admin === 1 },
        csrfToken: await reply.generateCsrf(),
        entries,
        offset,
        nextOffset: entries.length === LIMIT ? offset + LIMIT : null,
        prevOffset: offset >= LIMIT ? offset - LIMIT : null,
        level: level ?? '',
        sourceId: Number.isInteger(sourceId) && sourceId > 0 ? sourceId : '',
        total: eventCount(app.db),
      });
    },
  );
}
