// The desk's own history, read back from its anchored ledgers: for every stock, how its bStock tracked
// the real stock each day from the open ledger to the close ledger (the gap, in basis points) and how
// far the real stock moved. Claims and exit plans are sized from this, so the record grounds itself:
// nothing here comes from outside what the desk already put on chain.
'use strict';

const fs = require('fs');
const path = require('path');

const bpsMove = (a, b) => (Number(b) / Number(a) - 1) * 10000;

function readLedger(file) {
  try {
    const l = JSON.parse(fs.readFileSync(file, 'utf8'));
    return l.epochDay === null || l.epochDay === undefined ? null : l; // anchored ones only
  } catch {
    return null;
  }
}

/**
 * One day's tracking per stock, from that day's close ledger: its `tracking` pages when it has them,
 * else computed from the `pool` quotes on the session pages of the open and close ledgers (days before
 * tracking pages existed), else the `outcome` pages of the notes. Returns Map(symbol -> { gapBps, moveBps }).
 */
function dayTracking(open, close) {
  const out = new Map();
  const pages = (l, kind) => (l ? l.pages.map((e) => e.page).filter((p) => p.kind === kind) : []);
  for (const t of pages(close, 'tracking')) out.set(t.stock, { gapBps: Number(t.gapBps), moveBps: Number(t.referenceChangeBps) });
  const openPool = new Map(pages(open, 'session').filter((p) => p.pool).map((p) => [p.stock, p.pool]));
  for (const s of pages(close, 'session')) {
    const a = openPool.get(s.stock);
    const b = s.pool;
    if (out.has(s.stock) || !a || !b || !a.perShare || !b.perShare || !a.reference || !b.reference) continue;
    const move = bpsMove(a.reference, b.reference);
    out.set(s.stock, { gapBps: bpsMove(a.perShare, b.perShare) - move, moveBps: move });
  }
  for (const o of pages(close, 'outcome')) {
    if (!out.has(o.stock)) out.set(o.stock, { gapBps: Number(o.trackingGapBps), moveBps: Number(o.referenceChangeBps) });
  }
  return out;
}

/**
 * The last `days` closed days of an agent's record before `beforeDay` (yyyymmdd), newest first:
 * Map(symbol -> [{ day, gapBps, moveBps }]).
 */
function readHistory(ledgerDir, tokenId, { days = 10, beforeDay = Infinity } = {}) {
  const dir = path.join(ledgerDir, String(tokenId));
  const history = new Map();
  if (!fs.existsSync(dir)) return history;
  const closed = fs.readdirSync(dir)
    .map((f) => f.match(/^(\d{8})-2\.json$/))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .filter((d) => d < beforeDay)
    .sort((a, b) => b - a)
    .slice(0, days);
  for (const day of closed) {
    const close = readLedger(path.join(dir, `${day}-2.json`));
    if (!close) continue;
    const open = readLedger(path.join(dir, `${day}-1.json`));
    for (const [stock, t] of dayTracking(open, close)) {
      if (!Number.isFinite(t.gapBps) || !Number.isFinite(t.moveBps)) continue;
      if (!history.has(stock)) history.set(stock, []);
      history.get(stock).push({ day, ...t });
    }
  }
  return history;
}

module.exports = { readHistory, dayTracking };
