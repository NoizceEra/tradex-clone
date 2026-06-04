#!/usr/bin/env node
/**
 * Phase-0 spike — measure tcgpricelookup price coverage for MTG + One Piece.
 *
 * These are the two games scrydex does NOT grade yet, so before we commit to
 * tcgpricelookup as the graded vendor we need to know its real fill-rate and
 * sanity for them. This script queries a basket of well-known cards per game and
 * reports: raw-price fill %, any-graded %, PSA-10 %, the grades present, price
 * source (tcgplayer/ebay), and a few samples. It dumps the first card's full JSON
 * per game so the response schema is locked.
 *
 * NOTE ON TIERS: graded (PSA/BGS/CGC), eBay prices and history are gated to the
 * tcgpricelookup **Trader plan ($14.99/mo)**. A FREE-tier key returns only a `raw`
 * object (TCGPlayer, USD) with NO `graded` key — so graded%=0 with a free key means
 * "not entitled", not "no data". Run with a Trader key to measure graded coverage.
 *
 * Discovered live schema (free key):
 *   prices.raw.{near_mint|lightly_played|...}.{tcgplayer|ebay}.{market,low,mid,high}
 *   prices.graded.{...}  // Trader only — shape probed defensively below
 *
 * Never hardcodes the key — pass via env or --key.
 *
 * Usage:
 *   TCGPRICELOOKUP_API_KEY=tcg_... node apps/api/scripts/graded-spike.mjs
 *   node apps/api/scripts/graded-spike.mjs --key tcg_... --delay 4000 --limit 5
 *     --delay   ms between requests (free tier = 1 req / 3s; default 4000)
 *     --limit   printings to scan per card name (default 5)
 *     --timeout per-request timeout ms (default 25000)
 */

const BASE = 'https://api.tcgpricelookup.com/v1';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] != null ? argv[i + 1] : def;
};

const API_KEY = arg('key', process.env.TCGPRICELOOKUP_API_KEY || '');
const DELAY_MS = Number(arg('delay', '4000'));
const TIMEOUT_MS = Number(arg('timeout', '25000'));
const LIMIT = Number(arg('limit', '5'));
const MAX_RETRIES = 2; // per request, on timeout/5xx, with backoff

if (!API_KEY) {
  console.error('Missing API key. Set TCGPRICELOOKUP_API_KEY or pass --key tcg_...');
  process.exit(1);
}

// Well-known staples per game (likely to carry graded comps). `slugs` are candidate
// `game` param values; we keep the first that returns data. Live run confirmed "mtg"
// and "onepiece".
const GAMES = {
  'Magic: The Gathering': {
    slugs: ['mtg', 'magic'],
    cards: [
      'Black Lotus', 'Mox Sapphire', 'Tarmogoyf', 'Liliana of the Veil', 'Snapcaster Mage',
      'Ragavan, Nimble Pilferer', 'Sheoldred, the Apocalypse', 'Force of Will', 'Mana Crypt',
      'Jace, the Mind Sculptor', 'The One Ring', 'Orcish Bowmasters', 'Lightning Bolt', 'Sol Ring',
      'Thoughtseize', 'Wrenn and Six', 'Underground Sea', 'Teferi, Hero of Dominaria',
      'Dockside Extortionist', 'Counterspell',
    ],
  },
  'One Piece': {
    slugs: ['onepiece', 'one-piece', 'op'],
    cards: [
      'Monkey D. Luffy', 'Roronoa Zoro', 'Trafalgar Law', 'Sanji', 'Nami', 'Shanks', 'Kaido',
      'Charlotte Katakuri', 'Eustass Kid', 'Portgas D. Ace', 'Boa Hancock', 'Donquixote Doflamingo',
      'Gol D. Roger', 'Yamato', 'Nico Robin', 'Sabo', 'Marshall D. Teach', 'Crocodile',
      'Dracule Mihawk', 'Edward Newgate',
    ],
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isBlock(r) {
  if (r.error === 'timeout' || r.status === 0 || r.status === 403 || r.status === 503) return true;
  const t = (r.text || '').toLowerCase();
  return t.includes('just a moment') || t.includes('cloudflare') || t.includes('<!doctype html');
}

// One HTTP attempt.
async function attempt(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'X-API-Key': API_KEY, Accept: 'application/json', 'User-Agent': 'pokex-spike/1.0' },
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* HTML challenge / non-JSON */ }
    return { status: res.status, json, text };
  } catch (e) {
    return { status: 0, json: null, text: '', error: e.name === 'AbortError' ? 'timeout' : String(e) };
  } finally {
    clearTimeout(t);
  }
}

// Retry on transient block (the egress lets bursts through, then briefly times out).
async function fetchJson(url) {
  let r = await attempt(url);
  for (let i = 0; i < MAX_RETRIES && isBlock(r); i++) {
    const backoff = 8000 * (i + 1);
    console.log(`    …transient block (${r.status} ${r.error ?? ''}); backing off ${backoff / 1000}s and retrying`);
    await sleep(backoff);
    r = await attempt(url);
  }
  return r;
}

const rowsOf = (json) => (Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : []);

const numOrNull = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

// market value out of a {market,low,mid,high} | number | {tcgplayer|ebay:{...}} node
function marketOf(node) {
  if (node == null) return null;
  if (typeof node === 'number') return numOrNull(node);
  const src = node.tcgplayer ?? node.ebay ?? node;
  return numOrNull(src?.market ?? src?.price ?? src);
}

