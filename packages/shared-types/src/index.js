/**
 * @pokex/shared-types — zod schemas + constants shared by the web app and the api.
 *
 * Money/price fields that cross the wire are encoded as DECIMAL STRINGS of their
 * micro-unit BigInt (e.g. "535220000"), because JSON has no BigInt. The api encodes
 * BigInt -> string; the web app parses string -> BigInt for @pokex/pricing math.
 */
import { z } from 'zod';

// --- enums / constants ------------------------------------------------------

export const MARKET_KINDS = ['card', 'index'];
export const GAMES = ['pokemon', 'onepiece', 'mtg']; // raw prices via scrydex (Pokémon live; OP/MTG pending)
export const SIDES = ['long', 'short'];
export const ORDER_KINDS = ['market', 'reduce_only'];
export const MARKET_STATUS = ['active', 'reduce_only', 'halted', 'delisted'];

export const INDEX_SLUGS = ['top-250', 'top-100', 'graded', 'sealed'];

/** Per-game index catalogue. `tradeable:false` = data source pending (shown but gated). Pokémon is
 * computed live from the ingest; One Piece + MTG are listed but gated until scrydex card data lands. */
export const INDEX_CATALOG = [
  { game: 'pokemon', slug: 'top-100', name: 'Top 100', tracks: 'Top 100 cards by market price', tradeable: true, topN: 100 },
  { game: 'pokemon', slug: 'top-250', name: 'Top 250', tracks: 'Top 250 cards by market price', tradeable: true, topN: 250 },
  { game: 'pokemon', slug: 'graded', name: 'Graded (PSA 10)', tracks: 'PSA 10 graded cards', tradeable: false, topN: null },
  { game: 'pokemon', slug: 'sealed', name: 'Sealed', tracks: 'Sealed product', tradeable: false, topN: null },
  { game: 'onepiece', slug: 'top-100', name: 'Top 100', tracks: 'Top 100 cards by market price', tradeable: false, topN: 100 },
  { game: 'onepiece', slug: 'top-250', name: 'Top 250', tracks: 'Top 250 cards by market price', tradeable: false, topN: 250 },
  { game: 'mtg', slug: 'top-100', name: 'Top 100', tracks: 'Top 100 cards by market price', tradeable: false, topN: 100 },
  { game: 'mtg', slug: 'top-250', name: 'Top 250', tracks: 'Top 250 cards by market price', tradeable: false, topN: 250 },
];

export const MAX_LEVERAGE = 20;

// A BigInt-as-decimal-string field (micro-units over the wire).
export const MicroStr = z.string().regex(/^-?\d+$/, 'expected an integer micro-unit string');

// --- entities ---------------------------------------------------------------

export const MarketSchema = z.object({
  id: z.string(),
  kind: z.enum(MARKET_KINDS),
  game: z.enum(GAMES),
  symbol: z.string(),
  displayName: z.string(),
  cardId: z.string().nullable().optional(),
  variant: z.string().nullable().optional(),
  indexSlug: z.enum(INDEX_SLUGS).nullable().optional(),
  imageSmall: z.string().nullable().optional(),
  status: z.enum(MARKET_STATUS),
  tradeable: z.boolean(),
  maxLeverage: z.number().int().positive().max(MAX_LEVERAGE),
  maintMarginBps: z.number().int().positive(),
  // latest market data (micro-unit strings)
  markE6: MicroStr.optional(),
  indexE6: MicroStr.optional(),
  change24hPct: z.number().optional(),
});
export const MarketsResponse = z.array(MarketSchema);

export const PositionSchema = z.object({
  id: z.string(),
  marketId: z.string(),
  symbol: z.string(),
  side: z.enum(SIDES),
  qtyE6: MicroStr,
  avgEntryE6: MicroStr,
  marginUusdc: MicroStr,
  leverage: z.number().positive(),
  liqPriceE6: MicroStr,
  markE6: MicroStr,
  unrealizedPnlUusdc: MicroStr,
  status: z.enum(['open', 'closed', 'liquidated']),
});

export const BalanceSchema = z.object({
  availableUusdc: MicroStr,
  lockedMarginUusdc: MicroStr,
  equityUusdc: MicroStr,
});

// --- requests ----------------------------------------------------------------

export const OrderRequest = z.object({
  marketId: z.string(),
  side: z.enum(SIDES),
  // quantity in synthetic units, micro-string (e.g. "1500000" = 1.5 units)
  qtyE6: MicroStr,
  leverage: z.number().int().positive().max(MAX_LEVERAGE),
  kind: z.enum(ORDER_KINDS).default('market'),
  idempotencyKey: z.string().min(8),
});

export const ClosePositionRequest = z.object({
  positionId: z.string(),
  // fraction to close in bps (10000 = full close). default full.
  fractionBps: z.number().int().positive().max(10_000).default(10_000),
  idempotencyKey: z.string().min(8),
});

export const FaucetRequest = z.object({
  amountUsd: z.number().positive().max(100_000).default(10_000),
});

// --- social (referrals) ------------------------------------------------------

export const ReferralRedeemRequest = z.object({
  code: z.string().trim().min(4).max(32),
});

export const ReferralCodeRequest = z.object({
  code: z.string().trim().min(4).max(20), // server normalizes + validates charset
});

export const ChatPostRequest = z.object({
  body: z.string().trim().min(1).max(280),
  replyTo: z.string().min(1).optional(), // parent message id when replying
});

export const UsernameRequest = z.object({
  username: z.string().trim().min(3).max(20).regex(/^[A-Za-z0-9_-]+$/, 'letters, numbers, _ and - only'),
});

// --- auth (SIWS) -------------------------------------------------------------

export const NonceRequest = z.object({ pubkey: z.string().min(32) });
export const NonceResponse = z.object({ message: z.string(), nonce: z.string() });
export const VerifyRequest = z.object({
  pubkey: z.string().min(32),
  message: z.string(),
  signature: z.string(), // base58
});

// --- websocket protocol ------------------------------------------------------

export const WS_PUBLIC_CHANNELS = ['mark', 'stats', 'oi', 'funding']; // channel:{marketId}
export const WS_PRIVATE_CHANNELS = ['positions', 'orders', 'balance', 'liquidations', 'lp'];

export const WsClientMsg = z.discriminatedUnion('op', [
  z.object({ op: z.literal('sub'), channels: z.array(z.string()) }),
  z.object({ op: z.literal('unsub'), channels: z.array(z.string()) }),
  z.object({ op: z.literal('auth'), token: z.string() }),
  z.object({ op: z.literal('ping') }),
]);

/** Server push envelope: { ch, type, seq, data }. */
export const WsServerMsg = z.object({
  ch: z.string(),
  type: z.string(),
  seq: z.number().int().nonnegative(),
  data: z.unknown(),
});
