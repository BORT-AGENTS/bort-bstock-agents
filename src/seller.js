// The Analyst's paid notes endpoint (x402, $U), a small plain-Node HTTP server.
//
//   GET /notes/<tokenId>
//     free: the notes on sale now, each with its stock, address and price;
//   GET /notes/<tokenId>/<STOCK>
//     404 before any charge if the note is not on sale (the rule: it writes notes only about what its
//         wallet holds; a note sealed at the open stays on sale until that day's close, even after an
//         exit, and from the close on only while the wallet still holds the stock), or if there is no
//         note yet;
//     402 with the terms (PAYMENT-REQUIRED header, and the same JSON as the body);
//     200 with the note, its Merkle proof and where it is anchored, once the payment settles.
//     The same paid request sent again (the same PAYMENT-SIGNATURE) gets the same note again and is
//     charged nothing, so a buyer whose answer was lost on the way still gets what it paid for.
//
// Payment settles into the agent's own wallet. Verification simulates $U.transferWithAuthorization,
// so a person's wallet (ECDSA) and another agent's wallet (ERC-1271) are both accepted.
//
// It can be reached through a public HTTPS tunnel: `publicUrl` is the address buyers use (the terms
// name it), a rate limit keeps outside traffic from using up the RPC the desk's own jobs share, an unpaid
// ask reads the wallet's balance through a short cache, and no answer may be cached on the way.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { STOCKS } = require('./config');
const { PHASE } = require('./ledger');
const { challenge, settle, b64, unb64, U_ADDRESS } = require('./x402');

const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];
const NETWORK = 'eip155:56';
// Requests per minute: per client (its address as the tunnel reports it) and for everyone together.
// The Trader's own buys take about four a day.
const RATE = { perClient: 30, total: 120, windowMs: 60 * 1000 };
const HOLD_CACHE_MS = 20 * 1000; // unpaid asks only; a paid request always reads the chain
const DAY_MS = 24 * 60 * 60 * 1000;
// How long one request waits for a payment to confirm (BSC takes seconds) before answering "send the
// same request again": under a buyer's own timeout, so no request just hangs.
const SETTLE_WAIT_MS = 30 * 1000;

/** Every ledger file for an agent, newest first: highest chain day, then highest phase. */
function ledgerFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((file) => ({ file, ledger: JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) }));
  files.sort((a, b) => (Number(b.ledger.epochDay ?? 0) - Number(a.ledger.epochDay ?? 0)) || (b.ledger.phase - a.ledger.phase));
  return files;
}

/** The newest ledger file for an agent: highest chain day, then highest phase. */
function latestLedger(dir) {
  const [newest] = ledgerFiles(dir);
  return newest ? newest.ledger : null;
}

const noteEntry = (ledger, symbol) => (ledger ? ledger.pages.find((p) => p.page.kind === 'note' && p.page.stock === symbol) : null) || null;

/** What a buyer receives for a note: the page, its proof and where it is anchored. */
function noteBody(ledger, entry) {
  return {
    note: entry.page,
    proof: entry.proof,
    root: ledger.root,
    tokenId: ledger.tokenId,
    epochDay: ledger.epochDay,
    phase: ledger.phase,
    logic: ledger.logic || null,
  };
}

/**
 * The address buyers reach the seller at, from SELLER_PUBLIC_URL: https (plain http only for this
 * machine), no query, fragment or login, no trailing slash. Anything else is ignored, never fatal:
 * a mistake here must not stop the desk.
 */
function publicUrlOf(value) {
  if (!value || !String(value).trim()) return { url: null };
  try {
    const u = new URL(String(value).trim());
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return { url: null, ignored: 'not an https address' };
    if (u.search || u.hash || u.username || u.password) return { url: null, ignored: 'it has a query, fragment or login' };
    return { url: `${u.origin}${u.pathname.replace(/\/+$/, '')}` };
  } catch {
    return { url: null, ignored: 'not an address' };
  }
}

/** Who is asking: Cloudflare's client address, else the last hop the proxy added, else the socket. */
function clientOf(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return String(cf).trim();
  const hops = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (hops.length) return hops[hops.length - 1];
  return (req.socket && req.socket.remoteAddress) || 'local';
}

