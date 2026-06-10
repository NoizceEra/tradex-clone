# Deploying GachaDex

The deploy config already exists in the repo — this doc is the **env checklist** to paste into each host.

## Architecture
- **Frontend** (`apps/web`) → **Vercel**. Static Vite SPA. Config: [`vercel.json`](./vercel.json)
  (build `pnpm build --filter @pokex/web` → `apps/web/dist`, SPA rewrites).
- **Backend** (`apps/api`) → **Railway**. Persistent Fastify server: HTTP + WebSocket hub +
  background workers (oracle, funding, liquidations/ADL, custody scanners). Config:
  [`railway.toml`](./railway.toml) → [`apps/api/Dockerfile`](./apps/api/Dockerfile)
  (Docker build, installs all deps, `pnpm start` = `tsx src/index.ts`, healthcheck `/health`).
- **Database** → managed **Postgres** (Railway add-on, or Neon/Supabase). Wired via `DATABASE_URL`.
  Schema auto-applies on every boot (`initDb()` → `migrate()`, idempotent) — no separate migration step.

Monorepo: pnpm workspaces + Turbo, Node ≥20. Secrets live only in the host panels — `.env`/`.env.*`
are gitignored and never committed.

---

## Backend → Railway

1. **New Project → Deploy from GitHub repo** (`NoizceEra/tradex-clone`), pick your release branch.
   Railway reads `railway.toml` and builds via the Dockerfile. Leave the root directory at the repo root.
2. **Add Postgres:** New → Database → PostgreSQL. Reference its URL in the API service as
   `DATABASE_URL=${{Postgres.DATABASE_URL}}`.
3. **Set the variables** (below), then deploy. First boot runs the schema migration automatically.
4. Note the public URL, e.g. `https://<your-api>.up.railway.app`.

### Railway → service → Variables

```bash
NODE_ENV=production
DATABASE_URL=${{Postgres.DATABASE_URL}}          # reference the Railway Postgres plugin
WEB_ORIGINS=https://<your-vercel-domain>         # CORS allow-list (comma-separate if >1)
JWT_SECRET=<32+ random chars>                    # required in production

# --- Real funds / custody (server refuses to boot without these when REAL_FUNDS=true) ---
REAL_FUNDS=true
ALLOW_MAINNET_FUNDS=true                          # clears the mainnet boot-gate
SOLANA_RPC_URL=<your mainnet RPC>                 # e.g. https://mainnet.helius-rpc.com/?api-key=...
USDC_MINT=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v   # mainnet USDC (fixed, public)
TREASURY_PUBKEY=<your Squads multisig address>
DEPOSIT_MASTER_SEED=<32–64 bytes hex>             # SECRET — derives every user's deposit address
HOT_WALLET_SECRET=<base58 key or JSON byte array> # SECRET — the server's payout wallet
ADMIN_API_KEY=<32+ random chars>                  # operator key (approve withdrawals, treasury, freeze)

# --- Optional: override the pool-risk + custody knobs (all have defaults in src/config.ts) ---
# OI_CAP_NAV_BPS=4000
# MAX_PNL_FACTOR_BPS=6000
# ADL_PNL_FACTOR_BPS=8000
# WITHDRAWAL_DAILY_CAP_USD=10000
# HOT_WALLET_MAX_USD=25000
# WITHDRAWAL_AUTO_PROCESS=false                    # leave off = manual withdrawal approval
```

> `DEPOSIT_MASTER_SEED` + `HOT_WALLET_SECRET` are the money. In the Railway panel they're encrypted
> at rest. The code also accepts `DEPOSIT_SEED_KMS_REF` instead of the raw seed if you'd rather keep it
> in a KMS. Port binding is handled by the Dockerfile (`PORT=4000`, `HOST=0.0.0.0`).

---

## Frontend → Vercel

1. **Import the same GitHub repo.** Root directory = repo root (`vercel.json` drives the monorepo build).
2. **Set the variables** (below) — point `VITE_API_URL` at the Railway URL.
3. Deploy. Note the domain, e.g. `https://gachadex.vercel.app`.

### Vercel → Project → Settings → Environment Variables

```bash
VITE_API_URL=https://<your-api>.up.railway.app
VITE_SOLANA_RPC=<your mainnet RPC>               # same provider as the backend is fine
```

---

## Wire the two together (after both are up)
1. Railway: set `WEB_ORIGINS` to the Vercel domain → redeploy (CORS).
2. Vercel: confirm `VITE_API_URL` = the Railway URL → redeploy.

## What you still need to supply
- Your **mainnet RPC URL** (Helius/QuickNode/etc.)
- Your **treasury multisig address** (`TREASURY_PUBKEY`)
- The two **wallet keys** (`DEPOSIT_MASTER_SEED`, `HOT_WALLET_SECRET`) — generate fresh or bring your own
- Random **`ADMIN_API_KEY`** and **`JWT_SECRET`** (32+ chars each — `openssl rand -hex 32` works)

Operating the platform once it's live (withdrawals, freezes, treasury) is in [`docs/ops-runbook.md`](./docs/ops-runbook.md).
