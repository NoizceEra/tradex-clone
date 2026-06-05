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
no double-credit under concurrency, route auth correct). Open items tracked for Commit 3 / later:
- **F1 (HIGH):** fixed `limit:20` signature window with no pagination → a backlog or adversarial dust-spam can permanently strand (never-credit) a deposit. Fix: cursor/backward-pagination + persisted per-address high-water sig.
- **F2 (MED):** devnet SOL deposits loop in `swapping` forever (Jupiter has no devnet route). Fix: gate/handle the SOL swap path off when the network can't route; surface a stranded-SOL state instead of an infinite retry.
- **F3 (MED):** scanner has no reentrancy guard (`setInterval` doesn't await) → overlapping passes redundantly fire SOL swaps. Fix: self-chained `setTimeout` or per-address lock.
- **F4 (MED):** sub-minimum dust is re-parsed on every scan forever and pollutes the sig window (amplifies F1). Fix: record dust sigs as a terminal `ignored` row.
- **F5 (LOW-MED):** hot-wallet SOL griefing — every $1 deposit forces a hot-wallet-funded sweep. Fix: sweep only above a cost-multiple threshold; monitor/refill hot wallet.
- **F6 (LOW, mainnet/P4):** SOL→USDC swaps sandwichable at 1% via public RPC. Fix: tighten slippage + private/Jito route at mainnet.
- **F7 (LOW):** HD index allocation can throw a transient 500 under a burst of >3 simultaneous first-time registrations (no collision/fund risk). Fix: DB sequence or single-statement allocation.

### Accepted / deferred (design or out-of-scope for the MVP)
- **Refresh token in `localStorage`** — see Decisions above (deferred to P4).
- **Referral-code enumeration via the 409/200 pre-check** — materially mitigated by the new rate limit on `/referral/code`; codes are public identifiers.
