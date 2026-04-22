import type { FastifyInstance } from 'fastify';
import { hashPassword, needsRehash, verifyPassword } from './hash.ts';
import { audit } from '../audit.ts';

type LoginBody = { username?: string; password?: string; _csrf?: string };

type UserRow = {
  id: number;
  username: string;
  password_hash: string;
  is_admin: number;
};

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/login', async (req, reply) => {
    const token = await reply.generateCsrf();
    return reply.view('login.ejs', { csrfToken: token, error: null });
  });

  // Per-IP cap to block credential-stuffing that rotates usernames from one IP.
  // The plugin's own per-(user, IP) limiter handles the other axis.
  const PER_IP_MAX = 20;
  const PER_IP_WINDOW_MS = 15 * 60 * 1000;
  const perIpCounts = new Map<string, { count: number; resetAt: number }>();

  const perIpPreHandler = async (
    req: import('fastify').FastifyRequest,
    reply: import('fastify').FastifyReply,
  ): Promise<void> => {
    const now = Date.now();
    const key = `login:ip:${req.ip}`;
    const existing = perIpCounts.get(key);
    const entry =
      existing && existing.resetAt > now
        ? existing
        : { count: 0, resetAt: now + PER_IP_WINDOW_MS };
    entry.count += 1;
    perIpCounts.set(key, entry);
    if (entry.count > PER_IP_MAX) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      reply.header('Retry-After', String(retryAfter));
      reply.code(429).send({
        error: 'Too many login attempts from this IP. Try again later.',
      });
    }
  };

  app.post<{ Body: LoginBody }>(
    '/login',
    {
      preHandler: [app.csrfProtection, perIpPreHandler],
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '15 minutes',
          keyGenerator: (req) => {
            const body = (req.body ?? {}) as LoginBody;
            const u = typeof body.username === 'string' ? body.username.toLowerCase() : '';
            return `login:useripv:${req.ip}:${u}`;
          },
        },
      },
    },
    async (req, reply) => {
      const { username, password } = req.body ?? {};
      const fail = async (msg: string) => {
        const token = await reply.generateCsrf();
        return reply.code(401).view('login.ejs', { csrfToken: token, error: msg });
      };
      if (typeof username !== 'string' || typeof password !== 'string') {
        return fail('Username and password required.');
      }

      const row = app.db
        .prepare('SELECT id, username, password_hash, is_admin FROM users WHERE username = ?')
        .get(username) as UserRow | undefined;
      if (!row) {
        await verifyPassword(
          '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          password,
        );
        audit(app.db, {
          action: 'auth.login.failure',
          actorUsername: username,
          details: { reason: 'unknown_user' },
          req,
        });
        return fail('Invalid username or password.');
      }

      const ok = await verifyPassword(row.password_hash, password);
      if (!ok) {
        audit(app.db, {
          action: 'auth.login.failure',
          actorUserId: row.id,
          actorUsername: row.username,
          details: { reason: 'bad_password' },
          req,
        });
        return fail('Invalid username or password.');
      }

      // Transparently upgrade the stored hash when argon2 params have been raised.
      if (needsRehash(row.password_hash)) {
        try {
          const fresh = await hashPassword(password);
          app.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(fresh, row.id);
        } catch (err) {
          app.log.warn({ err, userId: row.id }, 'password rehash failed; leaving old hash in place');
        }
      }

      await req.session.regenerate();
      req.session.userId = row.id;
      req.session.isAdmin = row.is_admin === 1;
      audit(app.db, {
        action: 'auth.login.success',
        actorUserId: row.id,
        actorUsername: row.username,
        req,
      });
      return reply.redirect('/');
    },
  );

  app.post(
    '/logout',
    { preHandler: app.csrfProtection },
    async (req, reply) => {
      const actorUserId = req.session?.userId ?? null;
      audit(app.db, {
        action: 'auth.logout',
        actorUserId,
        req,
      });
      await req.session.destroy();
      return reply.redirect('/login');
    },
  );
}
