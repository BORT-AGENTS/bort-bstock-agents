// Publishing the desk's record. Until a day's close is anchored, only its roots are public (on chain);
// the notes are sold during the day. After the close, both of the day's ledgers are copied into the
// static site with an index the ledger page reads, so anyone can check every page against the
// roots that were anchored before the outcome.
//
//   node src/publish.js [--ledger ledger] [--site site]     publish every finished day again
'use strict';

const fs = require('fs');
const path = require('path');
const { PHASE } = require('./ledger');

/** A ledger is publishable once its root is anchored (it carries epochDay) and it is not a pending file. */
function anchored(file) {
  if (!/^\d{8}-[12]\.json$/.test(path.basename(file))) return null;
  const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
  return ledger.epochDay === null || ledger.epochDay === undefined ? null : ledger;
}

/**
 * Copies every day of every agent whose CLOSE is anchored (both phases) from `ledgerDir` into
 * `<siteDir>/ledger/<tokenId>/`, then rewrites `<siteDir>/ledger/index.json`. Returns the index.
 */
function publish({ ledgerDir, siteDir }) {
  const out = path.join(siteDir, 'ledger');
  fs.mkdirSync(out, { recursive: true });
  const agents = fs.existsSync(ledgerDir) ? fs.readdirSync(ledgerDir).filter((d) => /^\d+$/.test(d)) : [];
  for (const tokenId of agents) {
    const dir = path.join(ledgerDir, tokenId);
    const files = fs.readdirSync(dir);
    for (const f of files) {
      const m = f.match(/^(\d{8})-2\.json$/);
      if (!m || !anchored(path.join(dir, f))) continue; // a day goes public only after its close
      fs.mkdirSync(path.join(out, tokenId), { recursive: true });
      for (const phase of [PHASE.OPEN, PHASE.CLOSE]) {
        const name = `${m[1]}-${phase}.json`;
        if (files.includes(name) && anchored(path.join(dir, name))) fs.copyFileSync(path.join(dir, name), path.join(out, tokenId, name));
      }
    }
  }
  return writeIndex(out);
}

/** A close ledger's checked claims: { held, total }, or null when its outcomes carry none. */
function claimsOf(ledger) {
  const checked = ledger.pages.map((p) => p.page).filter((p) => p.kind === 'outcome' && p.claim);
  return checked.length ? { held: checked.filter((p) => p.claim.held).length, total: checked.length } : null;
}

/** The index the page reads: per agent, per day, each phase's file, root, chain day and anchor. */
function writeIndex(out) {
  const index = { format: 'desk-notes-index/1', agents: {}, claims: {} };
  for (const tokenId of fs.readdirSync(out).filter((d) => /^\d+$/.test(d)).sort()) {
    const days = {};
    for (const f of fs.readdirSync(path.join(out, tokenId)).sort()) {
      const ledger = anchored(path.join(out, tokenId, f));
      if (!ledger) continue;
      const day = String(ledger.day);
      days[day] = days[day] || { day: ledger.day, phases: [] };
      days[day].phases.push({
        phase: ledger.phase,
        file: `${tokenId}/${f}`,
        root: ledger.root,
        epochDay: ledger.epochDay,
        tx: ledger.anchor ? ledger.anchor.tx : null,
        // A close anchored with the IPFS address of the agent's whole record, and the record's summary.
        uri: ledger.anchor && ledger.anchor.uri ? ledger.anchor.uri : null,
        summary: ledger.summary || null,
        pages: ledger.pages.length,
        notes: ledger.pages.filter((p) => p.page.kind === 'note').map((p) => p.page.stock),
        // The Trader's record: the note it bought; either agent's close: the positions it sold, and why.
        bought: ledger.pages.filter((p) => p.page.kind === 'purchase').map((p) => p.page.stock),
        exits: ledger.pages.filter((p) => p.page.kind === 'exit').map((p) => `${p.page.stock} (${p.page.exit})`),
        // The Analyst's close: its morning claims, checked.
        claims: claimsOf(ledger),
      });
    }
    index.agents[tokenId] = Object.values(days).sort((a, b) => b.day - a.day);
    // The track record: every claim its notes made, and how many held, over all published days.
    const all = index.agents[tokenId].flatMap((d) => d.phases).map((p) => p.claims).filter(Boolean);
    if (all.length) index.claims[tokenId] = { held: all.reduce((n, c) => n + c.held, 0), total: all.reduce((n, c) => n + c.total, 0), days: all.length };
  }
  fs.writeFileSync(path.join(out, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  return index;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
  const index = publish({ ledgerDir: opt('ledger', process.env.LEDGER_DIR || 'ledger'), siteDir: opt('site', process.env.SITE_DIR || 'site') });
  for (const [tokenId, days] of Object.entries(index.agents)) console.log(`agent #${tokenId}: ${days.length} published day(s)`);
}

module.exports = { publish, writeIndex };
