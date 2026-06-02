import { randomUUID } from 'node:crypto';
import type { Db, Queryer } from '../db/client.ts';
import { usdc } from '../money.ts';

/** Market row with all BIGINT columns surfaced as decimal strings. */
export interface MarketRow {
  id: string;
  kind: 'card' | 'index';
  symbol: string;
  display_name: string;
  card_id: string | null;
  variant: string | null;
  index_slug: string | null;
  image_small: string | null;
  status: string;
  tradeable: boolean;
  max_leverage_e2: number;
  init_margin_bps: number;
  maint_margin_bps: number;
  max_oi_long_uusdc: string;
  max_oi_short_uusdc: string;
  skew_k_e6: string;
  premium_cap_e6: string;
  max_dev_bps: number;
  min_qty_e6: string;
  qty_step_e6: string;
  price_tick_e6: string;
}

const COLS = `id, kind, symbol, display_name, card_id, variant, index_slug, image_small, status, tradeable,
  max_leverage_e2, init_margin_bps, maint_margin_bps,
  max_oi_long_uusdc::text AS max_oi_long_uusdc, max_oi_short_uusdc::text AS max_oi_short_uusdc,
  skew_k_e6::text AS skew_k_e6, premium_cap_e6::text AS premium_cap_e6, max_dev_bps,
  min_qty_e6::text AS min_qty_e6, qty_step_e6::text AS qty_step_e6, price_tick_e6::text AS price_tick_e6`;

export async function getMarketById(q: Queryer, id: string): Promise<MarketRow | null> {
  const r = await q.query<MarketRow>(`SELECT ${COLS} FROM markets WHERE id = $1`, [id]);
  return r.rows[0] ?? null;
}

export async function upsertCardMarket(
  q: Queryer,
  opts: { symbol: string; cardId: string; displayName: string; variant: string | null; imageSmall: string | null },
): Promise<string> {
  const id = randomUUID();
  const oi = usdc(50_000).toString();
  await q.query(
    `INSERT INTO markets(id, kind, symbol, display_name, card_id, variant, image_small, tradeable,
       max_oi_long_uusdc, max_oi_short_uusdc)
     VALUES($1, 'card', $2, $3, $4, $5, $6, true, $7, $7)
     ON CONFLICT(symbol) DO UPDATE
       SET display_name = EXCLUDED.display_name, image_small = EXCLUDED.image_small, variant = EXCLUDED.variant`,
    [id, opts.symbol, opts.displayName, opts.cardId, opts.variant, opts.imageSmall, oi],
  );
  const r = await q.query<{ id: string }>(`SELECT id FROM markets WHERE symbol = $1`, [opts.symbol]);
  return r.rows[0].id;
}

export async function upsertIndexMarket(
  q: Queryer,
  opts: { slug: string; name: string; tradeable: boolean },
): Promise<string> {
  const id = randomUUID();
  const symbol = `INDEX:${opts.slug}`;
  const oi = usdc(250_000).toString(); // indices are diversified -> deeper books
  await q.query(
    `INSERT INTO markets(id, kind, symbol, display_name, index_slug, tradeable,
       max_oi_long_uusdc, max_oi_short_uusdc, max_dev_bps)
     VALUES($1, 'index', $2, $3, $4, $5, $6, $6, 1000)
     ON CONFLICT(symbol) DO UPDATE
       SET display_name = EXCLUDED.display_name, tradeable = EXCLUDED.tradeable`,
    [id, symbol, opts.name, opts.slug, opts.tradeable, oi],
  );
  const r = await q.query<{ id: string }>(`SELECT id FROM markets WHERE symbol = $1`, [symbol]);
  return r.rows[0].id;
}

/** Markets list for the API: latest mark + index + change-vs-previous-print. */
export interface MarketView {
  id: string;
  kind: 'card' | 'index';
  symbol: string;
  displayName: string;
  cardId: string | null;
  indexSlug: string | null;
  imageSmall: string | null;
  status: string;
  tradeable: boolean;
  maxLeverage: number;
  maintMarginBps: number;
  markE6: string | null;
  indexE6: string | null;
  change24hPct: number;
}

