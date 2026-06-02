import { randomUUID } from 'node:crypto';
import { notional, initialMargin, maintenanceMargin, unrealizedPnl, liquidationPrice, fee } from '@pokex/pricing';
import { HttpError } from '../errors.ts';
import { config } from '../config.ts';
import { advisoryXactLock, type Db, type Queryer } from '../db/client.ts';
import { getMarketById, type MarketRow } from './markets.ts';
import { recomputeMark } from './marks.ts';
import { getOrCreateUserAccount, getOrCreateSystemAccount, getBalance, postTxn } from './ledger.ts';
import { refreshReserved } from './lp.ts';
import { getCumulativeFundingE6, settlePositionFunding } from './funding.ts';
import { openNotionalBySide } from './oi.ts';
import { publish } from './bus.ts';

/** Charge a trading fee, split between LPs and platform revenue (a balanced ledger txn). */
async function chargeFee(q: Queryer, userId: string, feeAmt: bigint, reason: string, refId: string): Promise<void> {
  if (feeAmt <= 0n) return;
  const coll = await getOrCreateUserAccount(q, userId, 'USER_COLLATERAL');
  const lp = await getOrCreateSystemAccount(q, 'LP_POOL');
  const rev = await getOrCreateSystemAccount(q, 'FEE_REVENUE');
  const lpPart = (feeAmt * BigInt(config.feeLpSharePct)) / 100n;
  const revPart = feeAmt - lpPart;
  await postTxn(q, {
    reason,
    refType: 'fee',
    refId,
    entries: [
      { accountId: coll, amount: -feeAmt },
      { accountId: lp, amount: lpPart },
      { accountId: rev, amount: revPart },
    ],
  });
}

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
  p.realized_pnl_uusdc::text AS realized_pnl_uusdc, p.funding_index_snapshot_e6::text AS funding_index_snapshot_e6, p.status`;

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
  funding_index_snapshot_e6: string;
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
  // Authoritative NAV = the LP_POOL ledger balance. (lp_pool.total_assets_uusdc is only synced
  // on deposit/withdraw and drifts as trades move the pool, so don't use it as the mark depth.)
  const lp = await getOrCreateSystemAccount(q, 'LP_POOL');
  return getBalance(q, lp);
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

/** Post-mutation refresh: recompute the mark from current skew and the pool's reserved capital. */
async function refreshMarketState(q: Queryer, market: MarketRow, indexE6: bigint): Promise<void> {
  await refreshMark(q, market, indexE6);
  await refreshReserved(q);
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
  // fast-path idempotency, scoped to the user (keys are not a global namespace)
  const prior = await db.query<{ id: string }>(`SELECT id FROM orders WHERE user_id=$1 AND idempotency_key=$2`, [userId, input.idempotencyKey]);
  if (prior.rows[0]) {
    const f = await db.query<{ position_id: string }>(`SELECT position_id FROM fills WHERE order_id=$1 LIMIT 1`, [prior.rows[0].id]);
    return { orderId: prior.rows[0].id, positionId: f.rows[0]?.position_id ?? '', duplicate: true };
  }

  return withMarketLock(input.marketId, () =>
    db.tx(async (q) => {
      await advisoryXactLock(q, input.marketId); // DB-level single-writer per market
      const market = await validateMarketAndOrder(q, input);
      const mi = await getLatestMarkIndex(q, market.id);
      if (!mi) throw new HttpError(400, 'no price available for market');
      const { markE6, indexE6 } = mi;
      const leverageE2 = input.leverage * 100;

      // In-tx idempotency guard: the order row is the anchor. A racing duplicate inserts
      // nothing and replays the prior result instead of running the side effects twice.
      const orderId = randomUUID();
      const ins = await q.query<{ id: string }>(
        `INSERT INTO orders(id,user_id,market_id,idempotency_key,kind,side,qty_e6,leverage_e2,status)
         VALUES($1,$2,$3,$4,'market',$5,$6,$7,'filled')
         ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING id`,
        [orderId, userId, market.id, input.idempotencyKey, input.side, input.qtyE6.toString(), leverageE2],
      );
      if (ins.rows.length === 0) {
        const p = await q.query<{ id: string }>(`SELECT id FROM orders WHERE user_id=$1 AND idempotency_key=$2`, [userId, input.idempotencyKey]);
        const f = await q.query<{ position_id: string }>(`SELECT position_id FROM fills WHERE order_id=$1 LIMIT 1`, [p.rows[0].id]);
        return { orderId: p.rows[0].id, positionId: f.rows[0]?.position_id ?? '', duplicate: true };
      }

      const opp = input.side === 'long' ? 'short' : 'long';
      if (await getOpenPosition(q, userId, market.id, opp)) {
        throw new HttpError(400, `close your ${opp} position before opening a ${input.side}`);
      }

      const notion = notional(input.qtyE6, markE6);
      const margin = initialMargin(notion, leverageE2);
      if (margin <= 0n) throw new HttpError(400, 'order too small');
      const openFee = fee(notion, config.openFeeBps);

      // open-interest cap (per side) protects the LP pool
      const sideCap = input.side === 'long' ? BigInt(market.max_oi_long_uusdc) : BigInt(market.max_oi_short_uusdc);
      const sideOi = (await openNotionalBySide(q, market.id))[input.side === 'long' ? 'longOi' : 'shortOi'];
      if (sideCap > 0n && sideOi + notion > sideCap) {
        throw new HttpError(400, 'open interest cap reached for this side');
      }

      const collAcct = await getOrCreateUserAccount(q, userId, 'USER_COLLATERAL');
      const marginAcct = await getOrCreateUserAccount(q, userId, 'USER_POSITION_MARGIN');
      // lock the collateral row so concurrent opens by the same user (across markets) can't
      // both pass the balance check and overdraw it.
      await q.query('SELECT amount_uusdc FROM balances WHERE account_id=$1 FOR UPDATE', [collAcct]);
      const available = await getBalance(q, collAcct);
      if (available < margin + openFee) throw new HttpError(400, 'insufficient balance');

      // lock margin, then charge the open fee
      await postTxn(q, {
        reason: 'MARGIN_LOCK',
        refType: 'market',
        refId: market.id,
        entries: [
          { accountId: collAcct, amount: -margin },
          { accountId: marginAcct, amount: margin },
        ],
      });
      await chargeFee(q, userId, openFee, 'OPEN_FEE', market.id);

      // open or increase
      const existing = await getOpenPosition(q, userId, market.id, input.side);
      let positionId: string;
      if (existing) {
        await settlePositionFunding(q, existing, market.id); // settle funding at the old size first
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
        const cum = await getCumulativeFundingE6(q, market.id);
        const liq = liquidationPrice({ side: input.side, entryE6: markE6, leverageE2, maintMarginBps: market.maint_margin_bps });
        await q.query(
          `INSERT INTO positions(id,user_id,market_id,side,qty_e6,avg_entry_e6,margin_uusdc,leverage_e2,liq_price_e6,funding_index_snapshot_e6,status)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'open')`,
          [positionId, userId, market.id, input.side, input.qtyE6.toString(), markE6.toString(), margin.toString(), leverageE2, liq.toString(), cum.toString()],
        );
      }

      await q.query(
        `INSERT INTO fills(id,order_id,position_id,market_id,exec_price_e6,qty_e6,fee_uusdc,realized_pnl_uusdc)
         VALUES($1,$2,$3,$4,$5,$6,$7,0)`,
        [randomUUID(), orderId, positionId, market.id, markE6.toString(), input.qtyE6.toString(), openFee.toString()],
      );

      await refreshMarketState(q, market, indexE6);
      publish(`positions:${userId}`, 'update', { marketId: market.id });
      publish(`balance:${userId}`, 'update', {});
      return { orderId, positionId };
    }),
  );
}

export async function closePosition(db: Db, userId: string, input: CloseInput): Promise<{ orderId: string; realizedPnlUusdc: string; closedQtyE6: string; remainingQtyE6: string }> {
  const prior = await db.query<{ id: string }>(`SELECT id FROM orders WHERE user_id=$1 AND idempotency_key=$2`, [userId, input.idempotencyKey]);
  if (prior.rows[0]) {
    const f = await db.query<{ realized_pnl_uusdc: string; qty_e6: string; position_id: string }>(
      `SELECT realized_pnl_uusdc::text AS realized_pnl_uusdc, qty_e6::text AS qty_e6, position_id FROM fills WHERE order_id=$1 LIMIT 1`,
      [prior.rows[0].id],
    );
    const remPos = f.rows[0] ? await getPositionById(db, f.rows[0].position_id) : null;
    return {
      orderId: prior.rows[0].id,
      realizedPnlUusdc: f.rows[0]?.realized_pnl_uusdc ?? '0',
      closedQtyE6: f.rows[0]?.qty_e6 ?? '0',
      remainingQtyE6: remPos && remPos.status === 'open' ? remPos.qty_e6 : '0',
    };
  }

  const pos0 = await getPositionById(db, input.positionId);
  if (!pos0 || pos0.user_id !== userId) throw new HttpError(404, 'position not found');
  if (pos0.status !== 'open') throw new HttpError(400, 'position not open');

  return withMarketLock(pos0.market_id, () =>
    db.tx(async (q) => {
      await advisoryXactLock(q, pos0.market_id); // DB-level single-writer per market
      const pos = await getOpenPosition(q, userId, pos0.market_id, pos0.side);
      if (!pos || pos.id !== input.positionId) throw new HttpError(400, 'position not open');
      const market = (await getMarketById(q, pos.market_id))!;
      const mi = await getLatestMarkIndex(q, market.id);
      if (!mi) throw new HttpError(400, 'no price available');
      const { markE6, indexE6 } = mi;

      // an under-margined position must go through liquidation (loss-capped), not a voluntary
      // close that would drive the user's collateral negative.
      if (isLiquidatable(pos, market, markE6)) {
        throw new HttpError(409, 'position is liquidatable and will be liquidated; cannot close manually');
      }

      await settlePositionFunding(q, pos, market.id); // settle accrued funding first

      const qty = BigInt(pos.qty_e6);
      const closeQty = input.fractionBps >= 10_000 ? qty : (qty * BigInt(input.fractionBps)) / 10_000n;
      if (closeQty <= 0n) throw new HttpError(400, 'nothing to close');
      const entry = BigInt(pos.avg_entry_e6);
      const pnl = unrealizedPnl(pos.side, closeQty, entry, markE6);
      const marginRel = (BigInt(pos.margin_uusdc) * closeQty) / qty;
      const closeFeeAmt = fee(notional(closeQty, markE6), config.closeFeeBps);

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
      // close fee
      await chargeFee(q, userId, closeFeeAmt, 'CLOSE_FEE', pos.id);

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
         VALUES($1,$2,$3,$4,'reduce_only',$5,$6,$7,'filled')
         ON CONFLICT (user_id, idempotency_key) DO NOTHING`,
        [orderId, userId, market.id, input.idempotencyKey, pos.side, closeQty.toString(), pos.leverage_e2],
      );
      await q.query(
        `INSERT INTO fills(id,order_id,position_id,market_id,exec_price_e6,qty_e6,fee_uusdc,realized_pnl_uusdc)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [randomUUID(), orderId, pos.id, market.id, markE6.toString(), closeQty.toString(), closeFeeAmt.toString(), pnl.toString()],
      );

      await refreshMarketState(q, market, indexE6);
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

// ---- liquidations ---------------------------------------------------------

/** A position is liquidatable when its equity has fallen to/below maintenance margin. */
function isLiquidatable(pos: PositionRow, market: MarketRow, markE6: bigint): boolean {
  const qty = BigInt(pos.qty_e6);
  const equity = BigInt(pos.margin_uusdc) + unrealizedPnl(pos.side, qty, BigInt(pos.avg_entry_e6), markE6);
  const maint = maintenanceMargin(notional(qty, markE6), market.maint_margin_bps);
  return equity <= maint;
}

/**
 * Force-close a position at the mark. The user's loss is capped at their margin; any shortfall
 * (bad debt, e.g. a gap through the liq price) is drawn from the insurance fund, and whatever
 * the insurance can't cover is socialized to the LP pool. A liquidation penalty (from any
 * remaining equity) tops up the insurance fund. Every leg is a balanced ledger txn.
 */
async function liquidatePositionInTx(q: Queryer, pos: PositionRow, market: MarketRow, markE6: bigint, indexE6: bigint): Promise<void> {
  await settlePositionFunding(q, pos, market.id);

  const qty = BigInt(pos.qty_e6);
  const entry = BigInt(pos.avg_entry_e6);
  const margin = BigInt(pos.margin_uusdc);
  const pnl = unrealizedPnl(pos.side, qty, entry, markE6);
  const lossAbs = pnl < 0n ? -pnl : 0n;
  const liqFee = fee(notional(qty, markE6), config.liqFeeBps);

  const coll = await getOrCreateUserAccount(q, pos.user_id, 'USER_COLLATERAL');
  const marginAcct = await getOrCreateUserAccount(q, pos.user_id, 'USER_POSITION_MARGIN');
  const lp = await getOrCreateSystemAccount(q, 'LP_POOL');
  const insurance = await getOrCreateSystemAccount(q, 'INSURANCE_FUND');

  // release the locked margin back to collateral
  await postTxn(q, { reason: 'MARGIN_RELEASE', refType: 'liquidation', refId: pos.id, entries: [
    { accountId: marginAcct, amount: -margin },
    { accountId: coll, amount: margin },
  ] });

  let lossToUser = 0n;
  let badDebt = 0n;
  let drawn = 0n;
  let socialized = 0n;
  let liqFeeTaken = 0n;

  if (pnl > 0n) {
    await postTxn(q, { reason: 'REALIZED_PNL', refType: 'liquidation', refId: pos.id, entries: [
      { accountId: coll, amount: pnl },
      { accountId: lp, amount: -pnl },
    ] });
  } else if (lossAbs > 0n) {
    lossToUser = lossAbs < margin ? lossAbs : margin; // user can only lose their margin
    await postTxn(q, { reason: 'REALIZED_PNL', refType: 'liquidation', refId: pos.id, entries: [
      { accountId: coll, amount: -lossToUser },
      { accountId: lp, amount: lossToUser },
    ] });
    badDebt = lossAbs - lossToUser;
    if (badDebt > 0n) {
      const insBal = await getBalance(q, insurance);
      drawn = badDebt < insBal ? badDebt : insBal > 0n ? insBal : 0n;
      if (drawn > 0n) {
        await postTxn(q, { reason: 'INSURANCE_TOPUP', refType: 'liquidation', refId: pos.id, entries: [
          { accountId: insurance, amount: -drawn },
          { accountId: lp, amount: drawn },
        ] });
      }
      socialized = badDebt - drawn; // LP bears this (it simply receives less)
    }
  }

  // liquidation penalty from any remaining released margin
  const remaining = margin - lossToUser;
  if (remaining > 0n) {
    liqFeeTaken = liqFee < remaining ? liqFee : remaining;
    if (liqFeeTaken > 0n) {
      await postTxn(q, { reason: 'LIQUIDATION_FEE', refType: 'liquidation', refId: pos.id, entries: [
        { accountId: coll, amount: -liqFeeTaken },
        { accountId: insurance, amount: liqFeeTaken },
      ] });
    }
  }

  await q.query(
    `UPDATE positions SET qty_e6=0, margin_uusdc=0, realized_pnl_uusdc=realized_pnl_uusdc+$1, status='liquidated', closed_at=now(), version=version+1 WHERE id=$2`,
    [pnl.toString(), pos.id],
  );
  const orderId = randomUUID();
  await q.query(
    `INSERT INTO orders(id,user_id,market_id,idempotency_key,kind,side,qty_e6,leverage_e2,status)
     VALUES($1,$2,$3,$4,'reduce_only',$5,$6,$7,'filled')`,
    [orderId, pos.user_id, market.id, 'liq-' + pos.id + '-' + randomUUID(), pos.side, qty.toString(), pos.leverage_e2],
  );
  await q.query(
    `INSERT INTO fills(id,order_id,position_id,market_id,exec_price_e6,qty_e6,fee_uusdc,realized_pnl_uusdc)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [randomUUID(), orderId, pos.id, market.id, markE6.toString(), qty.toString(), liqFeeTaken.toString(), pnl.toString()],
  );
  await q.query(
    `INSERT INTO liquidations(id,position_id,market_id,user_id,trigger_mark_e6,closed_qty_e6,liquidation_fee_uusdc,bad_debt_uusdc,insurance_drawn_uusdc,socialized_uusdc)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [randomUUID(), pos.id, market.id, pos.user_id, markE6.toString(), qty.toString(), liqFeeTaken.toString(), badDebt.toString(), drawn.toString(), socialized.toString()],
  );

  await refreshMarketState(q, market, indexE6);
  publish(`positions:${pos.user_id}`, 'liquidated', { positionId: pos.id, markE6: markE6.toString() });
  publish(`liquidations:${pos.user_id}`, 'liquidation', { positionId: pos.id, marketId: market.id, badDebtUusdc: badDebt.toString() });
}

/** Sweep a market: liquidate every open position whose equity is at/below maintenance margin. */
export async function liquidateEligible(db: Db, marketId: string): Promise<number> {
  const mi = await getLatestMarkIndex(db, marketId);
  const market = await getMarketById(db, marketId);
  if (!mi || !market) return 0;
  const open = await db.query<PositionRow>(`SELECT ${POS_COLS} FROM positions p WHERE p.market_id=$1 AND p.status='open'`, [marketId]);
  let count = 0;
  for (const candidate of open.rows) {
    if (!isLiquidatable(candidate, market, mi.markE6)) continue;
    await withMarketLock(marketId, () =>
      db.tx(async (q) => {
        await advisoryXactLock(q, marketId);
        const fresh = await getOpenPosition(q, candidate.user_id, marketId, candidate.side);
        if (!fresh || fresh.id !== candidate.id) return;
        const mi2 = await getLatestMarkIndex(q, marketId);
        if (!mi2 || !isLiquidatable(fresh, market, mi2.markE6)) return;
        await liquidatePositionInTx(q, fresh, market, mi2.markE6, mi2.indexE6);
        count++;
      }),
    );
  }
  return count;
}

/**
 * Circuit breaker: halt any tradeable market (card OR index) whose latest accepted oracle print
 * is older than the staleness window, and symmetrically re-activate a halted market once a fresh
 * print arrives. Only ever moves between 'active' <-> 'reduce_only' (never touches halted/delisted).
 */
export async function haltStaleMarkets(db: Db, staleMs: number): Promise<{ halted: number; reactivated: number }> {
  const fresh = `SELECT market_id FROM oracle_prices WHERE is_accepted AND ingested_at > now() - ($1 || ' milliseconds')::interval`;
  const halted = await db.query<{ id: string }>(
    `UPDATE markets SET status='reduce_only'
     WHERE tradeable AND status='active' AND id NOT IN (${fresh}) RETURNING id`,
    [String(staleMs)],
  );
  const reactivated = await db.query<{ id: string }>(
    `UPDATE markets SET status='active'
     WHERE tradeable AND status='reduce_only' AND id IN (${fresh}) RETURNING id`,
    [String(staleMs)],
  );
  return { halted: halted.rows.length, reactivated: reactivated.rows.length };
}
