# PokeX

A **leveraged perpetual-futures exchange on Pokémon-card prices**, settled in USDC. Trade
perps on individual cards **and** on basket **indices** (Top 100 / Top 250, with Graded and
Sealed planned), with an index-anchored synthetic mark, a pooled-LP counterparty, funding,
and liquidations — plus a leaderboard and a referral system.

> ⚠️ **Play-money MVP.** This build runs entirely on simulated balances (a faucet) and Solana
> **devnet**. No real funds are accepted. It's a fan project built on public Pokémon-TCG price
> data (via [pokemontcg.io](https://pokemontcg.io)); it is **not** affiliated with Nintendo,
> The Pokémon Company, or TCGFish, and is **not financial advice**. Real custody, deposits, and
> withdrawals are gated behind a future security audit + legal/compliance review and are
> intentionally **not** part of this build. The `REAL_FUNDS` flag is hard-wired off — the API
> refuses to boot with `REAL_FUNDS=true`.

---

## What you can do (V1)

- **Sign in with your Solana wallet** (Sign-In-With-Solana; devnet) — no passwords, no email.
- **Faucet play USDC** into your platform balance (stands in for a real deposit).
- **Open leveraged perps**, long or short, up to **20×**, on any card market or on the Top
  100 / Top 250 index.
- **Manage positions** — partial or full close, live unrealized PnL, liquidation price.
- **Provide liquidity** to the LP pool (the counterparty to all trades) and earn fees + trader PnL.
- **Leaderboard** — traders ranked by net realized PnL (with equity + volume).
- **Referrals** — every account gets a shareable code; redeeming one pays both sides a play-USDC bonus.
- Everything is **server-authoritative** and streamed live over WebSocket; the browser is a renderer.

---

## Where the data comes from

This is the part most people ask about, so it's spelled out explicitly.

### Card prices and the live indices — one feed

There is **one** price feed: **[pokemontcg.io](https://pokemontcg.io) v2 `/cards`** (which itself
surfaces **TCGplayer** market prices). The oracle makes a single request per cycle:

```
GET https://api.pokemontcg.io/v2/cards
      ?q=supertype:Pokémon
      &orderBy=-tcgplayer.prices.holofoil.market
      &pageSize=250
```

That one response is reused two ways (`apps/api/src/services/oracle.ts`):

1. **Individual card markets** — each returned card becomes a tradeable market, priced from
   `tcgplayer.prices` (`getCardPrice` picks the best available variant).
2. **The Top 100 / Top 250 indices** — the *same* cards are sorted by price and the top-N slice
   becomes the index basket. The index value is a **divisor-based basket NAV** (S&P-style):
   `value = Σ(prices) · SCALE / divisor`, with the divisor chosen so the index starts at a base
   of 1000 and re-anchored on a constituent change so the print stays continuous.

So the indices are **not a separate API** — they're computed in-house from the exact dataset
that powers the card markets. The price *origin* is TCGplayer; pokemontcg.io is the delivery API.

> Note: pokemontcg.io v2 caps `pageSize` at 250, so the tracked universe is the ~250 highest-priced
> Pokémon cards. Top 250 ≈ that whole set; Top 100 ≈ its top 100; the card markets are that same set.

### The four indices

| Index | Source | Status in this build |
|---|---|---|
| **Top 100** | In-house basket NAV from pokemontcg.io card prices | ✅ Live |
| **Top 250** | In-house basket NAV from pokemontcg.io card prices | ✅ Live |
| **Graded (PSA 10)** | [JustTCG](https://justtcg.com) PSA-10 prices → in-house basket | 🔒 Gated — becomes tradeable only when `JUSTTCG_API_KEY` is set |
| **Sealed** | needs a sealed-product price feed (e.g. TCGplayer Sealed / PriceCharting) | 🔒 Gated — no source wired; shows "Soon" |

Graded/Sealed are **listed but not tradeable** until a real feed exists. We deliberately do **not**
scrape TCGFish: their pages and embed badges are Cloudflare bot-challenged and the badges are
rendered images, not an API, so they can't be ingested server-side. Enabling those indices for
real is a data decision (a licensed graded/sealed feed, or a TCGFish data partnership), not a hack.

### The oracle pipeline

`oracle.ts` runs on a timer (`ORACLE_REFRESH_MS`, default 6h since the source updates ~daily):

1. **Fetch** the top cards (above).
2. **Normalize** each price to integer micro-USD (`*_e6`) and drop anything with no price.
3. **Outlier guard** — reject a print that jumps > 60% from the last accepted value (manipulation /
   bad-data protection), with an escape hatch for sustained genuine moves.
4. **Record** the accepted print to `oracle_prices`, then **recompute the synthetic mark** and
   publish it on the `mark:{id}` channel.
5. **Staleness halt** — if a market gets no fresh print within `ORACLE_STALE_MS` (36h), it's halted.

---

## How trading works

- **Synthetic mark.** The tradeable price is `mark = clamp(index · (1 + premium), ±maxDev)`, where
  the `premium` comes from the LP pool's long/short skew (scaled by a per-market `k`, capped). The
  oracle/index value is a hard anchor; skew adds bounded intraday motion. Same model for cards and
  indices. (`packages/pricing/src/index.js` → `syntheticMark`.)
- **Isolated margin, up to 20×.** Each position locks its own margin; leverage is capped per market.
- **Pooled-LP counterparty.** There is no order book. Trades fill against the LP pool at the mark;
  the pool books trader PnL (LPs win when traders lose, and vice-versa).
- **Fees.** Open/close fees (default 0.10% each) split between LPs and platform fee revenue.
- **Funding.** Hourly, skew-balancing: the heavier side pays the lighter side (cumulative-index lazy
  settle). Keeps the mark tethered to the index.
- **Liquidations.** A maintenance-margin sweep runs every few seconds and after every accepted print.
  Liquidations are loss-capped at the trader's margin; a 1% penalty tops up the **insurance fund**;
  any bad debt is drawn from insurance first, then socialized across LP NAV. Every leg is a ledger entry.
- **Open-interest caps.** Per-side OI caps (vs pool depth) protect the pool from one-sided risk.

---

## Money & safety model

- **Integer money only.** All balances are `BIGINT` **micro-USDC** (1 USDC = 1,000,000); prices and
  quantities are `*_e6`. No floats anywhere. JSON encodes these as decimal strings.
- **Double-entry ledger.** Every value movement is a balanced transaction in `ledger_entries`
  (Σ per `txn_id` = 0, enforced by a deferred constraint). `balances` is a cache.
- **Continuous reconciler.** `reconcile.ts` proves `balances == Σ ledger`, every txn nets to 0, and
  the whole ledger nets to 0 — runs in tests and can auto-halt on drift.
- **Single-writer per market.** Each engine transaction takes an in-process mutex **and** a Postgres
  advisory lock, so concurrent orders on the same market serialize.
- **Idempotency.** Every order/close carries a client key; replays (even concurrent ones) return the
  prior result instead of double-executing.
- **Chart of accounts.** `USER_COLLATERAL`, `USER_POSITION_MARGIN`, `LP_POOL`, `INSURANCE_FUND`,
  `FEE_REVENUE`, `FUNDING_POOL`, `PNL_CLEARING`, `FAUCET_SOURCE`.

---

## Accounts: auth, faucet, leaderboard, referrals

- **Auth (SIWS).** `nonce → wallet signMessage → server re-renders the canonical message → ed25519
  verify → short-lived access JWT + a rotating refresh token` with token-family reuse detection.
- **Faucet.** Credits play USDC from `FAUCET_SOURCE`, clamped so a user's available balance never
  exceeds $1,000,000. Disabled entirely if `REAL_FUNDS` were ever on.
- **Leaderboard** (`GET /leaderboard`, public). Ranks traders by **net realized PnL**, derived from
  the ledger so it reconciles: `realized = (collateral + margin + LP-position value) − net deposits`.
  Equity and traded volume are shown as secondary columns; your own row is pinned when signed in.
- **Referrals.** Every account gets a unique `POKE-XXXXX` code at signup. Redeeming a code attributes
  the new account to the referrer (once) and, in play-money mode, pays **both** parties a bonus
  (default $1,000, clamped to the balance cap). The referrer is only paid for their first
  `MAX_REFERRALS_PAID` referrals (anti-farming). A `?ref=CODE` link is captured and offered for redeem.

---

## Architecture

```
        pokemontcg.io v2  (TCGplayer prices; ~daily)        [+ optional JustTCG for Graded]
                          │
              ┌───────────▼─────────────┐
              │  oracle (timer, 6h)      │  normalize → e6, outlier + staleness guard,
              │  src/services/oracle.ts  │  build Top-100/250 basket NAVs, recompute marks
              └───────────┬─────────────┘
                          │ publishes mark/stats/oi/funding
   apps/web (React SPA)   │            ┌──────────────────────────────────────┐
   ── REST ───────────────┼───────────▶│  apps/api (Fastify + ws)             │
   ── WebSocket ◀─────────┼────────────│  auth · markets · orders · account · │
                          │            │  lp · social · /ws hub               │
                          │            └───────────┬──────────────────────────┘
                          │                        │ commands (single-writer / market)
                          │            ┌───────────▼──────────────────────────┐
                          │            │  engine  src/services/engine.ts       │
                          │            │  open/close · mark · funding · liquidations
                          │            └───────────┬──────────────────────────┘
              ┌───────────▼─────────────┐  ┌───────▼─────────┐  ┌──────────────────┐
              │ Postgres / PGlite        │  │ in-process bus  │  │ reconciler       │
              │ ledger, balances,        │  │ → WebSocket hub │  │ balances==Σledger│
              │ markets, positions, lp…  │  │ (src/services/  │  │ src/services/    │
              └──────────────────────────┘  │  bus.ts, ws.ts) │  │ reconcile.ts     │
                                            └─────────────────┘  └──────────────────┘
```

The browser holds no money state. Money-critical state is re-hydrated via REST on (re)connect, then
kept live over WebSocket. Public channels (`mark`, `stats`, `oi`, `funding`) are open; private
channels (`positions`, `orders`, `balance`, `liquidations`, `lp`) require an authed socket and only
deliver the caller's own data.

### Monorepo layout

```
pokex/                      (pnpm workspaces + Turborepo)
  apps/web                  React 19 + Vite SPA — Vercel (retro "Press Start 2P" theme)
  apps/api                  Fastify + WebSocket backend: ledger, engine, oracle, liquidations
  packages/pricing          Shared money math (price/PnL/margin/liq/mark) — FE previews must equal the engine
  packages/shared-types     Shared zod schemas + constants for the REST + WebSocket contracts
```

`packages/pricing` is the single source of truth for money math, imported by **both** the API and
the web app, so the liquidation price / fees the user previews are exactly what the engine computes.

### Data model (Postgres / PGlite)

`users · sessions · auth_nonces` · `accounts · ledger_entries · balances` (double-entry core) ·
`markets · oracle_prices · marks · index_constituents · index_divisors` (pricing) ·
`orders · fills · positions · funding_rates · liquidations` (trading) ·
`lp_pool · lp_positions` (liquidity). The same `schema.sql` runs on PGlite locally and on managed
Postgres in prod; it's idempotent and applied on boot (`db/migrate.ts`).

---

## API surface

**REST** (`apps/api/src/routes`):

| Method + path | Auth | Purpose |
|---|---|---|
| `POST /auth/nonce` · `POST /auth/verify` · `POST /auth/refresh` · `POST /auth/logout` · `GET /auth/me` | mixed | SIWS login + session rotation |
| `GET /markets` · `GET /markets/:id/candles` · `GET /markets/:id/details` | public | Market list, chart series, card metadata + graded price |
| `GET /account/balance` · `POST /faucet` | yes | Balance/equity; claim play USDC |
| `GET /positions` · `POST /orders` · `POST /positions/:id/close` | yes | Open positions; place/close perps |
| `GET /lp/pool` · `GET /lp/position` · `POST /lp/deposit` · `POST /lp/withdraw` | mixed | LP pool state + provide/withdraw liquidity |
| `GET /leaderboard` · `GET /referral/me` · `POST /referral/redeem` | mixed | Leaderboard (public, optional viewer); referral code + redeem |
| `GET /health` | public | Health check |

**WebSocket** `GET /ws` — subscribe to `mark:{id}`, `stats:{id}`, `oi:{id}`, `funding:{id}` (public)
and `positions:{userId}`, `orders:{userId}`, `balance:{userId}`, `liquidations:{userId}`, `lp:{userId}`
(after sending `{op:'auth', token}`).

---

## Configuration

All config is read from the environment in `apps/api/src/config.ts` (never hardcoded, never shipped
to the browser). Copy `apps/api/.env.example` → `apps/api/.env`; every key has a safe default. Key ones:

| Var | Default | Notes |
|---|---|---|
| `PORT` / `HOST` | `4000` / `0.0.0.0` | API bind |
| `WEB_ORIGINS` | `localhost:5173,4173` | CORS allow-list (set to your Vercel URL in prod) |
| `DATABASE_URL` | _(empty)_ | Empty → embedded PGlite; set to managed Postgres in prod |
| `PGLITE_DIR` | `./.pglite` | Local embedded-DB dir (use `memory://` for ephemeral) |
| `JWT_SECRET` | dev default | **Must** be a strong ≥32-char value in production (boot refuses otherwise) |
| `POKEMONTCG_API_KEY` | _(empty)_ | Optional; keyless works at lower rate limits |
| `ORACLE_REFRESH_MS` / `ORACLE_PAGE_SIZE` | `6h` / `250` | Ingest cadence; page size (capped at 250 upstream) |
| `JUSTTCG_API_KEY` / `GRADED_CONSTITUENTS` | _(empty)_ / `100` | Set the key to make the **Graded** index live |
| `REAL_FUNDS` | `false` | **Hard gate** — `true` makes the API refuse to boot |
| `FAUCET_DEFAULT_USD` | `10000` | Per-claim play USDC (balance capped at $1M) |
| `REFERRAL_BONUS_USD` / `MAX_REFERRALS_PAID` | `1000` / `50` | Referral payout (both parties) + per-referrer cap |
| `OPEN_FEE_BPS` / `CLOSE_FEE_BPS` / `FEE_LP_SHARE_PCT` | `10` / `10` / `50` | Trading fees + LP share |
| `FUNDING_SKEW_FACTOR_BPS` / `FUNDING_INTERVAL_MS` | `30` / `1h` | Funding rate cap + cadence |
| `LIQ_FEE_BPS` / `LIQUIDATION_SWEEP_MS` / `ORACLE_STALE_MS` | `100` / `5s` / `36h` | Liquidation penalty, sweep, staleness halt |

---

## Develop

Requires **Node ≥ 20** and **pnpm**.

```bash
pnpm install

pnpm dev            # run web + api together (turbo)
# or individually:
pnpm dev:web        # Vite SPA   → http://localhost:5173
pnpm dev:api        # Fastify api → http://localhost:4000  (ingests live data ~1.5s after boot)
```

The web app reads `VITE_API_URL` (default `http://localhost:4000`) and derives the WebSocket URL
from it. If you run the API on a different port, start the web with
`VITE_API_URL=http://localhost:<port>` and make sure that web origin is in the API's `WEB_ORIGINS`.

With no `DATABASE_URL`, the API uses an embedded **PGlite** database under `apps/api/.pglite/`
(zero system deps). On first boot the oracle ingests live prices, so the markets populate on their own.

```bash
pnpm build          # build/typecheck all workspaces
pnpm lint           # lint (web) + tsc typecheck (api)
pnpm test           # api (node:test on PGlite) + pricing property tests
```

### Deployment topology (hybrid)

- **Frontend → Vercel** (static SPA). Set the project **Root Directory** to `apps/web` and
  `VITE_API_URL` to your backend URL.
- **Backend → a long-running host** (Railway / Render / Fly.io). The engine, WebSocket hub, and the
  funding/liquidation/oracle loops need a persistent process — Vercel's serverless model can't host them.
- **Database → managed Postgres** (Neon / Supabase) via `DATABASE_URL`. The same SQL runs locally on PGlite.

---

## Testing

- **API** (`apps/api/src/**/*.test.ts`, run with `node:test` on an in-memory PGlite): ledger
  conservation, SIWS auth, oracle ingest + outlier guard + index NAV, the trading engine
  (open/increase/close, margin, liq price, idempotency under contention), LP deposit/withdraw,
  funding, liquidations + bad-debt socialization, leaderboard + referrals, and a chaos test of
  concurrent activity. The reconciler asserts the ledger stays balanced after every scenario.
- **pricing** (`packages/pricing`): property tests for NAV, margin, liquidation price, PnL, fees, and
  the synthetic mark (conservation + rounding-against-the-user).

---

## Status & what's deferred

V1 is the **play-money engine end to end**: ledger → SIWS auth + faucet → oracle/marks → trading →
LP + fees + funding → liquidations → UI, plus the leaderboard and referral system, tuned on devnet.

Explicitly **out of scope** until a security audit + legal/AML review (all gated behind `REAL_FUNDS`):
real custody (deposit addresses, withdrawals, KMS/multisig), SOL→USDC conversion, KYC/AML, a Go
engine rewrite, limit/stop orders, and the Graded/Sealed indices going live (which need licensed
graded/sealed price feeds).
