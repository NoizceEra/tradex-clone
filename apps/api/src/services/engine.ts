import { randomUUID } from 'node:crypto';
import { notional, initialMargin, unrealizedPnl, liquidationPrice } from '@pokex/pricing';
import { HttpError } from '../errors.ts';
import type { Db, Queryer } from '../db/client.ts';
import { getMarketById, type MarketRow } from './markets.ts';
import { recomputeMark } from './marks.ts';
import { getOrCreateUserAccount, getOrCreateSystemAccount, getBalance, postTxn } from './ledger.ts';
import { publish } from './bus.ts';

/**
 * The trading engine. One position lifecycle: open / increase / decrease / close, as
 * MARKET orders priced at the current synthetic mark, with the LP pool as counterparty.
 * Isolated margin, up to the market's max leverage. All money math is integer (BigInt)
 * via @pokex/pricing, and all balance changes go through the double-entry ledger.
 *
 * Single-writer per market: operations on the same market serialize through an in-process
 * mutex, and the whole operation runs in one db transaction.
 */

// ---- per-market mutex (single-writer) -------------------------------------
const chains = new Map<string, Promise<unknown>>();
function withMarketLock<T>(marketId: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(marketId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  chains.set(
    marketId,
    run.catch(() => {}),
  );
  return run;
}

// ---- row helpers ----------------------------------------------------------
const POS_COLS = `p.id, p.user_id, p.market_id, p.side, p.qty_e6::text AS qty_e6, p.avg_entry_e6::text AS avg_entry_e6,
  p.margin_uusdc::text AS margin_uusdc, p.leverage_e2, p.liq_price_e6::text AS liq_price_e6,
  p.realized_pnl_uusdc::text AS realized_pnl_uusdc, p.status`;

export interface PositionRow {
  id: string;
  user_id: string;
  market_id: string;
  side: 'long' | 'short';
  qty_e6: string;
  avg_entry_e6: string;
  margin_uusdc: string;
  leverage_e2: number;
  liq_price_e6: string;
  realized_pnl_uusdc: string;
  status: string;
}

async function getOpenPosition(q: Queryer, userId: string, marketId: string, side: string): Promise<PositionRow | null> {
  const r = await q.query<PositionRow>(
    `SELECT ${POS_COLS} FROM positions p WHERE p.user_id=$1 AND p.market_id=$2 AND p.side=$3 AND p.status='open'`,
    [userId, marketId, side],
  );
  return r.rows[0] ?? null;
}

async function getPositionById(q: Queryer, id: string): Promise<PositionRow | null> {
  const r = await q.query<PositionRow>(`SELECT ${POS_COLS} FROM positions p WHERE p.id=$1`, [id]);
  return r.rows[0] ?? null;
}

async function getLatestMarkIndex(q: Queryer, marketId: string): Promise<{ markE6: bigint; indexE6: bigint } | null> {
  const r = await q.query<{ m: string; i: string }>(
    `SELECT mark_price_e6::text AS m, index_price_e6::text AS i FROM marks WHERE market_id=$1 ORDER BY computed_at DESC LIMIT 1`,
    [marketId],
  );
  return r.rows[0] ? { markE6: BigInt(r.rows[0].m), indexE6: BigInt(r.rows[0].i) } : null;
}

async function lpDepth(q: Queryer): Promise<bigint> {
  const r = await q.query<{ a: string }>(`SELECT total_assets_uusdc::text AS a FROM lp_pool WHERE id='pool'`);
  return r.rows[0] ? BigInt(r.rows[0].a) : 0n;
}

/** Recompute the market mark from current open-interest skew and persist+publish it. */
async function refreshMark(q: Queryer, market: MarketRow, indexE6: bigint): Promise<void> {
  const oi = await q.query<{ side: string; q: string }>(
    `SELECT side, COALESCE(SUM(qty_e6),0)::text AS q FROM positions WHERE market_id=$1 AND status='open' GROUP BY side`,
    [market.id],
  );
  let longQ = 0n;
  let shortQ = 0n;
  for (const row of oi.rows) {
    if (row.side === 'long') longQ = BigInt(row.q);
    else shortQ = BigInt(row.q);
  }
  const skewUusdc = ((longQ - shortQ) * indexE6) / 1_000_000n;
  await recomputeMark(q, market, indexE6, skewUusdc, await lpDepth(q));
  publish(`oi:${market.id}`, 'oi', {
    marketId: market.id,
    longUusdc: ((longQ * indexE6) / 1_000_000n).toString(),
    shortUusdc: ((shortQ * indexE6) / 1_000_000n).toString(),
  });
}

// ---- public types ---------------------------------------------------------
export interface OpenInput {
  marketId: string;
  side: 'long' | 'short';
  qtyE6: bigint;
  leverage: number;
  idempotencyKey: string;
}
export interface CloseInput {
  positionId: string;
  fractionBps: number;
  idempotencyKey: string;
}

async function validateMarketAndOrder(q: Queryer, input: OpenInput): Promise<MarketRow> {
  const market = await getMarketById(q, input.marketId);
  if (!market) throw new HttpError(404, 'market not found');
  if (!market.tradeable || market.status !== 'active') throw new HttpError(400, 'market not tradeable');
  const leverageE2 = input.leverage * 100;
  if (input.leverage < 1 || leverageE2 > market.max_leverage_e2) throw new HttpError(400, 'leverage out of range');
  if (input.qtyE6 < BigInt(market.min_qty_e6)) throw new HttpError(400, 'quantity below market minimum');
  if (input.qtyE6 % BigInt(market.qty_step_e6) !== 0n) throw new HttpError(400, 'quantity not on step');
  return market;
}

export async function openPosition(db: Db, userId: string, input: OpenInput): Promise<{ orderId: string; positionId: string; duplicate?: boolean }> {
  // idempotency: return prior order if this key was already processed
  const prior = await db.query<{ id: string }>(`SELECT id FROM orders WHERE idempotency_key=$1`, [input.idempotencyKey]);
  if (prior.rows[0]) {
    const f = await db.query<{ position_id: string }>(`SELECT position_id FROM fills WHERE order_id=$1 LIMIT 1`, [prior.rows[0].id]);
    return { orderId: prior.rows[0].id, positionId: f.rows[0]?.position_id ?? '', duplicate: true };
  }

  return withMarketLock(input.marketId, () =>
    db.tx(async (q) => {
      const market = await validateMarketAndOrder(q, input);
      const mi = await getLatestMarkIndex(q, market.id);
      if (!mi) throw new HttpError(400, 'no price available for market');
      const { markE6, indexE6 } = mi;
      const leverageE2 = input.leverage * 100;

      const opp = input.side === 'long' ? 'short' : 'long';
      if (await getOpenPosition(q, userId, market.id, opp)) {
        throw new HttpError(400, `close your ${opp} position before opening a ${input.side}`);
      }

      const notion = notional(input.qtyE6, markE6);
      const margin = initialMargin(notion, leverageE2);
      if (margin <= 0n) throw new HttpError(400, 'order too small');

      const collAcct = await getOrCreateUserAccount(q, userId, 'USER_COLLATERAL');
      const marginAcct = await getOrCreateUserAccount(q, userId, 'USER_POSITION_MARGIN');
      const available = await getBalance(q, collAcct);
      if (available < margin) throw new HttpError(400, 'insufficient balance');

      // lock margin
      await postTxn(q, {
        reason: 'MARGIN_LOCK',
        refType: 'market',
        refId: market.id,
        entries: [
          { accountId: collAcct, amount: -margin },
          { accountId: marginAcct, amount: margin },
        ],
      });

      // open or increase
      const existing = await getOpenPosition(q, userId, market.id, input.side);
      let positionId: string;
      if (existing) {
        const oldQty = BigInt(existing.qty_e6);
        const newQty = oldQty + input.qtyE6;
        const newEntry = (oldQty * BigInt(existing.avg_entry_e6) + input.qtyE6 * markE6) / newQty;
        const newMargin = BigInt(existing.margin_uusdc) + margin;
        const liq = liquidationPrice({ side: input.side, entryE6: newEntry, leverageE2, maintMarginBps: market.maint_margin_bps });
        positionId = existing.id;
        await q.query(
          `UPDATE positions SET qty_e6=$1, avg_entry_e6=$2, margin_uusdc=$3, leverage_e2=$4, liq_price_e6=$5, version=version+1 WHERE id=$6`,
          [newQty.toString(), newEntry.toString(), newMargin.toString(), leverageE2, liq.toString(), positionId],
        );
      } else {
        positionId = randomUUID();
        const liq = liquidationPrice({ side: input.side, entryE6: markE6, leverageE2, maintMarginBps: market.maint_margin_bps });
        await q.query(
          `INSERT INTO positions(id,user_id,market_id,side,qty_e6,avg_entry_e6,margin_uusdc,leverage_e2,liq_price_e6,status)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'open')`,
          [positionId, userId, market.id, input.side, input.qtyE6.toString(), markE6.toString(), margin.toString(), leverageE2, liq.toString()],
        );
      }

      const orderId = randomUUID();
      await q.query(
        `INSERT INTO orders(id,user_id,market_id,idempotency_key,kind,side,qty_e6,leverage_e2,status)
         VALUES($1,$2,$3,$4,'market',$5,$6,$7,'filled')`,
        [orderId, userId, market.id, input.idempotencyKey, input.side, input.qtyE6.toString(), leverageE2],
      );
      await q.query(
        `INSERT INTO fills(id,order_id,position_id,market_id,exec_price_e6,qty_e6,fee_uusdc,realized_pnl_uusdc)
         VALUES($1,$2,$3,$4,$5,$6,0,0)`,
        [randomUUID(), orderId, positionId, market.id, markE6.toString(), input.qtyE6.toString()],
      );

      await refreshMark(q, market, indexE6);
      publish(`positions:${userId}`, 'update', { marketId: market.id });
      publish(`balance:${userId}`, 'update', {});
      return { orderId, positionId };
    }),
  );
}

export async function closePosition(db: Db, userId: string, input: CloseInput): Promise<{ orderId: string; realizedPnlUusdc: string; closedQtyE6: string; remainingQtyE6: string }> {
  const prior = await db.query<{ id: string }>(`SELECT id FROM orders WHERE idempotency_key=$1`, [input.idempotencyKey]);
  if (prior.rows[0]) {
    const f = await db.query<{ realized_pnl_uusdc: string; qty_e6: string }>(
      `SELECT realized_pnl_uusdc::text AS realized_pnl_uusdc, qty_e6::text AS qty_e6 FROM fills WHERE order_id=$1 LIMIT 1`,
      [prior.rows[0].id],
    );
    return { orderId: prior.rows[0].id, realizedPnlUusdc: f.rows[0]?.realized_pnl_uusdc ?? '0', closedQtyE6: f.rows[0]?.qty_e6 ?? '0', remainingQtyE6: '0' };
  }

  const pos0 = await getPositionById(db, input.positionId);
  if (!pos0 || pos0.user_id !== userId) throw new HttpError(404, 'position not found');
  if (pos0.status !== 'open') throw new HttpError(400, 'position not open');

  return withMarketLock(pos0.market_id, () =>
    db.tx(async (q) => {
      const pos = await getOpenPosition(q, userId, pos0.market_id, pos0.side);
      if (!pos || pos.id !== input.positionId) throw new HttpError(400, 'position not open');
      const market = (await getMarketById(q, pos.market_id))!;
      const mi = await getLatestMarkIndex(q, market.id);
      if (!mi) throw new HttpError(400, 'no price available');
      const { markE6, indexE6 } = mi;

      const qty = BigInt(pos.qty_e6);
      const closeQty = input.fractionBps >= 10_000 ? qty : (qty * BigInt(input.fractionBps)) / 10_000n;
      if (closeQty <= 0n) throw new HttpError(400, 'nothing to close');
      const entry = BigInt(pos.avg_entry_e6);
      const pnl = unrealizedPnl(pos.side, closeQty, entry, markE6);
      const marginRel = (BigInt(pos.margin_uusdc) * closeQty) / qty;

      const collAcct = await getOrCreateUserAccount(q, userId, 'USER_COLLATERAL');
      const marginAcct = await getOrCreateUserAccount(q, userId, 'USER_POSITION_MARGIN');
      const lpAcct = await getOrCreateSystemAccount(q, 'LP_POOL');

      // release proportional margin back to collateral
      await postTxn(q, {
        reason: 'MARGIN_RELEASE',
        refType: 'position',
        refId: pos.id,
        entries: [
          { accountId: marginAcct, amount: -marginRel },
          { accountId: collAcct, amount: marginRel },
        ],
      });
      // settle realized PnL against the LP pool
      if (pnl !== 0n) {
        await postTxn(q, {
          reason: 'REALIZED_PNL',
          refType: 'position',
          refId: pos.id,
          entries: [
            { accountId: collAcct, amount: pnl },
            { accountId: lpAcct, amount: -pnl },
          ],
        });
      }

      const remQty = qty - closeQty;
      const remMargin = BigInt(pos.margin_uusdc) - marginRel;
      const newRealized = BigInt(pos.realized_pnl_uusdc) + pnl;
      if (remQty <= 0n) {
        await q.query(
          `UPDATE positions SET qty_e6=0, margin_uusdc=0, realized_pnl_uusdc=$1, status='closed', closed_at=now(), version=version+1 WHERE id=$2`,
          [newRealized.toString(), pos.id],
        );
      } else {
        const liq = liquidationPrice({ side: pos.side, entryE6: entry, leverageE2: pos.leverage_e2, maintMarginBps: market.maint_margin_bps });
        await q.query(
          `UPDATE positions SET qty_e6=$1, margin_uusdc=$2, realized_pnl_uusdc=$3, liq_price_e6=$4, version=version+1 WHERE id=$5`,
          [remQty.toString(), remMargin.toString(), newRealized.toString(), liq.toString(), pos.id],
        );
      }

      const orderId = randomUUID();
      await q.query(
        `INSERT INTO orders(id,user_id,market_id,idempotency_key,kind,side,qty_e6,leverage_e2,status)
         VALUES($1,$2,$3,$4,'reduce_only',$5,$6,$7,'filled')`,
        [orderId, userId, market.id, input.idempotencyKey, pos.side, closeQty.toString(), pos.leverage_e2],
      );
      await q.query(
        `INSERT INTO fills(id,order_id,position_id,market_id,exec_price_e6,qty_e6,fee_uusdc,realized_pnl_uusdc)
         VALUES($1,$2,$3,$4,$5,$6,0,$7)`,
        [randomUUID(), orderId, pos.id, market.id, markE6.toString(), closeQty.toString(), pnl.toString()],
      );

      await refreshMark(q, market, indexE6);
      publish(`positions:${userId}`, 'update', { marketId: market.id });
      publish(`balance:${userId}`, 'update', {});
      return { orderId, realizedPnlUusdc: pnl.toString(), closedQtyE6: closeQty.toString(), remainingQtyE6: remQty.toString() };
    }),
  );
}

// ---- read models ----------------------------------------------------------
export interface PositionView {
  id: string;
  marketId: string;
  symbol: string;
  displayName: string;
  side: 'long' | 'short';
  qtyE6: string;
  avgEntryE6: string;
  marginUusdc: string;
  leverage: number;
  liqPriceE6: string;
  markE6: string;
  unrealizedPnlUusdc: string;
  status: string;
}

export async function getUserPositions(db: Db, userId: string): Promise<PositionView[]> {
  const r = await db.query<PositionRow & { symbol: string; display_name: string; mark: string | null }>(
    `SELECT ${POS_COLS}, m.symbol, m.display_name,
            (SELECT mark_price_e6::text FROM marks k WHERE k.market_id=p.market_id ORDER BY computed_at DESC LIMIT 1) AS mark
     FROM positions p JOIN markets m ON m.id = p.market_id
     WHERE p.user_id=$1 AND p.status='open' ORDER BY p.opened_at DESC`,
    [userId],
  );
  return r.rows.map((row) => {
    const markE6 = row.mark ? BigInt(row.mark) : BigInt(row.avg_entry_e6);
    const uPnl = unrealizedPnl(row.side, BigInt(row.qty_e6), BigInt(row.avg_entry_e6), markE6);
    return {
      id: row.id,
      marketId: row.market_id,
      symbol: row.symbol,
      displayName: row.display_name,
      side: row.side,
      qtyE6: row.qty_e6,
      avgEntryE6: row.avg_entry_e6,
      marginUusdc: row.margin_uusdc,
      leverage: Math.round(row.leverage_e2 / 100),
      liqPriceE6: row.liq_price_e6,
      markE6: markE6.toString(),
      unrealizedPnlUusdc: uPnl.toString(),
      status: row.status,
    };
  });
}

/** Total unrealized PnL across a user's open positions (for equity). */
export async function getUserUnrealizedPnl(db: Db, userId: string): Promise<bigint> {
  const positions = await getUserPositions(db, userId);
  return positions.reduce((a, p) => a + BigInt(p.unrealizedPnlUusdc), 0n);
}
