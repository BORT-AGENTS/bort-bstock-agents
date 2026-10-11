// Verifies a Desk Notes ledger file: every page's hash, its proof against the root, and (with a
// contract address) the root anchored on chain and when it was anchored.
//
//   node src/verify.js <ledger file> [--logic <StockAgentLogicV1>]
//   e.g. node src/verify.js site/ledger/11181/20260930-1.json --logic 0x4245dd4DC9e9bC1035514C6de13C88ab91b61946
'use strict';

const fs = require('fs');
const { ethers } = require('ethers');
const { RPC_URL } = require('./config');
const { leafOf, pageHash, verifyPage } = require('./ledger');

const LOGIC_ABI = [
  'function verifyAnchored(uint256 tokenId, uint32 day, uint8 phase, bytes32 pageHash, bytes32[] proof) view returns (bool ok, uint64 anchoredAt)',
];

/**
 * Checks a parsed ledger. Returns one result per page. With `logic` (a contract instance), each page
 * is also checked on chain; `anchoredAt` is the time the root was written.
 */
async function verifyLedger(ledger, logic) {
  const results = [];
  for (const [i, entry] of ledger.pages.entries()) {
    const leaf = leafOf(entry.page);
    const r = {
      index: i,
      kind: entry.page.kind,
      stock: entry.page.stock || null,
      leafMatches: leaf === entry.leaf,
      proofOk: verifyPage(ledger.root, entry.page, entry.proof),
      onChain: null,
      anchoredAt: null,
    };
    // On chain, the page is identified by its own hash (the contract derives the leaf), under the
    // UTC day number the anchoring block recorded.
    if (logic && ledger.epochDay !== null && ledger.epochDay !== undefined) {
      const [ok, anchoredAt] = await logic.verifyAnchored(ledger.tokenId, ledger.epochDay, ledger.phase, pageHash(entry.page), entry.proof);
      r.onChain = ok;
      r.anchoredAt = anchoredAt.toNumber();
    }
    results.push(r);
  }
  return results;
}

async function main() {
  const [file, ...rest] = process.argv.slice(2);
  if (!file) {
    console.error('usage: node src/verify.js <ledger.json> [--logic <address>]');
    process.exit(2);
  }
  const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
  const i = rest.indexOf('--logic');
  const logicAddress = i >= 0 ? rest[i + 1] : ledger.logic;
  const logic = logicAddress
    ? new ethers.Contract(logicAddress, LOGIC_ABI, new ethers.providers.JsonRpcProvider(RPC_URL))
    : null;

  const results = await verifyLedger(ledger, logic);
  let bad = 0;
  for (const r of results) {
    const good = r.leafMatches && r.proofOk && (r.onChain === null || r.onChain);
    if (!good) bad++;
    console.log(
      `${good ? 'ok  ' : 'FAIL'} page ${r.index} ${r.kind}${r.stock ? ` ${r.stock}` : ''}` +
        (r.onChain === null ? '' : ` on-chain ${r.onChain ? 'ok' : 'NOT FOUND'}`),
    );
  }
  const at = results.find((r) => r.anchoredAt)?.anchoredAt;
  if (at) console.log(`root anchored at ${new Date(at * 1000).toISOString()} (day ${ledger.day}, phase ${ledger.phase})`);
  console.log(bad === 0 ? `all ${results.length} pages verify` : `${bad} of ${results.length} pages FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}

module.exports = { verifyLedger };
