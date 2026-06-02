import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { ingest } = await import('./oracle.ts');
const { listMarketsWithData, getCandles, getMarketDetails } = await import('./markets.ts');
const { reconcile } = await import('./reconcile.ts');

await initDb();
const db = await getDb();

const card = (id: string, name: string, number: string, price: number) => ({
  id,
  name,
  number,
  images: { small: `img/${id}` },
  tcgplayer: { prices: { holofoil: { market: price } } },
});

const cards = [
  card('sv-1', 'Charizard ex', '223', 1200),
  card('base1-4', 'Charizard', '4', 500),
  card('base1-2', 'Blastoise', '2', 300),
  card('jungle-60', 'Pikachu', '60', 50),
  card('nodata', 'NoPrice', '1', 0), // filtered out (price 0)
];

test('ingest seeds card markets, indices, oracle prints and marks', async () => {
  const r = await ingest(db, async () => cards);
  assert.equal(r.cards, 4); // the $0 card is excluded
  assert.equal(r.indices, 2); // top-100 + top-250 (graded/sealed are gated)

  const markets = await listMarketsWithData(db);
  // 4 cards + 4 index markets (top-100, top-250, graded, sealed)
  assert.equal(markets.length, 8);

  const chari = markets.find((m) => m.symbol === 'sv-1')!;
  assert.equal(chari.kind, 'card');
  assert.equal(Number(chari.markE6) / 1_000_000, 1200); // mark == index when skew = 0

  const top100 = markets.find((m) => m.indexSlug === 'top-100')!;
  assert.equal(top100.tradeable, true);
  assert.ok(top100.markE6 && Number(top100.markE6) / 1_000_000 > 1000, 'index value near base 1000');

  const graded = markets.find((m) => m.indexSlug === 'graded')!;
  assert.equal(graded.tradeable, false);
  assert.equal(graded.markE6, null); // gated: listed, no price/mark
});

test('candles endpoint returns a populated, deterministic series', async () => {
  const markets = await listMarketsWithData(db);
  const chari = markets.find((m) => m.symbol === 'sv-1')!;
  const a = await getCandles(db, chari.id, 30);
  const b = await getCandles(db, chari.id, 30);
  assert.ok(a.length >= 20);
  assert.deepEqual(a, b, 'series is deterministic across calls');
  assert.equal(a[a.length - 1].value, 1200); // ends at current mark
});

test('outlier guard rejects an implausible price jump', async () => {
  const spiked = cards.map((c) => (c.id === 'sv-1' ? card('sv-1', 'Charizard ex', '223', 99_999) : c));
  await ingest(db, async () => spiked);
  const markets = await listMarketsWithData(db);
  const chari = markets.find((m) => m.symbol === 'sv-1')!;
  // jump was rejected -> mark unchanged
  assert.equal(Number(chari.markE6) / 1_000_000, 1200);
});

test('card metadata is stored; JustTCG graded data activates the Graded index', async () => {
  const richCards = [
    {
      id: 'g-1', name: 'Charizard', number: '4', images: { small: 's1', large: 'l1' },
      set: { name: 'Base Set', images: { logo: 'logo1' } }, hp: '120', retreatCost: ['C', 'C'],
      attacks: [{ name: 'Fire Spin', damage: '100' }],
      tcgplayer: { productId: 111, prices: { holofoil: { market: 1000 } } },
    },
    {
      id: 'g-2', name: 'Blastoise', number: '2', images: { small: 's2', large: 'l2' },
      set: { name: 'Base Set', images: { logo: 'logo1' } }, hp: '100', retreatCost: ['C'],
      attacks: [{ name: 'Hydro Pump', damage: '60' }],
      tcgplayer: { productId: 222, prices: { holofoil: { market: 500 } } },
    },
  ];
  const mockGraded = async (card: any) => (card.id === 'g-1' ? 5000 : 2000); // PSA-10 prices
  const r = await ingest(db, async () => richCards, mockGraded);
  assert.equal(r.graded, 2);

  const markets = await listMarketsWithData(db);
  const chari = markets.find((m) => m.symbol === 'g-1')!;
  assert.equal(chari.setLogo, 'logo1');

  const details = (await getMarketDetails(db, chari.id))!;
  const meta = details.metadata as { hp: string; retreat: number; attacks: { name: string }[] };
  assert.equal(meta.hp, '120');
  assert.equal(meta.retreat, 2);
  assert.equal(meta.attacks[0].name, 'Fire Spin');
  assert.equal(details.gradedPsa10E6, (5000n * 1_000_000n).toString());

  const graded = markets.find((m) => m.indexSlug === 'graded')!;
  assert.equal(graded.tradeable, true);
  assert.ok(graded.markE6 && Number(graded.markE6) > 0, 'Graded index now has a mark');
});

test('ledger still reconciles (oracle never touches money)', async () => {
  const report = await reconcile(db);
  assert.equal(report.ok, true, JSON.stringify(report, null, 2));
});

after(async () => {
  await closeDb();
});
