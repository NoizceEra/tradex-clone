import { config } from '../../config.ts';
import type { Db, Queryer } from '../../db/client.ts';
import { getOrCreateSystemAccount, getBalance } from '../ledger.ts';
import { usdc } from '../../money.ts';
import type { CustodyLog } from './deposits.ts';

/**
 * Treasury automation (custody P3): proof-of-reserves + hot/cold float management.
 *
 * PROOF OF RESERVES. The ledger's TREASURY_USDC balance mirrors real money: its negative
 * balance equals total internal claims. The invariant is
 *
 *     on-chain custody (cold treasury + hot wallet + unswept deposit addresses) >= liabilities
 *
 * checked every pass. On a breach, withdrawals AUTO-FREEZE (the 'withdrawals_frozen' system
 * flag): new requests and new signings are rejected; deposits continue; recovery of
 * already-signed payouts proceeds (those debits are final and re-broadcast is idempotent).
 * Unfreezing is deliberately manual (`unfreezeWithdrawals`) — a PoR breach is an incident.
 *
 * HOT/COLD FLOAT. The cold treasury is a multisig the server cannot sign for; the hot wallet
 * funds payouts + fees. Each pass sweeps hot-wallet USDC above the float target to cold (the
 * target reserves enough for pending payouts), and flags a shortfall — hot balance below what
 * pending payouts need — for the operator to top up from cold (a manual multisig action).
 */

/** Chain-facing surface, injectable for tests (same pattern as DepositChain/WithdrawChain). */
export interface TreasuryChain {
  /** Finalized USDC balance of the hot wallet. */
  hotBalance(): Promise<bigint>;
  /** Finalized USDC balance of the cold treasury. */
  coldBalance(): Promise<bigint>;
  /** Move hot-wallet USDC to the cold treasury. Returns the tx signature. */
  sweepToCold(amountE6: bigint): Promise<string>;
}

const FROZEN_KEY = 'withdrawals_frozen';

/** The freeze reason when withdrawals are frozen, else null. Takes a Queryer so the withdrawal
 *  paths can check it inside their own transactions. */
export async function withdrawalsFrozen(q: Queryer): Promise<string | null> {
  const r = await q.query<{ reason: string }>(`SELECT reason FROM system_flags WHERE key = $1`, [FROZEN_KEY]);
  return r.rows[0]?.reason ?? null;
}

export async function freezeWithdrawals(db: Db, reason: string): Promise<void> {
  await db.query(
    `INSERT INTO system_flags(key, reason) VALUES($1, $2)
     ON CONFLICT(key) DO UPDATE SET reason = EXCLUDED.reason, updated_at = now()`,
    [FROZEN_KEY, reason],
  );
}

/** Operator action — a freeze never clears itself. */
export async function unfreezeWithdrawals(db: Db): Promise<void> {
  await db.query(`DELETE FROM system_flags WHERE key = $1`, [FROZEN_KEY]);
}

export interface TreasuryReport {
  liabilityE6: bigint; // |ledger TREASURY_USDC| — what the platform owes internally
  onchainE6: bigint; // cold + hot + unswept deposit-address balances
  sweptE6: bigint; // hot -> cold this pass
  shortfallE6: bigint; // pending payouts the hot wallet can't cover (operator: top up from cold)
  breached: boolean; // proof-of-reserves failed THIS pass (the frozen flag itself outlives the breach)
}

/** One treasury pass: proof-of-reserves (auto-freeze on breach), then hot-float management. */
export async function treasuryPass(db: Db, chain: TreasuryChain, log?: CustodyLog): Promise<TreasuryReport> {
  // The five reads are mutually independent — gather them concurrently (the chain RPCs dominate).
  const [ledgerBal, [hot, cold], unswept, pendingRes] = await Promise.all([
    getOrCreateSystemAccount(db, 'TREASURY_USDC').then((acct) => getBalance(db, acct)),
    Promise.all([chain.hotBalance(), chain.coldBalance()]),
    // Credited-but-unswept deposits still sit on their (ours, HD-derived) deposit addresses —
    // they are custody too, backed by recorded finalized transfers. Prompt sweeps keep this ~0.
    db.query<{ total: string }>(
      `SELECT COALESCE(SUM(usdc_credited_e6), 0)::text AS total FROM deposits
       WHERE asset = 'USDC' AND status = 'credited' AND sweep_sig IS NULL`,
    ),
    // Pending payouts (already debited; will leave the hot wallet) are reserved in the float target.
    db.query<{ total: string }>(
      `SELECT COALESCE(SUM(amount_e6), 0)::text AS total FROM withdrawals
       WHERE status IN ('requested', 'signed', 'broadcast')`,
    ),
  ]);

  // --- proof of reserves -------------------------------------------------------------------
  const liabilityE6 = ledgerBal < 0n ? -ledgerBal : 0n;
  const unsweptE6 = BigInt(unswept.rows[0].total);
  const onchainE6 = hot + cold + unsweptE6;

  const breached = onchainE6 < liabilityE6;
  if (breached) {
    const reason =
      `proof-of-reserves breach: on-chain custody ${onchainE6} uUSDC ` +
      `(hot ${hot} + cold ${cold} + unswept ${unsweptE6}) < liabilities ${liabilityE6} uUSDC`;
    await freezeWithdrawals(db, reason);
    log?.error({ onchainE6: onchainE6.toString(), liabilityE6: liabilityE6.toString() }, reason);
  }

  // --- hot-float management ----------------------------------------------------------------
  const pending = BigInt(pendingRes.rows[0].total);
  const hotMax = usdc(config.hotWalletMaxUsd);
  const excess = hot - (pending > hotMax ? pending : hotMax);
  const sweptE6 = excess >= usdc(config.minSweepUsd) ? excess : 0n;
  if (sweptE6 > 0n) await chain.sweepToCold(sweptE6);

  const shortfallE6 = pending > hot ? pending - hot : 0n;
  if (shortfallE6 > 0n) {
    log?.error(
      { shortfallE6: shortfallE6.toString(), hotE6: hot.toString(), pendingE6: pending.toString() },
      'hot wallet cannot cover pending withdrawals — top up from the cold treasury',
    );
  }

  return { liabilityE6, onchainE6, sweptE6, shortfallE6, breached };
}
