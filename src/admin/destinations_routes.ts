import type { FastifyInstance } from 'fastify';
import { requireAdmin } from '../auth/middleware.ts';
import {
  clearGmailOAuthClient,
  getGmailOAuthClient,
  maskSecret,
  setGmailOAuthClient,
} from '../settings.ts';
import { audit } from '../audit.ts';

type FormBody = {
  client_id?: string;
  client_secret?: string;
  redirect_uri?: string;
  _csrf?: string;
};

function takeFlash(req: { session: { flash?: string } }): string | null {
  const f = req.session.flash ?? null;
  if (f != null) delete req.session.flash;
  return f;
}

export async function registerAdminDestinationRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get('/admin/destinations/gmail', { preHandler: requireAdmin }, async (req, reply) => {
    const token = await reply.generateCsrf();
    const me = app.db
      .prepare('SELECT id, username, is_admin FROM users WHERE id = ?')
      .get(req.session.userId!) as { id: number; username: string; is_admin: number };
    const cfg = getGmailOAuthClient(app.db, app.appConfig.encryptionKeys);

    const host = (req.headers.host as string | undefined) ?? req.hostname;
    const proto = req.protocol;
    const origin = `${proto}://${host}`;
    const defaultRedirect = `${origin}/destinations/gmail/callback`;

    return reply.view('admin/destinations_gmail.ejs', {
      user: { id: me.id, username: me.username, isAdmin: me.is_admin === 1 },
      csrfToken: token,
      flash: takeFlash(req),
      configured: cfg !== null,
      client_id: cfg?.client_id ?? '',
      client_secret_mask: cfg ? maskSecret(cfg.client_secret) : '',
      redirect_uri: cfg?.redirect_uri ?? '',
      suggested_origin: origin,
      suggested_redirect_uri: defaultRedirect,
    });
  });

  app.post<{ Body: FormBody }>(
    '/admin/destinations/gmail',
    { preHandler: [requireAdmin, app.csrfProtection] },
    async (req, reply) => {
      const clientId = (req.body?.client_id ?? '').trim();
      const clientSecret = (req.body?.client_secret ?? '').trim();
      const redirectUri = (req.body?.redirect_uri ?? '').trim() || undefined;
      if (!clientId) {
        req.session.flash = 'client_id is required.';
        return reply.redirect('/destinations');
      }

      const existing = getGmailOAuthClient(app.db, app.appConfig.encryptionKeys);
      const effectiveSecret = clientSecret || existing?.client_secret || '';
      if (!effectiveSecret) {
        req.session.flash = 'client_secret is required the first time you save.';
        return reply.redirect('/destinations');
      }

      setGmailOAuthClient(app.db, app.appConfig.encryptionKeys, {
        client_id: clientId,
        client_secret: effectiveSecret,
        ...(redirectUri ? { redirect_uri: redirectUri } : {}),
      });
      audit(app.db, {
        action: 'admin.gmail_oauth.saved',
        details: {
          client_id: clientId,
          secret_updated: Boolean(clientSecret),
          redirect_uri: redirectUri ?? null,
        },
        req,
      });
      req.session.flash = clientSecret
        ? 'Gmail OAuth client saved (client_secret updated).'
        : 'Gmail OAuth client saved (client_secret kept).';
      return reply.redirect('/destinations');
    },
  );

  app.post<{ Body: { _csrf?: string } }>(
    '/admin/destinations/gmail/clear',
    { preHandler: [requireAdmin, app.csrfProtection] },
    async (req, reply) => {
      clearGmailOAuthClient(app.db);
      audit(app.db, { action: 'admin.gmail_oauth.cleared', req });
      req.session.flash = 'Gmail OAuth client cleared.';
      return reply.redirect('/destinations');
    },
  );
}
