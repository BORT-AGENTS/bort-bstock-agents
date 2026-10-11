#!/usr/bin/env node
// buy-note.js: a plain-wallet (EOA) buyer for one Desk Note, for agents that have no Binance Agentic Wallet.
//
//   node buy-note.js <SELLER_URL>/notes/<tokenId>/<STOCK>                 DRY RUN (the default)
//   node buy-note.js <SELLER_URL>/notes/<tokenId>/<STOCK> --pay           sign and buy
//
// DRY RUN: fetches the 402 answer (a GET that costs nothing), prints the terms, checks them, and prints what
// --pay WOULD sign. It signs nothing, sends nothing else and never touches a key.
//
// --pay: needs a private key in an environment variable (default DESK_NOTES_BUYER_KEY, or the name given with
// --key-env). The key is never taken from the command line and no .env file is ever read. It signs one EIP-3009
// TransferWithAuthorization for $U, sends it in the PAYMENT-SIGNATURE header, saves the note and checks it on
// chain with verify-note.js. If the answer is lost or the payment is still settling, it sends the same header
// again (the seller answers it with the same note and no second charge); it never signs a second payment.
// The payer needs $U only: EIP-3009 is gasless for the payer (the seller submits the
// transfer and pays the gas). This script never sends a transaction: its wallet has no provider, so it cannot.
// (If a transaction is ever added, give it a legacy gasPrice: ethers v5 tips 1.5 gwei on BSC by default.)
//
// Before signing it refuses unless, all read from the chain:
//   - the terms are x402 v2, scheme exact, eip3009, on eip155:56, in $U;
//   - the price is not above --max-price (default 0.02);
//   - the pay-to address is the ERC-6551 wallet of the agent in the URL (ERC-6551 registry, read-only);
//   - the EIP-712 domain in the terms hashes to $U's own DOMAIN_SEPARATOR();
//   - the payer holds enough $U.
//
// Needs Node 18+ and ethers v5 (npm install ethers@5.7.2).
// Exit code: 0 done, 1 error, 2 usage, 3 nothing to buy (404 or no 402), 4 terms refused, 5 seller refused the
// payment, 6 paid but the answer is not a note that verifies.
'use strict';

const fs = require('fs');
const path = require('path');

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
const { verifyNote, printResult, getProvider } = require('./verify-note');

// ── Pinned facts: BNB Smart Chain, chain 56 ──
const CHAIN_ID = 56;
const NETWORK = 'eip155:56';
const U_ADDRESS = '0xcE24439F2D9C6a2289F741120FE202248B666666'; // $U (United Stables), EIP-3009, 18 decimals
const U_DECIMALS = 18;
// An agent's wallet is its ERC-6551 account: registry.account(ACCOUNT_PROXY, salt 0, 56, BAP578, tokenId).
const ERC6551_REGISTRY = '0x000000006551c19487814612e58FE06813775758';
const ACCOUNT_PROXY = '0x55266d75D1a14E4572138116aF39863Ed6596E7F';
const BAP578 = '0x15b15df2ffff6653c21c11b93fb8a7718ce854ce';

const DEFAULT_MAX_PRICE = '0.02'; // $U, the price the desk lists
const DEFAULT_KEY_ENV = 'DESK_NOTES_BUYER_KEY';
const SIGN_WINDOW_SECONDS = 120; // how long a signed authorization stays valid
const HTTP_TIMEOUT_MS = 45000;
const PAID_ATTEMPTS = 4; // the paid request, sent again with the same header after a lost answer or a 503

const U_ABI = [
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function balanceOf(address) view returns (uint256)',
];
const REGISTRY_ABI = [
  'function account(address implementation, bytes32 salt, uint256 chainId, address tokenContract, uint256 tokenId) view returns (address)',
];
const TRANSFER_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

