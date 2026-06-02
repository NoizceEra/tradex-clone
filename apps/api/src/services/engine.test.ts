import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { ingest } = await import('./oracle.ts');
const { listMarketsWithData } = await import('./markets.ts');
const { creditFaucet, getUserBalances } = await import('./faucet.ts');
const { openPosition, closePosition, getUserPositions } = await import('./engine.ts');
const { reconcile } = await import('./reconcile.ts');
const { usdc } = await import('../money.ts');

await initDb();
const db = await getDb();

// one card market priced at $1000
await ingest(db, async () => [
  { id: 'card-x', name: 'Test', number: '1', images: { small: 'x' }, tcgplayer: { prices: { holofoil: { market: 1000 } } } },
]);
const markets = await listMarketsWithData(db);
const market = markets.find((m) => m.symbol === 'card-x')!;

async function newUser(): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO users(id, solana_pubkey) VALUES($1, $2)`, [id, 'pk-' + id.slice(0, 8)]);
  await creditFaucet(db, id, 10_000);
  return id;
}
async function closeAll(userId: string): Promise<void> {
  for (const p of await getUserPositions(db, userId)) {
    await closePosition(db, userId, { positionId: p.id, fractionBps: 10_000, idempotencyKey: randomUUID() });
  }
}
const U = (n: number) => usdc(n).toString();

// The mark reflects market-wide skew, so each test closes its positions to reset OI to 0.

test('open a 10x long locks the right margin and computes the liq price', async () => {
  const userId = await newUser();
  await openPosition(db, userId, { marketId: market.id, side: 'long', qtyE6: 5_000_000n, leverage: 10, idempotencyKey: randomUUID() });

  const b = await getUserBalances(db, userId);
  assert.equal(b.availableUusdc.toString(), U(9_500)); // $5000 notional / 10x = $500 margin
  assert.equal(b.lockedMarginUusdc.toString(), U(500));

  const [pos] = await getUserPositions(db, userId);
  assert.equal(pos.avgEntryE6, (1000n * 1_000_000n).toString());
  assert.equal(pos.liqPriceE6, (925n * 1_000_000n).toString()); // 1000 * (1 - 0.1 + 0.025)

  await closeAll(userId);
});

test('closing a profitable long pays out from the LP pool and conserves value', async () => {
  const userId = await newUser();
  await openPosition(db, userId, { marketId: market.id, side: 'long', qtyE6: 5_000_000n, leverage: 10, idempotencyKey: randomUUID() });
  const [pos] = await getUserPositions(db, userId);
  assert.equal(pos.markE6, (1005n * 1_000_000n).toString()); // own long skew lifts the mark 0.5%

  const close = await closePosition(db, userId, { positionId: pos.id, fractionBps: 10_000, idempotencyKey: randomUUID() });
  assert.equal(close.realizedPnlUusdc, U(25)); // 5 units * ($1005 - $1000)

  const b = await getUserBalances(db, userId);
  assert.equal(b.availableUusdc.toString(), U(10_025));
  assert.equal(b.lockedMarginUusdc.toString(), U(0));
  assert.equal((await getUserPositions(db, userId)).length, 0);
});

test('increasing a position volume-weights the entry', async () => {
  const userId = await newUser();
  await openPosition(db, userId, { marketId: market.id, side: 'long', qtyE6: 5_000_000n, leverage: 10, idempotencyKey: randomUUID() });
  await openPosition(db, userId, { marketId: market.id, side: 'long', qtyE6: 5_000_000n, leverage: 10, idempotencyKey: randomUUID() });
  const [pos] = await getUserPositions(db, userId);
  assert.equal(pos.qtyE6, (10_000_000n).toString());
  assert.equal(pos.avgEntryE6, (1_002_500_000n).toString()); // (5*1000 + 5*1005) / 10 = 1002.5
  await closeAll(userId);
});

test('leverage over the cap and oversized orders are rejected', async () => {
  const userId = await newUser();
  await assert.rejects(
    openPosition(db, userId, { marketId: market.id, side: 'long', qtyE6: 5_000_000n, leverage: 50, idempotencyKey: randomUUID() }),
    /leverage/,
  );
  await assert.rejects(
    openPosition(db, userId, { marketId: market.id, side: 'long', qtyE6: 10_000_000_000n, leverage: 1, idempotencyKey: randomUUID() }),
    /insufficient/,
  );
});

test('order idempotency key prevents double execution', async () => {
  const userId = await newUser();
  const key = randomUUID();
  const a = await openPosition(db, userId, { marketId: market.id, side: 'long', qtyE6: 5_000_000n, leverage: 10, idempotencyKey: key });
  const b = await openPosition(db, userId, { marketId: market.id, side: 'long', qtyE6: 5_000_000n, leverage: 10, idempotencyKey: key });
  assert.equal(b.duplicate, true);
  assert.equal(a.positionId, b.positionId);
  assert.equal((await getUserPositions(db, userId))[0].qtyE6, (5_000_000n).toString());
  await closeAll(userId);
});

test('reconciler stays balanced after all trading activity', async () => {
  const report = await reconcile(db);
  assert.equal(report.ok, true, JSON.stringify(report, null, 2));
});

after(async () => {
  await closeDb();
});
