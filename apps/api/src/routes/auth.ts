import type { FastifyInstance } from 'fastify';
import { NonceRequest, VerifyRequest } from '@pokex/shared-types';
import { getDb } from '../db/client.ts';
import { HttpError } from '../errors.ts';
import { createNonce, verifyAndLogin, refresh, logout } from '../services/auth.ts';
import { authenticate } from '../plugins/auth.ts';

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/nonce', async (req) => {
    const { pubkey } = NonceRequest.parse(req.body);
    return createNonce(await getDb(), pubkey);
  });

  app.post('/auth/verify', async (req) => {
    const input = VerifyRequest.parse(req.body);
    return verifyAndLogin(await getDb(), input);
  });

  app.post('/auth/refresh', async (req) => {
    const body = (req.body ?? {}) as { refreshToken?: string };
    if (!body.refreshToken) throw new HttpError(400, 'refreshToken required');
    return refresh(await getDb(), body.refreshToken);
  });

  app.post('/auth/logout', { preHandler: authenticate }, async (req) => {
    const body = (req.body ?? {}) as { refreshToken?: string };
    await logout(await getDb(), body.refreshToken, req.userId!);
    return { ok: true };
  });

  app.get('/auth/me', { preHandler: authenticate }, async (req) => ({
    id: req.userId,
    pubkey: req.pubkey,
  }));
}
