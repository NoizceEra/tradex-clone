import type { FastifyInstance } from 'fastify';
import { config } from '../config.ts';
import { HttpError } from '../errors.ts';
import { getDb } from '../db/client.ts';
import { authenticate } from '../plugins/auth.ts';
import { getOrCreateDepositAddress } from '../services/custody/wallet.ts';

/** Real-funds wallet endpoints (custody P1). Disabled in play-money mode. */
export async function walletRoutes(app: FastifyInstance): Promise<void> {
  app.get('/wallet/deposit-address', { preHandler: authenticate }, async (req) => {
    if (!config.realFunds) {
      throw new HttpError(403, 'real-funds deposits are disabled (play-money mode — use the faucet)');
    }
    const r = await getOrCreateDepositAddress(await getDb(), req.userId!);
    return { address: r.address };
  });
}
