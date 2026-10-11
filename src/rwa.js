// Binance Web3 RWA endpoints (public, no key), as documented in Binance's tokenized-securities
// skill: global market status and per-token Dynamic V2 (status, token price, sharesMultiplier,
// reference price). bStocks return null marketStatus and null stockInfo.price; Ondo returns both.
'use strict';

const HEADERS = { 'Accept-Encoding': 'identity', 'User-Agent': 'binance-web3/1.1 (Skill)' };
const V1 = 'https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/rwa';
const V2 = 'https://www.binance.com/bapi/defi/v2/public/wallet-direct/buw/wallet/market/token/rwa';
const TIMEOUT_MS = 15_000;
const RETRY_WAITS_MS = [2_000, 5_000];

/** fetch with two retries on a network error, a timeout, 429 or 5xx (one bare "fetch failed" was
 *  seen on 2026-09-28 while the status logger read the same endpoints without errors). */
async function fetchText(url) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      if (attempt >= RETRY_WAITS_MS.length) throw e;
    }
    if (res && res.status !== 429 && res.status < 500) return { res, text: await res.text() };
    if (res && attempt >= RETRY_WAITS_MS.length) return { res, text: await res.text() };
    await new Promise((r) => setTimeout(r, RETRY_WAITS_MS[attempt]));
  }
}

async function getData(url) {
  const { res, text } = await fetchText(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}: ${text.slice(0, 120)}`);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`non-JSON answer from ${url}: ${text.slice(0, 120)}`);
  }
  if (body.success !== true || !body.data) throw new Error(`unexpected answer from ${url}: code ${body.code}`);
  return body.data;
}

function status(s) {
  if (!s) return null;
  return {
    open: s.openState ?? null,
    market: s.marketStatus ?? null,
    reason: s.reasonCode ?? null,
    reasonMsg: s.reasonMsg ?? null,
    nextOpen: s.nextOpenTime ?? null,
    nextClose: s.nextCloseTime ?? null,
  };
}

async function marketStatus() {
  const d = await getData(`${V1}/market/status/ai`);
  return { ...status(d), offhours: d.offhours ?? null };
}

async function dynamic(address) {
  const d = await getData(`${V2}/dynamic/ai?chainId=56&contractAddress=${address}`);
  return {
    status: status(d.statusInfo),
    tokenPrice: d.tokenInfo?.price ?? null,
    sharesMultiplier: d.tokenInfo?.sharesMultiplier ?? null,
    referencePrice: d.stockInfo?.price ?? null,
  };
}

module.exports = { marketStatus, dynamic };
