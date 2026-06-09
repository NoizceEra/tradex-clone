# GachaDex — Roadmap & Deferred Decisions

Living doc for design decisions we've deliberately deferred, with the reasoning so we don't
re-litigate them from scratch later.

---

## 1. Margin model: isolated → cross (deferred)

**Decision (2026-06-09): stay ISOLATED for now.** Revisit before mainnet, or whenever the product
explicitly targets Aster-style cross-margin.

**Current behaviour (isolated margin):** a position's loss is **capped at that position's margin**.
If a price gap pushes the loss past the margin, the excess is "bad debt" → drawn from the
**insurance fund** → any remainder **socialized to the LP pool**. A trader can never lose more than
the margin they put on a position; their other balance is never at risk.

**Why we'd change it:** real futures (and our reference exchange, Aster, which shows **"Cross"** in
the Margin column) let a position draw on the trader's **whole account equity** — so a volatile gap
can cost more than the position's margin, up to the full balance, before insurance / auto-deleverage
kick in. With our **daily** price feed (see §3), large overnight gaps are realistic, so isolated mode
pushes more gap-risk onto the insurance fund / LPs than a cross model would.

**Isolated (now) vs Cross (if implemented):**

| | Isolated (current) | Cross (future) |
|---|---|---|
| Max loss on a position | the position's margin | the whole account balance (then insurance/ADL) |
| Liquidation price | from the position's margin only | from **total account equity** |
| Withdrawable balance | collateral − locked margin | collateral − margin − **unrealized losses** |
| Insurance fund | hit on any gap past a position's margin | only hit when the **whole account** is wiped |

**Scope to switch:** liquidation logic (debit up to full collateral, not capped at margin), the
liq-price formula (account-equity based), the free-balance / withdrawal check (must reserve for
unrealized losses — directly affects the custody↔trading withdrawal boundary), and the UI
(show "Cross", break-even price, etc.).

**Options when we revisit:**
1. Cross-margin globally (matches Aster; biggest change).
2. Isolated + cross toggle per position (Binance/Bybit style; most work).
3. Keep isolated, mitigate gap-risk via tighter maintenance margin / lower max leverage.

---

## 2. Manual price override (admin) — planned

**Why:** the only automated feed is pokemontcg.io (TCGplayer market price), which updates **~once a
day** and covers **Pokémon only**. Many real price sources — eBay sold listings, other marketplaces —
have **no API**. Operators need to set/override a market's price manually as they check those sources.

**Proposed approach:** a manual price is recorded through the **same path as the oracle** — write an
accepted oracle print, then recompute the mark — so it flows consistently into mark price, liquidation
checks, and the staleness circuit-breaker (a manual print also refreshes the "fresh price" timestamp).
Per-market (card or index).

**Open considerations:**
- Admin routes are currently gated behind `REAL_FUNDS`; manual pricing must also work in **play-money
  mode**, so admin-key auth needs decoupling from `REAL_FUNDS` (or a separate ops route group).
- **Audit trail:** record who set what price and when.
- **Sanity bounds:** optionally reject absurd deviations from the last price to prevent fat-finger
  liquidations.
- **Index markets:** decide whether a manual override sets the basket value directly or is card-only.
- **Surface:** HTTP admin endpoint + runbook first; a web admin panel later.

---

## 3. Price cadence (context for the above)

- Source updates **~once a day** — verified: `tcgplayer.updatedAt` is a date, not a timestamp.
- We re-pull every 6h (`ORACLE_REFRESH_MS`); the liquidation sweep runs every 5s
  (`LIQUIDATION_SWEEP_MS`) — cheap (local DB), mainly catches trade-driven mark moves and reacts
  promptly after each ingest. **5s stays.**
- The **daily feed is the real constraint.** Manual override (§2) is the near-term mitigation; a
  higher-frequency price source is a longer-term option.

---

## 4. Liquidity bootstrapping (researched, decision pending)

**Problem:** today a market needs LP seeded (by us or players) or trading doesn't work — but we want
**every market tradeable from day one** with little capital and **bounded real-USDC risk**.

**Researched 2026-06-09** — full write-up in [`docs/liquidity-research.md`](docs/liquidity-research.md).
Short version of the options (they stack; A/B is the near-term fork):

1. **A — Capped global vault** *(recommended primary)*: keep our single global LP vault, add GMX-style
   hard caps + auto-deleverage + Drift-style widening spread. Live everywhere now, risk bounded by caps.
2. **B — LS-LMSR formula quoter**: a formula is the counterparty for thin/long-tail markets; near-zero
   capital, pre-known worst-case loss per market. (Adapting prediction-market math to a leveraged perp
   is non-trivial — see doc.)
3. **C — Rent outside MMs** (Kalshi designated-MM + Polymarket per-market rewards): house-neutral, layer
   on as volume grows.
4. **D — JIT auction** (Drift-style): outside MMs take over from the backstop; long-term target.

**Cautionary tale:** a naive fixed virtual pool (Perp v1 vAMM) structurally drains under trending,
one-sided, thin markets — exactly our profile (daily price + long-tail cards). Caps are mandatory.

**Decision (2026-06-09): A + B hybrid.** Capped global vault (A) backs liquid markets; an LS-LMSR
formula quoter (B) is the counterparty for thin/long-tail cards (the common case — most cards are
thin + daily-priced). C and D layer on as volume grows.

**Math spike (2026-06-09) — settled:** LS-LMSR's bounded-loss proof does **NOT** transfer to a
leveraged perp (HIGH confidence; over-determined + an impossibility theorem). So **B is "adaptive
depth" only (B′)** — the hard USDC loss cap comes from caps + maintenance margin + ADL + oracle-
staleness halts, with per-market worst case `≈ (max OI) × (adverse oracle gap) × leverage − margin/
funding`. Full reports: [`docs/liquidity-hybrid-spec.md`](docs/liquidity-hybrid-spec.md),
[`docs/liquidity-lmsr-spike.md`](docs/liquidity-lmsr-spike.md).

**Build sequence (no work started):** Phase 1 — pool-health gate + PnL-factor cap; Phase 2 — per-market
adaptive depth (validate `b(q)` in fixed-point first — Augur dropped LS-LMSR over `exp()` precision);
Phase 3 — auto-deleverage; Phase 4 (later) — rent house-neutral MMs (C/D). Calibrate the daily-feed
gap term before sizing per-market OI/leverage caps.
