import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Keypair } from '@solana/web3.js';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
process.env.DEPOSIT_MASTER_SEED = 'ab'.repeat(32); // deterministic dev seed (32 bytes hex)

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { getOrCreateDepositAddress, deriveDepositKeypair } = await import('./custody/wallet.ts');
const { scanDeposits, creditDeposit } = await import('./custody/deposits.ts');
const { getUserBalances } = await import('./faucet.ts');
const { getOrCreateSystemAccount, getBalance } = await import('./ledger.ts');
const { reconcile } = await import('./reconcile.ts');

await initDb();
const db = await getDb();

async function newUser(): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO users(id, solana_pubkey) VALUES($1, $2)`, [id, 'pk-' + id.slice(0, 8)]);
  return id;
}

/** In-memory DepositChain: inbound transfers + simulated deposit-wallet balances + a sweep log. */
function fakeChain() {
  const chain = {
    inbound: new Map<string, { sig: string; amountE6: bigint }[]>(),
    balances: new Map<string, bigint>(),
    sweeps: [] as { from: string; amountE6: bigint }[],
    failSweeps: false,
    /** queue an inbound transfer + land the funds on the simulated deposit wallet */
    deposit(address: string, sig: string, amountE6: bigint) {
      chain.inbound.set(address, [...(chain.inbound.get(address) ?? []), { sig, amountE6 }]);
      chain.balances.set(address, (chain.balances.get(address) ?? 0n) + amountE6);
    },
    async inboundUsdc(address: string): Promise<{ sig: string; amountE6: bigint }[]> {
      return chain.inbound.get(address) ?? [];
    },
    async sweepAll(from: Keypair): Promise<{ sig: string; amountE6: bigint } | null> {
      if (chain.failSweeps) throw new Error('simulated RPC outage');
      const addr = from.publicKey.toBase58();
      const bal = chain.balances.get(addr) ?? 0n;
      if (bal <= 0n) return null;
      chain.balances.set(addr, 0n);
      chain.sweeps.push({ from: addr, amountE6: bal });
      return { sig: `sweep-${chain.sweeps.length}`, amountE6: bal };
    },
  };
  return chain;
}

test('deposit addresses are stable per user, unique across users, and re-derivable', async () => {
  const u1 = await newUser();
  const u2 = await newUser();

  const a1 = await getOrCreateDepositAddress(db, u1);
  const a1again = await getOrCreateDepositAddress(db, u1);
  const a2 = await getOrCreateDepositAddress(db, u2);

  assert.equal(a1.address, a1again.address); // idempotent per user
  assert.equal(a1.derivationIndex, a1again.derivationIndex);
  assert.notEqual(a1.address, a2.address); // distinct users, distinct addresses
  assert.notEqual(a1.derivationIndex, a2.derivationIndex);
  // the stored address is exactly what the HD path re-derives (sweeps depend on this)
  assert.equal(deriveDepositKeypair(a1.derivationIndex).publicKey.toBase58(), a1.address);
});

test('deposit lifecycle credits the FULL amount — even above the play-money cap — and sweeps', async () => {
  const u = await newUser();
  const addr = await getOrCreateDepositAddress(db, u);
  const chain = fakeChain();

  // $2.5M — far above creditCapped's $1M play cap; real money must never clamp
  const amount = 2_500_000n * 1_000_000n;
  chain.deposit(addr.address, 'sig-big-1', amount);

  const r = await scanDeposits(db, chain);
  assert.equal(r.credited, 1);

  const bal = await getUserBalances(db, u);
  assert.equal(bal.availableUusdc, amount); // full credit, no clamp

  // treasury mirror carries the matching liability leg
  const treasury = await db.tx((q) => getOrCreateSystemAccount(q, 'TREASURY_USDC'));
  assert.equal(await getBalance(db, treasury), -amount);

  const row = (
    await db.query<{ status: string; sweep_sig: string; usdc_credited_e6: string; txn_id: string }>(
      `SELECT status, sweep_sig, usdc_credited_e6::text AS usdc_credited_e6, txn_id FROM deposits WHERE onchain_sig = 'sig-big-1'`,
    )
  ).rows[0];
  assert.equal(row.status, 'credited');
  assert.ok(row.sweep_sig, 'sweep recorded');
  assert.equal(row.usdc_credited_e6, amount.toString());
  assert.ok(row.txn_id, 'ledger txn recorded');

  // the sweep moved the full balance out of the user's derived deposit wallet
  assert.deepEqual(chain.sweeps, [{ from: addr.address, amountE6: amount }]);

  assert.equal((await reconcile(db)).ok, true);
});

test('crediting is idempotent across re-scans and direct retries; new sigs still credit', async () => {
  const u = await newUser();
  const addr = await getOrCreateDepositAddress(db, u);
  const chain = fakeChain();
  const amount = 100n * 1_000_000n;
  chain.deposit(addr.address, 'sig-a', amount);

  assert.equal((await scanDeposits(db, chain)).credited, 1);
  // the fake still reports the same inbound transfer — a re-scan must not double-credit
  assert.equal((await scanDeposits(db, chain)).credited, 0);
  assert.equal((await getUserBalances(db, u)).availableUusdc, amount);
  assert.equal(chain.sweeps.length, 1); // balance is empty — nothing more to sweep

  // direct retry of an already-credited deposit is a no-op
  const dep = (await db.query<{ id: string }>(`SELECT id FROM deposits WHERE onchain_sig = 'sig-a'`)).rows[0];
  assert.equal(await creditDeposit(db, dep.id), null);
  assert.equal((await getUserBalances(db, u)).availableUusdc, amount);

  // a genuinely new transfer to the same address still credits
  chain.deposit(addr.address, 'sig-b', amount);
  assert.equal((await scanDeposits(db, chain)).credited, 1);
  assert.equal((await getUserBalances(db, u)).availableUusdc, amount * 2n);

  assert.equal((await reconcile(db)).ok, true);
});

test('a sweep failure never blocks or strands the credit; the sweep self-heals next pass', async () => {
  const u = await newUser();
  const addr = await getOrCreateDepositAddress(db, u);
  const chain = fakeChain();
  const amount = 50n * 1_000_000n;
  chain.deposit(addr.address, 'sig-outage', amount);

  chain.failSweeps = true;
  assert.equal((await scanDeposits(db, chain)).credited, 1); // credited despite the sweep outage
  assert.equal((await getUserBalances(db, u)).availableUusdc, amount);
  let row = (await db.query<{ sweep_sig: string | null }>(`SELECT sweep_sig FROM deposits WHERE onchain_sig = 'sig-outage'`)).rows[0];
  assert.equal(row.sweep_sig, null); // not swept yet

  chain.failSweeps = false;
  assert.equal((await scanDeposits(db, chain)).credited, 0); // no double credit
  row = (await db.query<{ sweep_sig: string | null }>(`SELECT sweep_sig FROM deposits WHERE onchain_sig = 'sig-outage'`)).rows[0];
  assert.ok(row.sweep_sig, 'sweep retried and recorded');
  assert.equal((await getUserBalances(db, u)).availableUusdc, amount); // unchanged

  assert.equal((await reconcile(db)).ok, true);
});

test('dust below the minimum deposit is ignored', async () => {
  const u = await newUser();
  const addr = await getOrCreateDepositAddress(db, u);
  const chain = fakeChain();
  chain.deposit(addr.address, 'sig-dust', 500_000n); // $0.50 < $1 min

  assert.equal((await scanDeposits(db, chain)).credited, 0);
  assert.equal((await getUserBalances(db, u)).availableUusdc, 0n);
  const rows = await db.query(`SELECT id FROM deposits WHERE onchain_sig = 'sig-dust'`);
  assert.equal(rows.rows.length, 0); // not even recorded
});

after(async () => {
  await closeDb();
});
