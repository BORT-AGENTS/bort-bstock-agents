// The desk's daily runner. On US market days (New York time):
//   09:00  OPEN    the Analyst ranks the stocks, makes at most one swap (ANALYST_PICK; else it buys back
//                  its fixed ANALYST_TARGETS), sets exit plans, then anchors its open ledger: the ranking
//                  and a note per stock it holds, with the price, a claim and its exit plan
//   10:00  TRADER  the Trader buys each of the Analyst's notes it can pay for over x402, checks them against
//                  the chain, decides on a fresh quote whether to follow the best-ranked one (else the next),
//                  buys, and copies that note's exit plan
//   16:15  CLOSE   the Analyst anchors its close ledger (each morning note scored against the day), and
//                  the Trader anchors its own record of the day (the note, its decision, its exits)
//   every 15 min   EXITS  each agent's positions against their targets, sold when one is reached
// A note seller for the Analyst runs the whole time (seller.js). Every job is also a one-shot command.
//
//   node src/runner.js daemon            run the schedule (and the seller) until stopped
//   node src/runner.js open|trader|close|exits  run one job now
//   RUNNER_DRY=1 ...                     log what would be sent, send nothing
// A job that fails is tried again 5 minutes later, up to 3 times (the close 6) inside its window. Finished jobs and
// the Trader's paid note are kept in RUNNER_DATA/runner-state.json, so a restart repeats nothing.
//
// Env (see .env.example): STOCK_LOGIC, ANALYST_ID, TRADER_ID; the relayer key (RELAYER_KEY, or
// BORT's RUNTIME_PRIVATE_KEY through ENV_FILE); optional ANALYST_TARGETS ("NVDAB:15,QQQB:15", USD
// each), TRADER_BUY_USD (5), NOTE_PRICE_U (0.02), SELLER_PORT (8402), SELLER_PUBLIC_URL (the https
// address a tunnel gives the seller, named in its terms), BSC_RPC, LEDGER_DIR (ledger),
// SITE_DIR (site: after each close the day's ledgers are published there for the ledger page); the
// trading rules (rules.js: BUY_MAX_PREMIUM_BPS, PRICE_SANITY_BPS, TAKE_PROFIT_BPS, STOP_LOSS_BPS) and
// EXIT_EVERY_MIN (15). With PINATA_API_KEY and PINATA_SECRET_API_KEY (BORT's, through ENV_FILE) each
// close anchors the IPFS address of the agent's whole record, and pins a summary of it (record.js);
// RECORD_IPFS=0 turns that off.
'use strict';

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { ADDR, STOCKS } = require('./config');
const { SturdyProvider } = require('./rpc');
const { loadEnv, relayerKey } = require('./env');
const { PHASE, dayKey, epochDay, pageHash } = require('./ledger');
const { snapshot, ledgerFor, ledgerOfPages } = require('./desk');
const { createSeller, latestLedger, publicUrlOf } = require('./seller');
const { payWithAgent } = require('./x402');
const { SIDE, trade, priceFloor, sendWithRetry, stockBySymbol } = require('./trade');
const { publish } = require('./publish');
const { withHeadroom } = require('./gas');
const { liveQuote, quotePage } = require('./quote');
const { rulesFromEnv, buyCheck, exitCheck, priceUnfit } = require('./rules');
const { readHistory } = require('./history');
const { profile, claimFor, planFor, rank, pickTrades, KEEP_TOP } = require('./claims');
const { recordOf, summaryOf } = require('./record');
const { pinataFromEnv, pinJSON } = require('./ipfs');

const REPLAN_BPS = 50; // an exit plan is reset when the desk's sizing moves it by this much or more

const LOGIC_ABI = [
  'function handleAction(uint256 tokenId, string action, bytes payload) returns (bool success, bytes result)',
  'function bnbToUsd(uint256) view returns (uint256)',
  'function verifyAnchored(uint256 tokenId, uint32 day, uint8 phase, bytes32 pageHash, bytes32[] proof) view returns (bool ok, uint64 anchoredAt)',
  'function anchors(uint256, uint32, uint8) view returns (bytes32 root, uint64 anchoredAt)',
  'function today() view returns (uint32)',
  'function openPositions(uint256 tokenId) view returns (address[])',
  'function positionOf(uint256 tokenId, address stock) view returns (uint256 units, uint256 costUsd, uint256 openedAt, uint256 stopLossBps, uint256 takeProfitBps)',
];
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];
const VAULT_ABI = ['function tbaFor(uint256) view returns (address)'];
const GAS_RESERVE = ethers.utils.parseEther('0.005'); // BNB always left for the agent's own gas

// ── New York market clock ──
const NY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' });
const HOLIDAYS = new Set(['2026-11-26', '2026-12-25', '2027-01-01']); // NYSE closures after launch
function nyParts(date = new Date()) {
  const p = Object.fromEntries(NY.formatToParts(date).map((x) => [x.type, x.value]));
  return { ymd: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute), weekday: p.weekday };
}
const isMarketDay = (p) => !['Sat', 'Sun'].includes(p.weekday) && !HOLIDAYS.has(p.ymd);
const JOBS = [
  { name: 'open', at: 9 * 60, lateUntil: 15 * 60 },
  { name: 'trader', at: 10 * 60, lateUntil: 15 * 60 },
  // The close gets more tries: a day whose close is never anchored loses its outcomes and its claims.
  { name: 'close', at: 16 * 60 + 15, lateUntil: 23 * 60, attempts: 6 },
];

// ── context ──
function makeLog(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'runner-events.jsonl');
  return (event, data = {}) => {
    const line = { at: new Date().toISOString(), event, ...data };
    fs.appendFileSync(file, `${JSON.stringify(line, (k, v) => (ethers.BigNumber.isBigNumber(v) ? v.toString() : v))}\n`);
    console.log(`[${line.at}] ${event}${Object.keys(data).length ? ` ${JSON.stringify(data, (k, v) => (ethers.BigNumber.isBigNumber(v) ? v.toString() : v))}` : ''}`);
  };
}

