// What one share costs through the pool, against the real stock: the number a tokenized-stock trader
// checks before a trade. The pool price is PancakeSwap's quote for a small USDT buy on the stock's
// deepest USDT pool; the multiplier and the bStock's status come from Binance's RWA data; the real
// share price (reference) and its session come from the stock's Ondo twin, because Binance publishes
// a reference price for Ondo tokens and not for bStocks.
'use strict';

const { ethers } = require('ethers');
const { ADDR } = require('./config');
const rwaDefault = require('./rwa');

const QUOTER_ABI = [
  'function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)',
];

// Sessions in which the real stock trades, so its reference price is live. On weekends and holidays
// ('offhours', 'closed') no exchange trades it. Ondo's reference keeps moving then (the status logger saw
// NVDAon's change 203 times over Sunday 2026-09-27, within 0.53%), but no share trades at it, and a
// bStock's gap to it is news the market has not priced yet, not a premium.
const LIVE_SESSIONS = new Set(['premarket', 'regular', 'postmarket', 'overnight']);

/** How far `a` is above `b`, in basis points (100 = 1%). */
const bpsAbove = (a, b) => (a / b - 1) * 10000;

/**
 * The pool's price per token (before its swap fee), what a 10 USDT buy pays per token (fee included),
 * the fee in basis points, and how much further a 1,000 USD buy moves the pool, in %. The premium is
 * measured on the pool's own price: the fee is a separate, known cost (0.25% on a 2500 pool, 0.01% on
 * a 100 pool), and folding it in would make every stock in a costly pool look overpriced. Nulls when
 * the pool gives no quote.
 */
async function poolPrices(quoter, stock, blockTag) {
  const route = ethers.utils.solidityPack(['address', 'uint24', 'address'], [ADDR.USDT, stock.usdtFee, stock.address]);
  const feeBps = stock.usdtFee / 100;
  try {
    const small = (await quoter.callStatic.quoteExactInput(route, ethers.utils.parseEther('10'), { blockTag })).amountOut;
    const big = (await quoter.callStatic.quoteExactInput(route, ethers.utils.parseEther('1000'), { blockTag })).amountOut;
    if (small.isZero() || big.isZero()) return { perToken: null, perTokenPaid: null, feeBps, impact1000UsdPct: null };
    const perTokenPaid = 10 / Number(ethers.utils.formatEther(small));
    const perTokenBig = 1000 / Number(ethers.utils.formatEther(big));
    return {
      perToken: perTokenPaid * (1 - stock.usdtFee / 1e6),
      perTokenPaid,
      feeBps,
      impact1000UsdPct: ((perTokenBig / perTokenPaid - 1) * 100).toFixed(4),
    };
  } catch {
    return { perToken: null, perTokenPaid: null, feeBps, impact1000UsdPct: null };
  }
}

/**
 * The live quote for one desk stock. `premiumBps` is how far the pool's price for one share (before its
 * swap fee) is above the real share (negative: a discount); `feeBps` is what a trade pays on top. Null
 * premium when either side is missing.
 */
async function liveQuote({ provider, stock, blockTag, rwa = rwaDefault, quoter }) {
  const [token, twin] = await Promise.all([
    rwa.dynamic(stock.address),
    stock.ondo ? rwa.dynamic(stock.ondo.address) : Promise.resolve(null),
  ]);
  const pool = await poolPrices(quoter || new ethers.Contract(ADDR.QUOTER, QUOTER_ABI, provider), stock, blockTag);
  const multiplier = Number(token.sharesMultiplier);
  const perShare = pool.perToken !== null && multiplier > 0 ? pool.perToken / multiplier : null;
  const reference = twin && twin.referencePrice !== null && twin.referencePrice !== undefined ? Number(twin.referencePrice) : null;
  const session = (twin && twin.status && twin.status.market) || null;
  return {
    stock: stock.symbol,
    open: Boolean(token.status && token.status.open),
    reason: (token.status && token.status.reason) || null,
    perToken: pool.perToken,
    multiplier,
    perShare,
    reference,
    session,
    referenceLive: LIVE_SESSIONS.has(session),
    premiumBps: perShare !== null && reference > 0 ? bpsAbove(perShare, reference) : null,
    feeBps: pool.feeBps,
    impact1000UsdPct: pool.impact1000UsdPct,
    token,
    twin,
  };
}

/** The quote as it goes into a page: decimal strings, so the page hashes the same everywhere. */
function quotePage(q) {
  const s = (v, dp) => (v === null || v === undefined || !Number.isFinite(v) ? null : v.toFixed(dp));
  return {
    perShare: s(q.perShare, 4),
    reference: s(q.reference, 4),
    premiumBps: s(q.premiumBps, 1),
    feeBps: q.feeBps === null || q.feeBps === undefined ? null : String(q.feeBps),
    session: q.session,
    impact1000UsdPct: q.impact1000UsdPct,
  };
}

module.exports = { liveQuote, quotePage, poolPrices, bpsAbove, LIVE_SESSIONS };