const USAGE = `usage: node buy-note.js <note-url> [options]

  <note-url>         <SELLER_URL>/notes/<tokenId>/<STOCK>
  (no option)        DRY RUN: show and check the terms, sign nothing
  --pay              sign and buy (needs the key in an environment variable)
  --key-env NAME     name of the variable that holds the payer's private key (default ${DEFAULT_KEY_ENV})
  --from 0x...       the payer's address: a dry run shows its $U balance; with --pay it must match the key
  --max-price 0.02   the most you accept to pay, in $U (default ${DEFAULT_MAX_PRICE})
  --out FILE         where to save the note (default ./note-<tokenId>-<STOCK>.json; never overwritten)
  --rpc URL          a BSC JSON-RPC endpoint (default: BSC_RPC, then public endpoints)
  --no-verify        with --pay, skip the on-chain check after saving
  --json             print one JSON report instead of text`;

// ── Small helpers ──

function withExit(message, exitCode) {
  const e = new Error(message);
  e.exitCode = exitCode;
  return e;
}
const short = (e) => String((e && (e.reason || e.message)) || e).split('\n')[0].slice(0, 160);
const b64 = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');

function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** One GET. Redirects are never followed: a payment must go only to the address the user chose. */
async function httpGet(url, headers = {}) {
  const res = await withTimeout(
    fetch(url, { method: 'GET', redirect: 'manual', headers: { accept: 'application/json', 'user-agent': 'desk-notes-skill/0.1', ...headers } }),
    HTTP_TIMEOUT_MS,
    `GET ${url}`,
  );
  const body = await withTimeout(res.text(), HTTP_TIMEOUT_MS, 'reading the answer');
  return { status: res.status, headers: res.headers, body };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

// ── Command line ──

function parseArgs(argv) {
  const a = { pay: false, json: false, verify: true, keyEnv: DEFAULT_KEY_ENV, maxPrice: DEFAULT_MAX_PRICE };
  const valueFlags = { '--key-env': 'keyEnv', '--from': 'from', '--max-price': 'maxPrice', '--out': 'out', '--rpc': 'rpc' };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--pay') a.pay = true;
    else if (t === '--json') a.json = true;
    else if (t === '--no-verify') a.verify = false;
    else if (t === '--help' || t === '-h') a.help = true;
    else if (t === '--key' || t === '--private-key') {
      throw withExit('never put a key on the command line (it shows in process lists and shell history): export it and pass the variable NAME with --key-env', 2);
    } else if (valueFlags[t]) {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw withExit(`${t} needs a value`, 2);
      a[valueFlags[t]] = v;
    } else if (t.startsWith('-')) throw withExit(`unknown option ${t}`, 2);
    else if (!a.url) a.url = t;
    else throw withExit(`unexpected argument ${t}`, 2);
  }
  return a;
}