/** A fixed one-minute window per client and for everyone. take(client) says whether to answer. */
function makeLimiter({ perClient, total, windowMs } = RATE, now = Date.now) {
  let start = now();
  let all = 0;
  const counts = new Map();
  return (client) => {
    if (now() - start >= windowMs) {
      start = now();
      all = 0;
      counts.clear();
    }
    const mine = (counts.get(client) || 0) + 1;
    if (mine > perClient || all + 1 > total) return false;
    counts.set(client, mine);
    all += 1;
    return true;
  };
}

/**
 * The notes sold, by payment (payer and nonce), kept in a file so a restart forgets none of them.
 * A row is written as soon as the transfer is sent, so a buyer can still collect the note if the
 * confirmation is slow or this process stops before answering.
 */
function openSales(file) {
  let rows = {};
  if (file && fs.existsSync(file)) {
    try {
      rows = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    } catch {
      fs.renameSync(file, `${file}.unreadable-${Date.now()}`); // kept for a person to read, never served
      rows = {};
    }
  }
  const save = () => {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(rows, null, 1));
    fs.renameSync(`${file}.tmp`, file);
  };
  return {
    get: (key) => rows[key] || null,
    put: (key, row) => { rows[key] = row; save(); },
    drop: (key) => { delete rows[key]; save(); },
  };
}

/** The payment a header carries: who pays, with which nonce and signature. Null if unreadable. */
function paymentOf(header) {
  try {
    const p = unb64(header);
    const a = p && p.payload && p.payload.authorization;
    const signature = p && p.payload && p.payload.signature;
    if (!a || typeof signature !== 'string' || !ethers.utils.isHexString(a.nonce, 32)) return null;
    const from = ethers.utils.getAddress(a.from);
    return { key: `${from.toLowerCase()}:${a.nonce.toLowerCase()}`, authorization: a, signature };
  } catch {
    return null;
  }
}

/** Whether a payment sent again is exactly the one a sale recorded: every field and the signature. */
function samePayment(sale, payment) {
  try {
    const n = (a) => [
      ethers.utils.getAddress(a.from), ethers.utils.getAddress(a.to), ethers.BigNumber.from(String(a.value)).toString(),
      ethers.BigNumber.from(String(a.validAfter)).toString(), ethers.BigNumber.from(String(a.validBefore)).toString(),
      String(a.nonce).toLowerCase(),
    ].join('|');
    return n(sale.authorization) === n(payment.authorization) && sale.signature.toLowerCase() === payment.signature.toLowerCase();
  } catch {
    return false;
  }
}

