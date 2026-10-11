#!/usr/bin/env node
// verify-note.js: check one saved Desk Note against BNB Smart Chain.
//
//   node verify-note.js <note.json> [--logic 0x...] [--rpc https://...] [--json]
//
// <note.json> is the body the seller returns once a note is paid for:
//   { note, proof, root, tokenId, epochDay, phase, logic }
//
// It does four things, in order:
//   1. hashes the note: keccak-256 of its canonical JSON (keys sorted at every level, no whitespace; a
//      number with a fraction is stored as a decimal string), the rule the desk uses when it builds the tree;
//   2. checks that hash against the `root` in the file with the Merkle proof (no network);
//   3. asks the chain, with read-only queries (no transaction), whether the desk contract anchored a root under
//      (tokenId, epochDay, phase) that contains this page: verifyAnchored(...) returns (ok, anchoredAt);
//   4. says where that anchor time falls against the US session of its own New York day. The contract keeps
//      no clock on a phase, so "before the open" is read from the time on chain, never from the phase number.
//
// It sends no transaction, needs no key and reads no .env file. The contract address is pinned below:
// a note that names another contract is still checked against this one, and the mismatch is reported.
//
// Needs Node 18+ and ethers v5 (npm install ethers@5.7.2).
// Exit code: 0 verified, 1 not verified, 2 bad input, 3 the chain could not be read.
'use strict';

const fs = require('fs');

let ethers;
try {
  ({ ethers } = require('ethers'));
} catch (e) {
  console.error('This script needs ethers v5: npm install ethers@5.7.2');
  process.exit(2);
}
if (!ethers.utils || !ethers.providers) {
  console.error('This script needs ethers v5 (found a different major version): npm install ethers@5.7.2');
  process.exit(2);
}

// StockAgentLogicV1 on BNB Smart Chain: the desk contract that anchors the notes' Merkle roots.
const LOGIC_ADDRESS = '0x4245dd4DC9e9bC1035514C6de13C88ab91b61946';
const CHAIN_ID = 56;
// Public endpoints, all tested with the exact read methods this script uses (chain id, contract code, contract reads).
const DEFAULT_RPCS = [
  'https://bsc-dataseed.bnbchain.org',
  'https://bsc-dataseed1.defibit.io',
  'https://bsc-dataseed1.ninicoin.io',
  'https://bsc-rpc.publicnode.com',
  'https://1rpc.io/bnb',
];
const RPC_TIMEOUT_MS = 12000;

const LOGIC_ABI = [
  'function verifyAnchored(uint256 tokenId, uint32 day, uint8 phase, bytes32 pageHash, bytes32[] proof) view returns (bool ok, uint64 anchoredAt)',
  'function anchors(uint256 tokenId, uint32 day, uint8 phase) view returns (bytes32 root, uint64 anchoredAt)',
];
const PHASES = { 1: 'the opening root', 2: 'the closing root' };

// Where an anchor time falls against the US cash session of its own New York day (09:30 to 16:00). Phase 1 is
// only the slot the desk writes its morning root under: nothing on chain ties it to the open.
function sessionOf(anchoredAt, phase) {
  const ph = Number(phase);
  if (!(anchoredAt > 0) || !PHASES[ph]) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(anchoredAt * 1000));
  const part = (type) => Number(parts.find((p) => p.type === type).value);
  const at = part('hour') * 3600 + part('minute') * 60 + part('second');
  const OPEN = 9 * 3600 + 30 * 60;
  const CLOSE = 16 * 3600;
  const span = (seconds) => { const m = Math.floor(seconds / 60); return `${m >= 60 ? `${Math.floor(m / 60)} h ` : ''}${m % 60} min`; };
  if (ph === 1) {
    return at < OPEN
      ? { asExpected: true, text: `${span(OPEN - at)} before the 09:30 New York open` }
      : { asExpected: false, text: `${span(at - OPEN)} AFTER the 09:30 New York open` };
  }
  return at >= CLOSE
    ? { asExpected: true, text: `${span(at - CLOSE)} after the 16:00 New York close` }
    : { asExpected: false, text: `${span(CLOSE - at)} BEFORE the 16:00 New York close` };
}

const { keccak256, toUtf8Bytes, defaultAbiCoder, hexConcat, isHexString } = ethers.utils;

function withExit(message, exitCode) {
  const e = new Error(message);
  e.exitCode = exitCode;
  return e;
}
const badInput = (message) => withExit(message, 2);
const short = (e) => String((e && (e.reason || e.message)) || e).split('\n')[0].slice(0, 160);

// ── The desk's page hashing, as written in its ledger code ──

/** JSON with object keys sorted at every level and no whitespace, so equal pages hash equally. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  if (typeof value === 'number' && !Number.isInteger(value)) {
    throw badInput(`the note holds a fractional number (${value}); the desk stores those as decimal strings`);
  }
  return JSON.stringify(value);
}

const pageHash = (page) => keccak256(toUtf8Bytes(canonical(page)));

/** The leaf OpenZeppelin's StandardMerkleTree builds for a page hash (the contract derives the same). */
const leafOf = (hash) => keccak256(keccak256(defaultAbiCoder.encode(['bytes32'], [hash])));

