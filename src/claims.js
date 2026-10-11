// What the Analyst claims and holds, as pure functions of its own history (history.js) and live quotes.
//
// A claim is about the token, not the stock's price: "at the close, this bStock's move since the note is
// within +/-N basis points of its real stock's move". N is twice the stock's typical daily tracking gap in
// the desk's record (25 bps until it has MIN_DAYS of history). Each claim is checked once, at the close,
// and the share of claims that held is the Analyst's track record. It is not a forecast of where the
// stock goes.
//
// Stocks are ranked by how far the pool is from the real share now plus how far it typically drifts over
// a day. The Analyst starts with the best-ranked it can buy, then replaces a holding only when that one
// falls out of the top KEEP_TOP AND the best stock it could buy instead scores better by more than the
// two pools' swap fees, at most one a day. So it can keep a stock ranked far down (13th, say) when a swap
// would cost more than it gains.
'use strict';

const MIN_DAYS = 3;
const DEFAULT_GAP_BPS = 10; // a typical tracking gap to assume before there is history
const DEFAULT_BAND_BPS = 25;
const BAND_MIN_BPS = 10;
const BAND_MAX_BPS = 100;
const PLAN_MIN_BPS = 200;
const PLAN_MAX_BPS = 600;
const KEEP_TOP = 4;

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** A stock's record: days of history, its typical absolute tracking gap and daily move (null if too short). */
function profile(entries = []) {
  const days = entries.length;
  const enough = days >= MIN_DAYS;
  return {
    days,
    typicalGapBps: enough ? median(entries.map((e) => Math.abs(e.gapBps))) : null,
    typicalMoveBps: enough ? median(entries.map((e) => Math.abs(e.moveBps))) : null,
  };
}

/** The claim a note makes: the band its tracking gap should stay in until the close. */
function claimFor(p) {
  if (p.typicalGapBps === null) return { bandBps: DEFAULT_BAND_BPS, basis: 'default', days: p.days };
  return {
    bandBps: clamp(Math.ceil(2 * p.typicalGapBps), BAND_MIN_BPS, BAND_MAX_BPS),
    basis: 'history',
    days: p.days,
    typicalGapBps: Number(p.typicalGapBps.toFixed(1)),
  };
}

/** Whether a claim held: the day's gap inside its band. */
const claimHeld = (claim, gapBps) => Math.abs(gapBps) <= claim.bandBps;

/**
 * The exit plan for a position, in basis points either way: 1.5 times the real stock's typical daily
 * move, rounded to 10 and kept between 2% and 6%; the default until there is history.
 */
function planFor(p, defaultBps) {
  if (p.typicalMoveBps === null) return defaultBps;
  return clamp(Math.round((1.5 * p.typicalMoveBps) / 10) * 10, PLAN_MIN_BPS, PLAN_MAX_BPS);
}

/**
 * Lower is better: how far the pool sits from the real share now, plus how far it typically drifts. In
 * tenths of a basis point, as the pages show it, so a tie is a tie (then the deeper pool wins), not noise.
 */
const score = (premiumBps, p) => Math.round((Math.abs(premiumBps) + (p.typicalGapBps === null ? DEFAULT_GAP_BPS : p.typicalGapBps)) * 10) / 10;

/**
 * Ranks the stocks whose price is fit to trade. `rows`: [{ symbol, premiumBps, impact, profile, unfit }]
 * (unfit: the reason the price cannot be trusted, or null). Ties go to the deeper pool, then the symbol.
 * Returns the fit ones ranked 1..n and the unfit ones with rank null.
 */
function rank(rows) {
  const fit = rows.filter((r) => !r.unfit).map((r) => ({ ...r, score: score(r.premiumBps, r.profile) }));
  fit.sort((a, b) => (a.score - b.score) || ((a.impact ?? 1e9) - (b.impact ?? 1e9)) || a.symbol.localeCompare(b.symbol));
  return [
    ...fit.map((r, i) => ({ ...r, rank: i + 1 })),
    ...rows.filter((r) => r.unfit).map((r) => ({ ...r, score: null, rank: null })),
  ];
}

/**
 * The day's trades. `held`: symbols the Analyst holds; `ranked`: rank()'s rows, with `buyable` (listed
 * for buys), `buyOk` (passes the buy rule now) and `feeBps` (its pool's swap fee). Fills up to `k`
 * holdings with the best buyable stocks. Once full, it replaces the worst holding only when that one is
 * out of the top KEEP_TOP AND the best stock it can buy scores better by more than the swap costs (the
 * sell fee plus the buy fee), so it does not pay 0.5% to move on a few basis points of noise. A holding
 * that is no longer buyable (sell-only) or not listed at all is replaced regardless; one whose price
 * cannot be trusted today is kept. At most one swap a day. Returns { sell: symbol|null, buy: [symbols], why }.
 */
function pickTrades({ held, ranked, k = 2, keepTop = KEEP_TOP }) {
  const find = (s) => ranked.find((x) => x.symbol === s);
  const rankOf = (s) => { const r = find(s); return r && r.rank !== null ? r.rank : Infinity; };
  const candidates = ranked.filter((r) => r.rank !== null && r.buyable && r.buyOk && !held.includes(r.symbol));
  if (held.length < k) {
    const buy = candidates.slice(0, k - held.length).map((r) => r.symbol);
    return { sell: null, buy, why: buy.length ? `holds ${held.length} of ${k}: buys the best-ranked` : 'nothing fit to buy' };
  }
  const gone = (s) => { const r = find(s); return !r || (!r.unfit && !r.buyable); };
  const due = held
    .filter((s) => { const r = find(s); return gone(s) || (r && !r.unfit && r.rank > keepTop); })
    .sort((a, b) => rankOf(b) - rankOf(a));
  if (!due.length) return { sell: null, buy: [], why: `its holdings are in the top ${keepTop}` };
  const best = candidates[0];
  if (!best) return { sell: null, buy: [], why: `${due[0]} is out of the top ${keepTop}, but nothing better is fit to buy` };
  const worst = find(due[0]);
  if (!gone(due[0])) {
    const gain = worst.score - best.score;
    const cost = (worst.feeBps || 0) + (best.feeBps || 0);
    if (!(gain > cost)) {
      return { sell: null, buy: [], why: `${due[0]} is ranked ${worst.rank}, but ${best.symbol} scores only ${gain.toFixed(1)} bps better, not more than the ${cost.toFixed(0)} bps a swap costs` };
    }
  }
  const r = rankOf(due[0]);
  const status = gone(due[0]) ? (find(due[0]) ? 'sell-only now' : 'no longer listed') : `ranked ${r}, out of the top ${keepTop}`;
  return { sell: due[0], buy: [best.symbol], why: `${due[0]} is ${status}: replaced by ${best.symbol}` };
}

module.exports = { MIN_DAYS, DEFAULT_GAP_BPS, DEFAULT_BAND_BPS, KEEP_TOP, median, profile, claimFor, claimHeld, planFor, score, rank, pickTrades };
