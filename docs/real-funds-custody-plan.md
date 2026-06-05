# Real-Funds Custody Plan — deposits, withdrawals & treasury (v2, reviewed)

**Status:** v2, **P0–P2 implemented** (devnet): deposits (USDC + SOL-via-Jupiter), withdrawals (step-up SIWS, atomic debit, sign-once-persist-then-broadcast, boot recovery, manual approval — `WITHDRAWAL_AUTO_PROCESS` gates the P3 loop). Deposit path hardened per the security re-review (`docs/security-notes.md` F1–F4: paginated scan + persisted high-water cursors, off-route SOL parking, non-overlapping worker loops, terminal dust rows; F5–F7 deferred). P3 (treasury automation/PoR auto-freeze) + P4 (mainnet gates) outstanding. Hard-gated behind `REAL_FUNDS` + a security audit + legal/AML review.
**Model:** Custodial USDC balance on Solana, per-user HD deposit wallets, server-side Jupiter SOL→USDC auto-swap. Reuses the existing double-entry ledger + perps engine unchanged.

---

## Why this model

The platform is Solana-native with an off-chain engine + pooled LP + a double-entry ledger (balances the platform controls). That architecture is inherently **custodial**, so the simplest viable path is a **custodial balance** (deposit → platform balance → trade off-chain → withdraw), not an on-chain program.

Validated against live comps:
- **CollectorRoll** (closest comp — "1v1 Pokémon Pack Battles on Solana"): full site-clone inspection found **no embedded-wallet vendor** (no Turnkey/Privy/Dynamic/Magic/dfns/Fireblocks). Client = `@solana/wallet-adapter` + public Solana RPC; `jupiter` = 0 client-side. Per-user wallet creation + the Jupiter swap are **server-side**, crediting a **custodial balance**. Conclusion: home-rolled server-side custody, no wallet vendor.
- **Axiom / Padre:** non-custodial **Turnkey** embedded wallets; Axiom routes perps to Hyperliquid (external venue). Not our case — we *are* the venue.
- **AsterDEX:** on-chain perps DEX (contracts + audits) with email→embedded-wallet onboarding. The "go fully non-custodial" alternative — heavier; deferred.

**Takeaway:** replicate CollectorRoll — free Solana libraries, server-side, no wallet vendor. The hard part is **securing the server-held keys + the custodial obligations** (treasury security, AML/KYC, proof-of-reserves). PokeX is synthetic price perps → settlement is **USDC-out only** (no card/NFT delivery), simpler than CollectorRoll.

---

## Ledger accounting (reuses `apps/api/src/services/ledger.ts` unchanged)

Add one system account — **`TREASURY_USDC`** (the on-chain mirror) — to `AccountType` + `SYSTEM_ACCOUNT_TYPES`. Real money = two balanced txns via the existing `postTxn` (Σ = 0):

- **Deposit:** `+USER_COLLATERAL, −TREASURY_USDC`.
- **Withdraw:** `−USER_COLLATERAL, +TREASURY_USDC` — posted **before** broadcast (two-phase); reversed if broadcast definitively fails.

### Invariants
- Σ over all accounts = 0 (existing constraint). Therefore **−`TREASURY_USDC` = total internal claims** (user collateral + margin + LP + insurance + fees + funding + PnL clearing).
- **Proof-of-reserves:** on-chain custody (treasury **+ unswept deposit-address balances**) ≥ |`TREASURY_USDC`| at all times — prompt sweeps keep the second term ≈ 0. House money (fees/insurance) is real too, so it's correctly included.
- **Only deposits/withdrawals touch `TREASURY_USDC`.** Everything else (trades, LP, funding, liquidations) stays internal — engine untouched.

