// x402 "exact" scheme on BSC with $U (EIP-3009), for BAP-578 agents: both ends.
//
// Payer (an agent's ERC-6551 wallet, which cannot sign): payWithAgent() reads the 402 challenge,
// asks StockAgentLogicV1 to approve that exact $U authorization from the agent's wallet
// (approve_payment, sent by the relayer), and retries with AccountV3's nested signature
// (r = the logic contract, s = 65, v = 0). $U checks it through ERC-1271, so the payment moves from
// the agent's own wallet with no key on it.
//
// Seller: challenge() builds the 402 terms and settle() verifies a payment by simulating
// $U.transferWithAuthorization (so the token itself checks ECDSA or ERC-1271), then submits it.
//
// Headers: v2 challenge in `PAYMENT-REQUIRED` (base64 JSON) and payment in `PAYMENT-SIGNATURE`;
// v1 servers read `X-PAYMENT`. Both carry the same payload shape.
'use strict';

const { ethers } = require('ethers');
const { ADDR } = require('./config');
const { gasOverrides, withHeadroom } = require('./gas');

const U_ADDRESS = ADDR.U;
const U_DOMAIN = { name: 'United Stables', version: '1' };
const NETWORK = 'eip155:56';
const U_ABI = [
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)',
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
  'function balanceOf(address) view returns (uint256)',
];
const LOGIC_ABI = [
  'function handleAction(uint256 tokenId, string action, bytes payload) returns (bool success, bytes result)',
  'function MAX_PAYMENT() view returns (uint256)',
  'function MAX_PAYMENT_WINDOW() view returns (uint256)',
];

const PAID_ATTEMPTS = 4; // the paid request, sent again with the same header after a lost answer or a 5xx
const b64 = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
const unb64 = (s) => JSON.parse(Buffer.from(s, 'base64').toString('utf8'));

/** AccountV3's nested contract signature naming `signer` (no extra bytes). */
function nestedSignature(signer) {
  return ethers.utils.hexConcat([ethers.utils.hexZeroPad(signer, 32), ethers.utils.hexZeroPad('0x41', 32), '0x00']);
}

/** Reads a 402 answer: v2 header first, then a JSON body (v1). */
async function readChallenge(res) {
  const header = res.headers.get('payment-required');
  if (header) return unb64(header);
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** The $U / EIP-3009 option of a challenge, if it offers one. */
function pickU(challenge) {
  const accepts = (challenge && challenge.accepts) || [];
  return accepts.find((a) => a.scheme === 'exact'
    && (a.network === NETWORK || a.network === 'bsc')
    && String(a.asset).toLowerCase() === U_ADDRESS.toLowerCase()
    && (!a.extra || !a.extra.assetTransferMethod || a.extra.assetTransferMethod === 'eip3009')) || null;
}

/**
 * Pays an x402 resource from an agent's wallet.
 * @param {object} o
 * @param {string} o.url, o.method, o.body   the request (body is a JSON-serialisable object or undefined)
 * @param {object} o.relayer   an ethers Signer registered as relayer on the logic contract
 * @param {string} o.logic     StockAgentLogicV1 address
 * @param {string|number} o.tokenId, o.wallet   the paying agent and its ERC-6551 wallet
 * @param {function} [o.fetchImpl]   fetch (defaults to global fetch)
 * @param {BigNumberish} [o.maxAmount]   the most the caller agreed to pay; a seller asking more gets
 *   nothing, not even an approval
 * @returns {{ status, body, payment, receipt }}
 */
async function payWithAgent({ url, method = 'POST', body, relayer, logic, tokenId, wallet, fetchImpl = fetch, maxAmount }) {
  const init = { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) };
  const first = await fetchImpl(url, init);
  if (first.status !== 402) return { status: first.status, body: await first.text(), payment: null };

  const challenge = await readChallenge(first);
  const req = pickU(challenge);
  if (!req) throw new Error('the seller does not accept $U by EIP-3009');
  const asked = ethers.BigNumber.from(String(req.amount ?? req.maxAmountRequired));
  if (maxAmount !== undefined && asked.gt(maxAmount)) {
    throw new Error(`the seller asks ${ethers.utils.formatEther(asked)} $U, more than the ${ethers.utils.formatEther(maxAmount)} agreed; nothing sent`);
  }

  const provider = relayer.provider;
  const now = (await provider.getBlock('latest')).timestamp;
  const logicC = new ethers.Contract(logic, LOGIC_ABI, relayer);
  const window = Math.min(Number(req.maxTimeoutSeconds || 300), (await logicC.MAX_PAYMENT_WINDOW()).toNumber() - 30);
  const authorization = {
    from: wallet,
    to: ethers.utils.getAddress(req.payTo),
    value: String(req.amount ?? req.maxAmountRequired),
    validAfter: '0',
    validBefore: String(now + window),
    nonce: ethers.utils.hexlify(ethers.utils.randomBytes(32)),
  };

  // The contract computes and records the exact digest; the budget is charged here.
  const payload = ethers.utils.defaultAbiCoder.encode(
    ['address', 'uint256', 'uint256', 'uint256', 'bytes32'],
    [authorization.to, authorization.value, authorization.validAfter, authorization.validBefore, authorization.nonce],
  );
  const args = [tokenId, 'approve_payment', payload];
  const receipt = await (await logicC.handleAction(...args, await withHeadroom(logicC, 'handleAction', args, await gasOverrides(provider)))).wait();

  const version = Number(challenge.x402Version || 1);
  const paymentPayload = version >= 2
    ? { x402Version: 2, resource: challenge.resource, accepted: req, payload: { signature: nestedSignature(logic), authorization } }
    : { x402Version: 1, scheme: 'exact', network: req.network, payload: { signature: nestedSignature(logic), authorization } };
  const header = b64(paymentPayload);
  // x402 v2 carries the proof in PAYMENT-SIGNATURE only (BNB Chain's gateway says so explicitly); v1 in X-PAYMENT.
  const proofHeader = version >= 2 ? { 'payment-signature': header } : { 'x-payment': header };
  // A lost answer, a 429 or a 5xx (the desk's seller says 503 while a payment settles) gets the SAME
  // header again, never a new approval: one authorization settles at most once, and the desk's seller
  // answers a payment it already settled with the same note.
  let second;
  for (let attempt = 1; ; attempt += 1) {
    try {
      second = await fetchImpl(url, { ...init, headers: { ...init.headers, ...proofHeader } });
    } catch (e) {
      if (attempt >= PAID_ATTEMPTS) throw e;
      second = null;
    }
    if (second && second.status !== 429 && second.status < 500) break;
    if (second && attempt >= PAID_ATTEMPTS) break;
    const asked = second ? Number(second.headers.get('retry-after')) : NaN;
    await new Promise((r) => setTimeout(r, Math.min(Number.isFinite(asked) && asked > 0 ? asked : 5, 20) * 1000));
  }
  const paymentResponse = second.headers.get('payment-response') || second.headers.get('x-payment-response');
  return {
    status: second.status,
    body: await second.text(),
    payment: paymentResponse ? unb64(paymentResponse) : null,
    authorization,
    receipt,
  };
}

