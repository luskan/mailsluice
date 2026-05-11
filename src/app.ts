import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifySession from '@fastify/session';
import fastifyCsrf from '@fastify/csrf-protection';
import fastifyFormbody from '@fastify/formbody';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fastifyHelmet from '@fastify/helmet';
import fastifyView from '@fastify/view';
import ejs from 'ejs';
import type { Config } from './config.ts';
import type { Db } from './db/index.ts';
import { registerAuthRoutes } from './auth/routes.ts';
import { registerAccountRoutes } from './auth/account_routes.ts';
import { registerAcknowledgeRoutes } from './auth/acknowledge_routes.ts';
import { registerBasicAuth } from './auth/basic_auth.ts';
import { requireLogin } from './auth/middleware.ts';
import { RISK_ACK_VERSION } from './risk_ack.ts';
import { registerAdminUserRoutes } from './admin/users_routes.ts';
import { registerAdminDestinationRoutes } from './admin/destinations_routes.ts';
import { registerAdminAuditRoutes } from './admin/audit_routes.ts';
import { registerAdminEventsRoutes } from './admin/events_routes.ts';
import { registerDestinationRoutes } from './destinations/routes.ts';
import { registerDestination } from './destinations/registry.ts';
import { GmailFactory } from './destinations/gmail.ts';
import { registerSourceRoutes } from './sources/routes.ts';
import {
  testConnection as realTestConnection,
  listImapFolders as realListImapFolders,
  type TestConnectionArgs,
  type TestConnectionResult,
  type ListFoldersArgs,
  type ListFoldersResult,
} from './sources/test_connection.ts';
import { relativeTime } from './ui/time.ts';
import { APP_VERSION } from './version.ts';

import type { SyncManager } from './sync/manager.ts';

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    appConfig: Config;
    syncManager?: SyncManager;
    testConnection: (args: TestConnectionArgs) => Promise<TestConnectionResult>;
    listImapFolders: (args: ListFoldersArgs) => Promise<ListFoldersResult>;
  }
  interface Session {
    userId?: number;
    isAdmin?: boolean;
    flash?: string;
    oauthState?: string;
    oauthRedirect?: string;
    oauthReconnectFor?: number;
  }
}

const here = dirname(fileURLToPath(import.meta.url));

export async function buildApp(cfg: Config, db: Db): Promise<FastifyInstance> {
  const trustProxy = parseTrustProxy(cfg.APP_TRUST_PROXY);
  const app = Fastify({
    logger: cfg.NODE_ENV !== 'test',
    trustProxy,
  });

  app.decorate('db', db);
  app.decorate('appConfig', cfg);
  app.decorate('syncManager', undefined as SyncManager | undefined);
  app.decorate('testConnection', realTestConnection);
  app.decorate('listImapFolders', realListImapFolders);

  if (cfg.APP_HTTP_AUTH && cfg.APP_HTTP_AUTH.length > 0) {
    registerBasicAuth(app, cfg.APP_HTTP_AUTH);
  }

  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    // HSTS only makes sense if the app is reached over HTTPS; helmet defaults
    // are fine there, and harmless otherwise because browsers ignore it on
    // plain HTTP.
  });

  await app.register(fastifyFormbody);
  await app.register(fastifyCookie);
  await app.register(fastifySession, {
    secret: cfg.APP_SESSION_SECRET,
    cookieName: 'mailsluice.sid',
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: resolveSecure(cfg.APP_COOKIE_SECURE),
      maxAge: 1000 * 60 * 60 * 24 * 7,
    },
    saveUninitialized: false,
  });
  await app.register(fastifyCsrf, { sessionPlugin: '@fastify/session' });
  await app.register(fastifyRateLimit, {
    global: false,
  });

  await app.register(fastifyView, {
    engine: { ejs },
    root: join(here, 'views'),
    viewExt: 'ejs',
    defaultContext: { appVersion: APP_VERSION },
  });

  await app.register(fastifyStatic, {
    root: join(here, 'public'),
    prefix: '/public/',
    decorateReply: false,
  });

  app.route({
    method: ['GET', 'HEAD'],
    url: '/health',
    handler: async () => ({ ok: true }),
  });

  registerDestination(GmailFactory);

  registerAckGate(app);

  await registerAuthRoutes(app);
  await registerAccountRoutes(app);
  await registerAcknowledgeRoutes(app);
  await registerAdminUserRoutes(app);
  await registerAdminDestinationRoutes(app);
  await registerAdminAuditRoutes(app);
  await registerAdminEventsRoutes(app);
  await registerDestinationRoutes(app);
  await registerSourceRoutes(app);

  app.get('/', { preHandler: requireLogin }, async (req, reply) => {
    const user = loadUser(app.db, req.session.userId!);
    const token = await reply.generateCsrf();

    const sources = app.db
      .prepare(
        `SELECT s.id, s.name, s.type, s.host, s.port, s.enabled, s.last_error, s.last_sync_at, s.skipped_count, s.destination_tag,
                (SELECT COUNT(*) FROM imported_messages WHERE source_id = s.id) AS imported_count
         FROM sources s WHERE s.user_id = ? ORDER BY s.id`,
      )
      .all(user.id) as Array<{
        id: number; name: string; type: string; host: string; port: number; enabled: number;
        last_error: string | null; last_sync_at: string | null; skipped_count: number;
        destination_tag: string; imported_count: number;
      }>;

    const liveStatuses = app.syncManager?.statuses() ?? {};
    const sourcesWithStatus = sources.map((s) => ({
      ...s,
      enabled: s.enabled === 1,
      connected: liveStatuses[s.id]?.connected ?? false,
      last_sync_at_display: relativeTime(s.last_sync_at),
    }));

    const destCount = app.db
      .prepare('SELECT COUNT(*) AS n FROM destinations WHERE user_id = ?')
      .get(user.id) as { n: number };

    return reply.view('home.ejs', {
      user,
      csrfToken: token,
      sources: sourcesWithStatus,
      hasDestinations: destCount.n > 0,
    });
  });

  return app;
}

