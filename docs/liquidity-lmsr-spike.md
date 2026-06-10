# Math spike — does LS-LMSR's bounded-loss guarantee transfer to a leveraged perp?

*Adversarial deep-research spike, 2026-06-09 (103 agents, ~3.3M tokens, ~45 min, 21 sources, 101
claims → 25 verified → 22 confirmed / 3 killed → 10 after synthesis). The question was framed to
**try to refute** the "does not transfer" claim from [`liquidity-hybrid-spec.md`](./liquidity-hybrid-spec.md) §3.*

---

## Verdict: **DOES NOT TRANSFER** — confidence HIGH

LMSR's `b·ln(N)` and LS-LMSR's `C(q0)→0` worst-case operator-loss guarantees **cannot be soundly
transferred to a continuous-price leveraged perpetual**. This isn't "we couldn't find a way" — the
spike found an **impossibility theorem** that actively argues no such construction can exist for the
responsive continuous case, and the failure is **over-determined**: it breaks independently at three
separate steps, any one of which is fatal.

### Why it breaks (three independent failures)

1. **No terminal settlement.** The scoring-rule bound is *defined* as `C(q0) − C(q) + q_iᵢ` where `q_i`
   is the payout owed **when exactly one of N exhaustive outcomes resolves, once**. A perpetual never
   realizes a terminal `q_i` — it marks-to-market forever — so the telescoping identity that produces
   the bound never closes. *(Othman/Sandholm/Pennock/Reeves EC'10 + TEAC, read verbatim.)*

2. **Continuous outcome space (fatal before leverage is even added).** Gao-Chen (2010) / Gao-Pennock
   proved **any** reasonable continuous-outcome market maker whose beliefs are a probability *density*
   has **unbounded** worst-case loss — equivalently, a continuous-outcome maker **cannot be both
   "responsive price" and "bounded loss."** A leveraged perp's price lives in `[0, ∞)`, a continuous
   outcome space. *(Gao-Chen "Betting on the Real Line"; Chen/Ruberry/Wortman Vaughan EC'13.)*

3. **Unbounded in leverage.** The one framework that *does* achieve bounded loss over a continuous
   space (Chen et al. EC'13, by allowing point-mass measures) proves loss is **unbounded in the
   leverage multiplier `k`**. Leverage `L·(p − entry)` has no finite sup as the price range or `L`
   grows.

### The one genuine refutation found — and why it doesn't rescue the perp

The adversarial search *did* surface a real counter-construction (and the verifier initially scored it
as refuting the blanket claim): **you can get true constant bounded loss over a continuous variable by
partitioning the range into interval securities** and shrinking the liquidity parameter per submarket.
But on verification it **reinforces** the verdict: it only works because each interval security is a
**binary `$1`/`$0` payoff with a single terminal resolution** — exactly the discrete-resolution
structure a perpetual lacks — and it carries **no leverage**. So the escape hatch from Gao-Chen exists
only for bounded-payoff, terminally-resolving contracts, which a leveraged perp is not.

### No prior art

No academic paper or production system was found implementing a scoring-rule/LMSR-based **leveraged
perpetual** with a proven bounded operator loss. The actual state of the art for perpetual market-
making is **inventory control** (Avellaneda-Stoikov + HJB with inventory and funding as coupled state
variables), which explicitly proves **no** hard loss bound — risk is governed by inventory and
volatility under soft penalties. Recent 2026 work that *does* build perps on prediction-market events
(PIRAP, arXiv:2605.10400) deliberately **reconstructs** bounded-loss discipline through margin + index
design and treats the scoring-rule guarantee as something a perp "does not inherit automatically."

---

## What actually bounds a perpetual's loss (and the formula)

Boundedness for a perp is a **best-effort, exhaustible waterfall** — caps → maintenance margin →
liquidation → insurance → ADL → oracle-staleness halt — **not** a clean pre-computable scoring-rule
constant. The practical per-market hard cap the spike derived:

```
worst-case operator loss per market
  ≈ (max OI) × (max adverse oracle gap before liquidation) × leverage
      − collected margin/funding
      − ADL / insurance recovery
```

This is an **oracle-gap × leverage × size** formula, governed by liquidation timeliness — *not*
`b·ln(N)`. Two consequences for us:

- **The ≈daily oracle cadence is the dominant risk multiplier.** With a stale price, the
  `(true_move − maintenance_margin) × L × size` gap term is large. So **oracle-staleness halts and
  conservative leverage caps on thin/long-tail markets are load-bearing, not optional** — this is the
  quantified version of the Perp-v1 "CREAM" warning in [`liquidity-research.md`](./liquidity-research.md).
- **ADL is an *allocation* mechanism, not a price-discovery one.** It haircuts only *positive*
  unrealized PnL (never posted collateral principal) and its proven bound is an *ex-post*, instance-
  calibrated regret envelope — you can't pre-compute it as a constant either.

---

## Build recommendation (unchanged from the spec, now verified)

- **Borrow LS-LMSR ONLY for liquidity-sensitive *depth*** — the `b(q)=α·Σqᵢ` shape is a sound,
  volume-scaling depth curve (option **B′** in the spec). It controls *price impact*, nothing more.
- **Deliver the hard pre-launch USDC loss bound through caps + maintenance margin + 5s liquidation +
  ADL/insurance + oracle-staleness halts** — not a scoring-rule constant.
- **Do NOT build or market an "LS-LMSR formula quoter as bounded-loss counterparty"** for the
  perpetual. That specific framing (the literal Option B) is confirmed infeasible.

---

## Caveats (how much to trust this)

- **Core verdict — HIGH confidence.** The LMSR/LS-LMSR and impossibility results are **foundational,
  peer-reviewed, read verbatim**, and don't expire. The verdict is over-determined across three
  independent failure points.
- **"No scoring-rule perp exists" is partly argument-from-absence** — an exhaustive negative search
  plus a structural reason (no terminal realization), not a formal non-existence proof. (Though the
  Gao-Pennock impossibility theorem covers the responsive-continuous case.)
- **Two supporting findings are weaker:** funding-doesn't-restore-boundedness (2-1 vote) and the
  LVR/theta-drain analogy (concerns passive *spot* AMMs, relevant to a perp only by analogy).
- **Several perpetual-side sources are 2026 arXiv preprints** (2605.06405, 2605.10400, 2605.10428,
  2602.15182) — on-topic and from recognized researchers (e.g. Gauntlet/Chitra), but not all peer-
  reviewed. The load-bearing theorems are the older, peer-reviewed ones.
- **What would change the verdict:** a peer-reviewed construction expressing a funded, leveraged,
  never-settling perp as a finite-outcome or measurable-space cost-function market whose bound
  *provably survives* continuous marking + funding + leverage without secretly re-capping via
  margin/OI. None was found; an impossibility theorem says not to expect one.

## New open questions surfaced (feed into the build)

1. **Calibrate the gap term.** What is the empirical worst-case adverse price gap for thin/long-tail
   TCG underlyings between ~daily updates, and does `(max OI) × gap × leverage × (1 − maint margin)`
   give a per-market cap small enough for the single global vault to backstop — or are per-market
   OI/leverage caps + auto-halt strictly required before launch?
2. **Can divergence-clamping funding help?** A boundary-aware funding correction / divergence circuit-
   breaker (PIRAP-style) *combined with* caps+margin — does it yield a closed-form pre-computable USDC
   cap? (Funding alone gives only convergence *pressure*, not a hard bound.)
3. **⚠️ Fixed-point safety of `b(q)` itself.** **Augur removed LS-LMSR in v2** citing fixed-point
   `exp()` precision and multi-outcome complexity. Is even the *depth-only* borrowing (B′) numerically
   safe at real-USDC precision? Validate before relying on it.
4. **Single global vault vs per-market isolation.** Does the ADL solvency/revenue/fairness trilemma
   (arXiv:2512.01112) force per-market loss isolation or a dedicated insurance fund before scaling to
   many long-tail markets?

## Key sources

Foundational (peer-reviewed, load-bearing): Othman/Sandholm/Pennock/Reeves, *A Practical Liquidity-
Sensitive Automated Market Maker* (EC'10 + TEAC); Chen/Ruberry/Wortman Vaughan, *Cost-Function Market
Makers for Measurable Spaces* (EC'13); Gao-Chen, *Betting on the Real Line* / Gao-Pennock impossibility
(WINE'09/'10). Perpetual-side (recent preprints): arXiv:2605.06405 (funding-aware perp MM),
arXiv:2605.10400 + 2605.10428 (resolution-aware perps on prediction markets), arXiv:2602.15182
(autodeleveraging as online learning), arXiv:2508.02971 (LVR as continuous-installment options),
arXiv:2512.01112 (ADL trilemma).
