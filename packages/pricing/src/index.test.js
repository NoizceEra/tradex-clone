import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getCardPrice,
  notional,
  initialMargin,
  maintenanceMargin,
  fee,
  unrealizedPnl,
  liquidationPrice,
  syntheticMark,
  toE6,
  formatSignedUsd,
  shortenPubkey,
} from './index.js';

const E6 = 1_000_000n;
const usd = (n) => BigInt(Math.round(n * 1_000_000));

test('getCardPrice falls back across tcgplayer variants', () => {
  assert.equal(getCardPrice({ tcgplayer: { prices: { holofoil: { market: 12.5 } } } }), 12.5);
  assert.equal(getCardPrice({ tcgplayer: { prices: { normal: { market: 3 } } } }), 3);
  assert.equal(getCardPrice(null), 0);
  assert.equal(getCardPrice({}), 0);
});

test('notional / margin / fee are exact', () => {
  const n = notional(5n * E6, usd(1000)); // 5 units @ $1000
  assert.equal(n, usd(5000));
  assert.equal(initialMargin(n, 2000), usd(250)); // 20x
  assert.equal(maintenanceMargin(n, 250), usd(125)); // 2.5%
  assert.equal(fee(n, 10), usd(5)); // 0.1%
});

test('unrealized PnL is sign-correct and long/short symmetric', () => {
  const long = unrealizedPnl('long', 5n * E6, usd(1000), usd(1100));
  const short = unrealizedPnl('short', 5n * E6, usd(1000), usd(1100));
  assert.equal(long, usd(500));
  assert.equal(short, usd(-500));
  assert.equal(long, -short);
});

test('liquidation price: long below entry, short above, higher leverage is tighter', () => {
  const args = { entryE6: usd(1000), maintMarginBps: 250 };
  const long10 = liquidationPrice({ ...args, side: 'long', leverageE2: 1000 });
  const long20 = liquidationPrice({ ...args, side: 'long', leverageE2: 2000 });
  const short10 = liquidationPrice({ ...args, side: 'short', leverageE2: 1000 });
  assert.equal(long10, usd(925)); // 1000*(1-0.1+0.025)
  assert.equal(long20, usd(975)); // 1000*(1-0.05+0.025)
  assert.ok(long20 > long10, '20x liquidates closer to entry');
  assert.equal(short10, usd(1075));
});

test('synthetic mark: anchored at zero skew, bounded by premium cap and max deviation', () => {
  const base = { indexE6: usd(1000), depthUusdc: usd(1_000_000), kE6: 1_000_000n, premiumCapE6: 100_000n, maxDevBps: 1500 };

  const flat = syntheticMark({ ...base, skewUusdc: 0n });
  assert.equal(flat.markE6, usd(1000));
  assert.equal(flat.premiumE6, 0n);

  // skew = 0.5% of depth -> +0.5% premium
  const small = syntheticMark({ ...base, skewUusdc: usd(5000) });
  assert.equal(small.premiumE6, 5000n); // 0.005
  assert.equal(small.markE6, usd(1005));

  // enormous skew -> premium hits the 10% cap (still inside the 15% anchor clamp)
  const capped = syntheticMark({ ...base, skewUusdc: usd(10_000_000) });
  assert.equal(capped.premiumE6, 100_000n); // capped at 10%
  assert.equal(capped.markE6, usd(1100));

  // if the cap exceeds max deviation, the anchor clamp wins
  const clamped = syntheticMark({ ...base, premiumCapE6: 500_000n, skewUusdc: usd(10_000_000) });
  assert.equal(clamped.markE6, usd(1150)); // index * (1 + 0.15)
});

test('toE6 rounds to micro-units', () => {
  assert.equal(toE6(1.23), 1_230_000n);
  assert.equal(toE6(0), 0n);
});

test('shortenPubkey truncates long ids and passes through short/empty', () => {
  assert.equal(shortenPubkey('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'), '7xKX…gAsU');
  assert.equal(shortenPubkey('short'), 'short');
  assert.equal(shortenPubkey(''), '');
  assert.equal(shortenPubkey(null), '');
});

test('formatSignedUsd signs both directions and handles strings/zero', () => {
  assert.equal(formatSignedUsd(1_230_000n), '+$1.23');
  assert.equal(formatSignedUsd(-5_000_000n), '-$5.00');
  assert.equal(formatSignedUsd('0'), '+$0.00');
  assert.equal(formatSignedUsd(null), '+$0.00');
});