function parseTargets(spec) {
  return String(spec || 'NVDAB:15,QQQB:15').split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
    const [symbol, usd] = x.split(':');
    const stock = stockBySymbol(symbol);
    if (!stock) throw new Error(`ANALYST_TARGETS: ${symbol} is not a desk stock`);
    return { stock, usd: Number(usd) };
  });
}

async function walletOf(provider, tokenId) {
  return new ethers.Contract(ADDR.VAULT_MANAGER, VAULT_ABI, provider).tbaFor(tokenId);
}

// ── jobs ──

/** A buy of `usd` dollars from the wallet: USDT if it holds enough, else $U, else BNB above the gas reserve. */
async function buyUsdWorth(ctx, agent, stock, usd) {
  const { signer, logic } = ctx;
  const provider = signer.provider;
  const want = ethers.utils.parseEther(String(usd));
  const [usdt, u, bnb] = await Promise.all([
    new ethers.Contract(ADDR.USDT, ERC20_ABI, provider).balanceOf(agent.wallet),
    new ethers.Contract(ADDR.U, ERC20_ABI, provider).balanceOf(agent.wallet),
    provider.getBalance(agent.wallet),
  ]);
  let side;
  let amountIn;
  if (usdt.gte(want)) { side = SIDE.USDT; amountIn = want; } else if (u.gte(want)) { side = SIDE.U; amountIn = want; } else {
    const usdPerBnb = await new ethers.Contract(logic, LOGIC_ABI, provider).bnbToUsd(ethers.utils.parseEther('1'));
    amountIn = want.mul(ethers.utils.parseEther('1')).div(usdPerBnb);
    if (bnb.sub(amountIn).lt(GAS_RESERVE)) return { skipped: `not enough USDT, $U or BNB for ${usd} USD` };
    side = SIDE.BNB;
  }
  if (ctx.dry) return { dry: true, side, amountIn };
  return trade({ signer, logic, tokenId: agent.tokenId, wallet: agent.wallet, stock: stock.address, side, amountIn, buying: true });
}

/** The live quote for a desk stock (quote.js), through the context's Binance client. */
const quoteFor = (ctx, stock) => liveQuote({ provider: ctx.signer.provider, stock, rwa: ctx.rwa });
const stockAt = (address) => STOCKS.find((s) => s.address.toLowerCase() === String(address).toLowerCase());

/** Sets an open position's exit targets through the relayer (set_targets). Returns the tx hash. */
async function setTargets(ctx, agent, stock, takeProfitBps, stopLossBps) {
  const payload = ethers.utils.defaultAbiCoder.encode(['address', 'uint32', 'uint32'], [stock.address, stopLossBps, takeProfitBps]);
  const c = new ethers.Contract(ctx.logic, LOGIC_ABI, ctx.signer);
  const args = [agent.tokenId, 'set_targets', payload];
  const receipt = await sendWithRetry(ctx.signer, async (o) => c.handleAction(...args, await withHeadroom(c, 'handleAction', args, o)));
  return receipt.transactionHash;
}

/**
 * Gives each open position of the agent an exit plan: the per-stock one the day's research sized
 * (`plans`, claims.planFor), else the default. A position without targets always gets one; with
 * `refresh` (the Analyst's own positions) one whose plan moved by REPLAN_BPS or more is reset too.
 * Targets count only for the owner who set them, so after a sale the new owner's positions get one here.
 */
async function ensureTargets(ctx, agent, { plans = {}, refresh = false } = {}) {
  const logicC = new ethers.Contract(ctx.logic, LOGIC_ABI, ctx.signer.provider);
  for (const address of await logicC.openPositions(agent.tokenId)) {
    const stock = stockAt(address);
    if (!stock) continue;
    const p = await logicC.positionOf(agent.tokenId, address);
    if (p.units.isZero()) continue;
    const want = plans[stock.symbol] || ctx.rules.takeProfitBps;
    const [tp, sl] = [p.takeProfitBps.toNumber(), p.stopLossBps.toNumber()];
    const none = !tp && !sl;
    if (!none && !(refresh && (Math.abs(tp - want) >= REPLAN_BPS || Math.abs(sl - want) >= REPLAN_BPS))) continue;
    const takeProfitBps = want;
    const stopLossBps = want;
    if (ctx.dry) { ctx.log('targets.dry', { tokenId: agent.tokenId, stock: stock.symbol, takeProfitBps, stopLossBps }); continue; }
    const tx = await setTargets(ctx, agent, stock, takeProfitBps, stopLossBps);
    ctx.log('targets.set', { tokenId: agent.tokenId, stock: stock.symbol, takeProfitBps, stopLossBps, tx, ...(none ? {} : { was: [tp, sl] }) });
  }
}

/**
 * The notes the Trader bought, best first: only the ones that checked out on chain, by the rank the desk
 * gave the stock (a note without a rank comes last), then by symbol. It follows the first.
 */
function chooseNotes(bought) {
  const rankOf = (b) => (b.rating && b.rating.rank) || Infinity;
  return Object.values(bought).filter((b) => b.verified).sort((a, b) => (rankOf(a) - rankOf(b)) || a.stock.localeCompare(b.stock));
}

/** Which desk stocks the contract lists for buys now (listed at a fee tier, and buyable). */
async function listedForBuys(ctx) {
  const c = new ethers.Contract(ctx.logic, ['function stockPoolFee(address) view returns (uint24)', 'function allowedStock(address) view returns (bool)'], ctx.signer.provider);
  const out = new Map();
  for (const s of STOCKS) {
    const [fee, ok] = await Promise.all([c.stockPoolFee(s.address), c.allowedStock(s.address)]);
    out.set(s.symbol, fee > 0 && ok);
  }
  return out;
}

/**
 * The morning's research from one snapshot: each desk stock's profile from the desk's own anchored
 * record (history.js), ranked when its price is fit to trade, with the claim a note on it makes and the
 * exit plan sized for it (claims.js). Kept on ctx for the day's open ledger.
 */
