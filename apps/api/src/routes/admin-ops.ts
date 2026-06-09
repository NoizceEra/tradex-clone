import type { FastifyInstance } from 'fastify';
import { SetPriceRequest, InsuranceFundRequest } from '@pokex/shared-types';
import { config } from '../config.ts';
import { getDb } from '../db/client.ts';
import { rl } from './_ratelimit.ts';
import { requireAdminKey } from './admin.ts';
import { setManualPrice, setPricePin } from '../services/admin-pricing.ts';
import { fundInsurance, defundInsurance, getInsurance } from '../services/insurance.ts';

/**
 * Non-custody operator endpoints (ROADMAP §2). Unlike the custody admin routes, these register
 * whenever ADMIN_API_KEY is set — including play-money mode — because they don't move real funds.
 * Same auth as custody admin: the timing-safe ADMIN_API_KEY hook + the admin rate cap.
 *
 * Manual price override: the auto-oracle only covers pokemontcg.io (Pokémon, ~daily). Operators set
 * prices by hand from sources without an API (eBay sold listings, etc.); a set pins the market so the
 * auto-oracle won't overwrite it until unpinned.
 */
export async function adminOpsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireAdminKey);

  // Set a manual price for a market (card or index). Pins by default.
  app.post('/admin/markets/:id/price', rl(config.routeRateLimits.admin), async (req) => {
    const { id } = req.params as { id: string };
    const input = SetPriceRequest.parse(req.body);
    const r = await setManualPrice(await getDb(), id, BigInt(input.priceE6), {
      pin: input.pin,
      force: input.force,
      note: input.note,
      operator: 'admin', // the key authenticates the operator; finer identity can come later
    });
    return { id, ...r };
  });

  // Unpin a market so the automated oracle resumes overwriting its price.
  app.post('/admin/markets/:id/unpin', rl(config.routeRateLimits.admin), async (req) => {
    const { id } = req.params as { id: string };
    await setPricePin(await getDb(), id, false);
    return { id, pinned: false };
  });

  // Insurance buffer (absorbs gap bad-debt before LPs). GET the balance; deposit/withdraw move it
  // to/from a funded account's collateral — the operator pre-seeds it from real USDC they deposited.
  app.get('/admin/insurance', rl(config.routeRateLimits.admin), async () => getInsurance(await getDb()));
  app.post('/admin/insurance/deposit', rl(config.routeRateLimits.admin), async (req) => {
    const input = InsuranceFundRequest.parse(req.body);
    return fundInsurance(await getDb(), input.userId, BigInt(input.amountUusdc));
  });
  app.post('/admin/insurance/withdraw', rl(config.routeRateLimits.admin), async (req) => {
    const input = InsuranceFundRequest.parse(req.body);
    return defundInsurance(await getDb(), input.userId, BigInt(input.amountUusdc));
  });
}
