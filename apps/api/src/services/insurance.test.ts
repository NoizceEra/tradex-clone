import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { creditFaucet, getUserBalances } = await import('./faucet.ts');
const { fundInsurance, defundInsurance, getInsurance } = await import('./insurance.ts');
const { reconcile } = await import('./reconcile.ts');
const { usdc } = await import('../money.ts');

await initDb();
const db = await getDb();

async function newUser(faucetUsd: number): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO users(id, solana_pubkey) VALUES($1, $2)`, [id, 'pk-' + id.slice(0, 8)]);
  await creditFaucet(db, id, faucetUsd);
  return id;
}
const avail = async (u: string) => (await getUserBalances(db, u)).availableUusdc.toString();
let op = ''; // the operator account seeding insurance, shared across the deposit/withdraw tests

test('fundInsurance moves collateral into the insurance buffer', async () => {
  op = await newUser(1_000);
  const r = await fundInsurance(db, op, usdc(600));
  assert.equal(r.insuranceUusdc, usdc(600).toString());
  assert.equal((await getInsurance(db)).insuranceUusdc, usdc(600).toString());
  assert.equal(await avail(op), usdc(400).toString()); // collateral debited
});

test('defundInsurance returns buffer money to collateral', async () => {
  const r = await defundInsurance(db, op, usdc(200));
  assert.equal(r.insuranceUusdc, usdc(400).toString());
  assert.equal(await avail(op), usdc(600).toString());
});

test('rejects over-funding (more than collateral) and over-defunding (more than the buffer)', async () => {
  const op = await newUser(100);
  await assert.rejects(fundInsurance(db, op, usdc(500)), /insufficient/);
  await assert.rejects(defundInsurance(db, op, usdc(10_000)), /balance too low/);
});

test('reconciler stays balanced after insurance moves', async () => {
  const report = await reconcile(db);
  assert.equal(report.ok, true, JSON.stringify(report, null, 2));
});

after(async () => {
  await closeDb();
});