async function dayAnalysis(ctx, snap) {
  const day = dayKey();
  const history = readHistory(ctx.ledgerDir, ctx.analyst.tokenId, { beforeDay: day });
  const listed = await listedForBuys(ctx);
  const rows = snap.rows.map((row) => ({
    symbol: row.stock.symbol,
    premiumBps: row.live.premiumBps,
    feeBps: row.live.feeBps,
    impact: row.impact1000 === null ? null : Number(row.impact1000),
    profile: profile(history.get(row.stock.symbol) || []),
    unfit: priceUnfit(row.live, ctx.rules),
    buyable: row.stock.buyable !== false && listed.get(row.stock.symbol) === true,
    buyOk: buyCheck(row.live, ctx.rules).ok,
  }));
  return {
    day,
    ranking: rank(rows),
    claims: Object.fromEntries(rows.map((r) => [r.symbol, claimFor(r.profile)])),
    plans: Object.fromEntries(rows.map((r) => [r.symbol, planFor(r.profile, ctx.rules.takeProfitBps)])),
  };
}

/** The exits an agent made today (kept by exitJob), as pages for its close record. */
function exitPages(ctx, day, agent) {
  const exits = (ctx.state && ctx.state.memo(`${nyParts().ymd}:exits`)) || [];
  return exits.filter((x) => String(x.tokenId) === String(agent.tokenId)).map((x) => ({
    kind: 'exit', day, phase: PHASE.CLOSE, stock: x.stock, exit: x.exit, reason: x.reason,
    costUsd: x.costUsd, valueUsd: x.valueUsd, premiumBps: x.premiumBps, tx: x.tx, at: x.at,
  }));
}

/** The Analyst's ledger for one phase: its snapshot, and for the close the outcomes and exits too. */
async function analystLedger(ctx, day, phase) {
  const { analyst } = ctx;
  const snap = await snapshot({ provider: ctx.signer.provider, tba: analyst.wallet, rwa: ctx.rwa, logic: ctx.logic, tokenId: analyst.tokenId });
  let openLedger = null;
  let extraPages = [];
  if (phase === PHASE.CLOSE) {
    const openFile = path.join(ctx.ledgerDir, String(analyst.tokenId), `${day}-${PHASE.OPEN}.json`);
    if (fs.existsSync(openFile)) openLedger = JSON.parse(fs.readFileSync(openFile, 'utf8'));
    extraPages = exitPages(ctx, day, analyst);
  }
  // Before the open the ledger carries the morning's research (the ranking, and a claim in each note).
  const analysis = phase === PHASE.OPEN && ctx.analysis && ctx.analysis.day === day ? ctx.analysis : null;
  return ledgerFor({ tokenId: analyst.tokenId, day, phase, tba: analyst.wallet, snap, openLedger, extraPages, analysis });
}

/**
 * The Trader's record of the day, anchored after the close like the Analyst's: the note it bought (and
 * where that note is anchored), what it decided and why, its exits, and its positions with their targets.
 */
async function traderLedger(ctx, day) {
  const { trader } = ctx;
  const provider = ctx.signer.provider;
  const block = await provider.getBlockNumber();
  const ymd = nyParts().ymd;
  const note = ctx.state ? ctx.state.memo(`${ymd}:trader:note`) : null;
  // Every note it paid for today; a day before it bought them all kept only the one.
  const bought = (ctx.state && ctx.state.memo(`${ymd}:trader:notes`)) || (note && !note.none ? { [note.stock]: note } : {});
  const pages = [{ kind: 'record', day, phase: PHASE.CLOSE, role: 'trader', tokenId: String(trader.tokenId), wallet: trader.wallet, block: String(block) }];
  for (const b of Object.values(bought)) {
    pages.push({
      kind: 'purchase', day, phase: PHASE.CLOSE, stock: b.stock, from: b.from || null, noteHash: b.noteHash || null,
      paidTx: b.paidTx || null, priceU: ethers.utils.formatEther(ctx.notePrice), verified: b.verified,
      rating: b.rating || null, claim: b.claim || null,
    });
  }
  if (note && !note.none) {
    if (note.decision) {
      pages.push({
        kind: 'decision', day, phase: PHASE.CLOSE, stock: note.stock, buy: note.decision.buy, reason: note.decision.reason,
        // Which note it followed: the best-ranked of the ones it bought.
        chosen: { rank: note.rating ? note.rating.rank : null, of: note.of || [note.stock] },
        // Every note it weighed, best-ranked first, and why it did or did not follow each.
        tried: note.decision.tried || null,
        quote: note.decision.quote, at: note.decision.at,
        rules: { maxPremiumBps: String(ctx.rules.maxPremiumBps), sanityBps: String(ctx.rules.sanityBps) },
        // The buy's tx; or 'landed earlier' (it went through, but its answer was lost), or 'skipped' (no funds).
        bought: typeof note.bought === 'string' ? note.bought : null,
        tradeTx: typeof note.bought === 'string' && note.bought.startsWith('0x') ? note.bought : null,
        targets: note.targets || null,
      });
    }
  }
  pages.push(...exitPages(ctx, day, trader));
  const logicC = new ethers.Contract(ctx.logic, LOGIC_ABI, provider);
  for (const address of await logicC.openPositions(trader.tokenId)) {
    const stock = stockAt(address);
    const p = await logicC.positionOf(trader.tokenId, address);
    if (!stock || p.units.isZero()) continue;
    pages.push({
      kind: 'position', day, phase: PHASE.CLOSE, stock: stock.symbol, units: p.units.toString(), costUsd: ethers.utils.formatEther(p.costUsd),
      takeProfitBps: p.takeProfitBps.toNumber(), stopLossBps: p.stopLossBps.toNumber(),
    });
  }
  return ledgerOfPages({ tokenId: trader.tokenId, day, phase: PHASE.CLOSE, wallet: trader.wallet, block, pages });
}

/**
 * Builds and anchors one phase of an agent's ledger (the Analyst's by default, from its snapshot; or
 * `build(day)`'s), and writes it under ledgerDir/<tokenId>, where the seller reads the Analyst's.
 */
