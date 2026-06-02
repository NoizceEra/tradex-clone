import { getDb, type Db } from './client.ts';
import { migrate } from './migrate.ts';
import { ensureSystemAccounts } from '../services/ledger.ts';

/** Apply schema, ensure system accounts and the singleton LP pool row exist. */
export async function initDb(): Promise<Db> {
  const db = await getDb();
  await migrate();
  await db.tx((q) => ensureSystemAccounts(q));
  await db.query(
    `INSERT INTO lp_pool(id, total_assets_uusdc, total_shares) VALUES('pool', 0, 0)
     ON CONFLICT(id) DO NOTHING`,
  );
  return db;
}
