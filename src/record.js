// An agent's record as one document for IPFS, and a short summary of it that BORT's chat can read.
//
// recordOf: every ledger of the agent whose day is public (its close is anchored), plus the close being
// anchored now, which makes its day public. Each root in it is on chain (anchors(tokenId, epochDay,
// phase) on the logic contract), so anyone can check the copy without trusting where it came from.
//
// summaryOf: the record in a few short paragraphs (in `content`, the field BORT's knowledge reader
// takes, first 8,000 characters), with the record's address. An owner registers it as one of the
// agent's knowledge sources (BAP-578's KnowledgeRegistry), so the agent can speak to its own record.
'use strict';

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { PHASE } = require('./ledger');

const RECORD_FORMAT = 'desk-notes-record/1';
const SUMMARY_FORMAT = 'desk-notes-summary/1';
const SUMMARY_MAX_CHARS = 7500; // BORT's knowledge reader keeps the first 8,000 characters
const FILE_RE = /^\d{8}-[12]\.json$/;

const CHECK = 'Each ledger is a Merkle tree of its pages (OpenZeppelin StandardMerkleTree, one bytes32 leaf per page: ' +
  'keccak256 of the page as canonical JSON, keys sorted, no whitespace). Its root is anchored on BNB Chain: ' +
  'anchors(tokenId, epochDay, phase) on the logic contract returns it, and verifyAnchored(tokenId, epochDay, phase, ' +
  'pageHash, proof) checks one page. Phase 1 is anchored before the US open, phase 2 after the close.';

/** The agent's anchored ledgers on disk (pending files and unanchored ones are left out). */
function readLedgers(ledgerDir, tokenId) {
  const dir = path.join(ledgerDir, String(tokenId));
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => FILE_RE.test(f))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
    .filter((l) => l.epochDay !== null && l.epochDay !== undefined);
}

/**
 * The agent's public record: the days whose close is anchored, both phases. `closing` is the close
 * ledger about to be anchored (with its epochDay), whose day becomes public with it.
 */
function recordOf({ ledgerDir, tokenId, logic, chainId = 56, closing = null }) {
  const all = readLedgers(ledgerDir, tokenId)
    .filter((l) => !(closing && l.day === closing.day && l.phase === closing.phase));
  if (closing) all.push(closing);
  // An open ledger whose day has no anchored close stays sealed (its notes were sold, not published).
  const closed = new Set(all.filter((l) => l.phase === PHASE.CLOSE).map((l) => l.day));
  const ledgers = all.filter((l) => closed.has(l.day)).sort((a, b) => a.day - b.day || a.phase - b.phase);
  const last = ledgers[ledgers.length - 1];
  return {
    format: RECORD_FORMAT,
    agent: { tokenId: String(tokenId), chainId, logic },
    asOf: last ? { day: last.day, phase: last.phase } : null,
    check: CHECK,
    ledgers,
  };
}

// ── summary ──

const date = (day) => String(day).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
const pct = (bps) => `${Number(bps) >= 0 ? '+' : ''}${(Number(bps) / 100).toFixed(2)}%`;
const levels = (tp, sl) => `sells at ${[tp ? pct(tp) : null, sl ? pct(-sl) : null].filter(Boolean).join(' or ')}`;
const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
};
// USD as the pages keep it: a decimal string, or an 18-decimal integer (the contract's book).
const usd = (x) => {
  const s = String(x);
  return (/^\d{13,}$/.test(s) ? Number(ethers.utils.formatEther(s)) : Number(s)).toFixed(2);
};
const units = (wei) => Number(ethers.utils.formatEther(String(wei))).toFixed(6);

const pagesOf = (ledger, kind) => (ledger ? ledger.pages.map((p) => p.page).filter((p) => p.kind === kind) : []);

/** Claims checked at each close: overall and per stock, in the order stocks first appeared. */
function claimTally(closes) {
  const byStock = new Map();
  let held = 0;
  let total = 0;
  for (const l of closes) {
    for (const o of pagesOf(l, 'outcome')) {
      if (!o.claim) continue;
      const t = byStock.get(o.stock) || { held: 0, total: 0 };
      t.total += 1;
      total += 1;
      if (o.claim.held) { t.held += 1; held += 1; }
      byStock.set(o.stock, t);
    }
  }
  return { held, total, byStock };
}

