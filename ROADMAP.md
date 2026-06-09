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
