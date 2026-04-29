import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { OAuth2Client } from 'google-auth-library';
import { requireLogin } from '../auth/middleware.ts';
import { decryptJson, encryptJson } from '../crypto.ts';
import { getDestinationFactory } from './registry.ts';
import type { GmailAdminConfig, GmailUserCredentials } from './gmail.ts';
import { getGmailOAuthClient, maskSecret } from '../settings.ts';
import { relativeTime } from '../ui/time.ts';
import { audit } from '../audit.ts';
import { publicOrigin } from '../ui/base_url.ts';

type DestinationRow = {
  id: number;
  user_id: number;
  type: string;
  account_identifier: string | null;
  credentials_encrypted: Buffer;
  enabled: number;
  created_at: string;
};

function takeFlash(req: { session: { flash?: string } }): string | null {
  const f = req.session.flash ?? null;
  if (f != null) delete req.session.flash;
  return f;
}

function computeRedirectUri(
  origin: string,
  adminRedirectOverride: string | undefined,
  type: string,
): string {
  if (adminRedirectOverride && adminRedirectOverride.length > 0) return adminRedirectOverride;
  return `${origin}/destinations/${type}/callback`;
}

function listForUser(app: FastifyInstance, userId: number): DestinationRow[] {
  return app.db
    .prepare(
      'SELECT id, user_id, type, account_identifier, credentials_encrypted, enabled, created_at FROM destinations WHERE user_id = ? ORDER BY id',
    )
    .all(userId) as DestinationRow[];
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

export async function registerDestinationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/destinations', { preHandler: requireLogin }, async (req, reply) => {
    const token = await reply.generateCsrf();
    const user = loadUser(app, req.session.userId!);
    const rows = listForUser(app, user.id);
    const admin = getGmailOAuthClient(app.db, app.appConfig.encryptionKeys);

    const origin = publicOrigin(req, app.appConfig);
    const suggestedRedirectUri = `${origin}/destinations/gmail/callback`;

    return reply.view('destinations/list.ejs', {
      user,
      csrfToken: token,
      flash: takeFlash(req),
      destinations: rows.map((r) => ({
        id: r.id,
        type: r.type,
        account_identifier: r.account_identifier,
        enabled: r.enabled === 1,
        created_at: r.created_at,
        created_at_display: relativeTime(r.created_at),
      })),
      adminConfigured: admin !== null,
      configured: admin !== null,
      client_id: admin?.client_id ?? '',
      client_secret_mask: admin ? maskSecret(admin.client_secret) : '',
      redirect_uri: admin?.redirect_uri ?? '',
      suggested_origin: origin,
      suggested_redirect_uri: suggestedRedirectUri,
    });
  });

  app.get(
    '/destinations/gmail/connect',
    { preHandler: requireLogin },
    async (req, reply) => {
      const user = loadUser(app, req.session.userId!);
      const existing = listForUser(app, user.id);
      if (existing.length > 0) {
        req.session.flash = 'Only one destination per user in v1. Disconnect the existing one first.';
        return reply.redirect('/destinations');
      }

      const admin = getGmailOAuthClient(app.db, app.appConfig.encryptionKeys);
      if (!admin) {
        return reply.view('destinations/admin_not_configured.ejs', {
          user,
          csrfToken: await reply.generateCsrf(),
        });
      }

      const factory = getDestinationFactory('gmail');
      if (!factory) return reply.code(500).send({ error: 'gmail factory not registered' });

      const redirectUri = computeRedirectUri(
        publicOrigin(req, app.appConfig),
        admin.redirect_uri,
        'gmail',
      );
      const state = randomBytes(24).toString('base64url');
      req.session.oauthState = state;
      req.session.oauthRedirect = redirectUri;

      const starter = factory.createAuthStarter({ adminConfig: admin, redirectUri });
      return reply.redirect(starter.authUrl(state));
    },
  );

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/destinations/gmail/callback',
    { preHandler: requireLogin },
    async (req, reply) => {
      const user = loadUser(app, req.session.userId!);
      const expected = req.session.oauthState;
      const redirectUri = req.session.oauthRedirect;
      delete req.session.oauthState;
      delete req.session.oauthRedirect;

      if (!expected || req.query.state !== expected) {
        return reply.code(400).send({ error: 'invalid oauth state' });
      }
      if (req.query.error) {
        req.session.flash = `Google rejected authorization: ${req.query.error}`;
        return reply.redirect('/destinations');
      }
      if (!req.query.code) {
        return reply.code(400).send({ error: 'missing code' });
      }
      if (!redirectUri) {
        return reply.code(400).send({ error: 'missing redirect context' });
      }

      const admin = getGmailOAuthClient(app.db, app.appConfig.encryptionKeys);
      if (!admin) {
        req.session.flash = 'Admin removed the Gmail OAuth config between connect and callback.';
        return reply.redirect('/destinations');
      }

      const factory = getDestinationFactory('gmail')!;
      const starter = factory.createAuthStarter({ adminConfig: admin, redirectUri });
      try {
        const params = new URLSearchParams({
          code: req.query.code,
          state: req.query.state ?? '',
        });
        const { userCredentials, accountIdentifier } = await starter.handleCallback(params);

        const tx = app.db.transaction((): number => {
          const res = app.db
            .prepare(
              'INSERT INTO destinations (user_id, type, account_identifier, credentials_encrypted) VALUES (?, ?, ?, ?)',
            )
            .run(user.id, 'gmail', accountIdentifier, Buffer.alloc(0));
          const id = Number(res.lastInsertRowid);
          const enc = encryptJson(
            userCredentials,
            app.appConfig.encryptionKeys,
            `destinations.credentials:${id}`,
          );
          app.db
            .prepare('UPDATE destinations SET credentials_encrypted = ? WHERE id = ?')
            .run(enc, id);
          return id;
        });
        const newId = tx();

        audit(app.db, {
          action: 'destination.connected',
          targetType: 'destination',
          targetId: newId,
          details: { type: 'gmail', account: accountIdentifier },
          req,
        });
        req.session.flash = `Connected Gmail: ${accountIdentifier}`;
        return reply.redirect('/destinations');
      } catch (err) {
        req.session.flash = `OAuth callback failed: ${err instanceof Error ? err.message : String(err)}`;
        return reply.redirect('/destinations');
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { _csrf?: string } }>(
    '/destinations/:id/disconnect',
    { preHandler: [requireLogin, app.csrfProtection] },
    async (req, reply) => {
      const user = loadUser(app, req.session.userId!);
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad id' });

      const row = app.db
        .prepare(
          'SELECT id, user_id, type, credentials_encrypted FROM destinations WHERE id = ?',
        )
        .get(id) as
        | { id: number; user_id: number; type: string; credentials_encrypted: Buffer }
        | undefined;
      if (!row || row.user_id !== user.id) {
        return reply.code(404).send({ error: 'not found' });
      }

      if (row.type === 'gmail') {
        const admin = getGmailOAuthClient(app.db, app.appConfig.encryptionKeys);
        if (admin) {
          try {
            const creds = decryptJson<GmailUserCredentials>(
              row.credentials_encrypted,
              app.appConfig.encryptionKeys,
              `destinations.credentials:${row.id}`,
            );
            const client = new OAuth2Client({
              clientId: admin.client_id,
              clientSecret: admin.client_secret,
            });
            client.setCredentials(creds);
            if (creds.refresh_token) {
              const revoke = client.revokeToken(creds.refresh_token).then(
                () => undefined,
                () => undefined,
              );
              const timeout = new Promise<void>((resolve) => setTimeout(resolve, 8000).unref());
              await Promise.race([revoke, timeout]);
            }
          } catch {
            // Non-fatal: we still remove the local record.
          }
        }
      }

      await app.syncManager?.stopDestinationWorkers(id).catch(() => undefined);
      const tx = app.db.transaction(() => {
        app.db.prepare('DELETE FROM sources WHERE destination_id = ?').run(id);
        app.db.prepare('DELETE FROM destinations WHERE id = ?').run(id);
      });
      tx();
      audit(app.db, {
        action: 'destination.disconnected',
        targetType: 'destination',
        targetId: id,
        details: { type: row.type },
        req,
      });
      req.session.flash = 'Destination disconnected. Any sources attached to it were also removed.';
      return reply.redirect('/destinations');
    },
  );
}
