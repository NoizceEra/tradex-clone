# PokeX

A **leveraged perpetual-futures exchange on Pokémon-card prices**, settled in USDC.
Trade perps on individual cards **and** on basket **indices** (Top 100 / Top 250, with
Graded and Sealed indices planned). Index-anchored synthetic mark, pooled-LP counterparty,
funding, and liquidations.

> ⚠️ **Play-money MVP.** This build runs entirely on simulated balances (a faucet) and
> Solana **devnet**. No real funds are accepted. It is a fan project for Pokémon TCG price
> data (via [pokemontcg.io](https://pokemontcg.io)); it is **not** affiliated with Nintendo,
> The Pokémon Company, or TCGFish, and is **not financial advice**. Real custody, deposits,
> and withdrawals are gated behind a future security audit + legal/compliance review and are
> intentionally **not** part of this build (`REAL_FUNDS` must stay `false`).

## Monorepo layout

```
pokex/                 (pnpm workspaces + Turborepo)
  apps/web             React 19 + Vite SPA — deployed on Vercel (retro "Press Start 2P" theme)
  apps/api             Fastify + WebSocket backend: ledger, trading engine, oracle, liquidations
  packages/pricing     Shared money math (price/PnL/margin/liq/mark) — FE previews must match engine
  packages/shared-types  Shared zod schemas for the REST + WebSocket contracts
```

### Deployment topology (hybrid)
- **Frontend → Vercel** (static SPA). Set the Vercel project **Root Directory** to `apps/web`.
- **Backend → a long-running host** (Railway / Render / Fly.io) — the engine, WebSockets, and
  liquidation/funding loops need a persistent process that Vercel's serverless model can't provide.
- **Database → managed Postgres** (Neon / Supabase) in prod. Locally it uses **PGlite**
  (embedded Postgres, zero system deps); the same SQL runs on hosted Postgres via `DATABASE_URL`.

## Develop

Requires Node ≥ 20 and pnpm.

```bash
pnpm install

# run both apps
pnpm dev

# or individually
pnpm dev:web    # Vite dev server (http://localhost:5173)
pnpm dev:api    # Fastify api  (http://localhost:4000)
```

API config lives in `apps/api/.env` (copy from `apps/api/.env.example`). With no `DATABASE_URL`
set it uses an embedded PGlite database under `apps/api/.pglite/`.

```bash
pnpm build      # build all workspaces
pnpm lint       # lint / typecheck all workspaces
pnpm test       # run tests
```

## Status

See `docs`/the project plan for the full roadmap. Current focus: the play-money engine
(ledger → auth/faucet → oracle/marks → trading → LP/funding → liquidations → UI), tuned on
devnet before any real-funds work is considered.
