import type { FastifyInstance } from 'fastify';
import { audit } from '../audit.ts';
import { RISK_ACK_VERSION } from '../risk_ack.ts';

type AckBody = { _csrf?: string };

export async function registerAcknowledgeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/acknowledge', async (req, reply) => {
    if (!req.session?.userId) return reply.redirect('/login');
    const token = await reply.generateCsrf();
    const user = loadUser(app.db, req.session.userId);
    return reply.view('acknowledge.ejs', {
      csrfToken: token,
      version: RISK_ACK_VERSION,
      user,
    });
  });

  app.post<{ Body: AckBody }>(
    '/acknowledge',
    { preHandler: app.csrfProtection },
    async (req, reply) => {
      if (!req.session?.userId) return reply.redirect('/login');
      app.db
        .prepare('UPDATE users SET risk_acked_version = ? WHERE id = ?')
        .run(RISK_ACK_VERSION, req.session.userId);
      audit(app.db, {
        action: 'risk.ack',
        actorUserId: req.session.userId,
        details: { version: RISK_ACK_VERSION },
        req,
      });
      return reply.redirect('/');
    },
  );
}

function loadUser(
  db: FastifyInstance['db'],
  id: number,
): { id: number; username: string; isAdmin: boolean } {
  const row = db
    .prepare('SELECT id, username, is_admin FROM users WHERE id = ?')
    .get(id) as { id: number; username: string; is_admin: number };
  return { id: row.id, username: row.username, isAdmin: row.is_admin === 1 };
}
