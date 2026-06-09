import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { getOrCreateSystemAccount, getBalance, postTxn } = await import('./ledger.ts');
const { allocateFeesToInsurance, deallocateInsuranceToFees, allocateTreasurySurplusToInsurance, getInsurance } = await import('./insurance.ts');
const { reconcile } = await import('./reconcile.ts');
const { usdc } = await import('../money.ts');

await initDb();
const db = await getDb();

// Seed accumulated platform fees (normally from trading commissions) so we can allocate from them.
await db.tx(async (q) => {
  const fees = await getOrCreateSystemAccount(q, 'FEE_REVENUE');
  const faucet = await getOrCreateSystemAccount(q, 'FAUCET_SOURCE');
  await postTxn(q, { reason: 'TEST_SEED', entries: [
    { accountId: fees, amount: usdc(1_000) },
    { accountId: faucet, amount: -usdc(1_000) },
  ] });
});

test('(a) allocate platform fees into the insurance buffer', async () => {
  const r = await allocateFeesToInsurance(db, usdc(600));
  assert.equal(r.insuranceUusdc, usdc(600).toString());
  assert.equal(r.feeRevenueUusdc, usdc(400).toString());
});

test('(a) rejects allocating more fees than the platform has earned', async () => {
  await assert.rejects(allocateFeesToInsurance(db, usdc(10_000)), /fee revenue balance too low/);
});

test('reverse: pull insurance back to fees', async () => {
  const r = await deallocateInsuranceToFees(db, usdc(200));
  assert.equal(r.insuranceUusdc, usdc(400).toString());
  assert.equal(r.feeRevenueUusdc, usdc(600).toString());
  await assert.rejects(deallocateInsuranceToFees(db, usdc(10_000)), /insurance fund balance too low/);
});

test('(b) allocate treasury surplus into insurance — capped at the available surplus', async () => {
  // operator has sent $500 of real USDC to the treasury (surplus); allocate $300 of it
  const r = await allocateTreasurySurplusToInsurance(db, usdc(300), usdc(500));
  assert.equal(r.insuranceUusdc, usdc(700).toString()); // 400 + 300
  // can't allocate beyond what's actually in the treasury
  await assert.rejects(allocateTreasurySurplusToInsurance(db, usdc(1_000), usdc(500)), /exceeds available treasury surplus/);
  assert.equal((await getInsurance(db)).insuranceUusdc, usdc(700).toString());
});

test('reconciler stays balanced after all insurance moves', async () => {
  const report = await reconcile(db);
  assert.equal(report.ok, true, JSON.stringify(report, null, 2));
});

after(async () => {
  await closeDb();
});
