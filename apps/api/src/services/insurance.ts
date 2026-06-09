import { HttpError } from '../errors.ts';
import type { Db } from '../db/client.ts';
import { getOrCreateUserAccount, getOrCreateSystemAccount, getBalance, postTxn } from './ledger.ts';

/**
 * The insurance fund is the buffer that absorbs gap-driven bad debt (a liquidation that blows past
 * the margin) BEFORE it socializes to LPs. Out of the box it only fills from liquidation penalties;
 * these let an operator pre-seed and manage it.
 *
 * Funding moves a funded account's collateral into the INSURANCE_FUND ledger account — symmetric to
 * an LP deposit, but with no shares (it's a donation to the buffer, not a yield-bearing stake). No
 * real USDC leaves custody: the on-chain reserves are unchanged, the ledger just reassigns the claim
 * from the operator's collateral to the house buffer (so it stops counting as money owed to a user).
 */
export async function fundInsurance(db: Db, userId: string, amountUusdc: bigint): Promise<{ insuranceUusdc: string }> {
  if (amountUusdc <= 0n) throw new HttpError(400, 'amount must be positive');
  return db.tx(async (q) => {
    const coll = await getOrCreateUserAccount(q, userId, 'USER_COLLATERAL');
    const ins = await getOrCreateSystemAccount(q, 'INSURANCE_FUND');
    if ((await getBalance(q, coll)) < amountUusdc) throw new HttpError(400, 'insufficient balance');
    await postTxn(q, {
      reason: 'INSURANCE_DEPOSIT',
      entries: [
        { accountId: coll, amount: -amountUusdc },
        { accountId: ins, amount: amountUusdc },
      ],
    });
    return { insuranceUusdc: (await getBalance(q, ins)).toString() };
  });
}

/** Pull from the insurance buffer back to an account's collateral (operator de-fund / rebalance). */
export async function defundInsurance(db: Db, userId: string, amountUusdc: bigint): Promise<{ insuranceUusdc: string }> {
  if (amountUusdc <= 0n) throw new HttpError(400, 'amount must be positive');
  return db.tx(async (q) => {
    const coll = await getOrCreateUserAccount(q, userId, 'USER_COLLATERAL');
    const ins = await getOrCreateSystemAccount(q, 'INSURANCE_FUND');
    if ((await getBalance(q, ins)) < amountUusdc) throw new HttpError(400, 'insurance fund balance too low');
    await postTxn(q, {
      reason: 'INSURANCE_DEFUND',
      entries: [
        { accountId: ins, amount: -amountUusdc },
        { accountId: coll, amount: amountUusdc },
      ],
    });
    return { insuranceUusdc: (await getBalance(q, ins)).toString() };
  });
}

/** Current insurance-fund balance (micro-USDC). */
export async function getInsurance(db: Db): Promise<{ insuranceUusdc: string }> {
  const ins = await getOrCreateSystemAccount(db, 'INSURANCE_FUND');
  return { insuranceUusdc: (await getBalance(db, ins)).toString() };
}
