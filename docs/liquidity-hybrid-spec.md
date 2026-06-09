# Liquidity hybrid (A + B) — spec & feasibility

*Follows the decision in [`ROADMAP.md`](../ROADMAP.md) §4 and the research in
[`liquidity-research.md`](./liquidity-research.md). Grounded in the current engine code
(`apps/api/src`, `packages/pricing`), not in the abstract options.*

---

## 0. Reality check — what the code actually does today

Before speccing, the premise "we require LP bootstrapped per market or trading doesn't work" needs
correcting against the code:

- **There is no per-market LP.** There is **one global LP vault** (`lp_pool`, ERC-4626-style shares —
  `apps/api/src/services/lp.ts`). All trader PnL settles against the single `LP_POOL` ledger account
  (`engine.ts:351`). One global `INSURANCE_FUND` backs all markets.
- **Every market already quotes a price from day one** *on an empty pool*. The mark formula falls back
  to a **virtual depth floor of $1M** (`DEPTH_FLOOR = 1_000_000_000_000n`, `marks.ts:7`) **only when NAV
  is exactly zero**, so `premium = clamp(k · skew/depth, ±cap)` stays small on a fresh, unfunded market.

  ```
  premium = clamp(k · skew/depth, ±premiumCap)          // packages/pricing/src/index.js:157
  mark    = clamp(index · (1 + premium), ±maxDev)        // index = oracle/manual price
  depth   = NAV > 0 ? NAV : $1M floor                    // marks.ts:25  (floor only when empty!)
  ```

  > **⚠️ Thin-pool gotcha (verified in test):** the floor is a *fallback*, not a minimum. The moment any
  > real LP capital lands, `depth = NAV` — so a thinly-funded pool (e.g. $1k) divides a $5k skew by $1k
  > and pins the premium straight to its cap (mark jumps the full ±`premiumCap`). This is a strong
  > argument for **B′** to make depth `max(NAV, α·volume, floor)` rather than today's NAV-or-floor.

- **So the real gap is solvency, not quoting.** Trading "doesn't work" on an underfunded pool because
  when traders **net-win**, `LP_POOL` would go negative — there's no money to pay them. The insurance/
  socialization path (`engine.ts:502-512`) only covers trader **losses** that become bad debt; it does
  nothing for net trader **winnings** against a thin pool.

**Conclusion:** the hybrid's job is not "make markets quotable" (already true) — it's **(A) bound the
house's downside so a thin/underfunded pool can't be drained, and (B) make the virtual depth honest
and per-market so thin markets are priced and risk-bounded without manual seeding.**

---

## 1. Feasibility verdict (TL;DR)

| | Verdict | Why |
|---|---|---|
| **A — Capped global vault** | ✅ **Feasible, incremental** | The vault, per-side OI caps, insurance, and socialization already exist. Only ADL + a pool-health gate + a PnL-factor cap are missing. Pure additions, no rewrite. |
| **B — LS-LMSR "drop-in bounded-loss counterparty"** | ❌ **NOT feasible — VERIFIED** | LS-LMSR's bounded-loss proof is for **discrete-outcome prediction markets with a terminal settlement**. Our product is a **continuous-price leveraged perp with funding + liquidations and no settlement event**. The `b·ln(N)` / `C(q0)` guarantee does **not** transfer (see §3). Confirmed HIGH-confidence by an adversarial math spike — [`liquidity-lmsr-spike.md`](./liquidity-lmsr-spike.md). |
| **B′ — LS-LMSR-*inspired* adaptive depth** | ✅ **Feasible and clean** | The *liquidity-sensitive depth shape* `b(q)=α·Σq` ports directly into our existing `depth` term, replacing the crude fixed $1M floor per-market. Bounded house risk then comes from A's caps + margin, **not** from the scoring rule. |

**Bottom line: the hybrid is feasible — but B must be reframed.** Build A's caps, and implement B as a
per-market *adaptive depth* (B′), not as a self-bounding LMSR counterparty. The "provable bounded loss"
you get is from caps + maintenance margin + ADL + oracle-gap handling, which is the honest mechanism
for a leveraged perp.

---

## 2. Part A — Capped global vault (what to add)

Everything settles against the global pool already. A is about bounding how much that pool can lose.

**Already present (reuse):**
- Global LP vault + share accounting — `lp.ts`
- Per-side, per-market OI caps ($50k card / $250k index) — `markets.ts:5`, enforced `engine.ts:229`
- LP-withdrawal reservation (`nav - payout ≥ reserved`) — `lp.ts:82`
- Insurance fund → socialization on bad debt — `engine.ts:502-512`
- Isolated-margin liquidation, 5s sweep — `engine.ts:458`, `index.ts:106`

**Missing (build):**