function send(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

/**
 * @param {object} o
 * @param {string} o.ledgerDir     folder holding <tokenId>/<day>-<phase>.json ledgers (from desk.js)
 * @param {string|number} o.tokenId  the Analyst agent
 * @param {string} o.wallet        the Analyst's ERC-6551 wallet (payee and position holder)
 * @param {string} o.price         price in $U base units (18 decimals), e.g. '20000000000000000' = 0.02 U
 * @param {object} o.facilitator   an ethers Signer that submits settlements (pays only gas)
 * @param {string} [o.publicUrl]   the address buyers use (see publicUrlOf); the terms name it
 * @param {string} [o.salesFile]   where the notes sold are kept; in memory only without it
 * @param {object} [o.rate]        { perClient, total, windowMs }
 * @param {function} [o.log]       (event, fields) for sales and refusals worth a line
 * @param {number} [o.settleWaitMs]  how long one request waits for a payment to confirm
 */
function createSeller({
  ledgerDir, tokenId, wallet, price, facilitator, publicUrl = null, salesFile = null, rate = RATE, log = () => {}, now = Date.now,
  settleWaitMs = SETTLE_WAIT_MS,
}) {
  const provider = facilitator.provider;
  const dir = path.join(ledgerDir, String(tokenId));
  const sales = openSales(salesFile);
  const settling = new Map(); // payment key -> promise of the paid request under way
  const holdCache = new Map(); // symbol -> { at, held }
  const take = makeLimiter(rate, now);
  const noteUrl = (symbol) => (publicUrl ? `${publicUrl}/notes/${tokenId}/${symbol}` : `/notes/${tokenId}/${symbol}`);

  async function holds(stock, { fresh = false } = {}) {
    const cached = holdCache.get(stock.symbol);
    if (!fresh && cached && now() - cached.at < HOLD_CACHE_MS) return cached.held;
    const held = !(await new ethers.Contract(stock.address, ERC20_ABI, provider).balanceOf(wallet)).isZero();
    holdCache.set(stock.symbol, { at: now(), held });
    return held;
  }

  // The rule (since 2026-10-02): a note is on sale while the desk holds its stock, and all day from
  // the open that sealed it until that day's close. It was written about a stock the wallet held (it carries
  // the proof), and an exit after the open does not withdraw it: on Oct 2 Pasteur's 2% take-profits sold both
  // stocks at 13:04 and 13:50 UTC, and Fermi's 14:00 run found no note on sale and skipped the day. From the
  // close on the day's pages are public, so only a stock still held keeps its note on sale; an open whose
  // close never came is not today's, and falls back to the holdings too.
  const sealedToday = (ledger) => Boolean(ledger) && Number(ledger.phase) === PHASE.OPEN
    && Number(ledger.epochDay) === Math.floor(now() / DAY_MS);

  async function onSaleNow(stock, ledger, opts) {
    if (sealedToday(ledger) && noteEntry(ledger, stock.symbol)) return true;
    return holds(stock, opts);
  }

  function termsFor(stock) {
    return challenge({
      amount: price,
      payTo: wallet,
      // The address a buyer pays for; without a public address, the desk's own name for the note.
      resource: publicUrl ? noteUrl(stock.symbol) : `desk-notes:${tokenId}/${stock.symbol}`,
      description: `Desk note on ${stock.symbol}, with the position proof and its on-chain anchor`,
    });
  }

  const receiptHeader = (sale) => ({ 'PAYMENT-RESPONSE': b64({ success: true, transaction: sale.tx, network: NETWORK, payer: sale.authorization.from }) });

  /** The note a recorded sale paid for, sent again. Never charges and never checks holdings again. */
  async function serveSale(res, payment, sale, stock) {
    if (!samePayment(sale, payment)) return send(res, 402, { ...termsFor(stock), error: 'this payment has already been used' });
    if (sale.stock !== stock.symbol) return send(res, 402, { ...termsFor(stock), error: `this payment bought the note on ${sale.stock}` });
    if (sale.state === 'sent') {
      let receipt = null;
      try {
        receipt = await provider.waitForTransaction(sale.tx, 1, settleWaitMs);
      } catch {
        receipt = null;
      }
      if (!receipt) return send(res, 503, { error: 'the payment is still settling; send the same request again in a moment' }, { 'retry-after': '15' });
      if (receipt.status !== 1) {
        sales.drop(payment.key); // the transfer reverted, so nothing was bought with it
        log('seller.sale.failed', { stock: sale.stock, tx: sale.tx });
        return send(res, 402, { ...termsFor(stock), error: 'the transfer for this payment did not go through' });
      }
      sales.put(payment.key, { ...sale, state: 'settled' });
    }
    const file = path.join(dir, sale.file);
    const ledger = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    const entry = noteEntry(ledger, sale.stock);
    if (!entry) return send(res, 500, { error: 'the note this payment bought is not on file' });
    log('seller.note.again', { stock: sale.stock, payer: sale.authorization.from, tx: sale.tx });
    return send(res, 200, noteBody(ledger, entry), receiptHeader(sale));
  }

  /** A first paid request: check the rule on chain, settle, record the sale, answer with the note. */
  async function sell(res, payment, header, stock) {
    const [newest] = ledgerFiles(dir);
    if (!(await onSaleNow(stock, newest && newest.ledger, { fresh: true }))) return send(res, 404, { error: `the desk does not hold ${stock.symbol}, so it writes no note about it` });
    const entry = newest && noteEntry(newest.ledger, stock.symbol);
    if (!entry) return send(res, 404, { error: `no note on ${stock.symbol} yet` });
    const terms = termsFor(stock);
    let sale = null;
    const onSent = (tx) => {
      if (!payment) return;
      sale = {
        stock: stock.symbol, file: newest.file, epochDay: newest.ledger.epochDay, phase: newest.ledger.phase,
        authorization: payment.authorization, signature: payment.signature, tx, state: 'sent', at: new Date(now()).toISOString(),
      };
      sales.put(payment.key, sale);
    };
    let result;
    try {
      result = await settle({ header, terms, facilitator, onSent, waitMs: settleWaitMs });
    } catch (e) {
      if (sale && e && e.code === 'CALL_EXCEPTION' && e.receipt && e.receipt.status === 0) {
        sales.drop(payment.key); // the transfer reverted, so nothing was bought with it
        log('seller.sale.failed', { stock: stock.symbol, tx: sale.tx });
        return send(res, 402, { ...terms, error: 'the transfer for this payment did not go through' }, { 'PAYMENT-REQUIRED': b64(terms) });
      }
      if (sale) {
        log('seller.sale.unconfirmed', { stock: stock.symbol, tx: sale.tx, error: String(e.message || e).slice(0, 160) });
        return send(res, 503, { error: 'the payment was sent but its confirmation has not arrived; send the same request again in a moment' }, { 'retry-after': '15' });
      }
      throw e;
    }
    if (!result.ok) {
      res.setHeader('PAYMENT-REQUIRED', b64(terms));
      return send(res, 402, { ...terms, error: result.reason });
    }
    if (sale) sales.put(payment.key, { ...sale, state: 'settled', tx: result.tx });
    log('seller.note.sold', { stock: stock.symbol, payer: result.payer, tx: result.tx });
    return send(res, 200, noteBody(newest.ledger, entry), { 'PAYMENT-RESPONSE': b64({ success: true, transaction: result.tx, network: NETWORK, payer: result.payer }) });
  }

  /** What is on sale now: every note of the day's open until the close, then those whose stock is still held. */
  async function onSale(res) {
    const [newest] = ledgerFiles(dir);
    const symbols = newest ? newest.ledger.pages.filter((p) => p.page.kind === 'note').map((p) => p.page.stock) : [];
    const notes = [];
    for (const symbol of symbols) {
      const stock = STOCKS.find((s) => s.symbol === symbol);
      if (stock && (await onSaleNow(stock, newest.ledger))) notes.push({ stock: symbol, url: noteUrl(symbol) });
    }
    return send(res, 200, {
      tokenId: String(tokenId),
      payTo: wallet,
      price: { amount: String(price), asset: U_ADDRESS, symbol: 'U', decimals: 18, network: NETWORK },
      from: newest ? { epochDay: newest.ledger.epochDay, phase: newest.ledger.phase } : null,
      notes,
      about: 'A note is a record of what this agent holds and observed. It is not investment advice.',
    });
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const list = url.pathname.match(/^\/notes\/(\d+)\/?$/);
      const one = url.pathname.match(/^\/notes\/(\d+)\/([A-Za-z]+)$/);
      if ((!list && !one) || (req.method !== 'GET' && req.method !== 'POST')) return send(res, 404, { error: 'not found' });
      if (!take(clientOf(req))) return send(res, 429, { error: 'too many requests; try again in a minute' }, { 'retry-after': '60' });
      if ((list || one)[1] !== String(tokenId)) return send(res, 404, { error: 'unknown agent' });
      if (list) return await onSale(res);
      const stock = STOCKS.find((s) => s.symbol.toLowerCase() === one[2].toLowerCase());
      if (!stock) return send(res, 404, { error: 'not a desk stock' });

      const header = req.headers['payment-signature'] || req.headers['x-payment'];
      if (!header) {
        // The rule, checked before anything is charged (on chain once the day's open is closed).
        const latest = latestLedger(dir);
        if (!(await onSaleNow(stock, latest))) return send(res, 404, { error: `the desk does not hold ${stock.symbol}, so it writes no note about it` });
        if (!noteEntry(latest, stock.symbol)) return send(res, 404, { error: `no note on ${stock.symbol} yet` });
        const terms = termsFor(stock);
        return send(res, 402, terms, { 'PAYMENT-REQUIRED': b64(terms) });
      }

      // A paid request. The same payment sent twice at once waits for the first, then gets its note.
      const payment = paymentOf(header);
      if (payment && settling.has(payment.key)) await settling.get(payment.key);
      const sale = payment && sales.get(payment.key);
      if (sale) return await serveSale(res, payment, sale, stock);
      const work = sell(res, payment, header, stock);
      if (payment) settling.set(payment.key, work.catch(() => {}));
      try {
        return await work;
      } finally {
        if (payment) settling.delete(payment.key);
      }
    } catch (e) {
      if (!res.headersSent) return send(res, 500, { error: 'internal error' });
      return undefined;
    }
  });
}

module.exports = { createSeller, latestLedger, ledgerFiles, publicUrlOf, clientOf, makeLimiter, paymentOf, samePayment, RATE };