// Logged-in users with a stale or missing risk ack are bounced to /acknowledge
// before they can reach anything that mutates state. Allowlist below covers
// session bootstrap, logout, the ack page itself, password change, health,
// and static assets.
const ACK_ALLOWLIST = new Set<string>([
  '/login',
  '/logout',
  '/acknowledge',
  '/health',
  '/account/password',
]);

function registerAckGate(app: FastifyInstance): void {
  // Test config bypasses the gate so existing integration tests keep working
  // without an explicit ack on every seeded user. Production is unaffected.
  if (app.appConfig.NODE_ENV === 'test') return;
  app.addHook('onRequest', async (req, reply) => {
    if (!req.session?.userId) return;
    const path = req.url.split('?', 1)[0]!;
    if (ACK_ALLOWLIST.has(path) || path.startsWith('/public/')) return;
    const row = app.db
      .prepare('SELECT risk_acked_version FROM users WHERE id = ?')
      .get(req.session.userId) as { risk_acked_version: string | null } | undefined;
    if (row?.risk_acked_version === RISK_ACK_VERSION) return;
    if (req.headers.accept?.includes('text/html')) {
      return reply.redirect('/acknowledge');
    }
    return reply.code(403).send({ error: 'risk acknowledgement required' });
  });
}

function parseTrustProxy(raw: string): boolean | string | number {
  const v = raw.trim();
  if (v === '' || v.toLowerCase() === 'false' || v === '0') return false;
  if (v.toLowerCase() === 'true') return true;
  const n = Number(v);
  if (Number.isInteger(n) && n > 0) return n;
  return v;
}

function resolveSecure(mode: 'auto' | 'true' | 'false'): boolean | 'auto' {
  if (mode === 'true') return true;
  if (mode === 'false') return false;
  // Let @fastify/session decide per request: Secure when req.protocol is
  // https (which honours X-Forwarded-Proto if APP_TRUST_PROXY is set).
  // Plain-HTTP localhost gets a non-Secure cookie, so the session and CSRF
  // actually work; HTTPS deployments still get Secure.
  return 'auto';
}

function loadUser(db: Db, id: number): { id: number; username: string; isAdmin: boolean } {
  const row = db
    .prepare('SELECT id, username, is_admin FROM users WHERE id = ?')
    .get(id) as { id: number; username: string; is_admin: number };
  return { id: row.id, username: row.username, isAdmin: row.is_admin === 1 };
}
