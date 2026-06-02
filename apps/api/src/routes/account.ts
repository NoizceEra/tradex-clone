import type { FastifyInstance } from 'fastify';
import { FaucetRequest } from '@pokex/shared-types';
import { getDb } from '../db/client.ts';
import { authenticate } from '../plugins/auth.ts';
import { creditFaucet, getUserBalances } from '../services/faucet.ts';

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  app.get('/account/balance', { preHandler: authenticate }, async (req) => {
    const b = await getUserBalances(await getDb(), req.userId!);
    return {
      availableUusdc: b.availableUusdc.toString(),
      lockedMarginUusdc: b.lockedMarginUusdc.toString(),
      equityUusdc: b.equityUusdc.toString(),
    };
  });

  app.post('/faucet', { preHandler: authenticate }, async (req) => {
    const { amountUsd } = FaucetRequest.parse(req.body ?? {});
    const r = await creditFaucet(await getDb(), req.userId!, amountUsd);
    return { ok: true, txnId: r.txnId, availableUusdc: r.availableUusdc.toString() };
  });
}