1. **Pool-health gate on opens.** Today nothing blocks new positions when the pool is thin relative to
   exposure — opens are only capped per-market-side, and withdrawals are the only NAV check. Add a gate
   in `openPosition` (before the OI check at `engine.ts:229`): reject/▾reduce-only when
   `reserved / NAV` or `pendingTraderProfit / NAV` exceeds a configured ceiling. This is the single
   highest-value cap — it's what stops a thin pool being drained by net winners.
2. **PnL-factor cap (MAX_PNL_FACTOR).** Cap how much *pending* trader profit is allowed against pool
   value before new same-direction risk is refused. New config + check alongside (1).
3. **Auto-deleverage (ADL).** None exists (confirmed: no `deleverage`/`ADL`/`pnlFactor` in `apps/api`).
   When pending-profit-to-NAV breaches a higher threshold, force-reduce the most-profitable positions
   (rank by profit, close at mark) until the ratio is safe. Hooks into the existing liquidation sweep
   (`liquidateEligible`, `engine.ts:555`) — same machinery, different trigger.

**Effort:** moderate. (1)+(2) are a config + one guard in the open path + tests. (3) is a new sweep
branch reusing the liquidation/close plumbing. No schema rewrite; `lp_pool` already tracks
`reserved_for_oi_uusdc`.

---

## 3. Part B — why the literal LS-LMSR doesn't transfer, and what does

### Why the bounded-loss guarantee does NOT carry over

LS-LMSR (Othman et al., 2010; LMSR is Hanson, 2002/2007) is a **scoring rule over a discrete set of
mutually-exclusive outcomes** that **resolve once**. Its safety theorem — operator worst-case loss
≤ `b·ln(N)` (LMSR) / `C(q0)→0` (LS-LMSR) — relies on two things our product doesn't have:

1. **A terminal settlement event.** The bound is the most the operator can pay out *when an outcome
   resolves true*. A perpetual **never settles** — it marks-to-market against an oracle forever and
   pays funding. There is no `N` outcomes and no `ln(N)` to bound.
2. **No leverage.** The cost-function math has no notion of margin, leverage, or liquidation. A 20x
   position's loss path is governed by oracle gaps and liquidation timeliness, which the scoring rule
   doesn't model at all.

So "use LS-LMSR as the counterparty and inherit a provable real-USDC loss cap" is a **category error**
for a leveraged perp.

