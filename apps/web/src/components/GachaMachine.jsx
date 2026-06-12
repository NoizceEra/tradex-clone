import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { formatUsd } from '@pokex/pricing';

// ─── Rarity model ────────────────────────────────────────────────────────────
// Tiers are assigned by live price rank within the card pool (most expensive first),
// so "rarity" tracks what the market actually says is chase-worthy right now.
const TIERS = [
  { id: 'secret', label: 'SECRET RARE', cut: 0.03 },
  { id: 'ultra',  label: 'ULTRA RARE',  cut: 0.10 },
  { id: 'holo',   label: 'HOLO RARE',   cut: 0.25 },
  { id: 'rare',   label: 'RARE',        cut: 0.55 },
  { id: 'common', label: 'COMMON',      cut: 1.01 },
];
const tierRank = { common: 0, rare: 1, holo: 2, ultra: 3, secret: 4 };

const PACK_SIZE = 5;
// Slot odds: slots 1-3 are filler, slot 4 is upgraded, slot 5 is the "hit" slot.
const SLOT_ODDS = [
  { common: 70, rare: 30 },
  { common: 70, rare: 30 },
  { common: 55, rare: 45 },
  { rare: 60, holo: 40 },
  { holo: 68, ultra: 27, secret: 5 },
];
const PITY_EVERY = 10; // every Nth pack, the hit slot is guaranteed ultra or better

const STATS_KEY = 'gachadex_gacha_stats';
const PULLS_KEY = 'gachadex_gacha_pulls';

function loadJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}