/** Walks a StandardMerkleTree proof: each step hashes the pair in sorted order. */
function rootFromProof(hash, proof) {
  let node = leafOf(hash);
  for (const sibling of proof) {
    const [a, b] = node.toLowerCase() < sibling.toLowerCase() ? [node, sibling] : [sibling, node];
    node = keccak256(hexConcat([a, b]));
  }
  return node;
}

// ── Input ──

/** Checks the shape of a saved note and returns it with typed fields. */
function readNote(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw badInput('the file must hold one JSON object');
  if (Array.isArray(data.pages)) {
    throw badInput('this is a whole-day ledger file; pass one note as { note, proof, root, tokenId, epochDay, phase }, the body the seller returns');
  }
  const { note, proof } = data;
  if (!note || typeof note !== 'object' || Array.isArray(note)) throw badInput('"note" must be a JSON object');
  if (!Array.isArray(proof) || !proof.every((p) => isHexString(p, 32))) throw badInput('"proof" must be an array of 32-byte hex strings');
  if (!/^\d+$/.test(String(data.tokenId))) throw badInput('"tokenId" must be a whole number');
  const epochDay = Number(data.epochDay);
  if (!Number.isInteger(epochDay) || epochDay < 0 || epochDay > 0xffffffff) throw badInput('"epochDay" must be a whole number of days since 1970-01-01 (UTC)');
  const phase = Number(data.phase);
  if (!Number.isInteger(phase) || phase < 0 || phase > 255) throw badInput('"phase" must be a whole number (1 = the opening root, 2 = the closing root)');
  let root = null;
  if (data.root !== undefined && data.root !== null) {
    if (!isHexString(data.root, 32)) throw badInput('"root" must be a 32-byte hex string');
    root = data.root.toLowerCase();
  }
  let claimedLogic = null;
  if (typeof data.logic === 'string') {
    try {
      claimedLogic = ethers.utils.getAddress(data.logic);
    } catch (e) {
      claimedLogic = data.logic;
    }
  }
  return { note, proof, root, tokenId: String(data.tokenId), epochDay, phase, claimedLogic };
}

// ── Chain access ──

/** The first public BSC endpoint that answers, confirmed to be chain 56. */
async function getProvider(rpc) {
  const urls = rpc ? [rpc] : [process.env.BSC_RPC, ...DEFAULT_RPCS].filter(Boolean);
  const tried = [];
  for (const url of urls) {
    try {
      const provider = new ethers.providers.StaticJsonRpcProvider({ url, timeout: RPC_TIMEOUT_MS }, { chainId: CHAIN_ID, name: 'bsc' });
      const id = Number(await provider.send('eth_chainId', []));
      if (id !== CHAIN_ID) {
        tried.push(`${url} is chain ${id}, not ${CHAIN_ID}`);
        continue;
      }
      return { provider, url };
    } catch (e) {
      tried.push(`${url}: ${short(e)}`);
    }
  }
  throw withExit(`no BSC endpoint answered (${tried.join('; ')})`, 3);
}

// ── The check ──

/**
 * Verifies one parsed note.
 * @param {object} data   { note, proof, root, tokenId, epochDay, phase, logic }
 * @param {object} [o]    { rpc, logic }: an endpoint to use, and a desk contract to use instead of the pinned one
 * @returns the result object printResult() prints.
 */
