import type { Db } from '../db/client.ts';

/**
 * The reconciler proves ledger integrity:
 *   1. every account's cached `balances` equals SUM(its ledger_entries)
 *   2. every txn_id's entries net to exactly zero
 *   3. (implied) the whole ledger sums to zero — money is only ever moved, never created
 * Run continuously; in the engine, a failure triggers an automatic trading halt.
 */
export interface ReconcileReport {
  ok: boolean;
  checkedAccounts: number;
  totalLedgerUusdc: string;
  drift: { accountId: string; cached: string; ledger: string }[];
  unbalancedTxns: { txnId: string; sum: string }[];
}

export async function reconcile(db: Db): Promise<ReconcileReport> {
  const driftRes = await db.query<{ account_id: string; cached: string; ledger: string }>(
    `SELECT a.id AS account_id,
            COALESCE(b.amount_uusdc, 0)::text AS cached,
            COALESCE((SELECT SUM(amount_uusdc) FROM ledger_entries le WHERE le.account_id = a.id), 0)::text AS ledger
     FROM accounts a
     LEFT JOIN balances b ON b.account_id = a.id`,
  );
  const drift = driftRes.rows
    .filter((r) => BigInt(r.cached) !== BigInt(r.ledger))
    .map((r) => ({ accountId: r.account_id, cached: r.cached, ledger: r.ledger }));

  const txRes = await db.query<{ txn_id: string; s: string }>(
    `SELECT txn_id, SUM(amount_uusdc)::text AS s
     FROM ledger_entries GROUP BY txn_id HAVING SUM(amount_uusdc) <> 0`,
  );
  const unbalancedTxns = txRes.rows.map((r) => ({ txnId: r.txn_id, sum: r.s }));

  const totalRes = await db.query<{ s: string }>(
    `SELECT COALESCE(SUM(amount_uusdc), 0)::text AS s FROM ledger_entries`,
  );
  const totalLedgerUusdc = totalRes.rows[0].s;

  return {
    ok: drift.length === 0 && unbalancedTxns.length === 0 && BigInt(totalLedgerUusdc) === 0n,
    checkedAccounts: driftRes.rows.length,
    totalLedgerUusdc,
    drift,
    unbalancedTxns,
  };
}
