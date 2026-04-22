import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

type Credential = { user: Buffer; password: Buffer };

const COLON = 0x3a;

function parseSpec(spec: string): Credential | null {
  const idx = spec.indexOf(':');
  if (idx <= 0 || idx === spec.length - 1) return null;
  return {
    user: Buffer.from(spec.slice(0, idx), 'utf8'),
    password: Buffer.from(spec.slice(idx + 1), 'utf8'),
  };
}

function parseHeader(header: string): Credential | null {
  if (!header.startsWith('Basic ')) return null;
  const decoded = Buffer.from(header.slice(6), 'base64');
  const sep = decoded.indexOf(COLON);
  if (sep <= 0 || sep === decoded.length - 1) return null;
  return {
    user: decoded.subarray(0, sep),
    password: decoded.subarray(sep + 1),
  };
}

function eqConst(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function pathOnly(rawUrl: string): string {
  const q = rawUrl.indexOf('?');
  return q < 0 ? rawUrl : rawUrl.slice(0, q);
}

type Throttle = { fails: number; resetAt: number };
const THROTTLE_WINDOW_MS = 60_000;
const THROTTLE_MAX = 60;

export function registerBasicAuth(app: FastifyInstance, spec: string): void {
  const expected = parseSpec(spec);
  if (!expected) {
    throw new Error('APP_HTTP_AUTH must be in the form user:password');
  }
  const throttle = new Map<string, Throttle>();

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const path = pathOnly(req.url);
    if (path === '/health') return;

    const ip = req.ip;
    const now = Date.now();
    const entry = throttle.get(ip);
    if (entry && entry.resetAt > now && entry.fails >= THROTTLE_MAX) {
      reply.header('Retry-After', Math.ceil((entry.resetAt - now) / 1000));
      return reply.code(429).send('Too many authentication attempts');
    }

    const header = req.headers.authorization;
    const got = header ? parseHeader(header) : null;
    const ok = got !== null
      && eqConst(got.user, expected.user)
      && eqConst(got.password, expected.password);

    if (ok) return;

    if (!entry || entry.resetAt <= now) {
      throttle.set(ip, { fails: 1, resetAt: now + THROTTLE_WINDOW_MS });
    } else {
      entry.fails += 1;
    }
    reply.header('WWW-Authenticate', 'Basic realm="mailsluice", charset="UTF-8"');
    return reply.code(401).send('Authentication required');
  });
}
