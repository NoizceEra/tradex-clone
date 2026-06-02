import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/client.ts';
import { listMarketsWithData, getCandles } from '../services/markets.ts';

const TF_DAYS: Record<string, number> = { '1D': 1, '1W': 7, '1M': 30, '3M': 90, '1Y': 365 };

export async function marketRoutes(app: FastifyInstance): Promise<void> {
  app.get('/markets', async () => ({ markets: await listMarketsWithData(await getDb()) }));

  app.get('/markets/:id/candles', async (req) => {
    const { id } = req.params as { id: string };
    const tf = (req.query as { tf?: string })?.tf ?? '1M';
    const days = TF_DAYS[tf] ?? 30;
    return { tf, candles: await getCandles(await getDb(), id, days) };
  });
}