export async function listMarketsWithData(db: Db): Promise<MarketView[]> {
  const markets = await db.query<MarketRow>(`SELECT ${COLS} FROM markets ORDER BY kind DESC, display_name`);

  const latest = await db.query<{ market_id: string; mark_e6: string; index_e6: string }>(
    `SELECT DISTINCT ON (market_id) market_id, mark_price_e6::text AS mark_e6, index_price_e6::text AS index_e6
     FROM marks ORDER BY market_id, computed_at DESC`,
  );
  const latestMap = new Map(latest.rows.map((r) => [r.market_id, r]));

  // change vs the previous accepted oracle print
  const hist = await db.query<{ market_id: string; latest: string | null; prev: string | null }>(
    `SELECT market_id,
            (array_agg(index_price_e6 ORDER BY source_observed_at DESC))[1]::text AS latest,
            (array_agg(index_price_e6 ORDER BY source_observed_at DESC))[2]::text AS prev
     FROM oracle_prices WHERE is_accepted GROUP BY market_id`,
  );
  const changeMap = new Map<string, number>();
  for (const h of hist.rows) {
    if (h.latest && h.prev && BigInt(h.prev) !== 0n) {
      const change = (Number(BigInt(h.latest) - BigInt(h.prev)) / Number(BigInt(h.prev))) * 100;
      changeMap.set(h.market_id, Math.round(change * 100) / 100);
    }
  }

  return markets.rows.map((m) => {
    const l = latestMap.get(m.id);
    return {
      id: m.id,
      kind: m.kind,
      symbol: m.symbol,
      displayName: m.display_name,
      cardId: m.card_id,
      indexSlug: m.index_slug,
      imageSmall: m.image_small,
      status: m.status,
      tradeable: m.tradeable,
      maxLeverage: Math.round(m.max_leverage_e2 / 100),
      maintMarginBps: m.maint_margin_bps,
      markE6: l?.mark_e6 ?? null,
      indexE6: l?.index_e6 ?? null,
      change24hPct: changeMap.get(m.id) ?? 0,
    };
  });
}

/** Deterministic per-market PRNG so synthetic history doesn't reshuffle each call. */
function seededRand(seedStr: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seedStr.length; i++) {
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Candle {
  time: string; // YYYY-MM-DD
  value: number;
}

/**
 * Candle history for the chart. Returns real `marks` history when we have enough points;
 * otherwise a DETERMINISTIC seeded series ending at the current mark (so the chart is
 * populated and stable across reloads — never re-randomized like the old client mock).
 */
export async function getCandles(db: Db, marketId: string, days: number): Promise<Candle[]> {
  const real = await db.query<{ d: string; v: string }>(
    `SELECT to_char(computed_at, 'YYYY-MM-DD') AS d, (array_agg(mark_price_e6 ORDER BY computed_at DESC))[1]::text AS v
     FROM marks WHERE market_id = $1 AND computed_at > now() - ($2 || ' days')::interval
     GROUP BY to_char(computed_at, 'YYYY-MM-DD') ORDER BY d`,
    [marketId, String(days)],
  );
  if (real.rows.length >= 10) {
    return real.rows.map((r) => ({ time: r.d, value: Number(r.v) / 1_000_000 }));
  }

  // synthetic, anchored to the latest mark
  const latest = await db.query<{ v: string }>(
    `SELECT mark_price_e6::text AS v FROM marks WHERE market_id = $1 ORDER BY computed_at DESC LIMIT 1`,
    [marketId],
  );
  const endValue = latest.rows[0] ? Number(latest.rows[0].v) / 1_000_000 : 0;
  if (endValue <= 0) return [];

  const rand = seededRand(marketId);
  const out: Candle[] = [];
  let cur = endValue * 0.78;
  const today = new Date();
  for (let i = days; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    cur = Math.max(cur + (rand() - 0.45) * endValue * 0.04, endValue * 0.1);
    if (i === 0) cur = endValue;
    out.push({ time: d.toISOString().split('T')[0], value: Math.round(cur * 100) / 100 });
  }
  // dedupe by day
  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c.time) ? false : (seen.add(c.time), true)));
}
