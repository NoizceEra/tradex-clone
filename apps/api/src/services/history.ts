import { notional } from '@pokex/pricing';
import type { Db } from '../db/client.ts';

/**
 * Read-only account history for the trade-panel tabs: order history, trade (fill) history,
 * transaction (ledger) history, and closed-position history. All amounts are micro-USDC / e6
 * strings over the wire. Everything is scoped to the calling user.
 */

const clampLimit = (n: number | undefined) => Math.min(Math.max(n ?? 100, 1), 500);

// orders store the POSITION side; a reduce-only order trades the opposite direction.
function tradeSide(positionSide: string, kind: string): 'Buy' | 'Sell' {
  const dir = kind === 'reduce_only' ? (positionSide === 'long' ? 'short' : 'long') : positionSide;
  return dir === 'long' ? 'Buy' : 'Sell';
}

const notionalE6 = (qtyE6: string, priceE6: string) => notional(BigInt(qtyE6), BigInt(priceE6)).toString();

export interface OrderHistoryRow {
  time: string;
  type: 'Market';
  symbol: string;
  side: 'Buy' | 'Sell';
  priceE6: string;
  filledE6: string;
  valueE6: string;
  reduceOnly: boolean;
  status: string;
  orderId: string;
}

export async function getOrderHistory(db: Db, userId: string, limit?: number): Promise<OrderHistoryRow[]> {
  const r = await db.query<{
    id: string; kind: string; side: string; status: string; created_at: string; symbol: string;
    price_e6: string | null; filled_e6: string | null;
  }>(
    `SELECT o.id, o.kind, o.side, o.status, o.created_at, m.symbol,
            f.exec_price_e6::text AS price_e6, f.qty_e6::text AS filled_e6
     FROM orders o
     JOIN markets m ON m.id = o.market_id
     LEFT JOIN fills f ON f.order_id = o.id
     WHERE o.user_id = $1
     ORDER BY o.created_at DESC
     LIMIT $2`,
    [userId, clampLimit(limit)],
  );
  return r.rows.map((o) => {
    const priceE6 = o.price_e6 ?? '0';
    const filledE6 = o.filled_e6 ?? '0';
    return {
      time: o.created_at,
      type: 'Market' as const,
      symbol: o.symbol,
      side: tradeSide(o.side, o.kind),
      priceE6,
      filledE6,
      valueE6: notionalE6(filledE6, priceE6),
      reduceOnly: o.kind === 'reduce_only',
      status: o.status,
      orderId: o.id,
    };
  });
}

export interface TradeHistoryRow {
  time: string;
  symbol: string;
  side: 'Buy' | 'Sell';
  priceE6: string;
  amountE6: string;
  valueE6: string;
  feeUusdc: string;
  realizedPnlUusdc: string;
  role: 'Taker';
}

export async function getTradeHistory(db: Db, userId: string, limit?: number): Promise<TradeHistoryRow[]> {
  const r = await db.query<{
    created_at: string; price_e6: string; qty_e6: string; fee: string; pnl: string;
    side: string; kind: string; symbol: string;
  }>(
    `SELECT f.created_at, f.exec_price_e6::text AS price_e6, f.qty_e6::text AS qty_e6,
            f.fee_uusdc::text AS fee, f.realized_pnl_uusdc::text AS pnl,
            o.side, o.kind, m.symbol
     FROM fills f
     JOIN orders o ON o.id = f.order_id
     JOIN markets m ON m.id = f.market_id
     WHERE o.user_id = $1
     ORDER BY f.created_at DESC
     LIMIT $2`,
    [userId, clampLimit(limit)],
  );
  return r.rows.map((f) => ({
    time: f.created_at,
    symbol: f.symbol,
    side: tradeSide(f.side, f.kind),
    priceE6: f.price_e6,
    amountE6: f.qty_e6,
    valueE6: notionalE6(f.qty_e6, f.price_e6),
    feeUusdc: f.fee,
    realizedPnlUusdc: f.pnl,
    role: 'Taker' as const,
  }));
}

