// The gas price for every transaction this project sends on BSC.
//
// BSC blocks carry a zero base fee, so ethers v5 picks an EIP-1559 transaction with its built-in
// 1.5 gwei tip, while BSC nodes quote 0.05 gwei (checked 2026-09-28). The agents repay their
// relayer's gas, so that default would bill every agent about 30 times the real price. Every send
// here uses a legacy transaction at the node's quoted price instead, or at GAS_PRICE_GWEI when set.
'use strict';

const { ethers } = require('ethers');

/** Transaction overrides: `{ type: 0, gasPrice }`, spread into any contract call or send. */
async function gasOverrides(provider) {
  const fixed = process.env.GAS_PRICE_GWEI;
  const gasPrice = fixed ? ethers.utils.parseUnits(String(fixed), 'gwei') : await provider.getGasPrice();
  return { type: 0, gasPrice };
}

/**
 * `overrides` plus a gas limit 30% and 50,000 above the estimate. ethers v5 sends exactly its
 * estimate, but a swap's gas depends on the block it lands in (price ticks crossed, the pools'
 * price observations): on the 2026-09-28 fork rehearsal a BNB-side buy estimated at 963,538 gas ran
 * out at exactly that limit. Agents repay the gas used, never the limit, so the headroom costs nothing.
 */
async function withHeadroom(contract, method, args, overrides) {
  const estimate = await contract.estimateGas[method](...args, overrides);
  return { ...overrides, gasLimit: estimate.mul(13).div(10).add(50000) };
}

module.exports = { gasOverrides, withHeadroom };
