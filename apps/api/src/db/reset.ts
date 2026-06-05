import { config } from '../config.ts';
import { getDb, closeDb } from './client.ts';
import { migrate } from './migrate.ts';

/**
 * Refuse to wipe anything that might be production or hold real funds. `DROP SCHEMA public CASCADE`
 * is irreversible, so this fails closed:
 *   - REAL_FUNDS on              -> never (a real-funds ledger must never be wiped by this script);
 *   - production env             -> only with the explicit ALLOW_DB_RESET=true override;
 *   - a managed DATABASE_URL set -> only with ALLOW_DB_RESET=true (local PGlite has no DATABASE_URL).
 * Local PGlite dev (no DATABASE_URL, not production, not real-funds) — the common `pnpm db:reset`
 * case — is allowed with no friction.
 */
function assertResetAllowed(): void {
  const override = process.env.ALLOW_DB_RESET === 'true';
  if (config.realFunds) {
    throw new Error('refusing to reset: REAL_FUNDS is on — this would irreversibly destroy a real-funds ledger.');
  }
  if (config.env === 'production' && !override) {
    throw new Error('refusing to DROP SCHEMA in production. Set ALLOW_DB_RESET=true to override (DESTRUCTIVE, irreversible).');
  }
  if (config.databaseUrl && !override) {
    throw new Error('refusing to DROP SCHEMA on a managed DATABASE_URL Postgres. Set ALLOW_DB_RESET=true to override (DESTRUCTIVE).');
  }
}

/** Drop everything and re-apply the schema. Guarded against prod / managed / real-funds databases. */
export async function reset(): Promise<void> {
  assertResetAllowed();
  const db = await getDb();
  await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
}

if (process.argv[1]?.endsWith('reset.ts')) {
  reset()
    .then(() => {
      console.log('db reset');
      return closeDb();
    })
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