/** The note URL: http(s), ending in /notes/<tokenId>/<STOCK>. */
function parseNoteUrl(text) {
  let u;
  try {
    u = new URL(text);
  } catch (e) {
    throw withExit(`not a URL: ${text}`, 2);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw withExit('the note URL must start with https:// (or http:// for localhost)', 2);
  const m = u.pathname.match(/\/notes\/(\d+)\/([A-Za-z]+)\/?$/);
  if (!m) throw withExit('the note URL must end in /notes/<tokenId>/<STOCK>', 2);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  return { href: u.href, tokenId: m[1], stock: m[2].toUpperCase(), plainRemote: u.protocol === 'http:' && !local };
}

// ── Reading and checking the terms ──

/** The 402 terms: the PAYMENT-REQUIRED header (base64 JSON) first, then a JSON body. */
function readTerms(res) {
  const header = res.headers.get('payment-required');
  if (header) {
    const terms = parseJson(Buffer.from(header, 'base64').toString('utf8'));
    if (terms) return { terms, header };
  }
  const terms = parseJson(res.body);
  return terms ? { terms, header: b64(terms) } : null;
}

/** The first option that is $U, exact, EIP-3009, on BSC. */
function pickOption(terms) {
  const accepts = Array.isArray(terms.accepts) ? terms.accepts : [];
  return accepts.find((a) => a && a.scheme === 'exact' && a.network === NETWORK
    && typeof a.asset === 'string' && a.asset.toLowerCase() === U_ADDRESS.toLowerCase()
    && (!a.extra || !a.extra.assetTransferMethod || a.extra.assetTransferMethod === 'eip3009')) || null;
}

/** The EIP-712 domain the terms name for $U. */
function domainOf(accept) {
  return { name: accept.extra.name, version: accept.extra.version, chainId: CHAIN_ID, verifyingContract: ethers.utils.getAddress(accept.asset) };
}

// ── Building and signing the payment ──

function makeAuthorization({ from, to, value, now, nonce }) {
  return { from, to, value: value.toString(), validAfter: '0', validBefore: String(now + SIGN_WINDOW_SECONDS), nonce };
}

function signAuthorization(wallet, domain, authorization) {
  return wallet._signTypedData(domain, TRANSFER_TYPES, authorization);
}

/** The x402 v2 payment header value: base64 of the payload the seller reads. */
function buildPaymentHeader({ terms, accept, authorization, signature }) {
  return b64({ x402Version: 2, resource: terms.resource, accepted: accept, payload: { signature, authorization } });
}

// ── The run ──

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (!args.url) {
    console.error(USAGE);
    return 2;
  }
  const say = (s = '') => {
    if (!args.json) console.log(s);
  };

  // Arguments that do not need the network, checked first so a mistake costs nothing.
  const noteRef = parseNoteUrl(args.url);
  if (!/^\d+(\.\d{1,18})?$/.test(args.maxPrice)) throw withExit('--max-price must be a decimal number of $U, such as 0.02', 2);
  const maxPrice = ethers.utils.parseUnits(args.maxPrice, U_DECIMALS);
  let fromAddress = null;
  if (args.from) {
    try {
      fromAddress = ethers.utils.getAddress(args.from);
    } catch (e) {
      throw withExit('--from is not a valid address', 2);
    }
  }
  const out = path.resolve(args.out || `note-${noteRef.tokenId}-${noteRef.stock}.json`);
  let wallet = null;
  if (args.pay) {
    if (noteRef.plainRemote) throw withExit('refusing to pay over plain http to a remote host: use an https:// seller URL', 4);
    if (fs.existsSync(out)) throw withExit(`${out} already exists; choose another --out (a note is never overwritten)`, 4);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(args.keyEnv)) throw withExit('--key-env must be the NAME of an environment variable (letters, digits, underscore), never the key itself', 2);
    const key = (process.env[args.keyEnv] || '').trim();
    if (!key) throw withExit(`--pay needs the payer's private key in the environment variable ${args.keyEnv} (export it in this shell; no .env file is read)`, 4);
    try {
      wallet = new ethers.Wallet(key.startsWith('0x') ? key : `0x${key}`);
    } catch (e) {
      throw withExit(`${args.keyEnv} does not hold a valid private key`, 4);
    }
    if (fromAddress && fromAddress !== wallet.address) throw withExit(`the key in ${args.keyEnv} belongs to ${wallet.address}, not ${fromAddress}`, 4);
  }
  const payer = wallet ? wallet.address : fromAddress;

  const report = {
    mode: args.pay ? 'pay' : 'dry-run',
    url: noteRef.href,
    tokenId: noteRef.tokenId,
    stock: noteRef.stock,
    status: null,
    terms: null,
    paymentRequired: null,
    checks: [],
    allRequiredOk: null,
    wouldSign: null,
    paid: null,
    note: null,
    verification: null,
  };
  const emitJson = () => {
    if (args.json) console.log(JSON.stringify(report, null, 2));
  };

  // 1. Ask for the note. A 402 costs nothing.
  say(`${args.pay ? 'BUY' : 'DRY RUN'}: GET ${noteRef.href}`);
  let first;
  try {
    first = await httpGet(noteRef.href);
  } catch (e) {
    throw withExit(`could not reach the seller: ${short(e)}`, 1);
  }
  report.status = first.status;
  if (first.status >= 300 && first.status < 400) throw withExit(`the seller answered ${first.status}, a redirect; a payment flow does not follow redirects`, 1);
  if (first.status !== 402) {
    const parsed = parseJson(first.body);
    const why = parsed && typeof parsed.error === 'string' ? `: "${parsed.error}"` : '';
    say(`The seller answered ${first.status}${why}`);
    say(first.status === 404 ? 'Nothing was charged and there is nothing to buy (that note is not on sale now).' : 'This is not a payment request, so there is nothing to sign.');
    emitJson();
    return 3;
  }
  const read = readTerms(first);
  if (!read) throw withExit('the 402 answer carries no readable terms', 1);
  const { terms, header } = read;
  report.paymentRequired = header;
  if (Number(terms.x402Version) !== 2) throw withExit(`the terms are x402 version ${terms.x402Version}; only version 2 is handled`, 4);
  const accept = pickOption(terms);
  if (!accept) {
    const offered = (Array.isArray(terms.accepts) ? terms.accepts : []).map((a) => `${a && a.scheme} ${a && a.network} ${a && a.asset}`).join('; ') || 'nothing';
    throw withExit(`the terms offer no $U / exact / EIP-3009 / ${NETWORK} option (offered: ${offered})`, 4);
  }
  const rawPrice = accept.amount !== undefined ? accept.amount : accept.maxAmountRequired;
  if (!/^\d+$/.test(String(rawPrice))) throw withExit('the terms carry no whole-number price', 4);
  const price = ethers.BigNumber.from(String(rawPrice));
  let payTo;
  try {
    payTo = ethers.utils.getAddress(accept.payTo);
  } catch (e) {
    throw withExit('the terms carry no valid pay-to address', 4);
  }
  if (!accept.extra || typeof accept.extra.name !== 'string' || typeof accept.extra.version !== 'string') {
    throw withExit('the terms do not name $U\'s EIP-712 domain (extra.name and extra.version)', 4);
  }
  const domain = domainOf(accept);
  const priceText = ethers.utils.formatUnits(price, U_DECIMALS);
  const resourceUrl = terms.resource && typeof terms.resource === 'object' ? terms.resource.url : terms.resource;
  report.terms = {
    resource: resourceUrl || null,
    scheme: accept.scheme,
    network: accept.network,
    asset: accept.asset,
    amount: String(rawPrice),
    priceU: priceText,
    payTo,
    maxTimeoutSeconds: accept.maxTimeoutSeconds || null,
  };

  say(`402 Payment Required (x402 v2)`);
  say(`  resource   ${resourceUrl || '(none named)'}`);
  say(`  scheme     exact, EIP-3009, ${NETWORK} (BSC)`);
  say(`  asset      $U ${ethers.utils.getAddress(accept.asset)} (${accept.extra.name}, ${U_DECIMALS} decimals)`);
  say(`  price      ${priceText} $U (${rawPrice} base units)`);
  say(`  pay to     ${payTo}`);
  say(`  valid for  ${accept.maxTimeoutSeconds || '?'} s (the seller's maxTimeoutSeconds)`);
  say();

  // 2. Check the terms against the chain (read-only).
  const checks = report.checks;
  const add = (id, ok, text, level = 'required') => {
    checks.push({ id, ok, level, text });
  };
  add('offer', true, `the seller offers $U by EIP-3009 (exact) on ${NETWORK}`);
  const priceOk = price.gt(0) && price.lte(maxPrice);
  add('price', priceOk, priceOk
    ? `price ${priceText} $U is within your maximum of ${args.maxPrice} $U`
    : price.isZero() ? 'the price is zero, which is not a payment request this script understands'
      : `price ${priceText} $U is ABOVE your maximum of ${args.maxPrice} $U (--max-price)`);
  const names = typeof resourceUrl === 'string' && resourceUrl.toLowerCase().includes(`${noteRef.tokenId}/${noteRef.stock}`.toLowerCase());
  add('resource', names, names ? `the resource names agent #${noteRef.tokenId} and ${noteRef.stock}` : `the resource "${resourceUrl}" does not name agent #${noteRef.tokenId} and ${noteRef.stock}`, 'advisory');

  let provider = null;
  let chainNow = null;
  try {
    ({ provider } = await getProvider(args.rpc));
    chainNow = (await provider.getBlock('latest')).timestamp;
  } catch (e) {
    provider = null;
  }
  if (!provider) {
    const why = 'no BSC endpoint answered';
    add('payee', null, `pay-to not checked: ${why}`);
    add('domain', null, `EIP-712 domain not checked: ${why}`);
    add('balance', null, `payer balance not checked: ${why}`, payer ? 'required' : 'advisory');
  } else {
    try {
      const wantPayee = await new ethers.Contract(ERC6551_REGISTRY, REGISTRY_ABI, provider)
        .account(ACCOUNT_PROXY, ethers.constants.HashZero, CHAIN_ID, BAP578, noteRef.tokenId);
      const same = wantPayee.toLowerCase() === payTo.toLowerCase();
      add('payee', same, same
        ? `pay-to is the ERC-6551 wallet of agent #${noteRef.tokenId} (derived from the registry)`
        : `pay-to ${payTo} is NOT the ERC-6551 wallet of agent #${noteRef.tokenId} (the registry derives ${wantPayee})`);
    } catch (e) {
      add('payee', null, `pay-to not checked: ${short(e)}`);
    }
    const u = new ethers.Contract(U_ADDRESS, U_ABI, provider);
    try {
      const chainSeparator = await u.DOMAIN_SEPARATOR();
      const localSeparator = ethers.utils._TypedDataEncoder.hashDomain(domain);
      add('domain', chainSeparator === localSeparator,
        chainSeparator === localSeparator ? 'the EIP-712 domain in the terms hashes to $U\'s own DOMAIN_SEPARATOR()' : 'the EIP-712 domain in the terms does NOT match $U\'s DOMAIN_SEPARATOR()');
    } catch (e) {
      add('domain', null, `EIP-712 domain not checked: ${short(e)}`);
    }
    if (payer) {
      try {
        const held = await u.balanceOf(payer);
        const enough = held.gte(price);
        add('balance', enough, enough
          ? `payer ${payer} holds ${ethers.utils.formatUnits(held, U_DECIMALS)} $U`
          : `payer ${payer} holds ${ethers.utils.formatUnits(held, U_DECIMALS)} $U, the note costs ${priceText}`);
      } catch (e) {
        add('balance', null, `payer balance not checked: ${short(e)}`);
      }
    } else {
      add('balance', null, 'payer balance not checked (pass --from <address> to see it)', 'advisory');
    }
  }
  say('Checks');
  for (const c of checks) say(`  ${c.ok === true ? 'ok  ' : c.ok === false ? (c.level === 'required' ? 'FAIL' : 'warn') : '--  '} ${c.text}`);
  say();
  const failed = checks.some((c) => c.level === 'required' && c.ok === false);
  const unchecked = checks.some((c) => c.level === 'required' && c.ok === null);
  report.allRequiredOk = !failed && !unchecked;

  // 3. Dry run: show what would be signed, then stop.
  const nowForExample = chainNow || Math.floor(Date.now() / 1000);
  if (!args.pay) {
    const example = makeAuthorization({ from: payer || '<payer address>', to: payTo, value: price, now: nowForExample, nonce: '<32 random bytes, chosen at signing>' });
    report.wouldSign = { primaryType: 'TransferWithAuthorization', domain, types: TRANSFER_TYPES, message: example };
    say(`What --pay WOULD sign (EIP-712 TransferWithAuthorization on $U, valid ${SIGN_WINDOW_SECONDS} s from signing):`);
    say(JSON.stringify({ domain, message: example }, null, 2));
    say(`It would then send the same GET with the header PAYMENT-SIGNATURE: base64({ x402Version: 2, resource, accepted, payload: { signature, authorization } }).`);
    say();
    say('With Binance\'s Agentic Wallet instead, the same terms go through:');
    say('  baw x402-payment preview --paymentRequirements "<the PAYMENT-REQUIRED header value>" --json');
    say();
    say(failed ? 'DRY RUN: a required check FAILED. Do not pay. Nothing was signed or sent.'
      : unchecked ? 'DRY RUN: some required checks could not run (see "--" above), so --pay would refuse. Nothing was signed or sent.'
        : 'DRY RUN: the terms pass every required check. Nothing was signed or sent. Add --pay to buy.');
    emitJson();
    return report.allRequiredOk ? 0 : 4;
  }

  // 4. Pay: only when every required check passed, including the ones that need the chain.
  if (failed || unchecked) throw withExit(failed ? 'a required check failed: refusing to sign' : 'a required check could not run: refusing to sign', 4);
  const authorization = makeAuthorization({
    from: wallet.address,
    to: payTo,
    value: price,
    now: chainNow,
    nonce: ethers.utils.hexlify(ethers.utils.randomBytes(32)),
  });
  say(`Signing: ${priceText} $U from ${wallet.address} to ${payTo}, valid until unix ${authorization.validBefore}.`);
  const signature = await signAuthorization(wallet, domain, authorization);
  const paymentHeader = buildPaymentHeader({ terms, accept, authorization, signature });

  // The desk's seller answers the same paid request again with the same note and no second charge, so
  // a lost answer, or a 503 while the payment settles, is met by sending the same header again. A
  // second payment is never signed here.
  let second;
  for (let attempt = 1; ; attempt += 1) {
    try {
      second = await httpGet(noteRef.href, { 'payment-signature': paymentHeader });
    } catch (e) {
      second = { error: e };
    }
    const again = second.error || second.status === 429 || second.status >= 500;
    if (!again || attempt >= PAID_ATTEMPTS) break;
    const asked = second.headers ? Number(second.headers.get('retry-after')) : NaN;
    const wait = Math.min(Number.isFinite(asked) && asked > 0 ? asked : 5, 20);
    say(`The paid request ${second.error ? `failed (${short(second.error)})` : `answered ${second.status}`}; sending the same request again in ${wait} s (the same payment, never a second one).`);
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
  if (second.error) {
    throw withExit(`the paid request failed (${short(second.error)}). The payment may have settled: never sign a second payment for this note without checking the payer's $U history first`, 1);
  }
  if (second.status === 402) {
    const parsed = parseJson(second.body);
    throw withExit(`the seller did not accept the payment: ${parsed && parsed.error ? parsed.error : 'no reason given'}. The signed authorization was not used and expires in ${SIGN_WINDOW_SECONDS} s`, 5);
  }
  if (second.status !== 200) throw withExit(`the seller answered ${second.status} to the paid request: ${second.body.slice(0, 160)}`, 1);

  const receiptHeader = second.headers.get('payment-response');
  const receipt = receiptHeader ? parseJson(Buffer.from(receiptHeader, 'base64').toString('utf8')) : null;
  report.paid = { priceU: priceText, payer: wallet.address, payTo, settlement: receipt };
  say(receipt && receipt.transaction
    ? `Paid ${priceText} $U. Settlement ${receipt.transaction} (https://bscscan.com/tx/${receipt.transaction})`
    : `Paid ${priceText} $U. The seller returned no settlement details.`);

  // 5. Save the note before anything else can fail, then check it.
  try {
    fs.writeFileSync(out, second.body, { flag: 'wx' });
    say(`Saved the note to ${out}`);
  } catch (e) {
    say(`Could not save to ${out} (${short(e)}). The paid answer follows so it is not lost:`);
    say(second.body);
  }
  const data = parseJson(second.body);
  const problems = [];
  if (!data || typeof data !== 'object') problems.push('the answer is not JSON');
  else {
    if (String(data.tokenId) !== noteRef.tokenId) problems.push(`the note is for agent #${data.tokenId}, not #${noteRef.tokenId}`);
    if (!data.note || String(data.note.stock).toUpperCase() !== noteRef.stock) problems.push(`the note is about ${data.note && data.note.stock}, not ${noteRef.stock}`);
  }
  report.note = { file: out, problems };
  if (problems.length) {
    say(`PAID, BUT THE ANSWER IS WRONG: ${problems.join('; ')}`);
    emitJson();
    return 6;
  }
  if (!args.verify) {
    emitJson();
    return 0;
  }
  try {
    const result = await verifyNote(data, { rpc: args.rpc });
    report.verification = result;
    if (!args.json) {
      say();
      printResult(result);
    }
    emitJson();
    return result.verified ? 0 : 6;
  } catch (e) {
    say(`The note is saved but the on-chain check could not run: ${short(e)}. Run: node verify-note.js ${out}`);
    emitJson();
    return e.exitCode === 3 ? 6 : 1;
  }
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

module.exports = { readTerms, pickOption, domainOf, makeAuthorization, signAuthorization, buildPaymentHeader, TRANSFER_TYPES, U_ADDRESS, SIGN_WINDOW_SECONDS };
