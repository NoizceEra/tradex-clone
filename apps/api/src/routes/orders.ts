import type { FastifyInstance } from 'fastify';
import { OrderRequest, ClosePositionRequest } from '@pokex/shared-types';
import { getDb } from '../db/client.ts';
import { authenticate } from '../plugins/auth.ts';
import { openPosition, closePosition, getUserPositions } from '../services/engine.ts';

export async function orderRoutes(app: FastifyInstance): Promise<void> {
  app.post('/orders', { preHandler: authenticate }, async (req) => {
    const body = OrderRequest.parse(req.body);
    const r = await openPosition(await getDb(), req.userId!, {
      marketId: body.marketId,
      side: body.side as 'long' | 'short',
      qtyE6: BigInt(body.qtyE6),
      leverage: body.leverage,
      idempotencyKey: body.idempotencyKey,
    });
    return { ok: true, ...r };
  });

  app.post('/positions/:id/close', { preHandler: authenticate }, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = ClosePositionRequest.parse({ positionId: id, ...(req.body as object) });
    const r = await closePosition(await getDb(), req.userId!, {
      positionId: id,
      fractionBps: parsed.fractionBps,
      idempotencyKey: parsed.idempotencyKey,
    });
    return { ok: true, ...r };
  });

  app.get('/positions', { preHandler: authenticate }, async (req) => ({
    positions: await getUserPositions(await getDb(), req.userId!),
  }));
}
