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

const LAMPORTS_PER_SOL = 1_000_000_000n;
const FEE_RESERVE = 10_000_000n; // mirrors SOL_FEE_RESERVE_LAMPORTS in deposits.ts
const FAKE_RATE_E6_PER_SOL = 150_000_000n; // $150/SOL in the fake chain

async function newUser(): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO users(id, solana_pubkey) VALUES($1, $2)`, [id, 'pk-' + id.slice(0, 8)]);
  return id;
}

/** In-memory DepositChain: USDC + SOL inbound queues, simulated balances, swap + sweep logs. */
function fakeChain() {
  const chain = {
    inbound: new Map<string, { sig: string; amountE6: bigint }[]>(),
    inboundSolQ: new Map<string, { sig: string; lamports: bigint }[]>(),
    balances: new Map<string, bigint>(), // USDC on the deposit wallet
    solBalances: new Map<string, bigint>(),
    sweeps: [] as { from: string; amountE6: bigint }[],
    swaps: [] as { from: string; lamports: bigint }[],
    failSweeps: false,
    /** queue an inbound USDC transfer + land the funds on the simulated deposit wallet */
    deposit(address: string, sig: string, amountE6: bigint) {
      chain.inbound.set(address, [...(chain.inbound.get(address) ?? []), { sig, amountE6 }]);
      chain.balances.set(address, (chain.balances.get(address) ?? 0n) + amountE6);
    },
    /** queue an inbound SOL transfer + land the lamports on the simulated deposit wallet */
    depositSol(address: string, sig: string, lamports: bigint) {
      chain.inboundSolQ.set(address, [...(chain.inboundSolQ.get(address) ?? []), { sig, lamports }]);
      chain.solBalances.set(address, (chain.solBalances.get(address) ?? 0n) + lamports);
    },
    async inboundUsdc(address: string): Promise<{ sig: string; amountE6: bigint }[]> {
      return chain.inbound.get(address) ?? [];
    },
    async inboundSol(address: string): Promise<{ sig: string; lamports: bigint }[]> {
      return chain.inboundSolQ.get(address) ?? [];
    },
    async solBalance(address: string): Promise<bigint> {
      return chain.solBalances.get(address) ?? 0n;
    },
    async swapSolToUsdc(from: Keypair, lamports: bigint): Promise<string> {
      const addr = from.publicKey.toBase58();
      const bal = chain.solBalances.get(addr) ?? 0n;
      if (lamports > bal) throw new Error('insufficient SOL');
      chain.solBalances.set(addr, bal - lamports);
      chain.swaps.push({ from: addr, lamports });
      const sig = `swap-${chain.swaps.length}-${addr.slice(0, 6)}`;
      // proceeds land on the wallet's own USDC ATA — visible as a new inbound USDC delta
      const proceedsE6 = (lamports * FAKE_RATE_E6_PER_SOL) / LAMPORTS_PER_SOL;
      chain.deposit(addr, sig, proceedsE6);
      return sig;
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
  // the stored address is exactly what the HD path re-derives (sweeps/swaps depend on this)
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

test('SOL deposits swap in place and credit the ACTUAL proceeds — never the SOL row itself', async () => {
  const u = await newUser();
  const addr = await getOrCreateDepositAddress(db, u);
  const chain = fakeChain();
  chain.depositSol(addr.address, 'sig-sol-1', LAMPORTS_PER_SOL); // 1 SOL

  // pass 1: detect + swap (fee reserve held back); proceeds are a new USDC delta, credited next pass
  assert.equal((await scanDeposits(db, chain)).credited, 0);
  assert.deepEqual(chain.swaps, [{ from: addr.address, lamports: LAMPORTS_PER_SOL - FEE_RESERVE }]);
  const solRow = (
    await db.query<{ status: string; swap_sig: string | null; usdc_credited_e6: string | null; txn_id: string | null }>(
      `SELECT status, swap_sig, usdc_credited_e6::text AS usdc_credited_e6, txn_id FROM deposits WHERE onchain_sig = 'sig-sol-1' AND asset = 'SOL'`,
    )
  ).rows[0];
  assert.equal(solRow.status, 'swapped');
  assert.ok(solRow.swap_sig, 'swap recorded');
  assert.equal(solRow.usdc_credited_e6, null); // SOL rows never credit
  assert.equal(solRow.txn_id, null);

  // pass 2: the swap's USDC proceeds are detected (sig = the swap tx), credited in full, swept
  assert.equal((await scanDeposits(db, chain)).credited, 1);
  const expected = ((LAMPORTS_PER_SOL - FEE_RESERVE) * FAKE_RATE_E6_PER_SOL) / LAMPORTS_PER_SOL;
  assert.equal((await getUserBalances(db, u)).availableUusdc, expected);
  const usdcRow = (
    await db.query<{ status: string }>(`SELECT status FROM deposits WHERE onchain_sig = $1 AND asset = 'USDC'`, [solRow.swap_sig])
  ).rows[0];
  assert.equal(usdcRow.status, 'credited');

  // steady state: nothing further credits or swaps
  assert.equal((await scanDeposits(db, chain)).credited, 0);
  assert.equal(chain.swaps.length, 1);
  assert.equal((await reconcile(db)).ok, true);
});

test('an unrecorded swap cannot strand or double-credit: proceeds credit via the USDC path', async () => {
  const u = await newUser();
  const addr = await getOrCreateDepositAddress(db, u);
  const chain = fakeChain();

  // Simulate a crash after a swap was broadcast but before the SOL row was updated:
  // history shows the SOL inbound, the wallet only holds sub-reserve residue, and the swap's
  // proceeds already sit on the wallet as a USDC delta.
  chain.inboundSolQ.set(addr.address, [{ sig: 'sig-sol-lost', lamports: 500_000_000n }]);
  chain.solBalances.set(addr.address, 5_000_000n); // below the fee reserve — nothing swappable
  chain.deposit(addr.address, 'swap-lost', 74_000_000n); // the unrecorded swap's $74 proceeds

  const r = await scanDeposits(db, chain);
  assert.equal(r.credited, 1); // proceeds credited exactly once
  assert.equal((await getUserBalances(db, u)).availableUusdc, 74_000_000n);
  const solRow = (
    await db.query<{ status: string; txn_id: string | null }>(
      `SELECT status, txn_id FROM deposits WHERE onchain_sig = 'sig-sol-lost' AND asset = 'SOL'`,
    )
  ).rows[0];
  assert.equal(solRow.status, 'swapped'); // closed out without a second swap
  assert.equal(solRow.txn_id, null);
  assert.equal(chain.swaps.length, 0); // no swap was attempted on the residue

  assert.equal((await scanDeposits(db, chain)).credited, 0);
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