async function anchorLedger(ctx, phase, agent = ctx.analyst, build = null) {
  const { signer, logic } = ctx;
  const provider = signer.provider;
  const day = dayKey();
  const dir = path.join(ctx.ledgerDir, String(agent.tokenId));
  const file = path.join(dir, `${day}-${phase}.json`);
  // The pages as they stood when their root was sent (not .json, so the seller never serves them).
  const pending = `${file}.pending`;
  if (fs.existsSync(file)) return { skipped: `${path.basename(file)} exists` };
  const logicC = new ethers.Contract(logic, LOGIC_ABI, provider);
  const chainDay = await logicC.today();
  const existing = await logicC.anchors(agent.tokenId, chainDay, phase);
  if (!existing.anchoredAt.isZero()) {
    // A send that landed before the process could write its result: finish it from the pending pages.
    const kept = fs.existsSync(pending) ? JSON.parse(fs.readFileSync(pending, 'utf8')) : null;
    if (kept && kept.root === existing.root) {
      // The pending file also keeps the address the root was sent with, once the record was pinned.
      const { uri = null, ...done } = kept;
      Object.assign(done, { anchor: { tx: null, recovered: true, anchoredAt: existing.anchoredAt.toNumber(), uri }, epochDay: Number(chainDay), logic });
      fs.writeFileSync(file, JSON.stringify(done, null, 2));
      fs.unlinkSync(pending);
      return { recovered: path.basename(file), root: done.root };
    }
    return { skipped: `phase ${phase} of chain day ${chainDay} is already anchored` };
  }

  const ledger = build ? await build(day) : await analystLedger(ctx, day, phase);
  if (ctx.dry) {
    const says = ledger.pages.filter((p) => ['note', 'outcome', 'decision'].includes(p.page.kind)).map((p) => `${p.page.kind} ${p.page.stock}: ${p.page.text || p.page.reason}`);
    return { dry: true, root: ledger.root, pages: ledger.pages.length, says };
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(pending, JSON.stringify(ledger, null, 2));
  // The close makes the day public, so its anchor carries the IPFS address of the agent's whole record
  // (every public day, this close included): the record can be found from the chain alone. A pin that
  // fails leaves the plain label; the anchor never waits on IPFS.
  let uri = `desk-notes:${agent.tokenId}/${day}-${phase}`;
  if (phase === PHASE.CLOSE && ctx.pin) {
    try {
      const record = recordOf({ ledgerDir: ctx.ledgerDir, tokenId: agent.tokenId, logic, closing: { ...ledger, epochDay: Number(chainDay) } });
      uri = `ipfs://${await ctx.pin(record, `desk-record-${agent.tokenId}-${day}`)}`;
      fs.writeFileSync(pending, JSON.stringify({ ...ledger, uri }, null, 2));
    } catch (e) {
      ctx.log('record.pin.failed', { tokenId: String(agent.tokenId), day, reason: e.message });
    }
  }
  const payload = ethers.utils.defaultAbiCoder.encode(['uint8', 'bytes32', 'string'], [phase, ledger.root, uri]);
  const c = new ethers.Contract(logic, LOGIC_ABI, signer);
  const args = [agent.tokenId, 'anchor_notes', payload];
  const receipt = await sendWithRetry(signer, async (o) => c.handleAction(...args, await withHeadroom(c, 'handleAction', args, o)));
  const block = await provider.getBlock(receipt.blockNumber);
  ledger.anchor = { tx: receipt.transactionHash, block: receipt.blockNumber, epochDay: epochDay(block.timestamp), uri };
  ledger.epochDay = ledger.anchor.epochDay;
  ledger.logic = logic;
  fs.writeFileSync(file, JSON.stringify(ledger, null, 2));
  fs.unlinkSync(pending);
  return { tx: receipt.transactionHash, root: ledger.root, pages: ledger.pages.length, notes: ledger.pages.filter((p) => p.page.kind === 'note').length, uri };
}

/**
 * Pins the summary of an agent's record once today's close is anchored with the record's IPFS address,
 * and keeps the summary's address in that close ledger: the ledger page links it, and the owner can
 * register it as one of the agent's knowledge sources. Null when there is nothing to do.
 */
async function pinSummary(ctx, agent) {
  const day = dayKey();
  const file = path.join(ctx.ledgerDir, String(agent.tokenId), `${day}-${PHASE.CLOSE}.json`);
  if (!fs.existsSync(file)) return null;
  const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
  const recordUri = ledger.anchor && ledger.anchor.uri;
  if (ledger.summary || !recordUri || !recordUri.startsWith('ipfs://')) return null;
  const record = recordOf({ ledgerDir: ctx.ledgerDir, tokenId: agent.tokenId, logic: ctx.logic });
  const names = ctx.names || {};
  const summary = summaryOf({ record, recordUri, name: names[String(agent.tokenId)], analystName: names[String(ctx.analyst.tokenId)] });
  ledger.summary = `ipfs://${await ctx.pin(summary, `desk-summary-${agent.tokenId}-${day}`)}`;
  fs.writeFileSync(file, JSON.stringify(ledger, null, 2));
  return { tokenId: String(agent.tokenId), summary: ledger.summary, record: recordUri };
}

async function openJob(ctx) {
  const { analyst } = ctx;
  // One look at the market before any trade: the day's research (ranking, claims, plans) comes from it.
  const snap = await snapshot({ provider: ctx.signer.provider, tba: analyst.wallet, rwa: ctx.rwa, logic: ctx.logic, tokenId: analyst.tokenId });
  ctx.analysis = await dayAnalysis(ctx, snap);
  if (ctx.pick) await pickAndTrade(ctx, snap, ctx.analysis);
  else await buyTargets(ctx, snap);
  // The exit plan goes into the notes, so set it before the ledger is written; a failure leaves the
  // notes saying "no exit targets" rather than holding up the anchor. The Analyst's plans follow the
  // day's sizing; the Trader's positions get one only when they have none (it copies the notes' plans),
  // so one it holds from an earlier day is covered even on a day it does not buy.
  for (const [agent, refresh] of [[ctx.analyst, true], [ctx.trader, false]]) {
    if (!agent) continue;
    try {
      await ensureTargets(ctx, agent, { plans: ctx.analysis.plans, refresh });
    } catch (e) {
      ctx.log('targets.failed', { tokenId: agent.tokenId, reason: e.reason || e.message });
    }
  }
  ctx.log('analyst.anchor.open', await anchorLedger(ctx, PHASE.OPEN));
}

/** Fixed targets (ANALYST_TARGETS): buy back any the Analyst no longer holds, at a fair price only. */
async function buyTargets(ctx, snap) {
  for (const t of ctx.targets) {
    const row = snap.rows.find((r) => r.stock.symbol === t.stock.symbol);
    if (BigInt(row.balance) > 0n) { ctx.log('analyst.hold', { stock: t.stock.symbol, units: ethers.utils.formatEther(row.balance) }); continue; }
    try {
      // Back in only at a fair price against the real share (after an exit, say): else no note on it today.
      const check = buyCheck(row.live, ctx.rules);
      if (!check.ok) { ctx.log('analyst.skip', { stock: t.stock.symbol, reason: check.reason, premiumBps: row.quote.premiumBps }); continue; }
      const r = await buyUsdWorth(ctx, ctx.analyst, t.stock, t.usd);
      ctx.log('analyst.buy', { stock: t.stock.symbol, usd: t.usd, premiumBps: row.quote.premiumBps, ...(r.receipt ? { tx: r.receipt.transactionHash, floor: r.floor } : r) });
    } catch (e) {
      ctx.log('analyst.buy.failed', { stock: t.stock.symbol, reason: e.reason || e.message });
    }
  }
}

/**
 * Pick mode (ANALYST_PICK=k): the Analyst holds the k best-ranked stocks the contract lets it buy, and
 * replaces one only when it falls out of the top KEEP_TOP (claims.pickTrades), at most one a day. The
 * sale goes to USDT under the same price check as an exit; the buy follows only if the sale went through.
 */
async function pickAndTrade(ctx, snap, analysis) {
  const { analyst } = ctx;
  // Holdings the desk bought itself; stock someone sent in directly is noted, never sold for a swap.
  const held = snap.rows.filter((r) => BigInt(r.balance) > 0n && r.position && BigInt(r.position.units) > 0n).map((r) => r.stock.symbol);
  const d = pickTrades({ held, ranked: analysis.ranking, k: ctx.pick, keepTop: ctx.keepTop || KEEP_TOP });
  ctx.log('analyst.pick', { held, sell: d.sell, buy: d.buy, why: d.why, top: analysis.ranking.filter((r) => r.rank !== null).slice(0, 5).map((r) => `${r.symbol}:${r.rank}`) });
  // The decision goes into the day's ranking page, so the anchored record says why it kept or swapped.
  analysis.pick = { held, sell: d.sell, buy: d.buy, why: d.why };
  if (ctx.dry) return;
  if (d.sell) {
    const row = snap.rows.find((r) => r.stock.symbol === d.sell);
    const units = BigInt(row.position.units) < BigInt(row.balance) ? row.position.units : row.balance;
    const unfit = priceUnfit(row.live, ctx.rules);
    if (unfit) { ctx.log('analyst.swap.held', { stock: d.sell, reason: unfit }); analysis.pick.notMade = unfit; return; }
    const r = await trade({ signer: ctx.signer, logic: ctx.logic, tokenId: analyst.tokenId, wallet: analyst.wallet, stock: row.stock.address, side: SIDE.USDT, amountIn: units, buying: false });
    if (!r.receipt) { ctx.log('analyst.swap.blocked', { stock: d.sell, reason: r.skipped }); analysis.pick.notMade = r.skipped; return; }
    ctx.log('analyst.sell', { stock: d.sell, why: d.why, tx: r.receipt.transactionHash });
  }
  for (const symbol of d.buy) {
    try {
      const r = await buyUsdWorth(ctx, analyst, stockBySymbol(symbol), ctx.positionUsd);
      ctx.log('analyst.buy', { stock: symbol, usd: ctx.positionUsd, why: d.why, ...(r.receipt ? { tx: r.receipt.transactionHash, floor: r.floor } : r) });
    } catch (e) {
      ctx.log('analyst.buy.failed', { stock: symbol, reason: e.reason || e.message });
    }
  }
}

async function closeJob(ctx) {
  ctx.log('analyst.anchor.close', await anchorLedger(ctx, PHASE.CLOSE));
  if (ctx.trader) ctx.log('trader.anchor.close', await anchorLedger(ctx, PHASE.CLOSE, ctx.trader, (day) => traderLedger(ctx, day)));
  // Each agent's record summary, pinned now that its close carries the record's address.
  if (ctx.pin && !ctx.dry) {
    for (const agent of [ctx.analyst, ctx.trader].filter(Boolean)) {
      try {
        const r = await pinSummary(ctx, agent);
        if (r) ctx.log('record.summary', r);
      } catch (e) {
        ctx.log('record.summary.failed', { tokenId: String(agent.tokenId), reason: e.message });
      }
    }
  }
  // The close is on chain, so the day's pages (the notes sold today included) go public.
  if (ctx.siteDir && !ctx.dry) {
    const index = publish({ ledgerDir: ctx.ledgerDir, siteDir: ctx.siteDir });
    ctx.log('site.published', { days: (index.agents[String(ctx.analyst.tokenId)] || []).length });
  }
}

async function traderJob(ctx) {
  const { signer, logic, analyst, trader } = ctx;
  // The note it follows today, kept so a retry (or a restart) acts on it without paying a second time.
  const memoKey = `${nyParts().ymd}:trader:note`;
  const boughtKey = `${nyParts().ymd}:trader:notes`;
  let note = ctx.state ? ctx.state.memo(memoKey) : undefined;
  if (!note) {
    const ledger = latestLedger(path.join(ctx.ledgerDir, String(analyst.tokenId)));
    const symbols = ledger ? ledger.pages.filter((p) => p.page.kind === 'note').map((p) => p.page.stock) : [];
    if (symbols.length === 0) throw new Error('the Analyst has no note yet');
    if (ctx.dry) { ctx.log('trader.dry', { notes: symbols }); return; }
    // It buys every note of the day: only together do they say which stock the desk rates best. Each one
    // paid for is kept at once, so a retry buys only the rest.
    const bought = { ...((ctx.state && ctx.state.memo(boughtKey)) || {}) };
    for (const symbol of symbols) {
      if (bought[symbol]) continue;
      // No payment approval (and no gas) until the wallet can pay: wait for $U without using up the retries.
      const u = await new ethers.Contract(ADDR.U, ERC20_ABI, signer.provider).balanceOf(trader.wallet);
      if (u.lt(ctx.notePrice)) {
        if (Object.keys(bought).length) break; // what it has will do
        throw Object.assign(new Error(`the Trader wallet holds ${ethers.utils.formatEther(u)} $U, less than one note`), { wait: true });
      }
      const url = `${ctx.sellerUrl}/notes/${analyst.tokenId}/${symbol}`;
      const res = await payWithAgent({ url, method: 'GET', relayer: signer, logic, tokenId: trader.tokenId, wallet: trader.wallet, maxAmount: ctx.notePrice });
      if (res.status !== 200) throw new Error(`the note answered ${res.status}: ${String(res.body).slice(0, 160)}`);
      const body = JSON.parse(res.body);
      const [ok, anchoredAt] = await new ethers.Contract(logic, LOGIC_ABI, signer.provider)
        .verifyAnchored(body.tokenId, body.epochDay, body.phase, pageHash(body.note), body.proof);
      ctx.log('trader.note', { stock: symbol, paid: res.payment, verified: ok, anchoredAt: anchoredAt.toNumber() });
      bought[symbol] = {
        stock: symbol, verified: ok, paidTx: res.payment ? res.payment.transaction : null,
        // What it bought, and where that is anchored, for its own record; the desk's rank, claim and plan.
        noteHash: pageHash(body.note),
        from: { tokenId: String(body.tokenId), epochDay: Number(body.epochDay), phase: Number(body.phase), root: body.root },
        plan: body.note.plan || null,
        rating: body.note.rating || null,
        claim: body.note.claim || null,
      };
      if (ctx.state) ctx.state.memo(boughtKey, bought);
    }
    const checked = chooseNotes(bought);
    if (!checked.length) {
      note = { none: true, of: Object.keys(bought) };
      if (ctx.state) ctx.state.memo(memoKey, note);
      ctx.log('trader.none', { of: note.of, reason: 'no note it bought checked out on chain' });
      return;
    }
    note = { ...checked[0], of: Object.keys(bought) };
    if (ctx.state) ctx.state.memo(memoKey, note);
    ctx.log('trader.choice', { stock: note.stock, rank: note.rating ? note.rating.rank : null, of: note.of });
  }
  if (note.none || !note.verified) return;
  const save = (next) => { note = next; if (ctx.state) ctx.state.memo(memoKey, note); };
  let stock = stockBySymbol(note.stock);
  // The notes say what the desk holds and plans; the price now decides which to follow. It paid for all
  // of them, so it tries them best-ranked first and follows the first it can buy at a fair price, or none.
  // Decided once and kept, so a retry acts on the same decision the record shows.
  if (!note.decision) {
    const bought = (ctx.state && ctx.state.memo(boughtKey)) || { [note.stock]: note };
    const tried = [];
    let follow = null;
    for (const b of chooseNotes(bought)) {
      const q = await quoteFor(ctx, stockBySymbol(b.stock));
      const check = buyCheck(q, ctx.rules);
      const t = { stock: b.stock, rank: b.rating ? b.rating.rank : null, buy: check.ok, reason: check.reason, quote: quotePage(q) };
      tried.push(t);
      ctx.log(check.ok ? 'trader.decision' : 'trader.skip', { stock: b.stock, buy: check.ok, reason: check.reason, premiumBps: t.quote.premiumBps });
      if (check.ok) { follow = b; break; }
    }
    const lead = follow ? tried[tried.length - 1] : tried[0];
    save({ ...(follow || note), of: note.of, decision: { buy: Boolean(follow), reason: lead.reason, quote: lead.quote, tried, at: new Date().toISOString() } });
    stock = stockBySymbol(note.stock);
  }
  if (!note.decision.buy) return;
  if (!note.bought) {
    // A buy can land and still fail the job (the network drops before its answer), and the retry must not
    // buy again: the stock held before the first try is kept, and more of it now means that try went through.
    const held = await new ethers.Contract(stock.address, ERC20_ABI, signer.provider).balanceOf(trader.wallet);
    if (note.heldBefore === undefined) {
      save({ ...note, heldBefore: held.toString() });
    }
    if (held.gt(note.heldBefore)) {
      ctx.log('trader.buy', { stock: note.stock, usd: ctx.traderBuyUsd, landedEarlier: true });
      save({ ...note, bought: 'landed earlier' });
    } else {
      // A failed buy fails the job, so it is tried again; the memo above keeps it from paying again.
      const r = await buyUsdWorth(ctx, trader, stock, ctx.traderBuyUsd);
      ctx.log('trader.buy', { stock: note.stock, usd: ctx.traderBuyUsd, ...(r.receipt ? { tx: r.receipt.transactionHash, floor: r.floor } : r) });
      save({ ...note, bought: r.receipt ? r.receipt.transactionHash : 'skipped' });
    }
  }
  // Follow the desk's exit plan: the targets the note carried (the desk's own, on chain), else the defaults.
  if (note.bought !== 'skipped' && !note.targets && !ctx.dry) {
    const fromNote = Boolean(note.plan && (note.plan.takeProfitBps || note.plan.stopLossBps));
    const takeProfitBps = fromNote ? note.plan.takeProfitBps : ctx.rules.takeProfitBps;
    const stopLossBps = fromNote ? note.plan.stopLossBps : ctx.rules.stopLossBps;
    const tx = await setTargets(ctx, trader, stock, takeProfitBps, stopLossBps);
    save({ ...note, targets: { takeProfitBps, stopLossBps, from: fromNote ? 'note' : 'default', tx } });
    ctx.log('trader.targets', { stock: note.stock, ...note.targets });
  }
}

/**
 * Each agent's open positions against their exit targets, sold to USDT through the relayer when one is
 * reached. Reads the chain only; Binance's quote is fetched when a target looks reached, and the rules
 * (a live, sane price) decide. Kept for the day's close record.
 */
async function exitJob(ctx) {
  const provider = ctx.signer.provider;
  const logicC = new ethers.Contract(ctx.logic, LOGIC_ABI, provider);
  for (const agent of [ctx.analyst, ctx.trader].filter(Boolean)) {
    for (const address of await logicC.openPositions(agent.tokenId)) {
      const stock = stockAt(address);
      if (!stock) continue;
      const p = await logicC.positionOf(agent.tokenId, address);
      const takeProfitBps = p.takeProfitBps.toNumber();
      const stopLossBps = p.stopLossBps.toNumber();
      if (p.units.isZero() || (!takeProfitBps && !stopLossBps)) continue;
      // Sell what was bought here and is still in the wallet (the owner may have moved some out).
      const held = await new ethers.Contract(address, ERC20_ABI, provider).balanceOf(agent.wallet);
      const units = held.lt(p.units) ? held : p.units;
      if (units.isZero()) continue;
      const { quoted } = await priceFloor({ provider, logic: ctx.logic, stock: address, side: SIDE.USDT, buying: false, amountIn: units });
      const costUsd = Number(ethers.utils.formatEther(p.costUsd.mul(units).div(p.units)));
      const valueUsd = Number(ethers.utils.formatEther(quoted));
      const changeBps = (valueUsd / costUsd - 1) * 10000;
      if (!(takeProfitBps && changeBps >= takeProfitBps - 1e-6) && !(stopLossBps && changeBps <= -stopLossBps + 1e-6)) continue;
      const q = await quoteFor(ctx, stock);
      const e = exitCheck({ costUsd, valueUsd, takeProfitBps, stopLossBps }, q, ctx.rules);
      const base = { tokenId: String(agent.tokenId), stock: stock.symbol, costUsd: costUsd.toFixed(4), valueUsd: valueUsd.toFixed(4), premiumBps: quotePage(q).premiumBps };
      if (!e.exit) { ctx.log('exit.held', { ...base, reason: e.reason }); continue; }
      if (ctx.dry) { ctx.log('exit.dry', { ...base, exit: e.exit, reason: e.reason }); continue; }
      const r = await trade({ signer: ctx.signer, logic: ctx.logic, tokenId: agent.tokenId, wallet: agent.wallet, stock: address, side: SIDE.USDT, amountIn: units, buying: false });
      if (!r.receipt) { ctx.log('exit.blocked', { ...base, exit: e.exit, reason: r.skipped }); continue; }
      const record = { ...base, exit: e.exit, reason: e.reason, tx: r.receipt.transactionHash, at: new Date().toISOString() };
      ctx.log('exit', record);
      if (ctx.state) {
        const key = `${nyParts().ymd}:exits`;
        ctx.state.memo(key, [...(ctx.state.memo(key) || []), record]);
      }
    }
  }
}

const RUN = { open: openJob, trader: traderJob, close: closeJob, exits: exitJob };
const EXIT_EVERY_MS = 15 * 60 * 1000;

// ── schedule ──

const RETRY_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 3;

/**
 * What the daemon has finished, in <dir>/runner-state.json, so a restart repeats no job, plus the
 * notes a job leaves for its own retry (the Trader's paid note).
 */
function makeState(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'runner-state.json');
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
  const done = new Set(saved.done || []);
  const memo = saved.memo || {};
  const save = () => fs.writeFileSync(file, JSON.stringify({ done: [...done].slice(-100), memo }, null, 2));
  return {
    isDone: (key) => done.has(key),
    markDone: (key) => { done.add(key); save(); },
    memo: (key, value) => { if (value !== undefined) { memo[key] = value; save(); } return memo[key]; },
  };
}

