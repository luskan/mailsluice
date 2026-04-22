import type { FastifyRequest } from 'fastify';
import type { Db } from './db/index.ts';

export type AuditArgs = {
  action: string;
  actorUserId?: number | null;
  actorUsername?: string | null;
  targetType?: string;
  targetId?: string | number | null;
  details?: Record<string, unknown>;
  req?: FastifyRequest;
};

function actorFromReq(db: Db, req?: FastifyRequest): {
  userId: number | null;
  username: string | null;
} {
  const sessUserId = req?.session?.userId ?? null;
  if (sessUserId == null) return { userId: null, username: null };
  const row = db
    .prepare('SELECT username FROM users WHERE id = ?')
    .get(sessUserId) as { username: string } | undefined;
  return { userId: sessUserId, username: row?.username ?? null };
}

export function audit(db: Db, a: AuditArgs): void {
  const resolvedActor = a.req
    ? actorFromReq(db, a.req)
    : { userId: null, username: null };
  const actorUserId = a.actorUserId ?? resolvedActor.userId;
  const actorUsername = a.actorUsername ?? resolvedActor.username;
  const ua = a.req?.headers['user-agent'];

  try {
    db.prepare(
      'INSERT INTO audit_log (actor_user_id, actor_username, action, target_type, target_id, details, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      actorUserId ?? null,
      actorUsername ?? null,
      a.action,
      a.targetType ?? null,
      a.targetId != null ? String(a.targetId) : null,
      a.details ? JSON.stringify(a.details) : null,
      a.req?.ip ?? null,
      typeof ua === 'string' ? ua : null,
    );
  } catch {
    // Best effort: audit logging must never break a user-facing action.
  }
}

export type AuditEntry = {
  id: number;
  actor_user_id: number | null;
  actor_username: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  details: string | null;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
};

export function listAudit(
  db: Db,
  opts: { limit?: number; offset?: number } = {},
): AuditEntry[] {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  return db
    .prepare(
      'SELECT id, actor_user_id, actor_username, action, target_type, target_id, details, ip, user_agent, created_at FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?',
    )
    .all(limit, offset) as AuditEntry[];
}
