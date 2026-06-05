import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

const { Keypair } = await import('@solana/web3.js');
const { initDb } = await import('../db/init.ts');
const { getDb, closeDb } = await import('../db/client.ts');
const { getOrCreateSystemAccount, getBalance } = await import('./ledger.ts');
const { treasuryPass, withdrawalsFrozen, unfreezeWithdrawals } = await import('./custody/treasury.ts');
const { requestWithdrawal, processWithdrawal, processAllRequested } = await import('./custody/withdrawals.ts');
const { reconcile } = await import('./reconcile.ts');
const { usdc } = await import('../money.ts');
const { fund: fundDb, fakeWithdrawChain } = await import('../test-helpers.ts');

await initDb();
const db = await getDb();

const DEST = Keypair.generate().publicKey.toBase58();
const fund = (userId: string, amount: bigint) => fundDb(db, userId, amount);

async function newUser(): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO users(id, solana_pubkey) VALUES($1, $2)`, [id, 'pk-' + id.slice(0, 8)]);
  return id;
}

/** What the ledger says the platform owes (the PoR right-hand side). */
async function liability(): Promise<bigint> {
  const acct = await getOrCreateSystemAccount(db, 'TREASURY_USDC');
  const bal = await getBalance(db, acct);
  return bal < 0n ? -bal : 0n;
}

/** A 'requested' withdrawal row planted directly (already-debited state is irrelevant here). */
async function insertRequested(userId: string, amountE6: bigint): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO withdrawals(id, user_id, dest_address, amount_e6, status, idempotency_key)
     VALUES($1, $2, $3, $4, 'requested', $5)`,
    [id, userId, DEST, amountE6.toString(), `t-idem-${id.slice(0, 8)}`],
  );
  return id;
}

/** In-memory TreasuryChain with mutable balances. */
function fakeTreasury(init: { hot?: bigint; cold?: bigint } = {}) {
  const t = {
    hot: init.hot ?? 0n,
    cold: init.cold ?? 0n,
    sweeps: [] as bigint[],
    async hotBalance() {
      return t.hot;
    },
    async coldBalance() {
      return t.cold;
    },
    async sweepToCold(amountE6: bigint) {
      t.hot -= amountE6;
      t.cold += amountE6;
      t.sweeps.push(amountE6);
      return `tsweep-${t.sweeps.length}`;
    },
  };
  return t;
}

test('a proof-of-reserves breach auto-freezes withdrawals; unfreezing is manual', async () => {
  const u = await newUser();
  await fund(u, usdc(100));
  const held = await insertRequested(u, usdc(20));

  // on-chain custody short of liabilities -> freeze
  const broke = fakeTreasury({ hot: usdc(30), cold: usdc(50) });
  const report = await treasuryPass(db, broke);
  assert.equal(report.breached, true);
  assert.match((await withdrawalsFrozen(db)) ?? '', /proof-of-reserves breach/);

  // new requests are rejected before any signature work
  await assert.rejects(
    () =>
      requestWithdrawal(db, u, 'pk-any', {
        amountE6: usdc(10),
        dest: DEST,
        idempotencyKey: 'frozen-try-1',
        message: 'irrelevant',
        signature: 'irrelevant',
      }),
    /frozen/,
  );
  // new payouts are blocked too — both the single-row path and the auto loop
  const wchain = fakeWithdrawChain();
  await assert.rejects(() => processWithdrawal(db, wchain, held), /frozen/);
  assert.deepEqual(await processAllRequested(db, wchain), { confirmed: 0 });
  assert.equal(wchain.signed.length, 0); // nothing was ever signed while frozen

  // a healthy pass does NOT unfreeze by itself — that's an operator call
  const solvent = fakeTreasury({ hot: usdc(30), cold: await liability() });
  assert.equal((await treasuryPass(db, solvent)).breached, false);
  assert.match((await withdrawalsFrozen(db)) ?? '', /proof-of-reserves breach/);

  await unfreezeWithdrawals(db);
  assert.equal(await withdrawalsFrozen(db), null);
  assert.deepEqual(await processAllRequested(db, wchain), { confirmed: 1 }); // the held row pays out
  assert.equal((await reconcile(db)).ok, true);
});

