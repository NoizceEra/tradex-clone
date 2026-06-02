import type { Queryer } from '../db/client.ts';

/**
 * Open-interest accounting. "Open notional" is entry-based: Σ qty * avg_entry (micro-USDC).
 * Centralized here because the OI-cap check, funding skew, and LP reserved capital must all
 * compute it the same way.
 */

/** Gross open notional per side for one market. */
export async function openNotionalBySide(q: Queryer, marketId: string): Promise<{ longOi: bigint; shortOi: bigint }> {
  const r = await q.query<{ side: string; oi: string }>(
    `SELECT side, COALESCE(SUM((qty_e6::numeric * avg_entry_e6::numeric) / 1000000), 0)::bigint::text AS oi
     FROM positions WHERE market_id=$1 AND status='open' GROUP BY side`,
    [marketId],
  );
  let longOi = 0n;
  let shortOi = 0n;
  for (const row of r.rows) {
    if (row.side === 'long') longOi = BigInt(row.oi);
    else shortOi = BigInt(row.oi);
  }
  return { longOi, shortOi };
}

/** Pool-wide gross open notional across all open positions (the LP's reserved capital). */
export async function grossOpenNotional(q: Queryer): Promise<bigint> {
  const r = await q.query<{ oi: string }>(
    `SELECT COALESCE(SUM((qty_e6::numeric * avg_entry_e6::numeric) / 1000000), 0)::bigint::text AS oi
     FROM positions WHERE status='open'`,
  );
  return BigInt(r.rows[0].oi);
}
