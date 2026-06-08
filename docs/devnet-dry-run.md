# Devnet dry-run — custody P1–P3 end-to-end

**Date:** 2026-06-08 · **Branch:** skins · **Result:** steps 1–5 PASSED (1–4 headless · 5 via Phantom UI)

First time the custody stack (`apps/api/src/services/custody/*`) has run against live Solana RPC.
Deposit → credit → sweep → withdraw (auto + manual) → proof-of-reserves auto-freeze/recover all
verified on-chain, not just in the ledger.

## Toolchain

- rustc 1.95.0 · solana-cli 4.0.1 (Agave) · anchor-cli 1.0.2 · spl-token-cli 5.5.0 · surfpool 0.9.5 (unused — ran real devnet)
- **RPC:** steps 1–4 ran on public `https://api.devnet.solana.com` (the original Helius devnet key
  was hard-429ing — capped, not a burst). For step 5 switched to a fresh Helius **devnet** key
  (`devnet.helius-rpc.com`, key in `~/.pokex-devnet/.env.devnet`). Note: a `beta.helius-rpc.com`
  URL is **mainnet** — verify cluster by genesis hash before pointing custody at any endpoint.

## Environment (not committed)

All artifacts live out-of-repo under `~/.pokex-devnet/` so secrets never touch git:

- `keys/{hot,cold,user}.json` — keypairs (secret)
- `.env.devnet` — `REAL_FUNDS`, `USDC_MINT`, `TREASURY_PUBKEY`, `DEPOSIT_MASTER_SEED`,
  `HOT_WALLET_SECRET`, `ADMIN_API_KEY`, `SOLANA_RPC_URL`, `PGLITE_DIR`, sped-up cadences,
  `WITHDRAWAL_AUTO_PROCESS=true` (secret)
- `pglite/` — fresh real-funds ledger (separate from the play-money `apps/api/.pglite/`)
- `mint.txt`, `api.log`, `session.json`

Funder + mint authority = the existing CLI keypair (`~/.config/solana/id.json`). Custody roles use
the three fresh keypairs above.

### On-chain identities (devnet, public)

| Role | Address |
|---|---|
| Test USDC mint (6dp) | `GC9WbcUYRwjcdBNw4UFUejR1qLb7Hx4fTSwvH37Bv422` |
| Funder / mint authority | `3s42NMy3BFnbF1pr6fzDU9V7CL1eEYNjKnphHNqc3yZL` |
| Hot wallet | `9Q3sR5sNFLXnK4wUtroSjX7Rty4iewPS7aAjzXgLWT4P` |
| Cold treasury | `5BPL3mxFzU8gPdXBrM7qhRvu8aP3nQAjcoPHsqiraT2e` |
| User (SIWS signer) | `8MiW6PZdoBFPBkGMmYJabT8mfBzJETDmPgfdTU3e77Ka` |
| User deposit addr (HD idx 0) | `4qHWQEpg6xemripaJHBrL3sKMyGkJKAuJw7V3a2cBkFc` |

## Results

### Step 1 — setup
6dp mint created; hot funded 0.2 SOL + 5,000 USDC float; funder minted 100,000 USDC; API booted
`REAL_FUNDS=true` on :4100, all custody workers clean.

### Step 2 — deposit path
Two 1,000-USDC transfers to the HD deposit address → **detected at `finalized` → full credit →
swept to cold**. Deposit address drained to 0; cold received the sweeps. Scan cursor advanced past
the first signature to pick up the second deposit.
- deposit sigs: `yAb63q…aQW`, `61hSYD…z1B`

