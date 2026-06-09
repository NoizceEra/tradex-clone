# Liquidity risk-parameter calibration (starting values)

*Source-cited deep-research spike, 2026-06-09 (102 agents, 20 sources, 86 claims → 25 verified →
20 confirmed / 5 killed → 7 synthesized). Proposes STARTING values for the Phase 1–3 liquidity knobs.
Companion to [`liquidity-hybrid-spec.md`](./liquidity-hybrid-spec.md) and
[`liquidity-lmsr-spike.md`](./liquidity-lmsr-spike.md).*

> **⚠️ Everything here is a TO-BE-BACKTESTED starting value, not a final setting.** The numbers are
> engineering choices grounded in researched venue patterns + a derived worst-case gap — *no real
> TCG-perp venue exists to copy from*. The defaults in code stay `0` (disabled / play-money); these
> values are what an operator would set, and validate, before enabling real funds.

---

## 0. The one caveat that governs everything: we don't yet have the daily gap

The dominant risk is the **~daily oracle**: a thin card can gap hard overnight and the 5s liquidation
sweep can't react until the next print. So the single most important input is the **worst-case daily
(overnight) price gap** per market.

**We could not measure it directly.** The only verifiable card series (PriceCharting, PSA-9 Charizard
1st Ed.) is sampled **monthly**, which *bounds but does not measure* the daily gap. Card Ladder index
pages are Cloudflare-gated. So:

- **Single-card worst-case daily gap ≈ 30%** — an *engineering estimate* (between the routine ~25%
  tail and the rare 50%+ event), **not observed at daily granularity**.
- **Diversified-index daily gap ≈ 10–15%** — directionally lower (diversification), also not quantified.

**Before real funds: re-derive `g` from an actual DAILY single-card series** (TCGplayer / pokemontcg.io
daily prints, or Card Ladder daily data) for the specific cards to be listed. Every number below scales
off `g`.

## 1. What the data does show (monthly, single blue-chip card)

PSA-9 Charizard 1st Ed., 64 monthly steps: **>10% in 38%** of steps, **>25% in 16%**, **>50% in ~3%**;
tails **+68.5%**, **+53.6%**, **−32.9%**. Even a *blue-chip graded* single is this volatile; thin
long-tail cards are worse. Indexes move materially less (diversified). *(Sources: PriceCharting;
Card Ladder index pages.)*

## 2. How real venues set these knobs (the patterns we copy)

All of these run **continuous 24/7 oracles** — strictly *easier* than our daily oracle — so we should
sit **at or below their most-illiquid settings**:

| Venue | Illiquid / long-tail setting | Source |
|---|---|---|
| dYdX | Long-Tail tier ~5x (20% IMF, 10% MM); Safety tier **1x** (100% IMF) | dYdX liquidity-tier docs |
| Hyperliquid | Floors at **3x**, MM = 16.7%; tiers step down by notional | Hyperliquid margin-tier docs |
| GMX V2 | OI capped as a fraction of pool TVL via **reserveFactor**; trader-PnL cap **90%** of pool, ADL at **85%** | gmx-synthetics repo |
| LS-LMSR | depth/liquidity grows with cumulative volume; `α = v/(n·log n)` for target vig `v` (~5–20%) | Othman et al. |

Key relationship: **max leverage ≈ 1 / (worst-case gap before liquidation can act).** A ~30% single-card
gap ⇒ a position's margin should roughly cover a full adverse gap ⇒ **~2–3x for cards**.

## 3. Proposed starting parameters

| Parameter | Code knob | Play-money default | **Real-funds starting value** | Basis |
|---|---|---|---|---|
| Max leverage — cards | `markets.max_leverage_e2` | 20x | **2–3x** | `≈1/g`, below dYdX/HL illiquid floor |
| Max leverage — index | `markets.max_leverage_e2` | 20x | **5–8x** | index `g≈12%`; HL/dYdX mid-tier |
| Maint. margin — cards | `markets.maint_margin_bps` | 250 (2.5%) | **~1500 bps (15%)** | HL pattern MM ≈ ½·(IM at max lev) |
| Maint. margin — index | `markets.maint_margin_bps` | 250 (2.5%) | **~700 bps (7%)** | same, at 5–8x |
| Per-market OI cap — cards | `markets.max_oi_*_uusdc` | $50k | **≤ 0.3–0.5 × NAV** | so one market's worst-case PnL `(OI×g)` ≤ ~10–15% NAV |
| Per-market OI cap — index | `markets.max_oi_*_uusdc` | $250k | **≤ ~1 × NAV** | `g≈12%`; capped below the 2×NAV theoretical |
| Open-gate | `MAX_PNL_FACTOR_BPS` | 0 (off) | **~5000–6000 (50–60%)** | pause opens at half-to-60% of NAV owed |
| ADL trigger | `ADL_PNL_FACTOR_BPS` | 0 (off) | **~7000–8000 (70–80%)** | force-close before insolvency; **≥ open-gate** (§4) |
| Depth α | `DEPTH_ALPHA_E6` | 1.0 | **calibrate** (§5) | so a typical trade's premium is a few % at expected volume |

