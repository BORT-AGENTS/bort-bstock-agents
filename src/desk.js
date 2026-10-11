// Desk Notes writer. Reads the market and the agent's holdings, writes the day's pages, and
// (with --anchor) anchors their Merkle root through StockAgentLogicV1.
//
// The rule it enforces: the agent writes a note only about a stock its own wallet holds, and the
// note carries the proof (wallet, balance, block). A stock it does not hold gets a session page
// of observed facts and no note. Every note ends with the fixed NOTE_FOOTER.
//
//   node src/desk.js open  --token <id> [--tba <wallet>] [--out ledger] [--anchor]
//   node src/desk.js close --token <id> ...
// --anchor needs RELAYER_KEY (a Safe-registered relayer) and STOCK_LOGIC (the contract address).
'use strict';

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { ADDR, STOCKS, NOTE_FOOTER, RPC_URL } = require('./config');
const rwa = require('./rwa');
const { liveQuote, quotePage } = require('./quote');
const { MIN_DAYS, DEFAULT_GAP_BPS, claimHeld } = require('./claims');
const { PHASE, buildTree, dayKey, epochDay } = require('./ledger');
const { gasOverrides, withHeadroom } = require('./gas');
const { loadEnv, relayerKey } = require('./env');

const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];
const LOGIC_ABI = [
  'function handleAction(uint256 tokenId, string action, bytes payload) returns (bool success, bytes result)',
  'function positionOf(uint256 tokenId, address stock) view returns (uint256 units, uint256 costUsd, uint256 openedAt, uint256 stopLossBps, uint256 takeProfitBps)',
];
const VAULT_ABI = ['function tbaFor(uint256) view returns (address)'];

const str = (v) => (v === null || v === undefined ? null : String(v));
const round = (n, dp) => (Number.isFinite(n) ? n.toFixed(dp) : null);
const pct = (bps) => `${Number(bps) >= 0 ? '+' : ''}${(Number(bps) / 100).toFixed(2)}%`;

/**
 * Live reads: market status, each stock and its Ondo twin, the pool price against the real share
 * (quote.js), the wallet's balances and, given the logic and the agent, its positions and exit targets.
 */
async function snapshot({ provider, tba, stocks = STOCKS, rwa: rwaImpl = rwa, logic, tokenId }) {
  const block = await provider.getBlockNumber();
  const market = await rwaImpl.marketStatus();
  const logicC = logic && tokenId !== undefined ? new ethers.Contract(logic, LOGIC_ABI, provider) : null;
  const rows = [];
  for (const stock of stocks) {
    const lq = await liveQuote({ provider, stock, blockTag: block, rwa: rwaImpl });
    const balance = tba
      ? await new ethers.Contract(stock.address, ERC20_ABI, provider).balanceOf(tba, { blockTag: block })
      : ethers.constants.Zero;
    // `live` is the quote with numbers, for the runner's decisions; pages copy only `quote`.
    const row = { stock, token: lq.token, twin: lq.twin, balance: balance.toString(), impact1000: lq.impact1000UsdPct, quote: quotePage(lq), live: lq };
    if (logicC) {
      const p = await logicC.positionOf(tokenId, stock.address, { blockTag: block });
      if (!p.units.isZero()) {
        row.position = { units: p.units.toString(), costUsd: p.costUsd.toString(), takeProfitBps: p.takeProfitBps.toNumber(), stopLossBps: p.stopLossBps.toNumber() };
      }
    }
    rows.push(row);
  }
  return { block, takenAt: new Date().toISOString(), market, rows };
}

/** The sentence a note (or an outcome) says about the pool price against the real share. */
function premiumSentence(stock, quote) {
  if (!quote || quote.premiumBps === null || quote.premiumBps === undefined) return null;
  const fee = quote.feeBps === null || quote.feeBps === undefined ? '' : `; a trade also pays the pool's ${(Number(quote.feeBps) / 100).toFixed(2)}% swap fee`;
  return `The pool prices one ${stock.underlying} share at ${Number(quote.perShare).toFixed(2)} USD, ${pct(quote.premiumBps)} against the ` +
    `real share at ${Number(quote.reference).toFixed(2)} (${quote.session || 'unknown'} session)${fee}.`;
}

