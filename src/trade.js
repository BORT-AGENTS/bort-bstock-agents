// The relayer's side of a stock trade: the route the contract will take, a price floor priced from
// it before sending, the bStock issuer's pause and sanctions checks, and a send that survives a
// nonce clash (the relayer can be BORT's runtime signer, which sends from the same address).
'use strict';

const { ethers } = require('ethers');
const { ADDR, STOCKS } = require('./config');
const { gasOverrides, withHeadroom } = require('./gas');

const SIDE = Object.freeze({ USDT: 0, BNB: 1, U: 2 });
const BRIDGE_FEE = 100; // WBNB/USDT and $U/USDT, as in the contract
const DEFAULT_SLIPPAGE_BPS = 100;
const ZERO = ethers.constants.AddressZero;

const QUOTER_ABI = ['function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)'];
const LOGIC_ABI = [
  'function handleAction(uint256 tokenId, string action, bytes payload) returns (bool success, bytes result)',
  'function stockPoolFee(address) view returns (uint24)',
];
const TOKEN_ABI = ['function pauseManager() view returns (address)', 'function compliance() view returns (address)'];
const PAUSE_ABI = ['function isTokenPaused(address) view returns (bool)', 'function allTokensPaused() view returns (bool)'];
const COMPLIANCE_ABI = [
  'function sanctionedAddresses(address) view returns (bool)',
  'function blockedAddresses(address token, address user) view returns (bool)',
];

const quoteOf = (side) => [ADDR.USDT, ADDR.WBNB, ADDR.U][side];
const stockBySymbol = (symbol) => STOCKS.find((s) => s.symbol.toLowerCase() === String(symbol).toLowerCase());

/** The path the contract builds for this trade (its _route), from the stock's listed pool fee. */
function routeOf(stock, fee, side, buying) {
  const quote = quoteOf(side);
  if (side === SIDE.USDT) {
    return buying
      ? ethers.utils.solidityPack(['address', 'uint24', 'address'], [ADDR.USDT, fee, stock])
      : ethers.utils.solidityPack(['address', 'uint24', 'address'], [stock, fee, ADDR.USDT]);
  }
  return buying
    ? ethers.utils.solidityPack(['address', 'uint24', 'address', 'uint24', 'address'], [quote, BRIDGE_FEE, ADDR.USDT, fee, stock])
    : ethers.utils.solidityPack(['address', 'uint24', 'address', 'uint24', 'address'], [stock, fee, ADDR.USDT, BRIDGE_FEE, quote]);
}

/** The least output to accept, priced now: the quote on the contract's route, less slippage. */
async function priceFloor({ provider, logic, stock, side, buying, amountIn, slippageBps = DEFAULT_SLIPPAGE_BPS }) {
  const fee = await new ethers.Contract(logic, LOGIC_ABI, provider).stockPoolFee(stock);
  if (fee === 0) throw new Error(`${stock} is not listed on the stock logic`);
  const quoter = new ethers.Contract(ADDR.QUOTER, QUOTER_ABI, provider);
  const q = await quoter.callStatic.quoteExactInput(routeOf(stock, fee, side, buying), amountIn);
  return { quoted: q.amountOut, floor: q.amountOut.mul(10000 - slippageBps).div(10000) };
}

/**
 * The bStock issuer can pause a token, pause them all, or block or sanction an address; any of those
 * makes a swap revert (as a failed transfer). Read them before sending so a refusal costs no gas.
 * Returns null when trading is clear, or the reason it is not. Unreadable checks do not block.
 */
async function issuerBlock(provider, stock, wallet) {
  try {
    const token = new ethers.Contract(stock, TOKEN_ABI, provider);
    const [pm, cp] = await Promise.all([token.pauseManager(), token.compliance()]);
    const pause = new ethers.Contract(pm, PAUSE_ABI, provider);
    const comp = new ethers.Contract(cp, COMPLIANCE_ABI, provider);
    const [one, all, sanctioned, blocked] = await Promise.all([
      pause.isTokenPaused(stock), pause.allTokensPaused(), comp.sanctionedAddresses(wallet), comp.blockedAddresses(stock, wallet),
    ]);
    if (all) return 'the issuer has paused all bStocks';
    if (one) return 'the issuer has paused this bStock';
    if (sanctioned) return 'the agent wallet is on the issuer sanctions list';
    if (blocked) return 'the agent wallet is blocked for this bStock';
    return null;
  } catch {
    return null;
  }
}

const NONCE_CLASH = /nonce too low|nonce has already been used|replacement transaction underpriced|already known|NONCE_EXPIRED/i;

/**
 * Sends a transaction built by `build(overrides)` at the node's gas price, and retries up to three
 * times when another sender took the nonce first (BORT's runtime shares this signer).
 */
async function sendWithRetry(signer, build, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const overrides = { ...(await gasOverrides(signer.provider)), nonce: await signer.getTransactionCount('pending') };
      const tx = await build(overrides);
      return await tx.wait();
    } catch (e) {
      const text = `${e.message || ''} ${e.error && e.error.message ? e.error.message : ''}`;
      if (i >= tries || !NONCE_CLASH.test(text)) throw e;
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
}

/** buy_stock / sell_stock payloads, with the floor as the eighth word. Route words are ignored on chain. */
const buyPayload = (stock, side, amountIn, slippageBps, floor) => ethers.utils.defaultAbiCoder.encode(
  ['address', 'uint8', 'uint256', 'address', 'uint24', 'uint24', 'uint256', 'uint256'],
  [stock, side, amountIn, ZERO, 0, 0, slippageBps, floor],
);
const sellPayload = (stock, amountIn, side, slippageBps, floor) => ethers.utils.defaultAbiCoder.encode(
  ['address', 'uint256', 'uint8', 'address', 'uint24', 'uint24', 'uint256', 'uint256'],
  [stock, amountIn, side, ZERO, 0, 0, slippageBps, floor],
);

/**
 * A relayer trade: issuer checks, a floor priced now, then handleAction. Returns the receipt and the
 * numbers, or { skipped } when the issuer blocks the trade.
 */
async function trade({ signer, logic, tokenId, wallet, stock, side, amountIn, buying, slippageBps = DEFAULT_SLIPPAGE_BPS }) {
  const provider = signer.provider;
  const blocked = await issuerBlock(provider, stock, wallet);
  if (blocked) return { skipped: blocked };
  const { quoted, floor } = await priceFloor({ provider, logic, stock, side, buying, amountIn, slippageBps });
  const payload = buying ? buyPayload(stock, side, amountIn, slippageBps, floor) : sellPayload(stock, amountIn, side, slippageBps, floor);
  const c = new ethers.Contract(logic, LOGIC_ABI, signer);
  const args = [tokenId, buying ? 'buy_stock' : 'sell_stock', payload];
  const receipt = await sendWithRetry(signer, async (o) => c.handleAction(...args, await withHeadroom(c, 'handleAction', args, o)));
  return { receipt, quoted, floor };
}

module.exports = { SIDE, routeOf, priceFloor, issuerBlock, sendWithRetry, buyPayload, sellPayload, trade, stockBySymbol };
