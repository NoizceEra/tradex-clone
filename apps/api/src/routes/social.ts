import type { FastifyInstance } from 'fastify';
import { ReferralRedeemRequest } from '@pokex/shared-types';
import { getDb } from '../db/client.ts';
import { authenticate } from '../plugins/auth.ts';
import { verifyAccessToken } from '../services/auth.ts';
import { getLeaderboard } from '../services/leaderboard.ts';
import { getReferralInfo, redeemReferral } from '../services/referral.ts';

export async function socialRoutes(app: FastifyInstance): Promise<void> {
  // Public board; a Bearer token is OPTIONAL and only used to pin the caller's own row.
  app.get('/leaderboard', async (req) => {
    const db = await getDb();
    const limit = Number((req.query as { limit?: string } | undefined)?.limit) || 100;
    const header = req.headers['authorization'];
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
    let viewerUserId: string | undefined;
    if (token) {
      try {
        viewerUserId = (await verifyAccessToken(token)).userId;
      } catch {
        /* anonymous view */
      }
    }
    return getLeaderboard(db, { limit, viewerUserId });
  });

  app.get('/referral/me', { preHandler: authenticate }, async (req) => {
    return getReferralInfo(await getDb(), req.userId!);
  });

  app.post('/referral/redeem', { preHandler: authenticate }, async (req) => {
    const { code } = ReferralRedeemRequest.parse(req.body ?? {});
    return redeemReferral(await getDb(), req.userId!, code);
  });
}