> **VERIFIED (2026-06-09).** An adversarial deep-research spike — framed to *refute* this claim — came
> back **"does not transfer," HIGH confidence**, and found an **impossibility theorem** (Gao-Chen /
> Gao-Pennock: a responsive continuous-outcome maker cannot be bounded-loss). The non-transfer is
> over-determined — it breaks independently at the no-terminal-settlement step, the continuous-outcome
> step, *and* the leverage step. The one continuous-space bounded-loss construction that exists (Chen
> et al. EC'13) works only for **binary, terminally-resolving, unleveraged** interval securities. Full
> write-up + sources: [`liquidity-lmsr-spike.md`](./liquidity-lmsr-spike.md).
>
> The spike also gave the **actual** per-market loss cap for a perp:
> `≈ (max OI) × (max adverse oracle gap before liquidation) × leverage − collected margin/funding,
> reduced by ADL/insurance` — an oracle/leverage/size formula, **not** `b·ln(N)`. The ~daily oracle
> cadence is the dominant multiplier, which makes oracle-staleness halts + thin-market leverage caps
> load-bearing (this is the quantified Perp-v1 "CREAM" risk).

### What *does* transfer — liquidity-sensitive adaptive depth (B′)

The useful, portable idea is LS-LMSR's **liquidity-sensitive depth**: `b(q) = α · Σ q_i` — liquidity
*grows endogenously with accumulated volume*, so the operator never has to pre-guess a market's size.
That maps **directly** onto our existing `depth` term:

```
// before:  depth = NAV > 0 ? NAV : $1M floor                    // global, NAV-or-floor (gotcha)
// B′:      depth_m = max(NAV, floor, α · cumulativeVolume_m)     // per-market, self-deepening
```

> **IMPLEMENTED (Phase 2).** `marketDepth()` in `engine.ts` now returns `max(NAV, depthFloorUusdc,
> α·cumulativeVolume_m)`, fed into `refreshMark`. NAV is kept as a lower bound so depth is **never
> shallower than the old behavior** (no market gets more volatile), the floor fixes the thin-pool
> gotcha, and a per-market `markets.cumulative_volume_uusdc` counter (bumped via `insertFill` on every
> open/close/liquidation) makes each market deepen with its own flow. Config: `DEPTH_FLOOR_UUSDC`
> ($1M), `DEPTH_ALPHA_E6` (1.0). See `adaptive-depth.test.ts`.

- Replaces the one-size-fits-all $1M floor with a **per-market** depth that starts small and **deepens
  as real volume flows in** — exactly the "launch from near-zero, auto-scale" property we wanted.
- Slots into `syntheticMark()` (`packages/pricing/src/index.js:157`) with **no settlement-model
  change** — it only feeds the price-impact term. Lowest-risk way to get B's benefit.
- **Bounded house risk on thin markets then comes from A** (pool-health gate + per-market OI cap +
  maintenance margin + ADL), not from the depth curve. The depth curve controls *price impact*; the
  caps control *solvency*.

**Effort:** small–moderate. Needs a per-market `cumulative volume` counter (we already sum OI/notional
in `oi.ts`), an `α` and per-market `floor`, and swapping the depth source in `refreshMark`/`marks.ts`.

> **⚠️ Implementation caveat (from the spike) — RESOLVED.** Augur removed LS-LMSR in v2 citing
> fixed-point `exp()` precision issues. We sidestepped that entirely: depth is a **linear** function of
> cumulative volume (`α·Σvolume`), all BigInt micro-USDC, **no `exp()`** — so the precision class that
> bit Augur doesn't apply. (A future decaying/windowed volume term, if wanted, must keep this property.)

---

## 4. Routing — which markets are "thin"

B′ is per-market depth, so routing is just a parameter, not a separate engine:

- **Liquid** (real LP depth ≥ threshold, or volume above a bar): `depth = LP free capital`.
- **Thin / long-tail** (most cards, daily-priced): `depth = max(α · volume, floor)` — the adaptive
  curve, with a **tighter per-market OI cap** and the pool-health gate doing the bounding.

No second codebase. One mark formula, a per-market depth source, and per-market caps.

---

## 5. The actual day-one risk to design against: oracle gaps

The research's #1 cautionary data point (Perp v1 "CREAM": one thin market, >$2M bad debt) is **our**
profile: thin, long-tail, **~daily** price feed (`ORACLE_REFRESH_MS = 6h`, but TCGplayer updates ~1×/
day — see ROADMAP §3). A big overnight gap on a thin market is the realistic drain vector. Mitigations,
all of which lean on A, not B:

- Tighter maintenance margin / lower max leverage on thin markets (raises the liquidation buffer).
- Funding/spread that widens with staleness and skew (the premium term already widens with skew).
- The staleness circuit-breaker already halts markets at >36h (`engine.ts:583`) — consider tightening
  for thin markets and pairing with the manual-price override (ROADMAP §2, already merged).

---

## 6. Recommended build sequence

1. **Phase 1 — A's caps. ✅ DONE.** Pool-health gate on opens (GMX-style MAX_PNL_FACTOR), off by
   default. `engine.ts` `poolPnlLiability` + gate, `pool-risk.test.ts`.
2. **Phase 2 — B′ adaptive per-market depth. ✅ DONE.** `depth = max(NAV, floor, α·cumulativeVolume)`,
   per-market volume counter via `insertFill`, no `exp()`. `adaptive-depth.test.ts`. *(Still open:
   per-market OI caps + thin-market margin/leverage tuning — fold into calibration, see §7.)*
3. **Phase 3 — ADL.** Add the auto-deleverage sweep branch as the backstop for Phase 1's caps. Route
   its fills through `insertFill` (so volume is recorded automatically).
4. **Phase 4 (optional, later) — C/D.** Designated-MM rewards / JIT auction to rent house-neutral
   liquidity once volume justifies paying makers.

## 7. Math spike — DONE (2026-06-09)

The load-bearing uncertainty (is a true bounded-loss scoring-rule quoter worth pursuing for thin
markets?) was settled by an adversarial deep-research spike — full report:
[`liquidity-lmsr-spike.md`](./liquidity-lmsr-spike.md).

**Result: the scoring-rule loss bound does NOT transfer to a leveraged perp (HIGH confidence).** So B
is strictly B′ (adaptive depth), and the solvency guarantee comes from caps + margin + ADL + oracle-
staleness halts. Proceed with Phases 1–3. Two items the spike added to the plan:

- **⚠️ Validate `b(q)` in fixed-point before relying on it.** Augur removed LS-LMSR in v2 over
  fixed-point `exp()` precision problems. Even the depth-only borrowing (B′) needs a numerical-safety
  check at real-USDC precision — fold into Phase 2.
- **Calibrate the gap term.** Before sizing per-market OI/leverage caps, measure the worst-case adverse
  oracle gap for thin TCG underlyings between ~daily updates and plug it into the loss-cap formula in §3.

## 8. Effort & risk summary

| Piece | Effort | Risk | Depends on |
|---|---|---|---|
| Pool-health gate + PnL-factor cap (A) | Small–moderate | Low | — |
| ADL sweep (A) | Moderate | Low–med (reuses liquidation plumbing) | gate/cap |
| Per-market adaptive depth (B′) | Small–moderate | Low (price-impact only, no settlement change) | per-market volume counter |
| Thin-market margin/leverage + staleness tuning | Small | Low | — |
| True bounded-loss LMSR counterparty (B literal) | High | **High / likely infeasible** | math spike first |
