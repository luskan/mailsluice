import { isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';
import type { Config } from '../config.ts';
import { publicOrigin } from './base_url.ts';

export function gmailSetupUrls(req: FastifyRequest, cfg: Config) {
  const base = publicOrigin(req, cfg);
  let hostname = '';
  let publicHttps = false;
  try {
    const url = new URL(base);
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) {
      hostname = url.hostname;
      publicHttps = url.protocol === 'https:' && hostname.includes('.')
        && !isIP(hostname.replace(/^\[|\]$/g, ''))
        && !/(^|\.)(localhost|local|internal)$/.test(hostname);
    }
  } catch { /* Show an explanation instead of guessing a domain. */ }
  return {
    suggested_redirect_uri: `${base}/destinations/gmail/callback`,
    oauth_setup: {
      homepage: `${base}/oauth-info`,
      privacy: `${base}/privacy`,
      hostname,
      publicHttps,
      pinned: Boolean(cfg.APP_PUBLIC_BASE_URL?.trim()),
    },
  };
}
