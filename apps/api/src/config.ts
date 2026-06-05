import 'dotenv/config';

/**
 * Central runtime config. Everything secret lives here and is read from the
 * environment — never hardcoded, never shipped to the browser. (The old SPA
 * leaked a pokemontcg.io key in client code; the api owns it now.)
 */
function num(name: string, fallback: number): number {
  const v = process.env[name];
  return v ? Number(v) : fallback;
}

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: num('PORT', 4000),
  host: process.env.HOST ?? '0.0.0.0',

  // CORS: the Vercel-hosted web origin(s) allowed to call this api.
  webOrigins: (process.env.WEB_ORIGINS ?? 'http://localhost:5173,http://localhost:4173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // Database. Empty => use embedded PGlite (local dev, zero deps).
  // In prod set DATABASE_URL to a managed Postgres (Neon/Supabase).
  databaseUrl: process.env.DATABASE_URL ?? '',
  pgliteDir: process.env.PGLITE_DIR ?? './.pglite',

  // Auth
  jwtSecret: process.env.JWT_SECRET ?? 'dev-insecure-secret-change-me',
  accessTtlSec: num('ACCESS_TTL_SEC', 15 * 60),
  refreshTtlSec: num('REFRESH_TTL_SEC', 7 * 24 * 60 * 60),
  authDomain: process.env.AUTH_DOMAIN ?? 'localhost',

  // Price source (server-side only)
  pokemontcgApiKey: process.env.POKEMONTCG_API_KEY ?? '', // optional; keyless works
  pokemontcgBase: 'https://api.pokemontcg.io/v2',
  oracleRefreshMs: num('ORACLE_REFRESH_MS', 6 * 60 * 60 * 1000), // 6h; source updates ~daily
  oraclePageSize: num('ORACLE_PAGE_SIZE', 250), // pokemontcg.io v2 caps pageSize at 250 (clamps silently); >250 is a no-op

  // JustTCG graded (PSA-10) pricing — server-side, optional. When set, the Graded index
  // becomes tradeable; without it, Graded stays gated.
  justtcgApiKey: process.env.JUSTTCG_API_KEY ?? '',
  justtcgBase: process.env.JUSTTCG_BASE ?? 'https://api.justtcg.com',
  gradedConstituents: num('GRADED_CONSTITUENTS', 100), // top-N cards for the Graded index

  // Money / safety
  realFunds: process.env.REAL_FUNDS === 'true', // hard gate; MVP must be false
  faucetDefaultUsd: num('FAUCET_DEFAULT_USD', 10_000),
  referralBonusUsd: num('REFERRAL_BONUS_USD', 1_000), // play-USDC bonus per redeemed referral (both parties); 0 disables
  maxReferralsPaid: num('MAX_REFERRALS_PAID', 50), // referrer is only paid a bonus for their first N referrals (anti-farming)

  // Trading commission (basis points of notional; 10 bps = 0.10%). Default 0 = no fee for now;
  // set OPEN_FEE_BPS / CLOSE_FEE_BPS to charge a commission (shown as "Commission" in tx history).
  openFeeBps: num('OPEN_FEE_BPS', 0),
  closeFeeBps: num('CLOSE_FEE_BPS', 0),
  feeLpSharePct: num('FEE_LP_SHARE_PCT', 50), // % of fees that go to LPs (rest to platform revenue)

  // Funding: per-accrual rate = skewFactor * (skew / openInterest), bps (the heavy side pays)
  fundingSkewFactorBps: num('FUNDING_SKEW_FACTOR_BPS', 30), // skew-balancing component (max)
  fundingIntervalMs: num('FUNDING_INTERVAL_MS', 60 * 60 * 1000), // hourly

  // Liquidations + circuit breakers
  liqFeeBps: num('LIQ_FEE_BPS', 100), // 1% liquidation penalty -> insurance fund
  liquidationSweepMs: num('LIQUIDATION_SWEEP_MS', 5_000),
  oracleStaleMs: num('ORACLE_STALE_MS', 36 * 60 * 60 * 1000), // halt a market if no fresh print

  // --- Real-funds custody (P0 scaffolding; unused until the REAL_FUNDS paths land) ---
  // See docs/real-funds-custody-plan.md. Env-only; keys/seeds are never hardcoded — the HD master
  // seed lives in KMS and only its reference is configured here.
  solanaRpcUrl: process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com',
  usdcMint: process.env.USDC_MINT ?? '', // per-network SPL mint
  treasuryPubkey: process.env.TREASURY_PUBKEY ?? '', // Squads multisig (cold) address
  depositSeedKmsRef: process.env.DEPOSIT_SEED_KMS_REF ?? '',
  jupiterBase: process.env.JUPITER_BASE ?? 'https://quote-api.jup.ag',
  swapSlippageBps: num('SWAP_SLIPPAGE_BPS', 100), // 1% max slippage on SOL->USDC deposit swaps
  minDepositUsd: num('MIN_DEPOSIT_USD', 1), // dust below this is ignored (uneconomic to sweep)
  minWithdrawalUsd: num('MIN_WITHDRAWAL_USD', 5),
  withdrawalDailyCapUsd: num('WITHDRAWAL_DAILY_CAP_USD', 10_000), // per-user velocity cap
  hotWalletMaxUsd: num('HOT_WALLET_MAX_USD', 25_000), // hot float cap; excess swept to cold
  depositScanMs: num('DEPOSIT_SCAN_MS', 30_000), // deposit scanner cadence
};

if (config.realFunds) {
  // Real funds (custody P1+, devnet): the deposit path needs its custody config up front.
  // Secrets stay off the config object: DEPOSIT_MASTER_SEED + HOT_WALLET_SECRET are read from
  // the environment directly by services/custody (dev/devnet) so config logging can't leak them.
  const missing = [
    !config.usdcMint && 'USDC_MINT',
    !config.treasuryPubkey && 'TREASURY_PUBKEY',
    !process.env.DEPOSIT_MASTER_SEED && !config.depositSeedKmsRef && 'DEPOSIT_MASTER_SEED (dev) or DEPOSIT_SEED_KMS_REF',
    !process.env.HOT_WALLET_SECRET && 'HOT_WALLET_SECRET',
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`REAL_FUNDS=true requires custody config; missing: ${missing.join(', ')}`);
  }
  // MAINNET stays hard-gated until audit + KYC/AML + geofence (custody P4 in
  // docs/real-funds-custody-plan.md). Devnet/testnet runs need no override.
  const MAINNET_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const mainnetish = /mainnet/i.test(config.solanaRpcUrl) || config.usdcMint === MAINNET_USDC;
  if (mainnetish && process.env.ALLOW_MAINNET_FUNDS !== 'true') {
    throw new Error(
      'REAL_FUNDS on MAINNET is gated behind the audit + KYC/AML + geofence (custody P4). Set ALLOW_MAINNET_FUNDS=true only once those gates are met.',
    );
  }
}

// Never run in production with the committed default JWT secret (would allow token forgery).
if (
  config.env === 'production' &&
  (!process.env.JWT_SECRET || config.jwtSecret === 'dev-insecure-secret-change-me' || config.jwtSecret.length < 32)
) {
  throw new Error('JWT_SECRET must be set to a strong (>= 32 char) value in production.');
}
