import { randomUUID } from 'node:crypto';
import type { Keypair } from '@solana/web3.js';
import { config } from '../../config.ts';
import type { Db } from '../../db/client.ts';
import { getOrCreateSystemAccount, getOrCreateUserAccount, postTxn } from '../ledger.ts';
import { deriveDepositKeypair } from './wallet.ts';

/**
 * USDC deposit pipeline (custody P1, USDC-only — SOL + Jupiter auto-swap is P1.5):
 *
 *   detect (finalized) -> credit the ledger -> sweep to treasury (async, self-healing)
 *
 * Credit-first: once an inbound transfer is FINALIZED the funds already sit in our custody
 * (the deposit address is ours, HD-derived), so the user is credited immediately — sweep
 * health never delays or strands a credit. The sweep is a FULL-BALANCE move (naturally
 * idempotent: it retries until the address is empty, one sweep may cover several deposits).
 *
 * Crediting is idempotent (deposits.onchain_sig UNIQUE + a status guard under FOR UPDATE)
 * and ALWAYS for the full received amount — the play-money faucet clamp (creditCapped's
 * $1M cap) must never apply to real money: a clamped real deposit would be USDC received
 * on-chain but not credited.
 *
 * Proof-of-reserves note: with credit-before-sweep, on-chain custody = treasury + unswept
 * deposit-address balances; prompt sweeps keep the second term ~0 and the P3 chain
 * reconciler must count both.
 */

export interface InboundUsdc {
  sig: string;
  amountE6: bigint;
}

export interface SweepResult {
  sig: string;
  amountE6: bigint;
}

/** Chain-facing surface, injectable for tests (same pattern as oracle.ts's CardFetcher). */
export interface DepositChain {
  /** Finalized inbound USDC transfers to `address`, oldest first. `knownSigs` lets impls skip work. */
  inboundUsdc(address: string, knownSigs: Set<string>): Promise<InboundUsdc[]>;
  /** Sweep the deposit wallet's ENTIRE USDC balance to the treasury (hot wallet = fee payer).
   *  Naturally idempotent — returns null when there is nothing to sweep. */
  sweepAll(from: Keypair): Promise<SweepResult | null>;
}

const minDepositE6 = (): bigint => BigInt(Math.round(config.minDepositUsd * 1_000_000));

/** Credit a finalized deposit to the user's collateral — full amount, never clamped. Idempotent. */
export async function creditDeposit(db: Db, depositId: string): Promise<string | null> {
  return db.tx(async (q) => {
    const r = await q.query<{ user_id: string; amt: string; status: string }>(
      `SELECT user_id, amount_in_raw::text AS amt, status FROM deposits WHERE id = $1 FOR UPDATE`,
      [depositId],
    );
    const d = r.rows[0];
    if (!d || d.status === 'credited') return null; // unknown or already credited (idempotent)
    const amount = BigInt(d.amt); // USDC raw units == micro-USDC

    const coll = await getOrCreateUserAccount(q, d.user_id, 'USER_COLLATERAL');
    const treasury = await getOrCreateSystemAccount(q, 'TREASURY_USDC');
    const txnId = await postTxn(q, {
      reason: 'DEPOSIT',
      refType: 'deposit',
      refId: depositId,
      entries: [
        { accountId: coll, amount },
        { accountId: treasury, amount: -amount },
      ],
    });
    await q.query(
      `UPDATE deposits SET status = 'credited', usdc_credited_e6 = $2, txn_id = $3, credited_at = now() WHERE id = $1`,
      [depositId, amount.toString(), txnId],
    );
    return txnId;
  });
}

/**
 * One scan pass over every deposit address:
 *   1. record new finalized inbound USDC (>= the dust threshold) — idempotent by signature;
 *   2. credit every uncredited row (re-entrant: also resumes rows stranded by a prior crash);
 *   3. sweep whatever sits on the deposit wallet to the treasury (retried next pass on failure).
 * Per-address failures are logged and don't stop the pass; everything is safe to re-run.
 */
export async function scanDeposits(
  db: Db,
  chain: DepositChain,
  log?: { error: (obj: unknown, msg: string) => void },
): Promise<{ credited: number }> {
  const addrs = await db.query<{ user_id: string; address: string; derivation_index: number }>(
    `SELECT user_id, address, derivation_index FROM deposit_addresses`,
  );
  let credited = 0;

  for (const a of addrs.rows) {
    try {
      // 1) detect
      const known = await db.query<{ onchain_sig: string }>(
        `SELECT onchain_sig FROM deposits WHERE user_id = $1`,
        [a.user_id],
      );
      const knownSigs = new Set(known.rows.map((r) => r.onchain_sig));
      for (const t of await chain.inboundUsdc(a.address, knownSigs)) {
        if (knownSigs.has(t.sig)) continue;
        if (t.amountE6 < minDepositE6()) continue; // dust: uneconomic to sweep (and anti-dusting)
        await db.query(
          `INSERT INTO deposits(id, user_id, onchain_sig, asset, amount_in_raw, status)
           VALUES($1, $2, $3, 'USDC', $4, 'detected')
           ON CONFLICT(onchain_sig) DO NOTHING`,
          [randomUUID(), a.user_id, t.sig, t.amountE6.toString()],
        );
      }

      // 2) credit (re-entrant)
      const pending = await db.query<{ id: string }>(
        `SELECT id FROM deposits WHERE user_id = $1 AND status <> 'credited'`,
        [a.user_id],
      );
      for (const p of pending.rows) {
        if (await creditDeposit(db, p.id)) credited++;
      }

      // 3) sweep (idempotent full-balance move; a failure here never blocks credits)
      const sweep = await chain.sweepAll(deriveDepositKeypair(a.derivation_index));
      if (sweep) {
        await db.query(`UPDATE deposits SET sweep_sig = $2 WHERE user_id = $1 AND sweep_sig IS NULL`, [
          a.user_id,
          sweep.sig,
        ]);
      }
    } catch (e) {
      log?.error(e, `deposit scan failed for ${a.address} (will retry next pass)`);
    }
  }
  return { credited };
}