function analystText({ name, tokenId, record, recordUri }) {
  const closes = record.ledgers.filter((l) => l.phase === PHASE.CLOSE);
  const days = closes.map((l) => l.day);
  const last = closes[closes.length - 1];
  const open = record.ledgers.find((l) => l.phase === PHASE.OPEN && last && l.day === last.day);
  const tally = claimTally(closes);
  const out = [];
  out.push(`${name} (BAP-578 agent #${tokenId} on BNB Chain) is the analyst of a two-agent stock desk. Before each US open it ranks ` +
    'bStocks (tokenized stocks) by how closely each token tracks its real share and holds two of them in its own wallet, ' +
    'swapping one only when a better one beats it by more than the swap costs. It writes a note on each stock it holds with ' +
    'one claim that can be checked: at the close, the token\'s move since the note is within a stated band of the real stock\'s ' +
    'move. Its pages are anchored on chain before the open and after the close, so nothing can be changed afterwards. This is a ' +
    'record of what the agent wrote and did, not investment advice.');
  if (!last) return out.join('\n\n');
  const claims = tally.total
    ? `Claims checked: ${tally.total}, held ${tally.held}. Each claim's band is twice that stock's typical gap in the desk's record ` +
      '(25 bps until it has three days of history), so about 3 to 4 claims in 5 should hold.'
    : 'No claim has been checked yet.';
  out.push(`Record: ${days.length} market day${days.length === 1 ? '' : 's'} (${date(days[0])} to ${date(days[days.length - 1])}), ` +
    `anchored before each open and after each close. ${claims}` +
    (tally.byStock.size ? `\nBy stock: ${[...tally.byStock].map(([s, t]) => `${s} held ${t.held} of ${t.total}`).join('; ')}.` : ''));
  const outcomes = new Map(pagesOf(last, 'outcome').map((o) => [o.stock, o]));
  const lines = pagesOf(open, 'note').map((n) => {
    const o = outcomes.get(n.stock);
    const rank = n.rating && n.rating.rank ? `, ranked ${ordinal(n.rating.rank)} of ${n.rating.of}` : '';
    // Notes from before the premium left the swap fee out carry no feeBps; say so rather than mix the two.
    const withFee = n.quote && n.quote.feeBps === undefined ? ', a price that still included the pool\'s swap fee' : '';
    const before = n.quote && n.quote.premiumBps !== null && n.quote.premiumBps !== undefined ? `: ${pct(n.quote.premiumBps)} against the real share before the open${withFee}` : '';
    const band = n.claim ? `; claimed within ${n.claim.bandBps} bps` : '';
    const after = o && o.claim ? `; at the close the gap was ${o.claim.gapBps} bps, so the claim ${o.claim.held ? 'held' : 'missed'}` : '';
    return `- ${n.stock}${rank}${before}${band}${after}.`;
  });
  if (lines.length) out.push(`Latest day, ${date(last.day)}:\n${lines.join('\n')}`);
  const holdings = pagesOf(last, 'note').filter((n) => n.position && n.position.balance).map((n) => {
    const plan = n.plan && n.plan.costUsd ? ` (cost ${usd(n.plan.costUsd)} USD${n.plan.takeProfitBps || n.plan.stopLossBps ? `, ${levels(n.plan.takeProfitBps, n.plan.stopLossBps)}` : ''})` : '';
    return `${n.stock} ${units(n.position.balance)}${plan}`;
  });
  out.push(`Holdings after the close: ${holdings.length ? holdings.join('; ') : 'none'}.`);
  out.push(`Every page of every day, with its proof, is at ${recordUri}. Check a page on chain with verifyAnchored(tokenId, epochDay, phase, pageHash, proof).`);
  return out.join('\n\n');
}

