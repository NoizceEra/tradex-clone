import { config } from '../config.ts';
import { getDb, type Db } from './client.ts';
import { migrate } from './migrate.ts';
import { ensureSystemAccounts, getBalance } from '../services/ledger.ts';

/** Apply schema, ensure system accounts and the singleton LP pool row exist. */
export async function initDb(): Promise<Db> {
  const db = await getDb();
  await migrate();
  const accounts = await db.tx((q) => ensureSystemAccounts(q));
  await db.query(
    `INSERT INTO lp_pool(id, total_assets_uusdc, total_shares) VALUES('pool', 0, 0)
     ON CONFLICT(id) DO NOTHING`,
  );

  // REAL_FUNDS requires a FRESH ledger: faucet-sourced play balances are liabilities with no
  // on-chain backing — they must never become withdrawable as real USDC. (Unreachable while
  // config.ts refuses REAL_FUNDS outright; stays correct when that gate opens — custody P4.)
  if (config.realFunds) {
    const faucetBal = await getBalance(db, accounts.FAUCET_SOURCE);
    if (faucetBal !== 0n) {
      throw new Error(
        `REAL_FUNDS=true requires a fresh ledger: FAUCET_SOURCE balance is ${faucetBal} (play-money liabilities present). Start from a clean production database.`,
      );
    }
  }
  return db;
}
