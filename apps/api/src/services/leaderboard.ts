import { unrealizedPnl } from '@pokex/pricing';
import type { Db } from '../db/client.ts';

export interface LeaderboardRow {
  rank: number;
  userId: string;
  pubkey: string;
  realizedPnlUusdc: string; // net booked PnL: (collateral + margin) - net deposits  (fees & funding included)
  equityUusdc: string; // collateral + margin + unrealized PnL
  volumeUusdc: string; // Σ notional traded across all fills
}

/**
 * Trader leaderboard, ranked by net realized PnL. All figures are derived from the ledger so they
 * reconcile with balances:
 *   net deposits   = Σ faucet + referral credits to the user's collateral
 *   cash           = collateral balance + locked margin
 *   realized PnL   = cash - net deposits        (what trading/fees/funding actually netted)
 *   equity         = cash + unrealized PnL on open positions (marked to the latest mark)
 * Computed with a handful of set-based queries + in-memory aggregation (fine for the MVP's user count).
 */
export async function getLeaderboard(
  db: Db,
  opts: { limit?: number; viewerUserId?: string } = {},
): Promise<{ rows: LeaderboardRow[]; you: LeaderboardRow | null; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);

  const [users, balances, deposits, volume, positions] = await Promise.all([
    db.query<{ id: string; solana_pubkey: string }>(`SELECT id, solana_pubkey FROM users`),
    db.query<{ user_id: string; type: string; amt: string }>(
      `SELECT a.user_id, a.type, COALESCE(b.amount_uusdc, 0)::text AS amt
       FROM accounts a LEFT JOIN balances b ON b.account_id = a.id
       WHERE a.user_id IS NOT NULL AND a.type IN ('USER_COLLATERAL', 'USER_POSITION_MARGIN')`,
    ),
    db.query<{ user_id: string; amt: string }>(
      `SELECT a.user_id, COALESCE(SUM(le.amount_uusdc), 0)::text AS amt
       FROM ledger_entries le JOIN accounts a ON a.id = le.account_id
       WHERE a.type = 'USER_COLLATERAL' AND le.reason IN ('FAUCET', 'REFERRAL_BONUS')
       GROUP BY a.user_id`,
    ),
    db.query<{ user_id: string; vol: string }>(
      `SELECT o.user_id, COALESCE(SUM(f.qty_e6 * f.exec_price_e6), 0)::text AS vol
       FROM fills f JOIN orders o ON o.id = f.order_id GROUP BY o.user_id`,
    ),
    db.query<{ user_id: string; side: 'long' | 'short'; qty_e6: string; avg_entry_e6: string; mark_e6: string | null }>(
      `SELECT p.user_id, p.side, p.qty_e6::text AS qty_e6, p.avg_entry_e6::text AS avg_entry_e6,
              (SELECT mark_price_e6::text FROM marks m WHERE m.market_id = p.market_id ORDER BY computed_at DESC LIMIT 1) AS mark_e6
       FROM positions p WHERE p.status = 'open'`,
    ),
  ]);

  const cash = new Map<string, bigint>(); // collateral + locked margin
  for (const r of balances.rows) cash.set(r.user_id, (cash.get(r.user_id) ?? 0n) + BigInt(r.amt));

  const deposited = new Map<string, bigint>();
  for (const r of deposits.rows) deposited.set(r.user_id, BigInt(r.amt));

  const vol = new Map<string, bigint>();
  for (const r of volume.rows) vol.set(r.user_id, BigInt(r.vol) / 1_000_000n); // qty_e6*price_e6 (e12) -> notional micro-USDC (e6)

  const uPnl = new Map<string, bigint>();
  for (const p of positions.rows) {
    if (!p.mark_e6) continue;
    const pnl = unrealizedPnl(p.side, BigInt(p.qty_e6), BigInt(p.avg_entry_e6), BigInt(p.mark_e6));
    uPnl.set(p.user_id, (uPnl.get(p.user_id) ?? 0n) + pnl);
  }

  const ranked = users.rows
    .map((u) => {
      const c = cash.get(u.id) ?? 0n;
      const realized = c - (deposited.get(u.id) ?? 0n);
      return {
        userId: u.id,
        pubkey: u.solana_pubkey,
        realized,
        equity: c + (uPnl.get(u.id) ?? 0n),
        volume: vol.get(u.id) ?? 0n,
      };
    })
    .sort((a, b) => (b.realized === a.realized ? cmp(b.equity, a.equity) : cmp(b.realized, a.realized)));

  const toRow = (e: (typeof ranked)[number], i: number): LeaderboardRow => ({
    rank: i + 1,
    userId: e.userId,
    pubkey: e.pubkey,
    realizedPnlUusdc: e.realized.toString(),
    equityUusdc: e.equity.toString(),
    volumeUusdc: e.volume.toString(),
  });

  const rows = ranked.slice(0, limit).map(toRow);
  let you: LeaderboardRow | null = null;
  if (opts.viewerUserId) {
    const idx = ranked.findIndex((e) => e.userId === opts.viewerUserId);
    if (idx >= 0) you = toRow(ranked[idx], idx);
  }
  return { rows, you, total: ranked.length };
}

function cmp(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
