# Security notes — open items, decisions & remediations

A living ledger of security findings (from the per-commit automated reviews + a custody re-review) and
what was done about each. Updated as items are fixed. Pairs with `docs/real-funds-custody-plan.md`.

---

## ⚠️ Action required by a human (cannot be done in code)

### Rotate two leaked API keys
Two real keys were committed to the early UI lineage and remain in **pushed** git history on
`origin/retro-theme` (they are **not** in `master`'s history):

| Key | Provider | Where it leaked | Action |
|---|---|---|---|
| `07c20d0a64msh…` | RapidAPI (pokemontcg proxy) | `src/App.jsx` / `src/components/BrowseCards.jsx` @ `15b93c4`, `caa569e` | **Rotate at RapidAPI.** Removal from current code ≠ rotation. |
| `tcg_3e157…` | JustTCG | `src/App.jsx` @ `15b93c4` | **Rotate at JustTCG.** |

Once rotated, the leaked values are worthless, so a history rewrite buys little and was deliberately
skipped (it would force-push `retro-theme` and break clones). The current codebase reads **all** keys
from the environment via `config.ts` only — never hardcoded — so this can't recur. If you later want the
history scrubbed anyway, `git filter-repo`/BFG on `retro-theme` + force-push is the path.

---

## Decisions

### Refresh token stays in `localStorage` (cookie migration deferred to custody P4)
The refresh token lives in `localStorage` (`apps/web/src/lib/api.js`), readable by in-origin JS. The
server already mitigates with **rotation + reuse-detection** (a reused/old token revokes the whole
session family — `services/auth.ts`). Moving it to an `httpOnly; Secure; SameSite=None` cookie is more
robust but is a cross-origin (Vercel web ↔ separate API host) deploy change that risks "stay logged in".
The fund-theft path is independently closed by the **withdrawal step-up signature** (a stolen token
cannot produce a fresh wallet signature over the amount+destination). Decision: keep `localStorage` for
the play-money MVP; do the cookie migration in **P4** alongside the audit/deploy hardening.

---

## Findings & status

### Fixed
- **JWT default secret in production (HIGH).** `config.ts` throws in production if `JWT_SECRET` is unset / the dev default / < 32 chars.
- **`orders.idempotency_key` global UNIQUE → cross-tenant collision/IDOR (HIGH).** Now `uq_orders_user_idem(user_id, idempotency_key)`.
- **`withdrawals.idempotency_key` global UNIQUE — same anti-pattern on the real-money table (MED).** Fixed: `uq_withdrawals_user_idem(user_id, idempotency_key)` (`schema.sql`). A user can no longer pre-claim a key to grief another's withdrawal.
- **`db/reset.ts` unguarded `DROP SCHEMA` (HIGH).** Now fails closed: never under `REAL_FUNDS`; in production / with a managed `DATABASE_URL` only with `ALLOW_DB_RESET=true`. Local PGlite dev is unaffected.
- **Username/`display_name` rename-hijack (MED).** Added `display_name_aliases`; `setUsername` permanently reserves the freed handle (case-insensitive) so it can't be claimed to impersonate the original owner — mirrors the referral-code fix.
- **Referral anti-farming cap TOCTOU race (MED).** `redeemReferral` now takes `SELECT … FOR UPDATE` on the referrer row before the count, so concurrent redemptions can't bust `maxReferralsPaid`.
- **Referral-code rename-hijack + `POKE-` namespace confusion (HIGH/MED).** Fixed earlier via `referral_code_aliases` + reserved prefix.
- **Anonymous WebSocket IDOR on per-user channels (HIGH).** Fixed earlier (socket `auth` + ownership gating).
- **No rate-limiting anywhere (enabler for enumeration/brute-force/DoS).** Added `@fastify/rate-limit`: a global per-IP cap + tighter per-route caps on the auth + write endpoints (`server.ts`, `routes/*`). Set `TRUST_PROXY=true` behind Vercel/Render/Fly.

### Custody deposit-path re-review (the surface the automated reviewer never finished)
Core crediting design verified sound (idempotent, reorg-safe at `finalized`, credits actual-not-quoted,
no double-credit under concurrency, route auth correct).

Fixed (deposit-path hardening commit):
- **F1 (HIGH):** fixed `limit:20` signature window with no pagination → a backlog or adversarial dust-spam could permanently strand (never-credit) a deposit. Fixed: the chain impl pages the full signature history backwards (1000/page) down to a persisted per-(address, asset) high-water sig (`deposit_scan_cursors`); the cursor only advances over fully-fetched history, deposits rows are recorded before the cursor moves, and a transiently unfetchable finalized tx aborts the pass (retry) instead of being skipped under an advancing cursor.
- **F2 (MED):** devnet SOL deposits looped in `swapping` forever (Jupiter has no devnet route). Fixed: `config.solSwapsEnabled` (default: only when `USDC_MINT` is the mainnet mint; `SOL_SWAPS_ENABLED` overrides) — off-route networks park SOL rows at `detected` with zero swap attempts, and they self-heal on a swap-capable network.
- **F3 (MED):** scanner had no reentrancy guard (`setInterval` doesn't await) → overlapping passes could redundantly fire SOL swaps. Fixed: self-chained loops (`chainLoop` in `index.ts`) for the deposit scanner AND the withdrawal processor — the next pass schedules only after the current one finishes.
- **F4 (MED):** sub-minimum dust was re-parsed on every scan forever and polluted the sig window (amplified F1). Fixed: dust is recorded as a terminal `ignored` row — never credited (`creditDeposit` guards on `status = 'detected'`), never re-fetched or re-parsed.

Fixed (treasury automation commit, P3):
- **F5 (LOW-MED):** hot-wallet SOL griefing — every $1 deposit forced a hot-wallet-funded sweep. Fixed: deposit sweeps only fire at/above `MIN_SWEEP_USD` (default $10) — small credits accumulate on the deposit address until a sweep is economic; the treasury worker also flags hot-wallet shortfalls (pending payouts > hot balance) for operator top-up.

Deferred (tracked, deliberately not in scope yet):
- **F6 (LOW, mainnet/P4):** SOL→USDC swaps sandwichable at 1% via public RPC. Fix at mainnet dark-launch: tighten slippage + private/Jito route.
- **F7 (LOW):** HD index allocation can throw a transient 500 under a burst of >3 simultaneous first-time registrations (no collision/fund risk). Fix opportunistically: DB sequence or single-statement allocation.

### Operator surface (`/admin` routes)
Registered only when `REAL_FUNDS` AND `ADMIN_API_KEY` (≥ 32 chars, enforced at boot) are set —
otherwise the routes don't exist (404). Timing-safe key compare, `RL_ADMIN` rate cap as
brute-force defense. Approve/reverse/freeze/unfreeze/treasury-report; payout signing stays
server-side (the operator key never exposes the hot-wallet secret). See `docs/ops-runbook.md`.

### Treasury / proof-of-reserves (P3)
- **Proof of reserves** runs every `TREASURY_PASS_MS`: on-chain custody (cold treasury + hot wallet + credited-but-unswept deposit balances) must cover the ledger's `TREASURY_USDC` liabilities. A breach **auto-freezes withdrawals** (the `system_flags.withdrawals_frozen` row): new requests and new payout signings are rejected with 503; deposits continue; recovery of already-signed payouts proceeds (those debits are final, re-broadcast is idempotent). **Unfreezing is manual** (`unfreezeWithdrawals`) — a PoR breach is an incident, not a self-healing condition.
- **Velocity guard on automation:** the `WITHDRAWAL_AUTO_PROCESS` loop only pays out rows ≤ `WITHDRAWAL_AUTO_APPROVE_MAX_USD` (default $1k); larger withdrawals sit debited until an operator runs `processWithdrawal` explicitly.

### Accepted / deferred (design or out-of-scope for the MVP)
- **Refresh token in `localStorage`** — see Decisions above (deferred to P4).
- **Referral-code enumeration via the 409/200 pre-check** — materially mitigated by the new rate limit on `/referral/code`; codes are public identifiers.