function extractRaw(card) {
  const raw = card?.prices?.raw;
  if (!raw || typeof raw !== 'object') return { price: null, source: null };
  const order = ['near_mint', 'nearMint', 'lightly_played', 'moderately_played', 'heavily_played', 'damaged'];
  const conds = [...order.filter((c) => raw[c]), ...Object.keys(raw).filter((c) => !order.includes(c))];
  for (const c of conds) {
    const node = raw[c];
    const v = marketOf(node);
    if (v != null) return { price: v, source: node?.tcgplayer ? 'tcgplayer' : node?.ebay ? 'ebay' : 'raw' };
  }
  return { price: null, source: null };
}

function extractGraded(card) {
  const g = card?.prices?.graded;
  if (!g || typeof g !== 'object') return {};
  const pick = (...keys) => {
    for (const k of keys) if (g[k] != null) { const v = marketOf(g[k]); if (v != null) return v; }
    return null;
  };
  return {
    psa10: pick('psa_10', 'psa10', 'PSA 10', 'psa-10'),
    psa9: pick('psa_9', 'psa9', 'PSA 9'),
    bgs95: pick('bgs_9_5', 'bgs95', 'BGS 9.5'),
    cgc95: pick('cgc_9_5', 'cgc95', 'CGC 9.5'),
  };
}

async function resolveSlug(game) {
  for (const slug of game.slugs) {
    const r = await fetchJson(`${BASE}/cards/search?q=${encodeURIComponent(game.cards[0])}&game=${slug}&limit=1`);
    if (isBlock(r)) return { blocked: r };
    if (r.status === 200 && rowsOf(r.json).length) return { slug };
    await sleep(DELAY_MS);
  }
  return { slug: null };
}

async function run() {
  console.log(`\n=== tcgpricelookup price/graded spike ===`);
  console.log(`base=${BASE}  delay=${DELAY_MS}ms  limit=${LIMIT}  retries=${MAX_RETRIES}  key=${API_KEY.slice(0, 8)}…\n`);

  for (const [gameName, game] of Object.entries(GAMES)) {
    console.log(`\n########## ${gameName} ##########`);
    const res = await resolveSlug(game);
    if (res.blocked) {
      console.log(`\n⛔ Egress Cloudflare-blocked even after retries (status=${res.blocked.status} ${res.blocked.error ?? ''}).`);
      console.log(`   Re-run from a host with normal egress (your machine / the API box):`);
      console.log(`   TCGPRICELOOKUP_API_KEY=tcg_... node apps/api/scripts/graded-spike.mjs\n`);
      process.exit(2);
    }
    if (!res.slug) { console.log(`  No working game slug (tried ${game.slugs.join(', ')}). Skipping.`); continue; }
    console.log(`  game slug = "${res.slug}"`);
    await sleep(DELAY_MS);

    let dumped = false, consecutiveBlocks = 0;
    const stats = { queried: 0, found: 0, raw: 0, anyGraded: 0, psa10: 0 };
    const sources = new Set();
    const samples = [];

    for (const name of game.cards) {
      const r = await fetchJson(`${BASE}/cards/search?q=${encodeURIComponent(name)}&game=${res.slug}&limit=${LIMIT}`);
      stats.queried++;
      if (isBlock(r)) {
        if (++consecutiveBlocks >= 4) { console.log(`  ⛔ 4 consecutive blocks — stopping early (partial stats below).`); break; }
        console.log(`    (skipped "${name}" — blocked)`); await sleep(DELAY_MS); continue;
      }
      consecutiveBlocks = 0;
      const rows = rowsOf(r.json);
      if (!rows.length) { await sleep(DELAY_MS); continue; }
      stats.found++;

      if (!dumped) {
        console.log(`\n  --- schema sample: first result for "${name}" ---`);
        console.log(JSON.stringify(rows[0], null, 2).split('\n').slice(0, 50).join('\n'));
        console.log(`  --- end sample ---\n`);
        dumped = true;
      }

      // a card "has X" if ANY returned printing carries it
      let raw = null, src = null, graded = {};
      for (const card of rows) {
        const rr = extractRaw(card);
        if (raw == null && rr.price != null) { raw = rr.price; src = rr.source; }
        const gr = extractGraded(card);
        for (const k of Object.keys(gr)) if (graded[k] == null && gr[k] != null) graded[k] = gr[k];
      }
      if (raw != null) stats.raw++;
      if (src) sources.add(src);
      if (Object.values(graded).some((v) => v != null)) stats.anyGraded++;
      if (graded.psa10 != null) stats.psa10++;
      if (samples.length < 5) samples.push({ name, raw, src, ...graded });
      await sleep(DELAY_MS);
    }

    const pct = (n) => `${Math.round((n / Math.max(stats.queried, 1)) * 100)}%`;
    console.log(`\n  RESULTS — ${gameName}:`);
    console.log(`    queried       ${stats.queried}`);
    console.log(`    name matched  ${stats.found} (${pct(stats.found)})`);
    console.log(`    raw price     ${stats.raw} (${pct(stats.raw)})   source(s): ${[...sources].join(', ') || '—'}`);
    console.log(`    ANY graded    ${stats.anyGraded} (${pct(stats.anyGraded)})   <-- needs Trader-tier key`);
    console.log(`    PSA-10        ${stats.psa10} (${pct(stats.psa10)})`);
    console.log(`    samples:`);
    for (const s of samples) {
      console.log(`      ${s.name}: raw=${s.raw ?? '—'}(${s.src ?? '—'}) psa10=${s.psa10 ?? '—'} psa9=${s.psa9 ?? '—'} bgs9.5=${s.bgs95 ?? '—'} cgc9.5=${s.cgc95 ?? '—'}`);
    }
  }
  console.log(`\n=== done ===\n`);
}

run().catch((e) => { console.error('spike failed:', e); process.exit(1); });
