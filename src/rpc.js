// The BSC provider for everything that sends: when a node gives no answer, ask the next one.
//
// The desk machine's resolver sometimes fails to find bsc-dataseed.bnbchain.org for a moment (ENOTFOUND), and
// ethers v5 then reports the contract read as a revert without data. Here a request that got no answer
// (no host, no connection, a timeout, an HTTP error, a body that is not JSON) goes to the next node, and
// so does one a node answered with an error that is not a revert (rate limited, lagging, overloaded:
// ethers v5 reports those as "missing revert data" too, and the close of 2026-09-30 failed twice on
// one). A revert is returned as it is. A transaction goes to another node only when the first was never
// reached (no such host, connection refused), so no send is ever made twice.
'use strict';

const { ethers } = require('ethers');
const { DEFAULT_RPC } = require('./config');

// Other public BSC nodes, used only with the default node: a custom BSC_RPC (a fork, say) gets backups
// from BSC_RPC_BACKUPS alone, so nothing meant for it ever reaches mainnet.
const DEFAULT_BACKUPS = 'https://bsc-dataseed1.binance.org,https://bsc-dataseed1.defibit.io';
const UNREACHED = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED']);
const TIMEOUT_MS = 15000;

/** The nodes to use, first choice first; read when the provider is made, so .env files count. */
function rpcUrls(env = process.env) {
  const backups = env.BSC_RPC_BACKUPS !== undefined ? env.BSC_RPC_BACKUPS : env.BSC_RPC ? '' : DEFAULT_BACKUPS;
  return [env.BSC_RPC || DEFAULT_RPC, ...backups.split(',').map((u) => u.trim()).filter(Boolean)];
}

/** Whether a node's JSON-RPC error is a revert: code 3, revert data, or "revert" in its message. */
function reverted(err) {
  if (!err) return false;
  if (err.code === 3) return true;
  if (typeof err.data === 'string' && /^0x[0-9a-fA-F]{8,}$/.test(err.data)) return true;
  return /revert/i.test(String(err.message || ''));
}

/**
 * What a failed request from ethers v5's JsonRpcProvider.send means: 'answer' (a node replied with a
 * revert, which ethers reports as a SERVER_ERROR "processing response error"), 'unreached' (the
 * request never left this machine) or 'lost' (no usable reply: none came back, or the node said it could not
 * serve the request, such as "limit exceeded" or "header not found", which the next node may).
 */
function outcome(e) {
  if (e && e.code === 'TIMEOUT') return 'lost';
  if (!e || e.code !== 'SERVER_ERROR') return 'answer';
  if (e.reason === 'processing response error') return reverted(e.error) ? 'answer' : 'lost';
  if (e.reason === 'missing response') return UNREACHED.has(e.serverError && e.serverError.code) ? 'unreached' : 'lost';
  return 'lost'; // bad response (an HTTP error status), failed response (too many 429s), invalid JSON
}

class SturdyProvider extends ethers.providers.StaticJsonRpcProvider {
  constructor(urls = rpcUrls(), network = 56) {
    super({ url: urls[0], timeout: TIMEOUT_MS }, network);
    this.backups = urls.slice(1).map((url) => new ethers.providers.StaticJsonRpcProvider({ url, timeout: TIMEOUT_MS }, network));
    this.rounds = 2;
    this.pauseMs = 2000;
  }

  async send(method, params) {
    const nodes = [(m, p) => super.send(m, p), ...this.backups.map((b) => (m, p) => b.send(m, p))];
    let last;
    for (let round = 0; round < this.rounds; round++) {
      if (round > 0) await new Promise((r) => setTimeout(r, this.pauseMs));
      for (const node of nodes) {
        try {
          return await node(method, params);
        } catch (e) {
          const o = outcome(e);
          if (o === 'answer' || (method === 'eth_sendRawTransaction' && o !== 'unreached')) throw e;
          last = e;
        }
      }
    }
    throw last;
  }
}

module.exports = { SturdyProvider, outcome, reverted, rpcUrls };