test('credited-but-unswept deposit balances count toward proof of reserves', async () => {
  const u = await newUser();
  const unswept = usdc(50);
  await fund(u, unswept);
  await db.query(
    `INSERT INTO deposits(id, user_id, onchain_sig, asset, amount_in_raw, usdc_credited_e6, status)
     VALUES($1, $2, 'sig-unswept-por', 'USDC', $3, $3, 'credited')`, // sweep_sig NULL
    [randomUUID(), u, unswept.toString()],
  );

  // cold + hot deliberately short by exactly the unswept amount: still solvent overall
  const chain = fakeTreasury({ hot: 0n, cold: (await liability()) - unswept });
  const report = await treasuryPass(db, chain);
  assert.equal(report.breached, false);
  assert.equal(await withdrawalsFrozen(db), null);
  assert.equal(report.onchainE6, report.liabilityE6); // balanced to the micro-dollar
});

test('hot-wallet excess above the float cap is swept to cold (threshold-gated)', async () => {
  const SAFE_COLD = usdc(1_000_000_000); // PoR comfortably satisfied in float-only tests

  // $30k hot vs the $25k cap -> sweep exactly the $5k excess
  const over = fakeTreasury({ hot: usdc(30_000), cold: SAFE_COLD });
  assert.equal((await treasuryPass(db, over)).sweptE6, usdc(5_000));
  assert.deepEqual(over.sweeps, [usdc(5_000)]);
  assert.equal(over.hot, usdc(25_000));

  // under the cap -> nothing to do; excess below the sweep threshold -> accumulate, no fee
  const under = fakeTreasury({ hot: usdc(10_000), cold: SAFE_COLD });
  assert.equal((await treasuryPass(db, under)).sweptE6, 0n);
  const dusty = fakeTreasury({ hot: usdc(25_000) + usdc(5), cold: SAFE_COLD });
  assert.equal((await treasuryPass(db, dusty)).sweptE6, 0n);
  assert.equal(dusty.sweeps.length, 0);
});

test('pending payouts are reserved in the float target, and a shortfall is reported', async () => {
  const SAFE_COLD = usdc(1_000_000_000);
  const u = await newUser();
  const big = await insertRequested(u, usdc(28_000)); // above the $25k cap on its own

  // $30k hot, $28k pending -> target is the pending amount, only $2k is sweepable
  const chain = fakeTreasury({ hot: usdc(30_000), cold: SAFE_COLD });
  const r1 = await treasuryPass(db, chain);
  assert.equal(r1.sweptE6, usdc(2_000));
  assert.equal(r1.shortfallE6, 0n);

  // hot wallet can't cover the pending payout -> shortfall flagged, nothing swept
  const broke = fakeTreasury({ hot: usdc(1_000), cold: SAFE_COLD });
  const r2 = await treasuryPass(db, broke);
  assert.equal(r2.sweptE6, 0n);
  assert.equal(r2.shortfallE6, usdc(27_000));

  await db.query(`UPDATE withdrawals SET status = 'reversed', reason = 'test cleanup' WHERE id = $1`, [big]);
});

test('the auto loop only pays out up to the auto-approve cap; larger rows wait for an operator', async () => {
  const u = await newUser();
  const small = await insertRequested(u, usdc(500)); // <= the $1k auto cap
  const large = await insertRequested(u, usdc(5_000)); // operator-only

  const wchain = fakeWithdrawChain();
  assert.deepEqual(await processAllRequested(db, wchain), { confirmed: 1 });
  const rows = await db.query<{ id: string; status: string }>(
    `SELECT id, status FROM withdrawals WHERE id = ANY($1) ORDER BY amount_e6`,
    [[small, large]],
  );
  assert.deepEqual(
    rows.rows.map((r) => r.status),
    ['confirmed', 'requested'],
  );

  // the operator path ignores the auto cap — explicit approval processes the large row
  assert.equal((await processWithdrawal(db, wchain, large)).status, 'confirmed');
});

after(async () => {
  await closeDb();
});