/**
 * Where a failed job's error came from, under ethers v5's wrapping, which reports a node that could not
 * serve a read as "missing revert data": the contract and function (selector) it called, the node, and
 * what the node said. Null when the error carries none of that.
 */
function errorDetail(e) {
  if (!e || typeof e !== 'object') return null;
  const tx = e.transaction || null;
  const src = e.error && typeof e.error === 'object' ? e.error : null;
  const said = src && ((src.error && src.error.message) || src.reason || src.message);
  const out = {
    ...(e.code ? { code: e.code } : {}),
    ...(tx && tx.to ? { to: tx.to, selector: typeof tx.data === 'string' ? tx.data.slice(0, 10) : null } : {}),
    ...(src && src.url ? { node: src.url } : {}),
    ...(src && src.error && src.error.code !== undefined ? { nodeCode: src.error.code } : {}),
    ...(said && said !== e.message ? { said: String(said).slice(0, 300) } : {}),
  };
  return Object.keys(out).length > (e.code ? 1 : 0) ? out : null;
}

/**
 * Runs every job whose time has come today and has not finished. A job that throws is tried again
 * RETRY_MS later, up to MAX_ATTEMPTS, while its window lasts. Returns the ms until the next check.
 * `retries` is the daemon's { key -> { attempts, nextAt } }; `now`, `clock` and `run` are for tests.
 */
