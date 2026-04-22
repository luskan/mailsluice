import type { FastifyRequest } from 'fastify';
import type { Config } from '../config.ts';

// Prefer an operator-configured public base URL so OAuth redirect_uri and any
// other absolute URL cannot be shifted by a forged Host header. Falls back to
// request-derived origin for local development.
export function publicOrigin(req: FastifyRequest, cfg: Config): string {
  const configured = cfg.APP_PUBLIC_BASE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  const host = (req.headers.host as string | undefined) ?? req.hostname;
  const fwdProto = req.headers['x-forwarded-proto'];
  const proto = typeof fwdProto === 'string' ? fwdProto.split(',')[0]!.trim() : req.protocol;
  return `${proto}://${host}`;
}
