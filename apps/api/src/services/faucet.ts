import { config } from '../config.ts';
import { HttpError } from '../errors.ts';
import type { Db } from '../db/client.ts';
import { getOrCreateUserAccount, getOrCreateSystemAccount, postTxn, getBalance } from './ledger.ts';
import { usdc } from '../money.ts';

/** Play-money cap: don't let a user faucet beyond this available balance. */
const MAX_AVAILABLE_UUSDC = usdc(1_000_000);

export interface UserBalances {
  availableUusdc: bigint;
  lockedMarginUusdc: bigint;
  equityUusdc: bigint; // available + locked (+ unrealized PnL once the engine lands)
}

export async function getUserBalances(db: Db, userId: string): Promise<UserBalances> {
  // single read; accounts get created on first faucet/trade, absent rows read as 0
  const r = await db.query<{ type: string; amt: string }>(
    `SELECT a.type, COALESCE(b.amount_uusdc, 0)::text AS amt
     FROM accounts a LEFT JOIN balances b ON b.account_id = a.id
     WHERE a.user_id = $1 AND a.type IN ('USER_COLLATERAL', 'USER_POSITION_MARGIN')`,
    [userId],
  );
  let availableUusdc = 0n;
  let lockedMarginUusdc = 0n;
  for (const row of r.rows) {
    if (row.type === 'USER_COLLATERAL') availableUusdc = BigInt(row.amt);
    else if (row.type === 'USER_POSITION_MARGIN') lockedMarginUusdc = BigInt(row.amt);
  }
  return { availableUusdc, lockedMarginUusdc, equityUusdc: availableUusdc + lockedMarginUusdc };
}

/** Credit play USDC to a user from the FAUCET_SOURCE account (a balanced ledger txn). */
export async function creditFaucet(db: Db, userId: string, amountUsd?: number): Promise<{ txnId: string; availableUusdc: bigint }> {
  if (config.realFunds) throw new HttpError(403, 'faucet disabled when REAL_FUNDS is on');
  const amount = usdc(amountUsd ?? config.faucetDefaultUsd);
  if (amount <= 0n) throw new HttpError(400, 'amount must be positive');

  const txnId = await db.tx(async (q) => {
    const coll = await getOrCreateUserAccount(q, userId, 'USER_COLLATERAL');
    const faucet = await getOrCreateSystemAccount(q, 'FAUCET_SOURCE');
    const current = await getBalance(q, coll);
    const headroom = MAX_AVAILABLE_UUSDC - current;
    if (headroom <= 0n) {
      throw new HttpError(429, 'faucet limit reached — you already have plenty of play USDC');
    }
    const credit = amount < headroom ? amount : headroom; // clamp so balance can't exceed the cap
    return postTxn(q, {
      reason: 'FAUCET',
      entries: [
        { accountId: coll, amount: credit },
        { accountId: faucet, amount: -credit },
      ],
    });
  });

  const balances = await getUserBalances(db, userId);
  return { txnId, availableUusdc: balances.availableUusdc };
}