function noteText(row) {
  const { stock, token, twin } = row;
  const held = Number(ethers.utils.formatEther(row.balance));
  const price = Number(token.tokenPrice);
  const multiplier = Number(token.sharesMultiplier);
  const sentences = [
    `The desk holds ${round(held, 6)} ${stock.symbol}, about ${round(held * price, 2)} USD at ${round(price, 2)} per token ` +
      `(${round(held * multiplier, 6)} ${stock.underlying} shares at a multiplier of ${token.sharesMultiplier}).`,
  ];
  if (twin) {
    sentences.push(
      `Ondo's ${stock.ondo.symbol} is in its ${twin.status?.market ?? 'unknown'} session, reference price ` +
        `${twin.referencePrice ?? 'not published'}.`,
    );
  }
  sentences.push(
    row.impact1000 === null
      ? `There was no USDT quote for ${stock.symbol} at 1,000 USD.`
      : `A 1,000 USD buy moves the ${stock.symbol}/USDT pool by ${row.impact1000}%.`,
  );
  const premium = premiumSentence(stock, row.quote);
  if (premium) sentences.push(premium);
  if (row.position) {
    const cost = Number(ethers.utils.formatEther(row.position.costUsd));
    const { takeProfitBps: tp, stopLossBps: sl } = row.position;
    sentences.push(tp || sl
      ? `The position cost ${round(cost, 2)} USD; the desk sells it ${[tp ? `at ${pct(tp)}` : null, sl ? `at ${pct(-sl)}` : null].filter(Boolean).join(' or ')} from that.`
      : `The position cost ${round(cost, 2)} USD; it has no exit plan.`);
  }
  if (row.rating && row.rating.rank) {
    const r = row.rating;
    sentences.push(`The desk ranks ${stock.symbol} ${ordinal(r.rank)} of ${r.of} by how closely it tracks the real stock (${r.score} bps: ` +
      `${Math.abs(Number(r.premiumBps)).toFixed(1)} from the real share now and a typical drift of ${r.driftBps} bps` +
      `${r.days >= MIN_DAYS ? ` over ${r.days} days` : ', assumed until it has three days of history'}).`);
  }
  if (row.claim) {
    // Worded as it is scored: once, at the close, on the move since this note (outcomePages).
    sentences.push(`Claim: at the close, ${stock.symbol}'s move since this note is within ${row.claim.bandBps} bps of ${stock.underlying}'s move, either way.`);
  }
  return sentences.join(' ');
}

