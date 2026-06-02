import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// Use an in-memory PGlite for tests. Must be set before importing config/client.
process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';

const { getDb, closeDb } = await import('../db/client.ts');
const { migrate } = await import('../db/migrate.ts');
const { ensureSystemAccounts, getOrCreateUserAccount, postTxn, getBalance } = await import('./ledger.ts');
const { reconcile } = await import('./reconcile.ts');
const { usdc } = await import('../money.ts');

const db = await getDb();
await migrate();

test('schema applied and system accounts created', async () => {
  const sys = await db.tx((q) => ensureSystemAccounts(q));
  assert.ok(sys.LP_POOL && sys.FAUCET_SOURCE && sys.INSURANCE_FUND);
});

test('faucet credit is balanced and reflected in the cache', async () => {
  const userId = randomUUID();
  await db.tx(async (q) => {
    const collateral = await getOrCreateUserAccount(q, userId, 'USER_COLLATERAL');
    const faucet = await ensureSystemAccounts(q).then((s) => s.FAUCET_SOURCE);
    await postTxn(q, {
      reason: 'FAUCET',
      entries: [
        { accountId: collateral, amount: usdc(10_000) },
        { accountId: faucet, amount: -usdc(10_000) },
      ],
    });
    const bal = await getBalance(q, collateral);
    assert.equal(bal, usdc(10_000));
  });
});

test('unbalanced txn is rejected', async () => {
  const userId = randomUUID();
  await assert.rejects(
    db.tx(async (q) => {
      const a = await getOrCreateUserAccount(q, userId, 'USER_COLLATERAL');
      const b = await getOrCreateUserAccount(q, userId, 'USER_POSITION_MARGIN');
      await postTxn(q, {
        reason: 'MARGIN_LOCK',
        entries: [
          { accountId: a, amount: -usdc(100) },
          { accountId: b, amount: usdc(99) }, // off by $1
        ],
      });
    }),
    /unbalanced/,
  );
});

test('transfer between two accounts conserves value', async () => {
  const userId = randomUUID();
  await db.tx(async (q) => {
    const coll = await getOrCreateUserAccount(q, userId, 'USER_COLLATERAL');
    const margin = await getOrCreateUserAccount(q, userId, 'USER_POSITION_MARGIN');
    const faucet = await ensureSystemAccounts(q).then((s) => s.FAUCET_SOURCE);
    // fund then lock margin
    await postTxn(q, { reason: 'FAUCET', entries: [
      { accountId: coll, amount: usdc(500) },
      { accountId: faucet, amount: -usdc(500) },
    ]});
    await postTxn(q, { reason: 'MARGIN_LOCK', entries: [
      { accountId: coll, amount: -usdc(200) },
      { accountId: margin, amount: usdc(200) },
    ]});
    assert.equal(await getBalance(q, coll), usdc(300));
    assert.equal(await getBalance(q, margin), usdc(200));
  });
});

test('reconciler reports OK after valid txns', async () => {
  const report = await reconcile(db);
  assert.equal(report.ok, true, JSON.stringify(report, null, 2));
  assert.equal(BigInt(report.totalLedgerUusdc), 0n);
  assert.equal(report.drift.length, 0);
  assert.equal(report.unbalancedTxns.length, 0);
});

test('cleanup', async () => {
  await closeDb();
});
