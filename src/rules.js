// The desk's trading rules, as pure functions of a live quote (quote.js) and a position. Both agents
// follow them: neither buys while the real stock is not trading or at more than a small premium over
// it, and each sells a position once it has gained or lost its targets' share of what it cost.
//
// Env (defaults): BUY_MAX_PREMIUM_BPS (20: pay at most 0.20% over the real share), PRICE_SANITY_BPS
// (100: a pool and a reference more than 1% apart are not trusted either way), TAKE_PROFIT_BPS (300)
// and STOP_LOSS_BPS (300), the exit targets a new position gets.
'use strict';

const DEFAULT_RULES = Object.freeze({ maxPremiumBps: 20, sanityBps: 100, takeProfitBps: 300, stopLossBps: 300 });

function rulesFromEnv(env = process.env) {
  const n = (name, fallback) => (env[name] === undefined || env[name] === '' ? fallback : Number(env[name]));
  const rules = {
    maxPremiumBps: n('BUY_MAX_PREMIUM_BPS', DEFAULT_RULES.maxPremiumBps),
    sanityBps: n('PRICE_SANITY_BPS', DEFAULT_RULES.sanityBps),
    takeProfitBps: n('TAKE_PROFIT_BPS', DEFAULT_RULES.takeProfitBps),
    stopLossBps: n('STOP_LOSS_BPS', DEFAULT_RULES.stopLossBps),
  };
  for (const [k, v] of Object.entries(rules)) if (!Number.isFinite(v)) throw new Error(`rule ${k} is not a number`);
  return rules;
}

const pct = (bps) => `${(bps / 100).toFixed(2)}%`;
const EPS_BPS = 1e-6;

/**
 * Whether the price is fit to trade at all: the bStock open, the real stock trading (its reference
 * live), and pool and reference within the sanity band. Returns null when fit, else the reason.
 */
function priceUnfit(q, rules) {
  if (!q.open) return `${q.stock} is not trading (${q.reason || 'closed'})`;
  if (!q.referenceLive) return `the real stock is not trading (${q.session || 'no session'}), so no share trades at its reference`;
  if (q.premiumBps === null) return `no pool quote or reference price for ${q.stock}`;
  if (Math.abs(q.premiumBps) > rules.sanityBps) return `pool and real price are ${pct(Math.abs(q.premiumBps))} apart, more than the ${pct(rules.sanityBps)} the desk trusts`;
  return null;
}

/** A buy: fit to trade, and one share costs at most maxPremiumBps over the real share. */
function buyCheck(q, rules) {
  const unfit = priceUnfit(q, rules);
  if (unfit) return { ok: false, reason: unfit };
  if (q.premiumBps > rules.maxPremiumBps) {
    return { ok: false, reason: `one share costs ${pct(q.premiumBps)} over the real share, above the ${pct(rules.maxPremiumBps)} limit` };
  }
  // Under the real share is a discount, which no premium limit stops; saying "within the 0.20% limit" after
  // "0.26% under" read as 0.26 inside 0.20 (Oct 1).
  if (q.premiumBps < 0) return { ok: true, reason: `one share costs ${pct(-q.premiumBps)} under the real share, a discount` };
  return { ok: true, reason: `one share costs ${pct(q.premiumBps)} over the real share, within the ${pct(rules.maxPremiumBps)} limit` };
}

/**
 * An exit: the position's value (what selling it all returns now, in USD) against what it cost.
 * `exit` is 'take-profit', 'stop-loss' or null; a target of 0 is off. Prices unfit to trade decide nothing.
 */
function exitCheck({ costUsd, valueUsd, takeProfitBps, stopLossBps }, q, rules) {
  if (!(costUsd > 0) || !(valueUsd >= 0)) return { exit: null, reason: 'no cost or value to compare' };
  const changeBps = (valueUsd / costUsd - 1) * 10000;
  const unfit = priceUnfit(q, rules);
  if (unfit) return { exit: null, changeBps, reason: unfit };
  // A target is reached at its exact level too; USD values are floats, so compare with a hair of slack.
  if (takeProfitBps > 0 && changeBps >= takeProfitBps - EPS_BPS) return { exit: 'take-profit', changeBps, reason: `up ${pct(changeBps)}, at or past the ${pct(takeProfitBps)} take-profit` };
  if (stopLossBps > 0 && changeBps <= -stopLossBps + EPS_BPS) return { exit: 'stop-loss', changeBps, reason: `down ${pct(-changeBps)}, at or past the ${pct(stopLossBps)} stop-loss` };
  return { exit: null, changeBps, reason: `${changeBps >= 0 ? 'up' : 'down'} ${pct(Math.abs(changeBps))}, inside its targets` };
}

module.exports = { DEFAULT_RULES, rulesFromEnv, priceUnfit, buyCheck, exitCheck };