The OI cap is the lever that fixes the deep-QA finding (a single position's PnL exceeding NAV): tying
`OI_cap ≈ 0.3–0.5×NAV` keeps one market's worst-case `OI×g` to ~10–15% of NAV.

> **✅ Built (Phase 4a): `OI_CAP_NAV_BPS`.** The engine now enforces a NAV-relative per-side OI cap
> automatically — each side's OI can't exceed `OI_CAP_NAV_BPS` of LP NAV, *on top of* the static
> per-market cap (the binding one wins). 0 = disabled (play-money default). Set it to ~3000–5000 for
> real funds. This removes the "operator must hand-set the right dollar cap per market" footgun; the
> static `max_oi_*_uusdc` columns remain as an additional fixed ceiling. Verified live: under
> `OI_CAP_NAV_BPS=5000`, the same +30% gap that drove NAV to −$825 leaves the pool solvent
> (NAV $10k → $8.8k) because the oversized position is rejected at open.

## 4. Open-gate vs ADL ordering — keep `adl ≥ maxPnl` (reconciling the GMX finding)

The research flagged that GMX runs **ADL (85%) *below* its trader cap (90%)** and called our
`adl ≥ maxPnl` rule "inverted." **It isn't — the two mechanisms differ:**

- **GMX's `maxPnlFactorForTraders` is a profit *hard-cap*** — traders literally cannot realize more than
  90% of pool value. ADL fires at 85% *to avoid ever hitting that clamp*. So ADL sits below the cap.
- **Our `maxPnlFactorBps` is an *open-gate*** — it only *pauses new opens*; it does **not** clamp anyone's
  realized profit (winners are paid in full — that's what ADL itself does). We have **no profit hard-cap.**

For our structure the right escalation is: the **gentle** intervention (pause new opens) fires at a
**lower** liability, and the **aggressive** one (force-close existing winners) fires **higher**, just
before insolvency. So **`adl ≥ maxPnl` is correct**, and the load-time config guard stays. Proposed:
open-gate **50–60%**, ADL **70–80%** of NAV.

*(Adopting a GMX-style profit hard-cap + ADL-below-it is a different design — a possible Phase-4 option,
not the engine as built.)*

## 5. Depth α

LS-LMSR gives `α = v/(n·log n)` to emulate a target vig `v` (real makers run ~5–20%), and confirms depth
should grow with cumulative volume — which validates our `depth = max(NAV, floor, α·cumulativeVolume)`.
But our `α` multiplies **dollar** volume and is floored by `max(NAV, floor)`, so it's a *depth-scaling
coefficient*, not the dimensionless LS-LMSR vig — the formula is a **structural analogy, not a drop-in**.
**Calibrate empirically:** choose `α` so that at a market's *expected steady-state OI*, a typical trade's
premium (`k·skew/depth`) lands at a few percent. With `α=1.0`, depth only exceeds the $1M floor once a
market's cumulative volume passes $1M — fine as a starting point; tune against real volume.

## 6. Worst-case-loss check (does the pool stay solvent?)

`loss ≈ (max OI) × (adverse daily gap g) × leverage − collected margin/funding, reduced by ADL/insurance`

With cards at **2–3x** (margin = 33–50% of notional), a **30%** gap is *largely absorbed by the trader's
own margin* — liquidation triggers with little bad debt. For a **winner**, ADL caps the upside. With
`OI_cap ≈ 0.3–0.5×NAV`, one market's worst-case trader profit the pool must pay is **≤ ~10–15% of NAV**;
the open-gate (50–60%) and ADL (70–80%, firing first as liability climbs) bound *aggregate* liability
**below NAV** even if several markets gap adversely at once. **The LP vault stays solvent for a given NAV
provided** (a) per-market OI caps are enforced, (b) ADL fires below insolvency, and (c) an **insurance
buffer** covers the slippage between the liquidation trigger and the actual fill on the *next daily print*.

## 7. Must-validate before real-funds launch

1. **Measure the daily gap `g`** from a real DAILY single-card series for the listed cards — *the
   governing input*; everything scales off it. (The verified data is monthly.)
2. **Size the insurance fund** vs NAV/OI to cover the liquidation-trigger → next-print fill gap. **No
   venue has a daily oracle, so this buffer has no precedent — it needs its own simulation.**
3. **Backtest** the proposed leverage / MM / OI caps against the daily gap distribution (worst-case +
   simultaneous multi-market gaps).
4. **Re-pull venue params at build time** — Hyperliquid/dYdX/GMX settings are governance-adjustable and
   change often (e.g. HL cut BTC to 40x after a March 2025 HLP loss).
5. **Calibrate `α`** against expected per-market volume for a sensible few-percent premium.
6. **Consider dynamic caps** — step leverage/OI down as a market's OI grows (Hyperliquid notional
   brackets, dYdX Lower/Upper-cap IMF), since a single LP vault is the sole counterparty and
   concentration risk on a thin card rises sharply with OI.

## Sources

PriceCharting (Charizard 1st Ed. graded series); Card Ladder index pages; dYdX default-liquidity-tier
docs; Hyperliquid margin-tier + liquidation docs; GMX `gmx-synthetics` repo (`config/markets.ts`,
README) + liquidations docs; Othman et al. (LS-LMSR). Confidence: HIGH on the venue patterns and the
monthly card-volatility series; MEDIUM on the instantiated TCG numbers (derived, not observed — no
comparable venue exists).
