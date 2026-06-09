# Liquidity bootstrapping — research & options

*Deep-research run on 2026-06-09. 5 search angles, 22 sources fetched, 103 claims extracted →
25 verified → 21 confirmed, 4 refuted, 17 kept after synthesis. The session that produced this
was AUP-blocked before it could be read back, so the findings are recovered and written up here.*

---

## The problem, in plain English

To trade a market on GachaDex today, **someone has to put up the liquidity first** — us or players —
otherwise there's nobody on the other side of the trade and the market just doesn't work.

We're new. Few players, not much money. But we want **every card and every index tradeable from day
one**, and we're using **real USDC**, so whatever we do **can't be drainable** — there has to be a
hard, known cap on the worst case the house can lose.

So the question was: *how do other platforms make every market tradeable without seeding each one and
without needing lots of player liquidity — and which of those is safe for real money?*

## What "liquidity" even means here (quick grounding)

A market needs a **counterparty** — something willing to take the other side of your bet at a fair
price, at any time. There are only three ways to get one:

1. **Other traders** — needs lots of users. We don't have them yet.
2. **A pool we fund** — always there, but now *the house carries the risk* if traders win.
3. **A formula that always quotes a price** — always there, risk is a *known fixed cost* we pay.

The research basically maps every real platform onto #2 or #3.

---

## The two approaches that actually work

### Approach 1 — One shared pool backs every market

*(Hyperliquid HLP, GMX, Drift)*

One pool of money acts as the counterparty for **all** markets at once. Any market is instantly
tradeable because the pool is always there to take your trade. This is basically **what we already
have** with our single global LP vault.

- **The catch:** the pool is **not market-neutral** — when traders win, the pool pays them. So the
  house carries real risk and the pool can bleed if it isn't capped.
- **How the big players make it safe:** GMX bounds the worst case with **layered hard caps** — limits
  on how big positions can get per market, a cap on how much pending trader profit can drain the pool,
  a reserve so withdrawals always work, and **auto-deleveraging** (force-closing winning positions
  when the pool gets too exposed). Drift adds a spread that **widens automatically** the more lopsided
  the pool gets, so it defends itself in thin markets.

### Approach 2 — A formula is the counterparty (LS-LMSR)

*(prediction-market math: LMSR and its volume-aware version LS-LMSR)*

Instead of a pool of money, a **formula** always quotes both a buy and a sell price on every market.
It needs **no other traders and no LPs present** — anyone can trade any market at any time.

- **The big win:** the house's **maximum possible loss is a known number you can compute before you
  even open the market**, and with the volume-aware version (LS-LMSR) that number **shrinks toward
  zero** as you start with less seed liquidity. This is the single best fit for "launch every market
  from almost no capital, with a safe, pre-known worst case."
- **The catch:** it's still a **subsidy** — the house pays that capped cost; it's not free or neutral.
  And it's proven math for **yes/no prediction markets**, *not* for a continuous-price leveraged perp
  with funding and liquidations. Adapting it to our product is real work, not copy-paste (see Open
  questions).

---

## The cautionary tale — why we can't just fake liquidity naively

Perpetual Protocol v1 used a **fixed virtual pool** (the simplest "just make up liquidity" approach).
It went badly, and it's directly relevant to us:

- When more traders are on one side (a trending market), the imbalance gets **paid out of the
  insurance fund** — a slow, constant bleed. Card prices **trend hard** (hype cycles, set rotations),
  and our price updates only **once a day**, so one-sided markets are our *normal* case, not the
  exception.
- A **single** thin, volatile market (their "CREAM" market) created **>$2M of bad debt** in one
  liquidation and nearly drained the shared backstop. **Every TCG card is a thin, long-tail,
  daily-priced market sharing one pool** — exactly the setup that broke them.

**Takeaway:** a shared pool is fine, but only with hard caps. A naive fixed virtual pool with no caps
is how you get drained.

> **Note on pump.fun:** you specifically asked about pump.fun's virtual/bonding-curve liquidity. The
> research found **no verified claim** that it maps safely onto a *leveraged perp*. Pump.fun's curve
> is for one-directional *spot token launches*, not two-sided margined trading. Treat this as an open
> question, not a recommendation.

---

## The options to choose from

These **stack** — they're not mutually exclusive. The realistic path is: pick a **day-one model**
now, layer the rest as we grow.

| Option | What it is | Capital needed | House risk | Best for |
|---|---|---|---|---|
| **A — Capped global vault** *(recommended primary)* | Keep our single global LP vault, but add GMX-style hard caps + auto-deleverage + Drift-style widening spread | Low–medium (the vault) | Bounded by caps | Being live everywhere now with our existing engine |
| **B — LS-LMSR formula quoter** | A formula is the counterparty for thin/long-tail markets; pre-known, near-zero worst-case loss | Near zero | Known fixed cap per market | Making the long tail of cards tradeable from almost nothing |
| **C — Rent outside market-makers** | Kalshi-style designated MM program + Polymarket-style per-market reward pots | Low (bounded subsidy) | House-neutral | Later, once we have volume worth paying makers for |
| **D — JIT auction** | Drift-style 5-second auction lets outside MMs compete to fill, taking over from our backstop | None | Offloaded to MMs | The long-term architecture target |

**The report's recommendation:** **A as the day-one backbone**, **B for thin/long-tail markets**, and
**C → D layered on as volume grows.** A and B are the real near-term fork; C and D are "later."

---

## Caveats (read before acting)

- **Numbers aren't given.** The *mechanisms* are verified, but every risk dial — position caps,
  profit-drain caps, reserve %, the LS-LMSR `b`/`α` parameters — was **deliberately not invented**.
  We must set those from our own risk modelling against real-USDC exposure, not copy them.
- **LS-LMSR is prediction-market math.** Its bounded-loss proof is for discrete yes/no outcomes.
  Mapping it to a continuous-price leveraged perp with funding + liquidations is a non-trivial
  adaptation the sources don't cover.
- **pump.fun virtual reserves: unanswered**, as above.
- **Genuine market-neutrality isn't available on day one.** Every "tradeable from launch" model here
  is capped-downside *house-risk*, not neutral. True neutrality only comes from outside MMs (Option C),
  which we can't rely on with few users. So the honest framing is **bounded house risk now,
  neutrality later.**

## Open questions to resolve before building

1. How do pump.fun-style virtual reserves map onto a leveraged perp (if at all), and what's the
   real-funds worst case if virtual depth is the only liquidity?
2. Can LS-LMSR's bounded-loss guarantee be soundly adapted to a continuous-price perp with funding and
   liquidations — and what's the per-market worst-case USDC formula once leverage is involved?
3. What real numeric parameters (caps, reserve %, `b`, `α`) suit thin, ~daily-priced TCG markets?
4. Given the ~daily price feed (+ manual override, see ROADMAP §2), how do we handle price gaps so a
   single thin market can't open a huge gap and drain the pool (the Perp-v1 CREAM scenario)?

## Sources

22 sources across Hyperliquid (HLP), GMX (GLV/GM, ADL), Drift v2 (backstop AMM, JIT auction), Kalshi
(designated-MM program), Polymarket (sponsor rewards), Perpetual Protocol v1 (vAMM post-mortem), and
the LMSR / LS-LMSR academic literature. HLP/GMX/Drift/Kalshi/Polymarket docs are current (2025–2026);
the Perp-v1 material is a 2021–2022 post-mortem (still valid as a design lesson); LMSR/LS-LMSR is
stable foundational theory (~2002–2010).