function traderText({ name, tokenId, record, recordUri, analystName }) {
  const closes = record.ledgers.filter((l) => l.phase === PHASE.CLOSE);
  const days = closes.map((l) => l.day);
  const last = closes[closes.length - 1];
  const purchases = closes.flatMap((l) => pagesOf(l, 'purchase'));
  const decisions = closes.flatMap((l) => pagesOf(l, 'decision'));
  const exits = closes.flatMap((l) => pagesOf(l, 'exit'));
  const spent = purchases.reduce((n, p) => n + Number(p.priceU || 0), 0);
  const seller = analystName || 'the analyst';
  const out = [];
  out.push(`${name} (BAP-578 agent #${tokenId} on BNB Chain) is the trader of a two-agent stock desk. Each market day it pays ${seller} ` +
    'over x402 for each of its notes, wallet to wallet, checks every note against the root anchored on chain, and buys the ' +
    'best-ranked note\'s stock only when one share costs little enough over the real share; otherwise it tries the next note, ' +
    'or buys nothing. Its own record is anchored on chain after each close. This is a record of what the agent did, not investment advice.');
  if (!last) return out.join('\n\n');
  out.push(`Record: ${days.length} market day${days.length === 1 ? '' : 's'} (${date(days[0])} to ${date(days[days.length - 1])}). ` +
    `Notes bought: ${purchases.length} (${spent.toFixed(2)} $U). Days it bought a stock: ${decisions.filter((d) => d.buy).length}; ` +
    `days it bought none: ${decisions.filter((d) => !d.buy).length}. Exits: ${exits.length}.`);
  const today = [];
  const bought = pagesOf(last, 'purchase');
  if (bought.length) today.push(`bought ${bought.length === 1 ? 'the note' : 'notes'} on ${bought.map((p) => p.stock).join(' and ')}${bought.every((p) => p.verified) ? ', each checked on chain' : ''}`);
  for (const d of pagesOf(last, 'decision')) {
    const weighed = (d.tried || []).map((t) => `${t.stock}${t.rank ? ` (ranked ${ordinal(t.rank)})` : ''}: ${t.buy ? 'bought' : 'passed'}, ${t.reason}`);
    today.push(weighed.length ? weighed.join('; ') : `${d.stock}: ${d.buy ? 'bought' : 'passed'}, ${d.reason}`);
  }
  for (const x of pagesOf(last, 'exit')) today.push(`sold ${x.stock} (${x.exit}): ${x.reason}`);
  if (today.length) out.push(`Latest day, ${date(last.day)}: ${today.join('. ')}.`);
  const positions = pagesOf(last, 'position').map((p) => `${p.stock} (cost ${usd(p.costUsd)} USD${p.takeProfitBps || p.stopLossBps ? `, ${levels(p.takeProfitBps, p.stopLossBps)}` : ''})`);
  out.push(`Positions after the close: ${positions.length ? positions.join('; ') : 'none'}.`);
  out.push(`Every page of every day, with its proof, is at ${recordUri}. Check a page on chain with verifyAnchored(tokenId, epochDay, phase, pageHash, proof).`);
  return out.join('\n\n');
}

/**
 * The summary document an owner registers as the agent's knowledge. `role` is 'analyst' or 'trader'
 * (a record whose first close page says role 'trader' is the Trader's). Kept under SUMMARY_MAX_CHARS.
 */
function summaryOf({ record, recordUri, name, analystName }) {
  const tokenId = record.agent.tokenId;
  const isTrader = record.ledgers.some((l) => pagesOf(l, 'record').some((p) => p.role === 'trader'));
  const label = name || `Agent #${tokenId}`;
  let content = isTrader
    ? traderText({ name: label, tokenId, record, recordUri, analystName })
    : analystText({ name: label, tokenId, record, recordUri });
  if (content.length > SUMMARY_MAX_CHARS) content = `${content.slice(0, SUMMARY_MAX_CHARS - 1)}…`;
  const closes = record.ledgers.filter((l) => l.phase === PHASE.CLOSE);
  const tally = claimTally(closes);
  return {
    format: SUMMARY_FORMAT,
    agent: record.agent,
    role: isTrader ? 'trader' : 'analyst',
    asOf: record.asOf,
    record: recordUri,
    days: closes.length,
    ...(isTrader ? {} : { claims: { held: tally.held, total: tally.total } }),
    content,
  };
}

module.exports = { recordOf, summaryOf, readLedgers, RECORD_FORMAT, SUMMARY_FORMAT, SUMMARY_MAX_CHARS };