async function tick(ctx, retries, now = nyParts(), clock = Date.now(), run = RUN) {
  if (isMarketDay(now)) {
    for (const job of JOBS) {
      const key = `${now.ymd}:${job.name}`;
      if (ctx.state.isDone(key) || now.minutes < job.at || now.minutes > job.lateUntil) continue;
      const r = retries.get(key) || { attempts: 0, nextAt: 0 };
      if (clock < r.nextAt) continue;
      if (r.attempts === 0 && !r.waiting && now.minutes > job.at + 30) ctx.log('job.late', { job: job.name, nyMinutes: now.minutes });
      try {
        await run[job.name](ctx);
        ctx.state.markDone(key);
        retries.delete(key);
      } catch (e) {
        if (e.wait) {
          // Waiting on the owner (e.g. $U to pay with), not failing: check again later, no attempt used.
          if (!r.waiting) ctx.log('job.waiting', { job: job.name, reason: e.message });
          retries.set(key, { ...r, nextAt: clock + RETRY_MS, waiting: true });
          continue;
        }
        r.attempts += 1;
        const giveUp = r.attempts >= (job.attempts || MAX_ATTEMPTS);
        const detail = errorDetail(e);
        ctx.log(giveUp ? 'job.gave-up' : 'job.failed', { job: job.name, attempt: r.attempts, reason: e.reason || e.message, ...(detail ? { detail } : {}) });
        if (giveUp) { ctx.state.markDone(key); retries.delete(key); } else { r.nextAt = clock + RETRY_MS; retries.set(key, r); }
      }
    }
    // Exits are not a once-a-day job: positions are checked every EXIT_EVERY_MS, whatever the hour
    // (the rules only act on a live price), and a failed check just waits for the next one.
    if (run.exits && clock >= (ctx.nextExitAt || 0)) {
      ctx.nextExitAt = clock + (ctx.exitEveryMs || EXIT_EVERY_MS);
      try {
        await run.exits(ctx);
      } catch (e) {
        const detail = errorDetail(e);
        ctx.log('exits.failed', { reason: e.reason || e.message, ...(detail ? { detail } : {}) });
      }
    }
  }
  return 60 * 1000;
}