### ⚠️ Real deposits must NEVER clamp (critical)
`faucet.ts:creditCapped` clamps available balance at $1M and **credits 0 at the cap** — correct for play money, catastrophic for real money (USDC arrives on-chain but isn't credited). `creditDeposit()` is a **separate function that always credits the full received amount**. If deposit limits are ever wanted, enforce by policy *before acceptance* (or refund on-chain) — never a silent ledger clamp.

### ⚠️ `REAL_FUNDS` requires a fresh ledger (critical)
Flipping `REAL_FUNDS=true` on a DB containing faucet/referral play balances would make **play money withdrawable as real USDC**. PoR would catch it (liabilities > on-chain), but fail fast instead: **on startup, if `REAL_FUNDS` and `FAUCET_SOURCE` balance ≠ 0 → refuse to start.** Production real-funds deployments start with a fresh ledger (faucet + referral bonuses already self-disable under `REAL_FUNDS` — verified in `faucet.ts:65`, `referral.ts:119,142`).

---

## New tables (`apps/api/src/db/schema.sql`, additive)

- `deposit_addresses(user_id PK → users.id, address TEXT UNIQUE, derivation_index INT UNIQUE, created_at)` — one HD-derived Solana deposit address per user.
- `deposits(id, user_id, onchain_sig, asset, amount_in_raw, usdc_credited_e6 BIGINT, swap_sig, sweep_sig, status, txn_id, observed_at, credited_at)` — **`UNIQUE(onchain_sig, asset)` ⇒ idempotent crediting** (a single tx may carry both SOL and USDC). `status`: USDC `detected → credited`; SOL `detected → swapping → swapped` (terminal — the swap's proceeds credit as their own USDC row). `sweep_sig` fills in asynchronously.
- `withdrawals(id, user_id, dest_address, amount_e6 BIGINT, status, signed_tx BYTEA/TEXT, onchain_sig, idempotency_key TEXT UNIQUE, requested_at, signed_at, confirmed_at, reason)` — lifecycle: `requested → signed → broadcast → confirmed | failed | reversed`. **`signed_tx` + `onchain_sig` are persisted at `signed`, before broadcast** (see crash-safety below).

---

## New service modules (`apps/api/src/services/custody/`)

| File | Responsibility |
|---|---|
| `wallet.ts` | Derive a deposit address per user (`ed25519-hd-key`, `derivation_index` from the user row). Master seed in **KMS/HSM** — never in DB/code. Blast-radius note: a leaked master seed compromises every deposit address → sweep promptly (below) so at-risk balances stay near zero. |
| `deposits.ts` | Scan deposit addresses (Helius webhook or poll) at **`finalized` commitment**. **Credit-first:** new `onchain_sig` → insert `deposits` row → `creditDeposit()` posting `+USER_COLLATERAL, −TREASURY_USDC` **for the actual USDC proceeds, full amount, no clamp**, idempotently (the deposit address is ours, so finalized funds are already in custody — sweep health never delays or strands a credit). Then **sweep = full-balance move to treasury** (naturally idempotent; retries until empty; one sweep may cover several deposits). (SOL deposits, P1.5: **Jupiter-swap in place** — balance-based, slippage-bounded, the wallet pays its own fee from the SOL; the proceeds land on the same address and credit as their own USDC row, sig = the swap tx — **SOL rows never credit**, making the swap crash-safe and double-credits structurally impossible.) Ignore dust below `minDepositUsd` (uneconomic to sweep; anti-dusting). **Fee mechanics:** fresh deposit addresses hold no SOL — the **hot wallet is the fee payer** for sweep txs and funds ATA rent (~0.002 SOL) where needed. |
| `withdrawals.ts` | `requestWithdrawal()`: in ONE `db.tx` — **lock the collateral balance row `FOR UPDATE`** (same discipline as `engine.ts:236-238`, else a concurrent trade/withdrawal races the check) → validate (≤ available, ≥ `minWithdrawalUsd`, ≤ daily velocity cap, dest = whitelisted/SIWS pubkey + new-address cooldown, step-up verified) → debit (`−USER_COLLATERAL, +TREASURY_USDC`) → build + sign the transfer → **persist `signed_tx` + its signature** → status `signed`. `processWithdrawal()`: broadcast → `confirmed`. **Crash-safety:** re-broadcasting the same signed tx is idempotent on Solana (same sig); on restart, check the chain for the persisted sig before doing anything; if the blockhash expired un-broadcast, confirm the sig is absent on-chain, then re-sign (or use a **durable nonce** to avoid expiry entirely). Only mark `failed`+reverse the ledger txn when the sig is definitively absent and abandoned. Network fee paid by treasury; optional flat withdrawal fee → `FEE_REVENUE`. Manual approval above a threshold. |
| `jupiter.ts` | Thin Jupiter quote + swap client (`swapSlippageBps`); server-signs with the derived deposit key; on swap failure leave the deposit in `swapping` for retry — never credit a quote, only actual output. |
| `treasury.ts` | Hot/cold split — **Squads multisig** cold; capped hot float (`hotWalletMaxUusdc`); sweep deposits to cold, top-up hot for withdrawals; PoR helper. Also the future **treasury-ops** path (house withdrawals of `FEE_REVENUE` go through the same `TREASURY_USDC` accounting). |

Extend the existing **`reconcile.ts`** with a chain check: on-chain treasury USDC ≥ |`TREASURY_USDC`| → else **auto-freeze withdrawals** (deposits may continue).

---

## Routes (`apps/api/src/routes/wallet.ts`, mirrors `account.ts` + `authenticate`)

- `GET /wallet/deposit-address` — derive-on-first-call; returns the user's deposit address (+ QR).
- `POST /wallet/withdraw` — **step-up = a fresh SIWS signature over `(amount, dest, nonce, expiry)`** (reuse the `auth.ts` message-building pattern); dest defaults to the user's `solana_pubkey` or a whitelisted withdrawal address.
- `GET /wallet/transactions` — deposit/withdrawal **lifecycle status** (pending/confirmed — on-chain state isn't in the ledger).
- `history.ts`: add `DEPOSIT`/`WITHDRAWAL` (and `WITHDRAWAL_REVERSAL`) to the `TXN_TYPE` reason map — otherwise the new ledger reasons silently vanish from `/history/transactions`.
- `/account/balance` already serves the balance — no change.

## Background workers (`apps/api/src/index.ts`, alongside the oracle loop)

Deposit scanner (webhook/poll) · withdrawal processor (broadcast `signed`, recover in-flight on boot) · chain reconciler (PoR + auto-freeze).

---

## Config (`apps/api/src/config.ts`, env-only) + the `REAL_FUNDS` flip

Add: `solanaRpcUrl`, `usdcMint` (per network), `treasuryPubkey`, `depositSeedKmsRef`, `jupiterBase`, `swapSlippageBps`, `minDepositUsd`, `minWithdrawalUsd`, `withdrawalDailyCapUsd`, `hotWalletMaxUusdc`.

Flip the gate: today `config.ts:69` **throws** if `REAL_FUNDS=true`. Change to: enable the deposit/withdraw paths, **refuse to start unless the custody config is present AND the ledger is fresh** (`FAUCET_SOURCE` = 0, see invariant above). Keep allowlist-gated for dark launch.

---

## Frontend (`apps/web`)

Deposit panel (address + QR; optional "send from connected wallet" via `wallet-adapter`) replacing the faucet button under `REAL_FUNDS`; Withdraw form (amount + dest default = connected pubkey → step-up sign). Balance UI (`/account/balance`) already works.

---

## Crown jewels (where the real risk is)

- **Deposit master seed** → KMS/HSM, never in DB/code; swap + sweep signing in a secured signer; prompt sweeps keep per-address balances ≈ 0.
- **Treasury cold = Squads multisig**; hot float capped + auto-swept; withdrawal signing guarded (velocity, approvals, step-up) — never a plaintext key on the API box.
- Idempotency end-to-end: deposit `onchain_sig` UNIQUE, withdrawal `idempotency_key` UNIQUE, sign-once-persist-then-broadcast.
- Reconciler auto-freeze on drift + published proof-of-reserves.

## Compliance gate (not code, but blocks mainnet)

Geofence · KYC/AML + sanctions screening · ToS · independent security audit — before flipping `REAL_FUNDS` on mainnet.

---

## Phasing (simplified after review)

| Phase | Scope | Network |
|---|---|---|
| **P0** ✅ | `TREASURY_USDC` account + the 3 tables + config scaffolding + fresh-ledger startup assertion. Zero behavior change. | — |
| **P1** ✅ | Deposit path, **USDC-only** (no Jupiter on the critical path): HD address → scanner (`finalized`) → **full-credit first** → idempotent balance-sweep (hot-wallet fee payer). | devnet, allowlisted |
| **P1.5** ✅ | SOL deposits: detect → Jupiter-swap in place (balance-based) → proceeds credit via the USDC path. Jupiter is **mainnet-only**, so devnet runs park SOL deposits; logic proven by injectable-chain tests. | tests / mainnet dark-launch |
| **P2** ✅ | Withdrawal path: atomic validate+debit (row lock) → sign-once-persist → **manual admin broadcast/approval first** (simplest, safest dark-launch). Step-up SIWS over (amount, dest, nonce); per-user idempotency; daily velocity cap; boot recovery re-broadcasts the persisted tx (re-signs only when provably dead). `WITHDRAWAL_AUTO_PROCESS` gates the auto loop. | devnet |
| **P3** | Automation + treasury: hot/cold (Squads), hot-float top-ups for payouts, auto-broadcast with velocity guards, chain reconciler/PoR/auto-freeze. | devnet |
| **P4** | Audit + KYC/AML + geofence → mainnet dark-launch to allowlist → flip `REAL_FUNDS`. | mainnet |

**Net:** the ledger + engine are already the custodial book of record — this adds a deposit-credit, a guarded withdrawal, a per-user HD wallet, Jupiter, and the treasury/security wrapper. No rearchitecture.

## Libraries (all free; no wallet vendor)

`@solana/web3.js`, `@solana/spl-token`, `@solana/wallet-adapter`, `ed25519-hd-key`, Jupiter swap API, Squads SDK, Helius or public RPC. Key security via cloud KMS/HSM (a managed server-custody API — Turnkey-server/dfns — is an optional later upgrade, not a requirement).

## Touch list

`ledger.ts` (+`TREASURY_USDC`) · `schema.sql` (3 tables) · `config.ts` (custody config + gate flip + fresh-ledger assert) · `services/custody/{wallet,deposits,withdrawals,jupiter,treasury}.ts` (new) · `routes/wallet.ts` (new) · `index.ts` (3 workers) · `services/history.ts` (reason labels) · `services/reconcile.ts` (chain check) · `packages/shared-types` (request/response schemas) · `apps/web` (deposit/withdraw UI).

---

## Review log (v1 → v2)

- **Critical:** real deposits must never reuse `creditCapped`'s clamp (silent 0-credit at the $1M play cap) → dedicated full-credit `creditDeposit()`.
- **Critical:** `REAL_FUNDS` flip requires a fresh ledger; startup assertion `FAUCET_SOURCE == 0` (play money must never become withdrawable).
- **High:** withdrawal crash-safety — sign once, persist signed tx + sig before broadcast; re-broadcast idempotent; durable-nonce/expiry handling; reverse only when definitively abandoned.
- **High:** `requestWithdrawal` must lock the collateral row `FOR UPDATE` (copy `engine.ts:236-238`) — else races concurrent trades/withdrawals.
- **High:** Solana fee mechanics — deposit addresses hold no SOL; hot wallet = fee payer for sweeps + ATA rent.
- **Med:** credit at `finalized`; `minDepositUsd` dust guard; `swapSlippageBps` + credit actual swap output; `history.ts` reason labels; step-up concretely defined; prompt sweeps.
- **Simplified:** P1 is USDC-only (Jupiter moved to P1.5); P2 withdrawals are manually processed first (automation in P3).
