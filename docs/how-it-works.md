# BORT bStock Agents: how the agents and the contract work

This document describes the desk as of Oct 10, 2026, when its latest close was Oct 6 (days sealed later
appear on the live page, not in this repository). The contract is `StockAgentLogicV1` at
[`0x4245dd4DC9e9bC1035514C6de13C88ab91b61946`](https://bscscan.com/address/0x4245dd4DC9e9bC1035514C6de13C88ab91b61946) on BNB Chain.

## In one paragraph

Two BAP-578 agents hold tokenized US stocks (bStocks) in their own wallets on BNB Chain. **Pasteur**, the
Analyst, ranks the stocks on the morning of a market day, holds two of them, and seals a note on each holding on
chain before the US market opens. **Fermi**, the Trader, pays Pasteur for those notes over x402, checks
each one against the chain, and buys one stock only at a fair price. After the close, each note's claim is
scored and the result is sealed too. One contract, StockAgentLogicV1, does the trading, the limits, the
payments, the record and the gas for both agents. A runner on one machine sends their transactions on a
fixed schedule.

## The pieces

| Piece | What it is | Address or place |
|---|---|---|
| Pasteur, #11181 | the Analyst agent (BAP-578 NFT) | wallet `0x6A2D3fda52A20D7970aA8a2810385b5aAE373A97`, owner `0xC85f…C720` |
| Fermi, #11182 | the Trader agent (BAP-578 NFT) | wallet `0x04B4849eFc453b8E313b52b5d1cd9Ff266D54af0`, owner `0x2905…56f5` |
| BAP-578 NFT | the agents' token contract | `0x15b15df2ffff6653c21c11b93fb8a7718ce854ce` |
| StockAgentLogicV1 | trading, limits, positions, record, payments and gas, in one contract | `0x4245…1946`, Sourcify exact match, immutable |
| Safe, 2 of 3 | owns the contract: lists stocks, registers the relayer, can pause | `0x78b90b71eF598A13530cF77a3E69CFd8Fb0b24fB` |
| Relayer | sends every agent action and is repaid by the agent's own wallet | `0x54E5651a7f62859CcCB5B75613165a69C24ECb4e` (BORT's runtime signer, also one of the Safe's three owners) |
| Runner | the daily schedule | `src/runner.js`, one process on the desk's machine |
| Note seller | sells Pasteur's notes over x402 | `src/seller.js` on `127.0.0.1:8402`; no public address yet |
| $U | the dollar stablecoin the agents pay each other with | `0xcE24439F2D9C6a2289F741120FE202248B666666` |

Each agent's wallet is its ERC-6551 account. The NFT owns it, so the stocks, the money and the record go
with the agent if it is sold.

## The two agents

### Pasteur, the Analyst

- Ranks 18 bStocks (17 buyable, MUB sell-only) on the morning of a market day by how closely each token tracks its
  real stock: how far the pool is from the real share now, plus how far it typically drifts over a day in
  the desk's own record. The ranking started on Sep 30; on Sep 28 and 29 the contract listed five stocks
  and the desk held two fixed positions.
- Holds two of them, 15 USD each, in its own wallet.
- Swaps at most one holding a day, and only when that holding falls out of the top four and the best
  stock it can buy instead scores better by more than the two pools' swap fees. So it can keep a stock
  ranked far down when a swap would cost more than it gains (on Oct 1 it kept NVDAB at 12th: MSFTB scored
  only 16.3 bps better against a 50 bps swap cost). The reason has been sealed in each morning's ranking
  page since Oct 1. One exception, not yet met in the record: a holding the contract no longer lists for
  buys is replaced whatever its rank, if another stock is fit to buy.
- Writes a note only about a stock its wallet holds. The note carries the proof of holding (wallet, balance, block).
  Every other stock gets a session page of observed facts and no note.
- A note gives: the price of one share through the pool against the real share, the pool's swap fee, the
  market session, the stock's rank, the position's exit plan, and one claim that is scored at the close.
  Every note ends with a fixed line: a record of what the agent holds and observed, not investment advice.
  Its last words changed on Oct 1, from "not a recommendation to buy or sell anything" to "not advice to
  buy or sell anything"; a sealed note keeps the words it was sealed with.
- Sells each note for 0.02 $U over x402.

### Fermi, the Trader

- Buys each of the day's notes it can pay for, from its own wallet, and checks each one on chain
  (`verifyAnchored`). Buying every note began on Sep 30: on Sep 28 and 29 it bought one of the two.
- Follows the best-ranked note only if one share costs at most 0.20% over the real share at that moment,
  else the next note, else nothing. Each note recorded as paid and the decision are kept for the day, so a
  retry or a restart does not pay again for a recorded note and does not buy the stock twice.
- Buys 2 USD of the chosen stock (the desk's setting; the code's default is 5) and copies the note's exit
  plan onto its own position.
- Seals its own record at the close: the notes it bought, what it decided and why, its exits.

## A market day

October is US daylight time, so New York is UTC-4.

| New York / UTC | Job | What happens |
|---|---|---|
| 09:00 / 13:00 | OPEN | Pasteur ranks the stocks, makes at most one swap (a sell, then a buy), sets the exit plan on each position, writes the day's pages, and seals their Merkle root on chain (`anchor_notes`, phase 1), before the 09:30 open |
| 10:00 / 14:00 | TRADER | Fermi buys the notes over x402, checks them on chain, decides on a fresh price, buys, sets its exit plan |
| every 15 min | EXITS | each position is checked against its exit plan and sold once it reaches it, but only while the real stock trades |
| 16:15 / 20:15 | CLOSE | each morning claim is scored; Pasteur's close is sealed (`anchor_notes`, phase 2) with the IPFS address of its whole record; Fermi seals its record the same way; a short summary of each record is pinned for BORT's chat; the day's pages are published (`site/ledger/`) |

A failed job is tried again 5 minutes later, for up to 3 tries in all (the close 6), inside its window.
Finished jobs and Fermi's paid notes are kept on disk, so a restart repeats nothing. Every close since
Oct 1 carries the IPFS address of the agent's record.

A job's window is how late it may still start: 15:00 ET for the open and for the Trader's job. A late open
is still filed as phase 1, and the contract checks no time of day, so the time stored with the root, not
the phase number, shows whether a morning root was written before the open (Sep 28's was not).

Exit checks go on after the close. An exit made between the sealing of its day's close and midnight
New York time gets no page in any sealed record (the next close reads only its own date); the sale itself is
on chain. The four exits in the record were all made before their day's close.

## The rules

- **Buy** only while the bStock and the real stock both trade (pre-market, regular, post-market or
  overnight), and only when one share costs at most 0.20% over the real share. The pool's swap fee is a stated cost, not
  premium. A pool and a reference more than 1% apart are not trusted either way.
- **Exit plan**: 1.5 times the stock's typical daily move in the desk's record, between 2% and 6% either
  way (3% until there are three days of history).
- **Claim**: at the close, the token's move since the note is within a band of the real stock's move. The
  band is twice the stock's typical gap in the desk's record, 10 to 100 bps (25 bps until there are three
  days of history), so about 3 to 4 claims in 5 should hold. Through Oct 6 no band came from the doubling
  itself: four claims used the 25 bps default (all held) and four the 10 bps floor (three held). A claim
  is about tracking, never about where a stock goes.
- **Notes** only about held stocks, with no advice wording.

The real share's price and session come from Binance's RWA data (the stock's Ondo twin); the pool price
comes from PancakeSwap's quoter.

## StockAgentLogicV1, the contract

One contract is the agent's executor, the keeper of its limits and positions, the holder of its record
and the payer of its gas. It is immutable and owned by the Safe.

### Arming an agent

- The owner's whole setup is one transaction on the agent's wallet: `setPermissions([contract], [true])`.
  No other grant or guard.
- The wallet keys that permission to its current owner. A sale therefore switches the agent off for this
  contract until the new owner sends the same one transaction. Revoking it stops everything at once.
- The agent's own logic address does not need to point here: any agent on BORT's BAP-578 NFT that has an
  ERC-6551 wallet can use the contract by giving it that permission.

### What it can make a wallet do, and nothing else

1. approve the router for exactly the amount being swapped;
2. swap along the stock's one listed route, with the output going back to the same wallet;
3. repay the relayer for the gas the action burned, at a capped price;
4. vouch for one $U payment it approved (ERC-1271).

Apart from the payee of an approved payment, no input names an address that can receive value.

### Actions

Everything goes through `handleAction(tokenId, action, payload)`, the entry point BORT's runtime already
uses for its other agent logics.

| Action | What it does | Checks |
|---|---|---|
| `buy_stock` | buys a listed stock with USDT, BNB or $U | the stock is listed and buyable; counts against the weekly buy limit; the wallet keeps enough BNB for this trade's gas; minimum output from PancakeSwap's QuoterV2 in the same transaction (1% slippage by default, 5% at most), or the sender's own floor if higher; a pool running dry is refused; a BNB buy is refused while the WBNB/USDT price sits more than about 1% from its 30-minute average |
| `sell_stock` | sells into USDT, BNB or $U | not counted against any limit, so a limit never blocks an exit (a pause, or the Safe removing the stock, still stops it); the same minimum-output checks |
| `set_targets` | stores stop-loss and take-profit levels on an open position, for BORT's triggers | the contract never acts on them itself; they read as zero after a sale until set again under the new owner |
| `anchor_notes` | seals a Merkle root of the day's pages | the day is the block's own UTC day; the phase must be 1 or 2 (the desk uses 1 before the open, 2 after the close; the contract does not check market hours); once per day and phase, final once written |
| `approve_payment` | approves one $U payment from the agent's wallet | at most 5 $U, valid at most 15 minutes, counted against the weekly payment limit |
| `record_learning` | a BAP-578 learning report, as BORT's V7 logics take it | moves no value |
| `check_balance` | reads a balance | read only |

Writes come from a Safe-registered relayer or from the agent's owner, and only for an armed agent. Reads
are open to anyone.

### Limits

- Built in, with no transaction needed: 10,000 USD of buys and 100 USD of payments per 7 days, per agent.
- The owner can change both with one `setBudget`: raise, lower, remove, or set 0 to stop that kind. A new
  owner starts again from the defaults.
- Sells are never limited.
- A payment counts when the contract approves it, so "payments approved" can be more than what was paid.

### Trading safety

- The router, the quote tokens and the two bridge pools (WBNB/USDT and $U/USDT, fee 100) are fixed at
  deployment. Each stock trades only on its one USDT pool, whose fee tier the Safe sets. No sender
  chooses a pool, so no one can route an agent through a pool of their own. A trade payload still has
  three route words (`bridge`, `fee1`, `fee2`) from before review 3: the contract reads none of them, and
  the runner sends zeros.
- A buy measures what actually arrived in the wallet, not what the router reports.

### Paying for services (x402)

An agent's wallet has no key, so it cannot sign. Instead `approve_payment` has the contract compute the
exact EIP-3009 `TransferWithAuthorization` digest for one $U payment, and record it. When the seller
settles, $U asks the agent's wallet (ERC-1271), the wallet asks the contract, and the contract says yes
only for a digest it computed for that same wallet, while the owner who approved it still owns the agent
and nothing is paused. So a sale or a Safe pause also stops a payment that was approved but not yet
settled.

### The record

- `anchor_notes` stores the root under (agent, day, phase) with the time it was written, and emits
  `NotesAnchored` with the root and a `uri`: from the Oct 1 close, each close's `uri` is the `ipfs://`
  address of the agent's whole record (an open's is a plain label).
- `verifyAnchored(agent, day, phase, pageHash, proof)` tells anyone whether a page is in that root, and
  when the root was written.
- The contract is also BAP-578's learning module for these agents: `getLearningRoot` is the latest sealed
  root, `verifyLearning` checks a page against it, and `getLearningMetrics` counts the agent's actions and
  learning events.

### Positions and book

Every trade here updates the agent's position in that stock (units, USD cost, when it opened) and its
lifetime totals (realized profit, volume bought and sold). Read them with `positionOf`, `openPositions`,
`tradingBook`, or BORT's `getMetrics`.

### Gas

- Every action the relayer sends is repaid from the agent's own wallet: the gas actually burned plus
  20,000, at most 2,000,000 gas, at the transaction's gas price capped by a maximum the Safe can only
  lower. The source starts it at 10 gwei; the deploy lowered it to 1 gwei (read `maxGasPriceWei`).
- The repayment never undoes an action. If the wallet is short, it pays what it has, and the shortfall is
  recorded in the event.
- An owner who sends an action pays their own gas.
- The runner sends legacy transactions at the node's quoted price (about 0.05 gwei on BSC), so the agents
  pay the real price.

### Governance and stops

- The Safe (2 of 3) can list or delist a stock (a delisted stock is sell-only), register or drop a
  relayer, pause the contract, and lower the gas price cap. Ownership cannot be renounced.
- BORT's circuit breaker (the fleet-wide pause) also stops every write here.
- Stated plainly, a stolen relayer key could trade inside the weekly limits through the listed pools (and
  push a buy through a pool it moved first, which on a deep pool costs it more than it gains), sell
  positions, pay up to the payment limit, and fill today's empty record slot with a wrong root. The Safe
  can pause it or drop the relayer at once, and each agent's owner can revoke.

## How anyone checks the record

1. A page's hash is keccak-256 of its canonical JSON: keys sorted at every level, no spaces. A number with
   a fraction is always stored as a decimal string (the writer refuses one that is not); whole numbers
   stay JSON numbers.
2. The leaf is `keccak256(keccak256(abi.encode(pageHash)))`, as in OpenZeppelin's StandardMerkleTree, and
   the leaves fold into the day's root.
3. The contract holds that root and the time it was written.

Ways to check: the live page ("Check every page" runs all of it in the browser); from a terminal with
`node src/verify.js site/ledger/11181/20260930-1.json --logic 0x4245dd4DC9e9bC1035514C6de13C88ab91b61946`;
one note at a time with the Wallet Skill's `verify-note.js`; or read `anchors(11181, 20726, 1)` straight
from a public BSC node with the one curl command in the README.

## Notes for sale (x402)

- `GET /notes/11181` (free): the notes on sale now, with the price and the pay-to wallet.
- `GET /notes/11181/<STOCK>`: 404 if that note is not on sale (nothing is charged), otherwise 402 with the
  terms: 0.02 $U, scheme `exact`, EIP-3009, on BSC, paid to Pasteur's own wallet. A note sealed at the open
  stays on sale until that day's close, even if Pasteur sells the stock in between (an early take-profit
  must not cost Fermi its day); from the close on, a note is on sale only while Pasteur still holds the stock.
- The same request with a `PAYMENT-SIGNATURE` header: the seller checks the payment with the token itself,
  settles it into Pasteur's wallet (the relayer pays only the gas), and answers with the note, its proof
  and its anchor.
- The same paid request sent again gets the same note and no second charge. A slow confirmation answers
  503, "send the same request again". Rate limited, never cached. Stated plainly, that header is the
  receipt, and its fields are public once the transfer is on chain: until the close publishes the day's
  pages, anyone who rebuilds it gets the same note. The seller does not bind a repeat to the payer.
- Fermi buys this way, wallet to wallet, with no key: the contract approves its payment
  (`approve_payment`) and its wallet vouches for it. It bought notes on five of the six days. On Oct 2 it
  bought none: Pasteur's take-profit levels had sold both stocks before 10:00 ET, and until that day a
  note went off sale once its stock was sold. Since then a note stays on sale until the close.
- The Wallet Skill (`skills/desk-notes`) lets any agent with Binance's Agentic Wallet do the same and then
  check the note on chain. It still waits on a public https address for the seller: as of Oct 10 the
  seller answers only on the desk's own machine, and no outside wallet has bought a note.

## In BORT

- BORT's dapp has a Stock Agent type: one transaction mints the agent and funds its wallet, one more allows
  stock trading. The agent page shows positions, limits and the lifetime book, and BORT's chat can buy,
  sell, check balances and set exit levels.
- Living Brain, BORT's memory for an agent, is on for both agents (since Oct 1): each remembers its
  conversations with its owner. It
  never touches the contract, the relayer or the agents' gas, and it does not see the runner's work by
  itself.
- The link between the two: after a close, the record's summary is on IPFS. The owner adds it as the
  agent's knowledge source (one signature), and BORT's chat reads it on every turn.
- The public page ([www.bortagent.xyz/#/stocks](https://www.bortagent.xyz/#/stocks)) shows both agents
  live from the chain and the record, with no wallet. BORT's runtime finds each agent's record through
  its latest close on chain (`GET /api/stock-desk/<agent>`), and the page checks every page it shows in
  the browser.
- For every Stock Agent in BORT, not only the desk's two: a chat buy goes through only at a fair price,
  exit levels sell automatically (checked every 15 minutes), each trade shows a receipt, and the
  agent's stock work reaches its journal and memory. The desk's two agents are left out of BORT's own
  exit checks, because the runner does theirs.

## Days the desk did not run

The runner is one process on one machine. That machine was offline on Oct 5 and from Oct 7 to Oct 9,
so those four market days have no pages, no notes were sold and no exit checks ran. As of Oct 10 the
record has six market days: Sep 28 to Oct 2, and Oct 6. A market day the desk misses later will show the
same way, as a day without pages. Nothing is filled in afterwards: a day's root can only be written on
that day.

## When an agent is sold (rehearsed on a fork; no sale as of Oct 10)

A sale of Pasteur was planned for after the Oct 7 close and did not take place. What a sale changes:

- Stocks, money, positions, book and the sealed record stay with the agent: the buyer gets all of it.
- The contract stops acting for the agent until the buyer sends the one arming transaction. Approved but
  unsettled payments die, and exit levels need setting again.
- The contract's header comment says exit levels "travel with the agent when it is sold". That line is
  older than review 3: the levels stay stored, but they count only for the owner who set them.
- The buyer gets a fresh Living Brain. Knowledge sources stay with the token.
- Before signing, check that the wallet is not locked (`isLocked()`, `lockedUntil()`): a lock would carry
  over to the buyer.

## Numbers as of the Oct 6 close

2 agents, 18 stocks ranked (17 buyable, MUB sell-only), 17 roots sealed over 6 market days (Pasteur 12,
Fermi 5), 8 notes bought agent to agent at 0.02 $U each, 7 of 8 claims held (four scored days: Sep 30,
Oct 1, Oct 2 and Oct 6; the notes of Sep 28 and 29 carried no claim), 4 positions sold at their take-profit
level. Seven of the eight purchases are pages in Fermi's own record,
which starts on Sep 29; the first, on Sep 28, is on chain only.

## Where things are

| What | Where |
|---|---|
| Contract source and its reviews | `contracts/StockAgentLogicV1.sol`, `docs/review-stock-agent-v1.md` |
| Runner and desk code | `src/` (the README says what each file is) |
| Published days | `site/ledger/<agent>/<day>-<phase>.json` |
| Wallet Skill | `skills/desk-notes/` |
| Deployment record | `deployments/` |
| Not in this repository | see the README: the tests, the deploy kit, the probes, the desk's static page, and BORT itself |

The notes and this document are a record of what the agents hold and do. They are not investment advice,
and not advice to buy or sell anything.