### Step 3 — withdrawals (step-up SIWS signed headlessly; atomic debit 2,000 → 450)
- **$50 (≤ $1k auto cap)** → auto loop signed/broadcast/**confirmed** (payout sig `22u4jZ…5YB`).
- **$1,500 (> $1k)** → held `requested` by the velocity guard → **`/admin/approve`** → confirmed.
- Destination received exactly **1,550** from the hot wallet, on-chain.

### Step 4 — proof-of-reserves (auto-freeze + recover)
1. Drained hot+cold out-of-band → on-chain `0 < 450` liability → treasury loop **auto-froze**.
2. New withdrawal correctly rejected: `503 — withdrawals are temporarily frozen: proof-of-reserves
   breach…`.
3. Restored custody → live breach cleared **but freeze persisted** (incident = manual clear).
4. **`/admin/unfreeze`** → `frozen:null` → fresh **$25 withdrawal confirmed** on-chain.

**End state:** liability 425 · hot 975 · cold 2,000 · on-chain 2,975 ≥ 425 · `breached:false` ·
`frozen:null`. Destination total **1,575** (50 + 1,500 + 25). Only log ERRORs are the seven
intentional breach lines.

### Step 5 — UI round-trip (Phantom, devnet)
Real browser flow against the live API: Phantom connect → **SIWS sign-in** → Wallet panel shows the
HD deposit address (idx 1, `Lc9Ned…`) + QR. 100-USDC deposit credited + swept (cold 2,000 → 2,100),
shown in the panel's table; then a **$50 withdrawal authorized by an in-Phantom step-up signature**
auto-confirmed on-chain (payout sig `rtcgGk…`), USDC returned to the user wallet. End state:
liability 475 · hot 925 · cold 2,100 · `breached:false`.
- The deposit was pushed from the funder (not Phantom) because Phantom can't display a metadata-less
  devnet mint (see findings) — but the deposit credit/sweep, panel display, step-up signing, and
  payout are all real and validated.

## Cost
~0.21 devnet SOL (funder 9 → 8.79; mostly the hot-wallet funding). Plus immutable devnet ATAs/txs.

## Operational findings
- **Helius devnet key capped (429)** — used public RPC for steps 1–4, then a fresh Helius devnet key.
- **`spl-token` footgun:** 0-SOL recipients/owners (deposit + cold addresses) need
  `--allow-unfunded-recipient` and an explicit funded `--fee-payer`. Server code handles SOL-less
  deposit addresses correctly (hot wallet is fee payer, by design) — CLI-only quirk.
- **Phantom can't display a metadata-less devnet SPL token (2026).** Phantom removed manual
  add-by-mint and auto-hides unverified/no-metadata tokens with no way to force-show them (visible on
  explorers only). Cosmetic + devnet-only — doesn't affect custody, and a mainnet token with Metaplex
  metadata won't hit it. Workaround for devnet UI testing: push deposits server-side; the withdrawal
  step-up (the real UI test) works regardless.

## Bug found (worth fixing)
- **Transient RPC error → false PoR breach → spurious withdrawal freeze.** `usdcBalance()` in
  `apps/api/src/services/custody/solana.ts` catches *any* error and returns `0n`. During the old
  API's long run on the rate-limited public RPC, a transient balance-read failure made on-chain
  custody read `0 < liabilities`, so `treasuryPass` auto-froze withdrawals (observed: freeze reason
  `hot 0 + cold 0` while the wallets actually held 975/2000). On a flaky/rate-limited RPC this is a
  real availability risk. **Fix:** distinguish "RPC errored" from "balance is zero" — on a read
  error, skip the PoR freeze decision that pass (and/or surface a distinct alert) instead of
  treating it as zero custody.

## Coverage gaps (not tested)
SOL→USDC Jupiter deposit swap (mainnet-only; devnet parks by design) · dust `ignored` path ·
withdrawal **boot-recovery** (crash mid-broadcast) · `/admin/reverse` · hot→cold auto-sweep above
the $25k cap · idempotency replay · multi-user concurrency · **UI round-trip (step 5)**.
Highest-value follow-ups: boot-recovery and reversal.

## Resume / step 5 (UI round-trip)

The devnet API is left running for this.

```bash
# (re)start the real-funds API against the devnet env, if needed:
cd apps/api
DOTENV_CONFIG_PATH=~/.pokex-devnet/.env.devnet npx tsx src/index.ts > ~/.pokex-devnet/api.log 2>&1 &

# headless driver (temporary helper, apps/api/_dryrun.mjs):
node _dryrun.mjs login | address | txns | withdraw <usd> <dest> <idemKey>

# operator (ADMIN_API_KEY is in ~/.pokex-devnet/.env.devnet):
curl -s localhost:4100/admin/treasury -H "x-admin-key: $KEY" | jq
curl -s "localhost:4100/admin/withdrawals?status=requested" -H "x-admin-key: $KEY" | jq
```

**Step 5 prerequisites:** point `apps/web` at `http://localhost:4100`; use a browser wallet (Phantom)
on **devnet**; that wallet needs a little devnet SOL + some of the test mint
(`GC9Wb…Bv422`) to make a UI deposit. Then: connect → wallet panel shows deposit address + QR →
send test-USDC → watch credit → withdraw with step-up Phantom signature.

## Teardown (when done — destructive, run explicitly)
```bash
kill <api-pid>            # background API on :4100
rm -rf ~/.pokex-devnet/   # keys, env, devnet ledger
rm apps/api/_dryrun.mjs   # temp driver
```
On-chain artifacts (mint, ATAs, txs) remain — immutable devnet history. The play-money
`apps/api/.pglite/`, your CLI config, and main keypair are untouched throughout.