// Ledger reasons grouped into the user-facing transaction types. MARGIN_LOCK / MARGIN_RELEASE are
// intentionally excluded — they move funds between the user's own collateral and margin sub-accounts,
// not in/out of the account.
const TXN_TYPE: Record<string, 'Transfer' | 'Realized PNL' | 'Funding Fee' | 'Commission'> = {
  FAUCET: 'Transfer',
  REFERRAL_BONUS: 'Transfer',
  LP_DEPOSIT: 'Transfer',
  LP_WITHDRAW: 'Transfer',
  REALIZED_PNL: 'Realized PNL',
  FUNDING: 'Funding Fee',
  OPEN_FEE: 'Commission',
  CLOSE_FEE: 'Commission',
  LIQUIDATION_FEE: 'Commission',
};

export interface TransactionRow {
  time: string;
  type: 'Transfer' | 'Realized PNL' | 'Funding Fee' | 'Commission';
  amountUusdc: string; // signed
  symbol: string | null;
}

export async function getTransactionHistory(db: Db, userId: string, limit?: number): Promise<TransactionRow[]> {
  const reasons = Object.keys(TXN_TYPE);
  const r = await db.query<{ created_at: string; reason: string; amt: string; symbol: string | null }>(
    `SELECT le.created_at, le.reason, le.amount_uusdc::text AS amt,
            COALESCE(m.symbol, pm.symbol) AS symbol
     FROM ledger_entries le
     JOIN accounts a ON a.id = le.account_id
     LEFT JOIN markets m ON m.id = le.ref_id
     LEFT JOIN positions p ON p.id = le.ref_id
     LEFT JOIN markets pm ON pm.id = p.market_id
     WHERE a.user_id = $1 AND a.type = 'USER_COLLATERAL' AND le.reason = ANY($2)
     ORDER BY le.created_at DESC, le.id DESC
     LIMIT $3`,
    [userId, reasons, clampLimit(limit)],
  );
  return r.rows.map((e) => ({
    time: e.created_at,
    type: TXN_TYPE[e.reason],
    amountUusdc: e.amt,
    symbol: e.symbol,
  }));
}

export interface PositionHistoryRow {
  symbol: string;
  side: 'Long' | 'Short';
  leverage: number;
  status: string; // closed | liquidated
  entryE6: string;
  avgCloseE6: string | null;
  realizedPnlUusdc: string;
  closedQtyE6: string;
  openedAt: string;
  closedAt: string | null;
}

export async function getPositionHistory(db: Db, userId: string, limit?: number): Promise<PositionHistoryRow[]> {
  const positions = await db.query<{
    id: string; side: string; leverage_e2: number; status: string; pnl: string; entry_e6: string;
    opened_at: string; closed_at: string | null; symbol: string;
  }>(
    `SELECT p.id, p.side, p.leverage_e2, p.status, p.realized_pnl_uusdc::text AS pnl,
            p.avg_entry_e6::text AS entry_e6, p.opened_at, p.closed_at, m.symbol
     FROM positions p JOIN markets m ON m.id = p.market_id
     WHERE p.user_id = $1 AND p.status IN ('closed', 'liquidated')
     ORDER BY p.closed_at DESC NULLS LAST
     LIMIT $2`,
    [userId, clampLimit(limit)],
  );

  // volume-weighted close price + total closed qty from reduce-only fills, scoped to THIS page's
  // positions (uses idx_fills_position; avoids an unbounded scan of every reduce-only fill ever).
  const ids = positions.rows.map((p) => p.id);
  const closes = ids.length
    ? await db.query<{ position_id: string; qty: string; notional: string }>(
        `SELECT f.position_id, SUM(f.qty_e6)::text AS qty, SUM(f.qty_e6 * f.exec_price_e6)::text AS notional
         FROM fills f JOIN orders o ON o.id = f.order_id
         WHERE f.position_id = ANY($1) AND o.kind = 'reduce_only'
         GROUP BY f.position_id`,
        [ids],
      )
    : { rows: [] as { position_id: string; qty: string; notional: string }[] };

  const closeByPos = new Map(closes.rows.map((c) => [c.position_id, c]));
  return positions.rows.map((p) => {
    const c = closeByPos.get(p.id);
    const qty = c ? BigInt(c.qty) : 0n;
    return {
      symbol: p.symbol,
      side: p.side === 'long' ? 'Long' : 'Short',
      leverage: Math.round(p.leverage_e2 / 100),
      status: p.status,
      entryE6: p.entry_e6,
      avgCloseE6: c && qty > 0n ? (BigInt(c.notional) / qty).toString() : null,
      realizedPnlUusdc: p.pnl,
      closedQtyE6: qty.toString(),
      openedAt: p.opened_at,
      closedAt: p.closed_at,
    };
  });
}
