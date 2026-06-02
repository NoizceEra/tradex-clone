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

/** Card metadata for the detail panel, extracted from the pokemontcg card we already fetch. */
function extractMetadata(c: any): { hp: string | null; retreat: number; attacks: { name: string; damage: string }[]; setName: string | null } {
  return {
    hp: c?.hp ?? null,
    retreat: Array.isArray(c?.retreatCost) ? c.retreatCost.length : (c?.convertedRetreatCost ?? 0),
    attacks: Array.isArray(c?.attacks) ? c.attacks.map((a: any) => ({ name: a?.name ?? '', damage: a?.damage ?? '' })) : [],
    setName: c?.set?.name ?? null,
  };
}

/** Returns the PSA-10 graded price (USD) for a card, or null. Injectable for tests. */
export type GradedFetcher = (card: any) => Promise<number | null>;

async function fetchGradedPrice(card: any): Promise<number | null> {
  if (!config.justtcgApiKey) return null;
  const pid = card?.tcgplayer?.productId;
  const query = pid ? `tcgplayerId=${pid}` : `cardId=${encodeURIComponent(card?.id ?? '')}`;
  try {
    const res = await fetch(`${config.justtcgBase}/v1/cards?${query}`, { headers: { 'x-api-key': config.justtcgApiKey } });
    if (!res.ok) return null;
    const json = (await res.json()) as any;
    const row = Array.isArray(json) ? json[0] : (json?.data?.[0] ?? json);
    const psa10 = row?.prices?.psa10 ?? row?.prices?.['psa 10'] ?? row?.prices?.['psa-10'];
    const n = psa10 != null ? Number(psa10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** Live fetcher: top Pokémon cards by TCGplayer market price (server-side, keyless-ok). */
export async function fetchTopCards(): Promise<any[]> {
  const url = `${config.pokemontcgBase}/cards?q=supertype:Pok%C3%A9mon&orderBy=-tcgplayer.prices.holofoil.market&pageSize=${config.oraclePageSize}`;
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
      // Escape hatch: adopt a large move once it PERSISTS (the most recent print already showed
      // this level) so a genuine >60% move can't wedge the market on a frozen reference forever.
      const recent = await q.query<{ v: string }>(
        `SELECT index_price_e6::text AS v FROM oracle_prices WHERE market_id=$1 ORDER BY source_observed_at DESC LIMIT 1`,
        [marketId],
      );
      const lastAny = recent.rows[0] ? BigInt(recent.rows[0].v) : 0n;
      const persisted = lastAny > 0n && lastAny !== prev && Math.abs(Number(indexE6 - lastAny) / Number(lastAny)) <= OUTLIER_THRESHOLD;
      if (persisted) {
        reason = 'force-accepted: level persisted';
      } else {
        accepted = false;
        reason = `outlier ${(dev * 100).toFixed(0)}% vs last`;
      }
    }
  }
  // RETURNING lets us detect a duplicate (no-op) insert so callers don't recompute a stray mark.
  const ins = await q.query<{ id: string }>(
    `INSERT INTO oracle_prices(market_id, index_price_e6, raw_payload, source_observed_at, is_accepted, reject_reason)
     VALUES($1, $2, $3, $4, $5, $6)
     ON CONFLICT(market_id, source_observed_at) DO NOTHING
     RETURNING id`,
    [marketId, indexE6.toString(), JSON.stringify(payload ?? null), observedAt.toISOString(), accepted, reason],
  );
  return ins.rows.length > 0 && accepted;
}

/** Ingest a price snapshot: upsert card markets, record prints, recompute marks, rebuild indices. */
export async function ingest(
  db: Db,
  fetcher: CardFetcher = fetchTopCards,
  gradedFetcher: GradedFetcher | null = config.justtcgApiKey ? fetchGradedPrice : null,
): Promise<{ cards: number; indices: number; graded: number }> {
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
        imageLarge: c.images?.large ?? null,
        setLogo: c.set?.images?.logo ?? null,
        metadata: extractMetadata(c),
      }),
    );
    const accepted = await db.tx((q) => recordOracle(q, marketId, priceE6, observedAt, { tcgplayer: c.tcgplayer ?? null }));
    if (accepted) {
      const market = await getMarketById(db, marketId);
      if (market) await db.tx((q) => recomputeMark(q, market, priceE6, 0n, 0n));
    }
  }

  const sorted = [...priced].sort((a, b) => (b.priceE6 > a.priceE6 ? 1 : b.priceE6 < a.priceE6 ? -1 : 0));

  // Graded (PSA-10) prices for the top-N — powers the Graded index + per-card graded panel.
  const gradedMembers: { cardId: string; priceE6: bigint }[] = [];
  if (gradedFetcher) {
    for (const { c } of sorted.slice(0, config.gradedConstituents)) {
      const g = await gradedFetcher(c);
      if (g != null && g > 0) {
        const gE6 = toE6(g);
        await db.query(`UPDATE markets SET graded_psa10_e6=$1 WHERE card_id=$2 AND kind='card'`, [gE6.toString(), c.id]);
        gradedMembers.push({ cardId: c.id as string, priceE6: gE6 });
      }
    }
  }

  let indices = 0;
  for (const idx of INDEX_CATALOG) {
    if (idx.slug === 'graded') {
      // tradeable only when we actually have PSA-10 data; priced off the graded basket
      if (gradedMembers.length > 0) {
        await buildIndex(db, idx, gradedMembers, observedAt);
        indices++;
      } else {
        await db.tx((q) => upsertIndexMarket(q, { slug: idx.slug, name: idx.name, tradeable: false }));
      }
      continue;
    }
    if (!idx.tradeable) {
      await db.tx((q) => upsertIndexMarket(q, { slug: idx.slug, name: idx.name, tradeable: false }));
      continue;
    }
    const n = idx.topN ?? sorted.length;
    const members = sorted.slice(0, n).map((x) => ({ cardId: x.c.id as string, priceE6: x.priceE6 }));
    await buildIndex(db, idx, members, observedAt);
    indices++;
  }
  return { cards: priced.length, indices, graded: gradedMembers.length };
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

  // Divisor: based at BASE_VALUE on first build, then RE-BASED whenever the constituent set
  // changes so the index value is continuous across rebalances (composition shouldn't move it).
  const newSet = members.map((m) => m.cardId).sort().join(',');
  const oldRows = await db.query<{ card_id: string }>(`SELECT card_id FROM index_constituents WHERE market_id=$1`, [marketId]);
  const oldSet = oldRows.rows.map((r) => r.card_id).sort().join(',');
  const divRow = await db.query<{ d: string }>(
    `SELECT divisor_e6::text AS d FROM index_divisors WHERE market_id = $1`,
    [marketId],
  );
  // The divisor carries 6 fractional digits (the column is divisor_e6): value = rawE6 * SCALE / divisor.
  // Without the scale a sub-$1000 basket would truncate the divisor toward 0 and the index would jump.
  const SCALE = 1_000_000n;
  const anchorDivisor = (target: bigint) => {
    const d = (rawE6 * SCALE) / target; // solve  rawE6 * SCALE / d == target
    return d > 0n ? d : 1n; // floor only for the degenerate rawE6 == 0 basket
  };
  const prevRow = await db.query<{ v: string }>(
    `SELECT index_price_e6::text AS v FROM oracle_prices WHERE market_id=$1 AND is_accepted ORDER BY source_observed_at DESC LIMIT 1`,
    [marketId],
  );
  const prevVal = prevRow.rows[0] ? BigInt(prevRow.rows[0].v) : 0n;

  let divisor: bigint;
  if (!divRow.rows[0]) {
    divisor = anchorDivisor(BASE_VALUE_E6); // start the index at its base value (1000.000000)
    await db.query(
      `INSERT INTO index_divisors(market_id, divisor_e6, base_value_e6) VALUES($1, $2, $3)
       ON CONFLICT(market_id) DO NOTHING`,
      [marketId, divisor.toString(), BASE_VALUE_E6.toString()],
    );
  } else {
    divisor = BigInt(divRow.rows[0].d);
    // Re-anchor the divisor so the print stays continuous on a constituent-set change, and self-heal a
    // divisor persisted at the wrong scale (legacy pre-SCALE rows would otherwise jump ~1e6x — a
    // discontinuity no diversified basket can make, well past the outlier guard).
    const setChanged = oldSet !== '' && oldSet !== newSet;
    const wrongScale = prevVal > 0n && (rawE6 * SCALE) / divisor > prevVal * 4n;
    if (prevVal > 0n && (setChanged || wrongScale)) {
      divisor = anchorDivisor(prevVal);
      await db.query(`UPDATE index_divisors SET divisor_e6=$1, as_of=now() WHERE market_id=$2`, [divisor.toString(), marketId]);
    }
  }
  const indexValueE6 = (rawE6 * SCALE) / divisor;

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