// ── Seller side ──

/** The 402 terms for one resource priced in $U, paid to `payTo` (the seller agent's wallet). */
function challenge({ amount, payTo, resource, description, maxTimeoutSeconds = 600 }) {
  return {
    x402Version: 2,
    error: 'Payment Required',
    resource: { url: resource, description, mimeType: 'application/json' },
    accepts: [{
      scheme: 'exact',
      network: NETWORK,
      amount: String(amount),
      asset: U_ADDRESS,
      payTo,
      maxTimeoutSeconds,
      extra: { ...U_DOMAIN, assetTransferMethod: 'eip3009' },
    }],
  };
}

/**
 * Verifies and settles one payment header against the terms. Verification is a simulation of the
 * real transfer, so ECDSA (a person's wallet) and ERC-1271 (an agent's wallet) are both checked by
 * $U itself. Returns { ok, reason?, tx? }. `onSent(txHash)` runs once the transfer is sent, before
 * its confirmation, so the seller can record a sale that a lost confirmation would otherwise hide.
 * With `waitMs`, waiting for the confirmation throws ethers' TIMEOUT after that long instead of
 * waiting on; a reverted transfer throws CALL_EXCEPTION with its receipt either way.
 */
async function settle({ header, terms, facilitator, onSent, waitMs }) {
  let p;
  try {
    p = unb64(header);
  } catch {
    return { ok: false, reason: 'unreadable payment header' };
  }
  const a = p && p.payload && p.payload.authorization;
  const sig = p && p.payload && p.payload.signature;
  if (!a || !sig) return { ok: false, reason: 'missing authorization or signature' };
  const want = terms.accepts[0];
  if (ethers.utils.getAddress(a.to) !== ethers.utils.getAddress(want.payTo)) return { ok: false, reason: 'wrong payee' };
  if (String(a.value) !== String(want.amount)) return { ok: false, reason: 'amount must equal the price' };
  const now = (await facilitator.provider.getBlock('latest')).timestamp;
  if (Number(a.validBefore) <= now) return { ok: false, reason: 'authorization expired' };

  const u = new ethers.Contract(U_ADDRESS, U_ABI, facilitator);
  const args = [a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, sig];
  try {
    await u.callStatic.transferWithAuthorization(...args);
  } catch (e) {
    return { ok: false, reason: `the token refused it: ${e.reason || e.errorName || 'invalid'}` };
  }
  const sent = await u.transferWithAuthorization(...args, await gasOverrides(facilitator.provider));
  if (onSent) onSent(sent.hash);
  let receipt;
  if (waitMs) {
    receipt = await facilitator.provider.waitForTransaction(sent.hash, 1, waitMs);
    if (receipt.status === 0) throw Object.assign(new Error('the transfer reverted'), { code: 'CALL_EXCEPTION', receipt });
  } else {
    receipt = await sent.wait();
  }
  return { ok: true, tx: receipt.transactionHash, payer: a.from };
}

module.exports = { U_ADDRESS, nestedSignature, readChallenge, pickU, payWithAgent, challenge, settle, b64, unb64 };
