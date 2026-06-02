import { randomUUID } from 'node:crypto';
import { getCardPrice, toE6 } from '@pokex/pricing';
import { INDEX_CATALOG } from '@pokex/shared-types';
import { config } from '../config.ts';
import type { Db, Queryer } from '../db/client.ts';
import { upsertCardMarket, upsertIndexMarket, getMarketById } from './markets.ts';
import { recomputeMark } from './marks.ts';

/** Returns an array of pokemontcg.io card objects. Injectable for tests. */
export type CardFetcher = () => Promise<any[]>;

const OUTLIER_THRESHOLD = 0.6; // reject prints > 60% from last accepted (manipulation/staleness guard)
const BASE_VALUE_E6 = 1_000_000_000n; // indices start at 1000.000000 points

function pickVariant(c: any): string | null {
  const p = c?.tcgplayer?.prices;
  if (!p) return null;
  if (p.holofoil?.market) return 'holofoil';
  if (p.normal?.market) return 'normal';
  if (p['1stEditionHolofoil']?.market) return '1stEditionHolofoil';
  if (p.reverseHolofoil?.market) return 'reverseHolofoil';
  return null;
}

/** Live fetcher: top Pokémon cards by TCGplayer market price (server-side, keyless-ok). */
export async function fetchTopCards(): Promise<any[]> {
  const url = `${config.pokemontcgBase}/cards?q=supertype:Pok%C3%A9mon&orderBy=-tcgplayer.prices.holofoil.market&pageSize=250`;
  const headers: Record<string, string> = {};
  if (config.pokemontcgApiKey) headers['X-Api-Key'] = config.pokemontcgApiKey;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`pokemontcg.io responded ${res.status}`);
  const json = (await res.json()) as any;
  return json?.data ?? [];
}

/** Insert an oracle print, guarding against outliers. Returns whether it was accepted. */
async function recordOracle(
  q: Queryer,
  marketId: string,
  indexE6: bigint,
  observedAt: Date,
  payload: unknown,
): Promise<boolean> {
  const last = await q.query<{ v: string }>(
    `SELECT index_price_e6::text AS v FROM oracle_prices
     WHERE market_id = $1 AND is_accepted ORDER BY source_observed_at DESC LIMIT 1`,
    [marketId],
  );
  let accepted = true;
  let reason: string | null = null;
  const prev = last.rows[0] ? BigInt(last.rows[0].v) : 0n;
  if (prev > 0n) {
    const dev = Number(indexE6 - prev) / Number(prev);
    if (Math.abs(dev) > OUTLIER_THRESHOLD) {
      accepted = false;
      reason = `outlier ${(dev * 100).toFixed(0)}% vs last`;
    }
  }
  await q.query(
    `INSERT INTO oracle_prices(market_id, index_price_e6, raw_payload, source_observed_at, is_accepted, reject_reason)
     VALUES($1, $2, $3, $4, $5, $6)
     ON CONFLICT(market_id, source_observed_at) DO NOTHING`,
    [marketId, indexE6.toString(), JSON.stringify(payload ?? null), observedAt.toISOString(), accepted, reason],
  );
  return accepted;
}

/** Ingest a price snapshot: upsert card markets, record prints, recompute marks, rebuild indices. */
export async function ingest(db: Db, fetcher: CardFetcher = fetchTopCards): Promise<{ cards: number; indices: number }> {
  const raw = await fetcher();
  const observedAt = new Date();
  const priced = raw
    .map((c) => ({ c, priceE6: toE6(getCardPrice(c)) }))
    .filter((x) => x.priceE6 > 0n);

  for (const { c, priceE6 } of priced) {
    const marketId = await db.tx((q) =>
      upsertCardMarket(q, {
        symbol: c.id,
        cardId: c.id,
        displayName: `${c.name}${c.number ? ' #' + c.number : ''}`,
        variant: pickVariant(c),
        imageSmall: c.images?.small ?? null,
      }),
    );
    const accepted = await db.tx((q) => recordOracle(q, marketId, priceE6, observedAt, { tcgplayer: c.tcgplayer ?? null }));
    if (accepted) {
      const market = await getMarketById(db, marketId);
      if (market) await db.tx((q) => recomputeMark(q, market, priceE6, 0n, 0n));
    }
  }

  const sorted = [...priced].sort((a, b) => (b.priceE6 > a.priceE6 ? 1 : b.priceE6 < a.priceE6 ? -1 : 0));
  let indices = 0;
  for (const idx of INDEX_CATALOG) {
    if (!idx.tradeable) {
      await db.tx((q) => upsertIndexMarket(q, { slug: idx.slug, name: idx.name, tradeable: false }));
      continue;
    }
    const n = idx.slug === 'top-100' ? 100 : idx.slug === 'top-250' ? 250 : sorted.length;
    const members = sorted.slice(0, n).map((x) => ({ cardId: x.c.id as string, priceE6: x.priceE6 }));
    await buildIndex(db, idx, members, observedAt);
    indices++;
  }
  return { cards: priced.length, indices };
}

async function buildIndex(
  db: Db,
  idx: { slug: string; name: string },
  members: { cardId: string; priceE6: bigint }[],
  observedAt: Date,
): Promise<void> {
  if (members.length === 0) return;
  const rawE6 = members.reduce((a, m) => a + m.priceE6, 0n);
  const marketId = await db.tx((q) => upsertIndexMarket(q, { slug: idx.slug, name: idx.name, tradeable: true }));

  // Divisor is set once for continuity: index_value = rawE6 / divisor (≈ base on first build).
  const divRow = await db.query<{ d: string }>(
    `SELECT divisor_e6::text AS d FROM index_divisors WHERE market_id = $1`,
    [marketId],
  );
  let divisor: bigint;
  if (divRow.rows[0]) {
    divisor = BigInt(divRow.rows[0].d);
  } else {
    divisor = rawE6 / BASE_VALUE_E6;
    if (divisor <= 0n) divisor = 1n;
    await db.query(
      `INSERT INTO index_divisors(market_id, divisor_e6, base_value_e6) VALUES($1, $2, $3)
       ON CONFLICT(market_id) DO NOTHING`,
      [marketId, divisor.toString(), BASE_VALUE_E6.toString()],
    );
  }
  const indexValueE6 = rawE6 / divisor;

  // Snapshot constituents (transparency / future rebalancing).
  await db.tx(async (q) => {
    await q.query(`DELETE FROM index_constituents WHERE market_id = $1`, [marketId]);
    for (const m of members) {
      await q.query(
        `INSERT INTO index_constituents(id, market_id, card_id, weight_e6) VALUES($1, $2, $3, $4)`,
        [randomUUID(), marketId, m.cardId, m.priceE6.toString()],
      );
    }
  });

  const accepted = await db.tx((q) =>
    recordOracle(q, marketId, indexValueE6, observedAt, { kind: 'index', constituents: members.length }),
  );
  if (accepted) {
    const market = await getMarketById(db, marketId);
    if (market) await db.tx((q) => recomputeMark(q, market, indexValueE6, 0n, 0n));
  }
}