async function buildContext({ provider, signer, env = process.env }) {
  const logic = env.STOCK_LOGIC;
  if (!logic) throw new Error('STOCK_LOGIC is not set');
  const analystId = env.ANALYST_ID;
  const traderId = env.TRADER_ID;
  if (!analystId) throw new Error('ANALYST_ID is not set');
  const dataDir = env.RUNNER_DATA || path.join('probes', 'data');
  const ctx = {
    provider, signer, logic,
    analyst: { tokenId: analystId, wallet: await walletOf(provider, analystId) },
    trader: traderId ? { tokenId: traderId, wallet: await walletOf(provider, traderId) } : null,
    targets: parseTargets(env.ANALYST_TARGETS),
    traderBuyUsd: Number(env.TRADER_BUY_USD || 5),
    notePrice: ethers.utils.parseEther(String(env.NOTE_PRICE_U || '0.02')).toString(),
    sellerPort: Number(env.SELLER_PORT || 8402),
    ledgerDir: env.LEDGER_DIR || 'ledger',
    siteDir: env.SITE_DIR || 'site',
    dry: ['1', 'true'].includes(String(env.RUNNER_DRY || '').toLowerCase()),
    rules: rulesFromEnv(env),
    rwa: require('./rwa'),
    exitEveryMs: Number(env.EXIT_EVERY_MIN || 15) * 60 * 1000,
    // Pick mode: the Analyst holds the ANALYST_PICK best-ranked stocks, ANALYST_POSITION_USD each;
    // without it, the fixed ANALYST_TARGETS.
    pick: Number(env.ANALYST_PICK || 0),
    keepTop: Number(env.ANALYST_KEEP_TOP || KEEP_TOP),
    positionUsd: Number(env.ANALYST_POSITION_USD || 15),
    dataDir,
    log: makeLog(dataDir),
    state: makeState(dataDir),
    pin: makePin(env),
    names: agentNames(env.SITE_DIR || 'site'),
  };
  ctx.sellerUrl = `http://127.0.0.1:${ctx.sellerPort}`;
  // A wrong SELLER_PUBLIC_URL is logged and left out, never fatal: the desk runs on without it.
  const pub = publicUrlOf(env.SELLER_PUBLIC_URL);
  if (pub.ignored) ctx.log('seller.publicUrl.ignored', { reason: pub.ignored });
  ctx.sellerPublicUrl = pub.url;
  return ctx;
}