function rollTier(odds) {
  let r = Math.random() * 100;
  for (const [tier, w] of Object.entries(odds)) {
    if ((r -= w) < 0) return tier;
  }
  return Object.keys(odds)[0];
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

const CAPSULE_COLORS = ['#e74c3c', '#3fb950', '#58a6ff', '#f0c040', '#c678dd', '#e8862e'];

export function GachaMachine({ markets, onTradeMarket }) {
  // Pool: live Pokémon card markets with a price and art, tiered by price rank.
  const pool = useMemo(() => {
    const cards = (markets || [])
      .filter((m) => m.kind === 'card' && m.game === 'pokemon' && m.markE6 && m.imageSmall)
      .sort((a, b) => Number(b.markE6) - Number(a.markE6));
    const byTier = { secret: [], ultra: [], holo: [], rare: [], common: [] };
    cards.forEach((c, i) => {
      const pct = (i + 1) / cards.length;
      const tier = TIERS.find((t) => pct <= t.cut).id;
      byTier[tier].push({ ...c, tier });
    });
    return { cards, byTier };
  }, [markets]);

  // phase: idle -> cranking -> dropping -> capsule -> pack -> reveal
  const [phase, setPhase] = useState('idle');
  const [pack, setPack] = useState([]); // 5 drawn cards
  const [flipped, setFlipped] = useState([]); // which reveal slots are face-up
  const [stats, setStats] = useState(() => loadJson(STATS_KEY, { packs: 0, byTier: {} }));
  const [recent, setRecent] = useState(() => loadJson(PULLS_KEY, []));
  const [capsuleColor, setCapsuleColor] = useState(CAPSULE_COLORS[0]);
  const timers = useRef([]);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const after = (ms, fn) => timers.current.push(setTimeout(fn, ms));

  const drawPack = useCallback(() => {
    const pity = (stats.packs + 1) % PITY_EVERY === 0;
    return SLOT_ODDS.map((odds, i) => {
      let tier = rollTier(odds);
      if (i === PACK_SIZE - 1 && pity && tierRank[tier] < tierRank.ultra) tier = 'ultra';
      // fall back down the rarity ladder if a tier bucket is empty (tiny pools)
      const ladder = ['common', 'rare', 'holo', 'ultra', 'secret'];
      let r = tierRank[tier];
      let bucket = pool.byTier[ladder[r]];
      while ((!bucket || !bucket.length) && r > 0) bucket = pool.byTier[ladder[--r]];
      if (!bucket || !bucket.length) bucket = pool.cards.map((c) => ({ ...c, tier: 'common' }));
      return pick(bucket);
    });
  }, [pool, stats.packs]);

  const crank = () => {
    if (phase !== 'idle' || !pool.cards.length) return;
    const drawn = drawPack();
    setPack(drawn);
    setFlipped(Array(PACK_SIZE).fill(false));
    setCapsuleColor(pick(CAPSULE_COLORS));
    setPhase('cranking');
    after(1400, () => setPhase('dropping'));
    after(2300, () => setPhase('capsule'));
  };

  const popCapsule = () => {
    if (phase !== 'capsule') return;
    setPhase('pack');
  };

  const ripPack = () => {
    if (phase !== 'pack') return;
    setPhase('reveal');
  };

  const flip = (i) => {
    if (phase !== 'reveal' || flipped[i]) return;
    const next = flipped.map((f, j) => (j === i ? true : f));
    setFlipped(next);
    if (next.every(Boolean)) commitPull();
  };

  const flipAll = () => {
    if (phase !== 'reveal') return;
    if (!flipped.every(Boolean)) {
      setFlipped(Array(PACK_SIZE).fill(true));
      commitPull();
    }
  };

  const commitPull = () => {
    const byTier = { ...stats.byTier };
    pack.forEach((c) => { byTier[c.tier] = (byTier[c.tier] || 0) + 1; });
    const nextStats = { packs: stats.packs + 1, byTier };
    setStats(nextStats);
    localStorage.setItem(STATS_KEY, JSON.stringify(nextStats));
    // keep the best pull of the pack in the recent strip (newest first, max 12)
    const best = [...pack].sort((a, b) => tierRank[b.tier] - tierRank[a.tier])[0];
    const nextRecent = [
      { id: best.id, name: best.displayName, img: best.imageSmall, tier: best.tier, markE6: best.markE6 },
      ...recent,
    ].slice(0, 12);
    setRecent(nextRecent);
    localStorage.setItem(PULLS_KEY, JSON.stringify(nextRecent));
  };

  const reset = () => {
    setPhase('idle');
    setPack([]);
    setFlipped([]);
  };

  const packValueE6 = pack.reduce((s, c) => s + Number(c.markE6 || 0), 0);
  const allFlipped = flipped.length > 0 && flipped.every(Boolean);
  const pullsUntilPity = PITY_EVERY - (stats.packs % PITY_EVERY);

  return (
    <div className="gacha-view">
      <div className="gacha-header">
        <h2>PACK GACHAPON</h2>
        <p>One coin. One capsule. Five cards from the top {pool.cards.length || '…'} Pokémon markets — rarity set by live price rank.</p>
      </div>

      <div className="gacha-stage">
        {/* ── the machine ── */}
        <div className={`gacha-machine ${phase === 'cranking' ? 'shaking' : ''}`}>
          <div className="gacha-globe">
            <div className="gacha-globe-shine" />
            {CAPSULE_COLORS.concat(CAPSULE_COLORS.slice(0, 4)).map((c, i) => (
              <span
                key={i}
                className="gacha-capsule-mini"
                style={{
                  '--cap': c,
                  left: `${6 + (i * 53) % 74}%`,
                  bottom: `${3 + (i * 29) % 36}%`,
                  animationDelay: `${(i * 0.37) % 1.6}s`,
                }}
              />
            ))}
          </div>
          <div className="gacha-body">
            <div className="gacha-marquee">GACHADEX</div>
            <div className="gacha-coin-slot" title="Coin slot"><span /></div>
            <div className={`gacha-crank ${phase === 'cranking' ? 'turning' : ''}`}>
              <span className="gacha-crank-handle" />
            </div>
            <div className="gacha-chute">
              <div className={`gacha-chute-flap ${phase === 'dropping' ? 'open' : ''}`} />
              {phase === 'dropping' && (
                <span className="gacha-capsule falling" style={{ '--cap': capsuleColor }} />
              )}
            </div>
          </div>
          <div className="gacha-feet"><span /><span /></div>
        </div>

        {/* ── the action area ── */}
        <div className="gacha-result-zone">
          {phase === 'idle' && (
            <div className="gacha-prompt">
              <button className="gacha-pull-btn" onClick={crank} disabled={!pool.cards.length}>
                {pool.cards.length ? '▶ INSERT COIN' : 'LOADING CARDS…'}
              </button>
              <div className="gacha-odds">
                <span className="tier-chip tier-secret">SECRET 5%*</span>
                <span className="tier-chip tier-ultra">ULTRA 27%*</span>
                <span className="tier-chip tier-holo">HOLO 68%*</span>
              </div>
              <p className="gacha-fineprint">
                *hit-slot odds · guaranteed ULTRA+ in {pullsUntilPity} pull{pullsUntilPity === 1 ? '' : 's'} · play money, just for fun
              </p>
            </div>
          )}

          {(phase === 'cranking' || phase === 'dropping') && (
            <div className="gacha-prompt">
              <div className="gacha-cranking-msg">{phase === 'cranking' ? 'CRANKING…' : 'KA-CHUNK!'}</div>
            </div>
          )}

          {phase === 'capsule' && (
            <div className="gacha-prompt">
              <button className="gacha-capsule-big" style={{ '--cap': capsuleColor }} onClick={popCapsule}>
                <span className="gacha-capsule-top" />
                <span className="gacha-capsule-bottom" />
              </button>
              <div className="gacha-tap-hint">▼ TAP THE CAPSULE ▼</div>
            </div>
          )}

          {phase === 'pack' && (
            <div className="gacha-prompt">
              <button className="gacha-pack" onClick={ripPack}>
                <span className="gacha-pack-foil" />
                <img src="/GachaDexPFP2.png" alt="" />
                <strong>GACHADEX</strong>
                <em>BOOSTER PACK · {PACK_SIZE} CARDS</em>
              </button>
              <div className="gacha-tap-hint">▼ RIP IT OPEN ▼</div>
            </div>
          )}

          {phase === 'reveal' && (
            <div className="gacha-reveal">
              <div className="gacha-cards">
                {pack.map((c, i) => (
                  <div
                    key={`${c.id}-${i}`}
                    className={`gacha-card ${flipped[i] ? 'flipped' : ''} tier-${c.tier}`}
                    style={{ animationDelay: `${i * 0.12}s` }}
                    onClick={() => flip(i)}
                  >
                    <div className="gacha-card-inner">
                      <div className="gacha-card-back">
                        <img src="/GachaDexPFP2.png" alt="" />
                      </div>
                      <div className="gacha-card-front">
                        <span className={`gacha-tier-tag tier-${c.tier}`}>
                          {TIERS.find((t) => t.id === c.tier).label}
                        </span>
                        <img src={c.imageSmall} alt={c.displayName} />
                        {(c.tier === 'holo' || c.tier === 'ultra' || c.tier === 'secret') && (
                          <span className="gacha-holo-sheen" />
                        )}
                        <div className="gacha-card-meta">
                          <span className="gacha-card-name">{c.displayName}</span>
                          <span className="gacha-card-price">{formatUsd(BigInt(c.markE6))}</span>
                          {onTradeMarket && (
                            <button
                              className="gacha-trade-btn"
                              onClick={(e) => { e.stopPropagation(); onTradeMarket(c); }}
                            >
                              ▶ TRADE
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <div className="gacha-reveal-actions">
                {!allFlipped ? (
                  <button className="gacha-secondary-btn" onClick={flipAll}>FLIP ALL</button>
                ) : (
                  <>
                    <div className="gacha-pack-value">
                      PACK VALUE: <strong>{formatUsd(BigInt(packValueE6))}</strong>
                    </div>
                    <button className="gacha-pull-btn" onClick={reset}>▶ PULL AGAIN</button>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── pull history ── */}
      <div className="gacha-binder">
        <div className="gacha-binder-head">
          <span>BEST PULLS</span>
          <span className="gacha-stats-line">
            {stats.packs} pack{stats.packs === 1 ? '' : 's'} opened
            {Object.entries(stats.byTier)
              .filter(([t]) => tierRank[t] >= tierRank.holo)
              .sort(([a], [b]) => tierRank[b] - tierRank[a])
              .map(([t, n]) => ` · ${n} ${t.toUpperCase()}`)
              .join('')}
          </span>
        </div>
        <div className="gacha-binder-row">
          {recent.length === 0 && <span className="gacha-binder-empty">Crank the machine to start your collection…</span>}
          {recent.map((p, i) => (
            <div key={`${p.id}-${i}`} className={`gacha-binder-card tier-${p.tier}`} title={`${p.name} — ${formatUsd(BigInt(p.markE6))}`}>
              <img src={p.img} alt={p.name} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
