import type { FastifyReply, FastifyRequest } from 'fastify';

export async function requireLogin(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!req.session?.userId) {
    if (req.headers.accept?.includes('text/html') ?? false) {
      return reply.redirect('/login');
    }
    reply.code(401).send({ error: 'unauthorized' });
  }
}

export async function requireAdmin(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!req.session?.userId) {
    if (req.headers.accept?.includes('text/html') ?? false) {
      return reply.redirect('/login');
    }
    reply.code(401).send({ error: 'unauthorized' });
    return;
  }
  if (!req.session.isAdmin) {
    reply.code(403).send({ error: 'forbidden' });
  }
}
