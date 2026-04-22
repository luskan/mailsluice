import type { FastifyInstance } from 'fastify';
import { requireLogin } from './middleware.ts';
import { hashPassword, verifyPassword } from './hash.ts';
import { checkPasswordPolicy, MIN_LENGTH } from './password_policy.ts';
import { audit } from '../audit.ts';

type ChangeBody = {
  current_password?: string;
  new_password?: string;
  confirm_password?: string;
  _csrf?: string;
};

function takeFlash(req: { session: { flash?: string } }): string | null {
  const f = req.session.flash ?? null;
  if (f != null) delete req.session.flash;
  return f;
}

function loadUser(
  app: FastifyInstance,
  id: number,
): { id: number; username: string; isAdmin: boolean; password_hash: string } {
  const row = app.db
    .prepare('SELECT id, username, is_admin, password_hash FROM users WHERE id = ?')
    .get(id) as { id: number; username: string; is_admin: number; password_hash: string };
  return {
    id: row.id,
    username: row.username,
    isAdmin: row.is_admin === 1,
    password_hash: row.password_hash,
  };
}

export async function registerAccountRoutes(app: FastifyInstance): Promise<void> {
  app.get('/account/password', { preHandler: requireLogin }, async (req, reply) => {
    const user = loadUser(app, req.session.userId!);
    const token = await reply.generateCsrf();
    return reply.view('account/change_password.ejs', {
      user: { id: user.id, username: user.username, isAdmin: user.isAdmin },
      csrfToken: token,
      flash: takeFlash(req),
      error: null,
      minLength: MIN_LENGTH,
    });
  });

  app.post<{ Body: ChangeBody }>(
    '/account/password',
    {
      preHandler: [requireLogin, app.csrfProtection],
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '15 minutes',
          keyGenerator: (req) => `pwchange:${req.ip}:${req.session?.userId ?? 'anon'}`,
        },
      },
    },
    async (req, reply) => {
      const user = loadUser(app, req.session.userId!);
      const body = req.body ?? {};
      const current = typeof body.current_password === 'string' ? body.current_password : '';
      const next = typeof body.new_password === 'string' ? body.new_password : '';
      const confirm = typeof body.confirm_password === 'string' ? body.confirm_password : '';

      const render = async (err: string) => {
        const token = await reply.generateCsrf();
        return reply.code(400).view('account/change_password.ejs', {
          user: { id: user.id, username: user.username, isAdmin: user.isAdmin },
          csrfToken: token,
          flash: null,
          error: err,
          minLength: MIN_LENGTH,
        });
      };

      if (!current || !next || !confirm) {
        return render('All fields are required.');
      }

      const currentOk = await verifyPassword(user.password_hash, current);
      if (!currentOk) {
        return render('Current password is incorrect.');
      }

      if (next !== confirm) {
        return render('New password and confirmation do not match.');
      }

      const policy = checkPasswordPolicy(next, {
        username: user.username,
        currentPassword: current,
      });
      if (!policy.ok) {
        return render(policy.error);
      }

      const newHash = await hashPassword(next);
      app.db
        .prepare('UPDATE users SET password_hash = ? WHERE id = ?')
        .run(newHash, user.id);

      // Destroy-then-regenerate so an already-issued session cookie stops
      // working after a password change.
      const oldSessionId = req.session.sessionId;
      const store = req.sessionStore as {
        destroy: (sid: string, cb: (err?: Error | null) => void) => void;
      };
      await new Promise<void>((resolve, reject) => {
        store.destroy(oldSessionId, (err) => (err ? reject(err) : resolve()));
      });
      await req.session.regenerate();
      req.session.userId = user.id;
      req.session.isAdmin = user.isAdmin;
      audit(app.db, {
        action: 'auth.password.changed',
        actorUserId: user.id,
        actorUsername: user.username,
        req,
      });
      req.session.flash = 'Password changed.';
      return reply.redirect('/account/password');
    },
  );
}