const ordinal = (n) => `${n}${[11, 12, 13].includes(n % 100) ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;

/** A claim as it goes into a page: integers and decimal strings only. */
const claimPage = (c) => ({ bandBps: c.bandBps, basis: c.basis, days: c.days, typicalGapBps: c.typicalGapBps === undefined ? null : c.typicalGapBps.toFixed(1) });

/**
 * Pure: turns a snapshot into the day's pages. Same input, same pages, same root.
 * Numbers are strings (see ledger.js); booleans and the integer day/phase are kept as they are.
 */
function pagesFor({ tokenId, day, phase, tba, snap, openLedger, extraPages = [], analysis }) {
  const m = snap.market || {};
  // The morning's research (claims.js): every stock ranked, and a claim for each one it holds.
  const ranked = analysis ? analysis.ranking.filter((r) => r.rank !== null).length : 0;
  const ratingOf = (symbol) => {
    const r = analysis && analysis.ranking.find((x) => x.symbol === symbol);
    return r ? { rank: r.rank, of: ranked, score: r.score === null ? null : r.score.toFixed(1), premiumBps: r.premiumBps === null ? null : Number(r.premiumBps).toFixed(1),
      driftBps: (r.profile.typicalGapBps === null ? DEFAULT_GAP_BPS : r.profile.typicalGapBps).toFixed(1), days: r.profile.days } : null;
  };
  const pages = [
    {
      kind: 'market',
      day,
      phase,
      tokenId: String(tokenId),
      wallet: tba,
      block: String(snap.block),
      takenAt: snap.takenAt,
      session: { open: m.open ?? null, market: m.market ?? null, reason: m.reason ?? null, nextOpen: str(m.nextOpen), nextClose: str(m.nextClose) },
    },
  ];
  for (const row of snap.rows) {
    pages.push({
      kind: 'session',
      day,
      phase,
      stock: row.stock.symbol,
      underlying: row.stock.underlying,
      bStock: {
        open: row.token.status?.open ?? null,
        reason: row.token.status?.reason ?? null,
        tokenPrice: str(row.token.tokenPrice),
        sharesMultiplier: str(row.token.sharesMultiplier),
      },
      ondo: row.twin
        ? {
          symbol: row.stock.ondo.symbol,
          market: row.twin.status?.market ?? null,
          reason: row.twin.status?.reason ?? null,
          tokenPrice: str(row.twin.tokenPrice),
          sharesMultiplier: str(row.twin.sharesMultiplier),
          referencePrice: str(row.twin.referencePrice),
        }
        : null,
      impact1000UsdPct: row.impact1000,
      ...(row.quote ? { pool: row.quote } : {}),
    });
    // The rule: a note only for a stock the wallet holds, with the proof.
    if (BigInt(row.balance) > 0n) {
      const rating = phase === PHASE.OPEN ? ratingOf(row.stock.symbol) : null;
      const claim = phase === PHASE.OPEN && analysis && analysis.claims[row.stock.symbol] ? analysis.claims[row.stock.symbol] : null;
      pages.push({
        kind: 'note',
        day,
        phase,
        stock: row.stock.symbol,
        position: { wallet: tba, balance: row.balance, block: String(snap.block) },
        // What a buyer acts on: the price against the real share, and the desk's own plan (on chain).
        ...(row.quote ? { quote: row.quote } : {}),
        ...(row.position ? { plan: row.position } : {}),
        // Where it ranks the stock, and what it claims until the close (checked by the close's outcome).
        ...(rating ? { rating } : {}),
        ...(claim ? { claim: claimPage(claim) } : {}),
        text: noteText({ ...row, rating, claim }),
        footer: NOTE_FOOTER,
      });
    }
  }
  if (phase === PHASE.OPEN && analysis) {
    pages.push({
      kind: 'ranking',
      day,
      phase,
      of: ranked,
      rows: analysis.ranking.map((r) => ({
        stock: r.symbol,
        rank: r.rank,
        score: r.score === null ? null : r.score.toFixed(1),
        premiumBps: r.premiumBps === null || r.premiumBps === undefined ? null : Number(r.premiumBps).toFixed(1),
        typicalGapBps: r.profile.typicalGapBps === null ? null : r.profile.typicalGapBps.toFixed(1),
        days: r.profile.days,
        unfit: r.unfit || null,
        // Whether the desk can buy it at all (listed on the contract, not sell-only): ranked either way.
        buyable: r.buyable === undefined ? null : r.buyable,
      })),
      // In pick mode, what the Analyst held and why it kept or swapped (claims.pickTrades), decided
      // before this ledger was written.
      ...(analysis.pick ? { pick: analysis.pick } : {}),
    });
  }
  if (phase === PHASE.CLOSE && openLedger) pages.push(...trackingPages({ day, openLedger, snap }), ...outcomePages({ day, openLedger, snap }));
  pages.push(...extraPages);
  return pages;
}

/**
 * After the close, how every stock tracked its real stock from the open ledger to now: the history the
 * next claims are sized from (history.js), for held and unheld stocks alike.
 */
function trackingPages({ day, openLedger, snap }) {
  const out = [];
  const opened = new Map(openLedger.pages.map((e) => e.page).filter((p) => p.kind === 'session' && p.pool).map((p) => [p.stock, p.pool]));
  for (const row of snap.rows) {
    const a = opened.get(row.stock.symbol);
    const b = row.quote;
    if (!a || !b || !a.perShare || !b.perShare || !a.reference || !b.reference) continue;
    const move = (x, y) => (Number(y) / Number(x) - 1) * 10000;
    const bStockBps = move(a.perShare, b.perShare);
    const referenceBps = move(a.reference, b.reference);
    out.push({
      kind: 'tracking',
      day,
      phase: PHASE.CLOSE,
      stock: row.stock.symbol,
      open: { perShare: a.perShare, reference: a.reference },
      close: { perShare: b.perShare, reference: b.reference },
      bStockChangeBps: bStockBps.toFixed(1),
      referenceChangeBps: referenceBps.toFixed(1),
      gapBps: (bStockBps - referenceBps).toFixed(1),
    });
  }
  return out;
}

/**
 * After the close, what became of each note written before the open: how the bStock moved per share
 * against the real stock (the tracking gap), and how its premium changed. Only notes that carried a
 * quote, and stocks with a quote now, get one.
 */
function outcomePages({ day, openLedger, snap }) {
  const out = [];
  for (const { page } of openLedger.pages) {
    if (page.kind !== 'note' || !page.quote || page.quote.premiumBps === null) continue;
    const row = snap.rows.find((r) => r.stock.symbol === page.stock);
    const now = row && row.quote;
    if (!now || now.premiumBps === null) continue;
    const move = (a, b) => (Number(b) / Number(a) - 1) * 10000;
    const bStockBps = move(page.quote.perShare, now.perShare);
    const referenceBps = move(page.quote.reference, now.reference);
    const gap = bStockBps - referenceBps;
    // A note written before premiums left the swap fee out (no feeBps) is not comparable with one now.
    const comparable = (page.quote.feeBps === undefined) === (now.feeBps === undefined);
    const premiumChange = comparable ? Number(now.premiumBps) - Number(page.quote.premiumBps) : null;
    // The note's claim, checked: its gap from the note to now inside the band it gave.
    const verdict = page.claim ? { bandBps: page.claim.bandBps, gapBps: gap.toFixed(1), held: claimHeld(page.claim, gap) } : null;
    out.push({
      kind: 'outcome',
      day,
      phase: PHASE.CLOSE,
      stock: page.stock,
      note: { day: openLedger.day, phase: openLedger.phase, root: openLedger.root },
      open: { ...page.quote, block: page.position.block },
      close: { ...now, block: String(snap.block) },
      bStockChangeBps: bStockBps.toFixed(1),
      referenceChangeBps: referenceBps.toFixed(1),
      trackingGapBps: gap.toFixed(1),
      premiumChangeBps: premiumChange === null ? null : premiumChange.toFixed(1),
      ...(verdict ? { claim: verdict } : {}),
      text: `Per share, ${page.stock} moved ${pct(bStockBps)} from before the open to after the close and the real ${row.stock.underlying} ` +
        `moved ${pct(referenceBps)}: a tracking gap of ${gap.toFixed(1)} bps.` +
        (premiumChange === null ? '' : ` Its premium went from ${pct(page.quote.premiumBps)} to ${pct(now.premiumBps)}.`) +
        (verdict ? ` Claim ${verdict.held ? 'held' : 'missed'}: within ${verdict.bandBps} bps either way, the gap was ${gap.toFixed(1)} bps.` : ''),
    });
  }
  return out;
}

/**
 * Builds the day's ledger file content from a snapshot (and, for the close, the day's open ledger and
 * any pages the runner adds, such as the exits it made).
 */
function ledgerFor({ tokenId, day, phase, tba, snap, openLedger, extraPages, analysis }) {
  const pages = pagesFor({ tokenId, day, phase, tba, snap, openLedger, extraPages, analysis });
  return ledgerOfPages({ tokenId, day, phase, wallet: tba, block: snap.block, pages });
}

/** A ledger from pages already written (the Trader's record is built this way, not from a snapshot). */
function ledgerOfPages({ tokenId, day, phase, wallet, block, pages }) {
  const { root, entries } = buildTree(pages);
  return {
    format: 'desk-notes/1',
    tokenId: String(tokenId),
    day,
    // The on-chain key: the anchoring block's UTC day number. Filled in when the root is anchored.
    epochDay: null,
    phase,
    wallet,
    block: String(block),
    root,
    pages: entries.map((e) => ({ page: e.page, leaf: e.leaf, proof: e.proof })),
  };
}

/** Anchors the ledger's root. The contract files it under the block's UTC day, returned here. */
async function anchor({ signer, logicAddress, ledger, uri }) {
  const logic = new ethers.Contract(logicAddress, LOGIC_ABI, signer);
  const payload = ethers.utils.defaultAbiCoder.encode(['uint8', 'bytes32', 'string'], [ledger.phase, ledger.root, uri]);
  const args = [ledger.tokenId, 'anchor_notes', payload];
  const tx = await logic.handleAction(...args, await withHeadroom(logic, 'handleAction', args, await gasOverrides(signer.provider)));
  const receipt = await tx.wait();
  const block = await signer.provider.getBlock(receipt.blockNumber);
  return { tx: receipt.transactionHash, block: receipt.blockNumber, epochDay: epochDay(block.timestamp) };
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else { args[key] = next; i++; }
    } else args._.push(a);
  }
  return args;
}

async function main() {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  const phaseName = args._[0];
  if (!['open', 'close'].includes(phaseName) || !args.token) {
    console.error('usage: node src/desk.js <open|close> --token <id> [--tba <wallet>] [--day yyyymmdd] [--out ledger] [--anchor]');
    process.exit(2);
  }
  const phase = phaseName === 'open' ? PHASE.OPEN : PHASE.CLOSE;
  const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
  const tba = args.tba || (await new ethers.Contract(ADDR.VAULT_MANAGER, VAULT_ABI, provider).tbaFor(args.token));
  const day = args.day ? Number(args.day) : dayKey();

  // With STOCK_LOGIC set, notes carry the agent's positions and exit targets from the contract.
  const snap = await snapshot({ provider, tba, logic: process.env.STOCK_LOGIC, tokenId: args.token });
  const ledger = ledgerFor({ tokenId: args.token, day, phase, tba, snap });

  const dir = path.join(args.out || 'ledger', String(args.token));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${day}-${phase}.json`);
  if (fs.existsSync(file) && !args.force) throw new Error(`${file} exists; a day and phase are written once (use --force only for a dry run)`);

  if (args.anchor) {
    if (!relayerKey() || !process.env.STOCK_LOGIC) throw new Error('--anchor needs RELAYER_KEY (or RUNTIME_PRIVATE_KEY) and STOCK_LOGIC');
    const signer = new ethers.Wallet(relayerKey(), provider);
    ledger.anchor = await anchor({ signer, logicAddress: process.env.STOCK_LOGIC, ledger, uri: args.uri || `desk-notes:${args.token}/${day}-${phase}` });
    ledger.epochDay = ledger.anchor.epochDay;
    ledger.logic = process.env.STOCK_LOGIC;
  }
  fs.writeFileSync(file, JSON.stringify(ledger, null, 2));

  const notes = ledger.pages.filter((p) => p.page.kind === 'note').length;
  console.log(`${phaseName} ${day} agent #${args.token} wallet ${tba}: ${ledger.pages.length} pages (${notes} notes), root ${ledger.root}`);
  console.log(ledger.anchor ? `anchored in tx ${ledger.anchor.tx}` : 'not anchored (dry run)');
  console.log(`written to ${file}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}

module.exports = { snapshot, pagesFor, ledgerFor, ledgerOfPages, noteText, outcomePages, trackingPages, anchor };
