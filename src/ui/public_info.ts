import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

export function isPublicInfoRequest(method: string, url: string): boolean {
  const path = url.split('?', 1)[0];
  return (method === 'GET' || method === 'HEAD') && (path === '/oauth-info' || path === '/privacy');
}

// Self-contained pages must not fetch the Basic-Auth-protected app stylesheet.
const style = `:root{color-scheme:dark}body{margin:0;background:#111322;color:#e5e7ef;font:16px/1.65 system-ui,sans-serif}main{max-width:48rem;margin:auto;padding:2rem 1.25rem}nav{border-bottom:1px solid #34384d;padding-bottom:1rem}a{color:#93c5fd}h1,h2{line-height:1.25}h2{margin-top:2rem}footer{margin-top:3rem;border-top:1px solid #34384d;padding-top:1rem}`;
const styleHash = createHash('sha256').update(style).digest('base64');

export function registerPublicInfoRoutes(app: FastifyInstance): void {
  for (const [url, page] of [['/oauth-info', 'oauth_info'], ['/privacy', 'privacy']] as const) {
    app.route({
      // Fastify's implicit HEAD route removes the rendered response body.
      method: 'GET',
      url,
      handler: async (_req, reply) => {
        // Allow only this constant stylesheet; retain the other Helmet headers.
        reply.header('Content-Security-Policy', `default-src 'none'; style-src 'sha256-${styleHash}'; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
        return reply.view(`public/${page}.ejs`, { style });
      },
    });
  }
}