/** Pins a JSON document to IPFS and returns its CID; null (nothing pinned) without keys or with RECORD_IPFS=0. */
function makePin(env) {
  const keys = String(env.RECORD_IPFS || '1') === '0' ? null : pinataFromEnv(env);
  return keys ? (content, name) => pinJSON(keys, content, name) : null;
}

/** The agents' names from the ledger page's config (site/config.json), for the record summaries. */
function agentNames(siteDir) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(siteDir, 'config.json'), 'utf8'));
    return Object.fromEntries((cfg.agents || []).map((a) => [String(a.tokenId), a.name]));
  } catch {
    return {};
  }
}

function startSeller(ctx) {
  const server = createSeller({
    ledgerDir: ctx.ledgerDir, tokenId: ctx.analyst.tokenId, wallet: ctx.analyst.wallet, price: ctx.notePrice, facilitator: ctx.signer,
    publicUrl: ctx.sellerPublicUrl || null,
    // The notes sold, so the same paid request sent again (an answer lost on the way) gets its note.
    salesFile: ctx.dataDir ? path.join(ctx.dataDir, `sales-${ctx.analyst.tokenId}.json`) : null,
    log: ctx.log || (() => {}),
  });
  return new Promise((resolve) => server.listen(ctx.sellerPort, '127.0.0.1', () => resolve(server)));
}

async function main() {
  loadEnv();
  const cmd = process.argv[2];
  if (!['daemon', 'open', 'trader', 'close', 'exits'].includes(cmd)) {
    console.error('usage: node src/runner.js daemon|open|trader|close|exits   (RUNNER_DRY=1 to send nothing)');
    process.exit(2);
  }
  const provider = new SturdyProvider();
  if (!relayerKey()) throw new Error('no relayer key: RELAYER_KEY, or RUNTIME_PRIVATE_KEY through ENV_FILE');
  const signer = new ethers.Wallet(relayerKey(), provider);
  const ctx = await buildContext({ provider, signer });
  ctx.log('runner.start', {
    cmd, relayer: signer.address, logic: ctx.logic, analyst: ctx.analyst, trader: ctx.trader, dry: ctx.dry,
    pick: ctx.pick || null, rules: ctx.rules, ipfs: Boolean(ctx.pin), seller: { port: ctx.sellerPort, public: ctx.sellerPublicUrl },
  });
  const server = await startSeller(ctx);
  if (cmd !== 'daemon') {
    if (cmd === 'trader' && !ctx.trader) throw new Error('TRADER_ID is not set');
    await RUN[cmd](ctx);
    server.close();
    return;
  }
  fs.writeFileSync(path.join(process.env.RUNNER_DATA || path.join('probes', 'data'), 'runner.pid'), String(process.pid));
  const retries = new Map();
  for (;;) {
    const wait = await tick(ctx, retries);
    await new Promise((r) => setTimeout(r, wait));
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e.message || e); process.exit(1); });
}

module.exports = {
  buildContext, startSeller, openJob, traderJob, closeJob, exitJob, anchorLedger, traderLedger, pinSummary, makePin, ensureTargets, setTargets, dayAnalysis, chooseNotes,
  buyUsdWorth, nyParts, isMarketDay, JOBS, tick, makeState, errorDetail, RETRY_MS, MAX_ATTEMPTS, EXIT_EVERY_MS,
};