async function verifyNote(data, { rpc, logic } = {}) {
  const n = readNote(data);
  const hash = pageHash(n.note);
  const warnings = [];

  const offChainProofOk = n.root === null ? null : rootFromProof(hash, n.proof).toLowerCase() === n.root;
  if (offChainProofOk === false) warnings.push('the proof does not lead from this note to the root written in the file');

  let logicAddress;
  try {
    logicAddress = ethers.utils.getAddress(logic || LOGIC_ADDRESS);
  } catch (e) {
    throw badInput(`--logic is not a valid address: ${logic}`);
  }
  if (n.claimedLogic && n.claimedLogic.toLowerCase() !== logicAddress.toLowerCase()) {
    warnings.push(`the file names a different contract (${n.claimedLogic}); this check uses ${logicAddress}`);
  }

  const dayText = new Date(n.epochDay * 86400000).toISOString().slice(0, 10);
  if (typeof n.note.day === 'number' && String(n.note.day) !== dayText.replace(/-/g, '')) {
    warnings.push(`the note says day ${n.note.day} but epochDay ${n.epochDay} is ${dayText}`);
  }
  if (n.note.kind !== undefined && n.note.kind !== 'note') warnings.push(`this page is of kind "${n.note.kind}", not "note"`);
  if (!PHASES[n.phase]) warnings.push(`phase ${n.phase} is not one the desk uses (1 or 2)`);

  const { provider, url } = await getProvider(rpc);
  let onChain;
  let anchored;
  try {
    if ((await provider.getCode(logicAddress)) === '0x') {
      throw withExit(`no contract at ${logicAddress} on BSC (chain ${CHAIN_ID}) through ${url}`, 3);
    }
    const c = new ethers.Contract(logicAddress, LOGIC_ABI, provider);
    [onChain, anchored] = await Promise.all([
      c.verifyAnchored(n.tokenId, n.epochDay, n.phase, hash, n.proof),
      c.anchors(n.tokenId, n.epochDay, n.phase),
    ]);
  } catch (e) {
    if (e.exitCode) throw e;
    throw withExit(`the chain could not be read through ${url}: ${e.code ? `${e.code}: ` : ''}${short(e)}`, 3);
  }

  const anchoredAt = onChain.anchoredAt.toNumber();
  const ok = onChain.ok === true && anchoredAt > 0;
  const chainRoot = anchored.root.toLowerCase();
  const rootMatchesChain = n.root === null || anchoredAt === 0 ? null : chainRoot === n.root;
  if (rootMatchesChain === false) warnings.push('the root written in the file is not the root anchored on chain (the on-chain answer above is what counts)');

  return {
    verified: ok,
    onChain: onChain.ok === true,
    anchoredAt,
    anchoredAtIso: anchoredAt > 0 ? new Date(anchoredAt * 1000).toISOString() : null,
    offChainProofOk,
    rootMatchesChain,
    pageHash: hash,
    tokenId: n.tokenId,
    stock: n.note.stock || null,
    kind: n.note.kind || null,
    epochDay: n.epochDay,
    epochDayDate: dayText,
    phase: n.phase,
    phaseLabel: PHASES[n.phase] || 'unknown phase',
    session: sessionOf(anchoredAt, n.phase),
    logic: logicAddress,
    rpc: url,
    warnings,
  };
}

function printResult(r) {
  const yn = (v) => (v === null ? 'not checked' : String(v));
  console.log('Desk Note check');
  console.log(`  agent       #${r.tokenId}   page kind ${r.kind || '?'}${r.stock ? `   stock ${r.stock}` : ''}`);
  console.log(`  anchored    day ${r.epochDayDate} (epoch day ${r.epochDay}), phase ${r.phase} (${r.phaseLabel})`);
  console.log(`  page hash   ${r.pageHash}`);
  console.log(`  off chain   proof leads to the root in the file: ${yn(r.offChainProofOk)}`);
  console.log(`  on chain    verifyAnchored on ${r.logic} (BSC, chain ${CHAIN_ID}): ${r.onChain}`);
  console.log(`  anchor time ${r.anchoredAtIso ? `${r.anchoredAtIso} (unix ${r.anchoredAt})` : 'none: nothing is anchored under this agent, day and phase'}`);
  if (r.session) console.log(`  session     ${r.session.text}${r.session.asExpected ? '' : ' (not when this phase is meant to be written)'}`);
  console.log(`  root        the anchored root equals the root in the file: ${yn(r.rootMatchesChain)}`);
  for (const w of r.warnings) console.log(`  warning     ${w}`);
  if (r.verified) {
    console.log('VERIFIED: this exact page was fixed on chain at the anchor time above.');
    console.log('That shows when it was written, not that what it says is right. It is a record of what the agent holds, not investment advice.');
  } else if (r.anchoredAt > 0) {
    console.log('NOT VERIFIED: a root was anchored under this agent, day and phase, but this page is not in it.');
  } else {
    console.log('NOT VERIFIED: nothing is anchored under this agent, day and phase.');
  }
}

// ── Command line ──

function parseArgs(argv) {
  const a = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--json') a.json = true;
    else if (t === '--help' || t === '-h') a.help = true;
    else if (t === '--logic' || t === '--rpc') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw badInput(`${t} needs a value`);
      a[t.slice(2)] = v;
    } else if (t.startsWith('-')) throw badInput(`unknown option ${t}`);
    else if (!a.file) a.file = t;
    else throw badInput(`unexpected argument ${t}`);
  }
  return a;
}

const USAGE = 'usage: node verify-note.js <note.json> [--logic 0x...] [--rpc https://...] [--json]';

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help || !args.file) {
    console.log(`${USAGE}\n<note.json> is the body the seller returns after payment: { note, proof, root, tokenId, epochDay, phase, logic }.`);
    return args.help ? 0 : 2;
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(args.file, 'utf8'));
  } catch (e) {
    throw badInput(`cannot read ${args.file} as JSON: ${short(e)}`);
  }
  const result = await verifyNote(data, { rpc: args.rpc, logic: args.logic });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else printResult(result);
  return result.verified ? 0 : 1;
}

function finish(code) {
  process.exitCode = code;
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
}

if (require.main === module) {
  main(process.argv.slice(2)).then(finish, (e) => {
    console.error(e.message || String(e));
    finish(e.exitCode || 1);
  });
}

module.exports = { verifyNote, printResult, getProvider, canonical, pageHash, rootFromProof, LOGIC_ADDRESS, CHAIN_ID };
