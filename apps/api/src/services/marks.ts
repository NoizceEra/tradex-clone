import { syntheticMark } from '@pokex/pricing';
import { publish } from './bus.ts';
import { config } from '../config.ts';
import type { Queryer } from '../db/client.ts';
import type { MarketRow } from './markets.ts';

/**
 * Compute and persist the synthetic mark for a market, then publish it.
 *   mark = clamp(index * (1 + premium), ±max_dev),  premium = clamp(k * skew/depth, ±cap)
 * With skew = 0 (no open interest) the mark equals the index. The engine calls this with
 * live skew/depth on every trade so the price moves intraday. Depth falls back to the
 * configured floor only when the caller passes 0 (e.g. the skew-0 ingest path, where it's moot).
 */
export async function recomputeMark(
  q: Queryer,
  market: MarketRow,
  indexE6: bigint,
  skewUusdc: bigint,
  depthUusdc: bigint,
): Promise<bigint> {
  const { markE6, premiumE6 } = syntheticMark({
    indexE6,
    skewUusdc,
    depthUusdc: depthUusdc > 0n ? depthUusdc : config.depthFloorUusdc,
    kE6: BigInt(market.skew_k_e6),
    premiumCapE6: BigInt(market.premium_cap_e6),
    maxDevBps: market.max_dev_bps,
  });
  await q.query(
    `INSERT INTO marks(market_id, mark_price_e6, index_price_e6, skew_uusdc, premium_e6)
     VALUES($1, $2, $3, $4, $5)`,
    [market.id, markE6.toString(), indexE6.toString(), skewUusdc.toString(), premiumE6.toString()],
  );
  publish(`mark:${market.id}`, 'mark', {
    marketId: market.id,
    markE6: markE6.toString(),
    indexE6: indexE6.toString(),
    premiumE6: premiumE6.toString(),
    ts: new Date().toISOString(),
  });
  return markE6;
}
