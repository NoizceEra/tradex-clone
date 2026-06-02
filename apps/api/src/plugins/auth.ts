import type { FastifyReply, FastifyRequest } from 'fastify';
import { verifyAccessToken } from '../services/auth.ts';

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
    pubkey?: string;
  }
}

/** preHandler that requires a valid Bearer access token; sets req.userId / req.pubkey. */
export async function authenticate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = req.headers['authorization'];
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    await reply.code(401).send({ error: 'unauthorized' });
    return;
  }
  try {
    const { userId, pubkey } = await verifyAccessToken(token);
    req.userId = userId;
    req.pubkey = pubkey;
  } catch {
    await reply.code(401).send({ error: 'invalid or expired token' });
  }
}
