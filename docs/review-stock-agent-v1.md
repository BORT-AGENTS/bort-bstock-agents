# Review of StockAgentLogicV1.sol

> This is the working record of four internal review rounds of the contract. It is not a third-party
> audit. It cites proof-of-concept tests (`test/review/...`, `test/*.fork.test.js`) and commit ids from
> the desk's own history. Neither is part of this repository, so its `Run:` lines cannot be run here.
> Line numbers are those of the commit each round reviewed, not of the `contracts/StockAgentLogicV1.sol`
> published here: find the code by function name.

Scope: `contracts/StockAgentLogicV1.sol` at commit `6056a77`, against a BSC mainnet fork pinned at
block `124365019` (the same fork the existing suite uses). Reviewed for real, exploitable loss of
the agent's funds or the relayer's money, plus DoS. PoCs live in `test/review/` and pass:

- `test/review/probe-facts.test.js`: on-chain facts (pool depths, token types, AccountProxy init rules)
- `test/review/poc-bnb-budget-bypass.test.js`: Finding 1
- `test/review/poc-gas-settlement.test.js`: gas-settlement bounds (Finding 3)
- `test/review/lib/fixture.js`: shared fixture (not a test)

Run: `BSC_FORK_BLOCK=124365019 npx hardhat test test/review/*.test.js`

## Resolution (2026-09-27, after this review)

- **Finding 1, fixed.** A BNB buy is now refused with `BnbPriceUnsettled` while the WBNB/USDT
  fee-100 pool's spot tick is more than `MAX_BNB_TICK_DEVIATION` (100 ticks, about 1 %) from its
  `BNB_TWAP_WINDOW` (1,800 s) average, read through `observe`. The pool keeps 4,500 observations,
  and normal drift was 2 to 12 ticks. `poc-bnb-budget-bypass.test.js` is now a regression test:
  the review's exact sequence (dump 2,600 WBNB, 1 BNB reads 720.69 instead of 774.50 USD) ends in
  `BnbPriceUnsettled`, and USDT buys keep working while BNB is unsettled. The contract header no
  longer over-claims.
- **Finding 2, fixed.** `canTrade` reads `ownerOf` and `permissions` through `_tryWord`, the same
  never-throw helper as `AgentGasRelay`, so an uninitialized wallet or an unminted agent reads as
  not permitted. It is covered by a test in `stock-agent.fork.test.js`.
- **Findings 3 to 5,** informational: no change. The pre-launch checklist items are carried into
  the deploy plan: check `lockedUntil` before a marketplace sale, and watch the bStock issuer's
  pause and compliance hook.
- Suite after the fixes: 22 passing at block 124365019.

## Added after this review (covered by the focused re-review below)

- `anchor_notes` and `verifyAnchored` (commit be2b5ec): write-once Merkle roots of the daily desk
  pages. Moves no value except the gas repayment.
- `approve_payment` and `isValidSignature` (ERC-1271): the contract computes one $U EIP-3009
  `TransferWithAuthorization` digest for the agent's own wallet (at most 5 U, expiring within 15
  minutes, counted against the budget) and answers ERC-1271 yes only for that digest, only when the
  asking wallet is the payer. **This adds a new value path:** $U can leave the wallet to the payee
  of an approved payment. The review's core invariant now reads: router (swaps), relayer (bounded
  gas), or the payee of an approved, budgeted $U payment.
- Points to review:
  - that no approved digest can match an ERC-4337 user-operation hash or any other signed message
    (the digest is built here from payment fields);
  - approvals keyed by wallet;
  - approval storage never cleared (the $U nonce prevents a replay);
  - interaction with AccountV3's nested-signature path.
- The fork tests cover the happy path, a replay, a different amount, an EIP-191 wrap and a foreign
  caller.

**Bottom line of the first review (as written, before the fixes and additions above).** The core value-flow invariant holds: value leaves the TBA only to the router (for the
swap) and back to the TBA, plus bounded gas to the *calling registered relayer*, verified by reading
every `execute()` call site. No unconditional fund-loss path exists for an honest relayer + honest
Safe + honest owner. All findings are LOW/INFO. The most substantive is that the contract's own
stated invariant "buys cannot exceed the agent's budget per period" is **false for BNB buys**
(CONFIRMED; fixed since, see the Resolution above), though it is economically bounded on the currently-wired pricing pool.

---

## Finding 1: BNB-buy budget is a soft bound: `bnbToUsd` reads a spot price that a caller can move (LOW, borderline MEDIUM)

**Severity:** LOW today (uneconomical on the wired pool); becomes MEDIUM if a large custom budget is
set via `setBudget`, or if `BNB_USD_POOL` is ever rewired to a thinner pool. **Status: CONFIRMED (PoC).**

**Why it is in scope despite the header.** The header discloses that `minOut` does not stop a caller
who moves the pool, and that BNB spends are valued via the fee-100 WBNB/USDT `slot0`. But it also makes
a hard promise for the stolen-relayer case: *"buys cannot exceed the agent's budget per period."* This
promise is what bounds self-dealing / sandwich extraction on **buys** (positions stay in the wallet, so
the only way a buy leaks value is a sandwich, and the budget is the sole per-period cap on buy volume).
The finding is that this specific promise is breakable, i.e., the real impact is worse than the header
claims.

**Mechanism.** `_buy` values a BNB buy with `usdValue = bnbToUsd(t.amountIn)` (line 351), and
`bnbToUsd` (lines 470–480) reads the *instantaneous* `slot0` sqrtPrice of the fee-100 WBNB/USDT pool.
`_consumeBudget` (lines 563–575) then checks `usdValue` against the cap. USDT buys are immune
(`usdValue = amountIn`, no oracle, see the control test), but a BNB buy's budget charge is whatever
the pool's spot price says *in the same transaction*. Anyone (the caller need not be the relayer) can
push that pool first, so a fixed amount of BNB is charged fewer USD against the budget.

**Failure scenario (proven).** With the built-in $50/week budget and a treasury holding BNB:
- A `buy_stock` of `0.069 BNB` is worth **$53.44** at the true price → reverts `BudgetExceeded` (correct).
- Attacker swaps `2600 WBNB → USDT` in the fee-100 pool, moving `bnbToUsd(1 BNB)` from **774.50 → 720.69**.
- The identical `0.069 BNB` buy is now recorded as **$49.73** and is **admitted**, spending real
  treasury BNB while the budget shows `$49.73 / $50`.

Evidence (`poc-bnb-budget-bypass.test.js` output):
```
baseline bnbToUsd(1) = 774.495... USD; buy is worth 53.44 USD   -> BudgetExceeded
after moving the pool: bnbToUsd(1) = 720.69 USD
buy admitted: spent 0.06949 BNB, recorded usdValue 49.73 USD (budget cap 50)
attacker round-trip pool-move cost ~ 0.5112 BNB (~$396)
```

**Why only LOW today.** The wired pool is very deep (~$9.58M USDT + ~3972 WBNB, in-range liquidity
3.95e24). Moving `bnbToUsd` down ~7% cost the attacker about 0.51 BNB (about $396) round-trip, to raise buying
room by ~$3.44 over the cap. A larger bypass needs a super-linearly larger (and costlier) move, which
dwarfs the treasury of a $50-budget agent. It matters more if `setBudget` set a large custom cap, if
the pricing pool were changed to a thin one, or for valuing a large BNB position.

**Minimal fix.** Value the BNB spend with the manipulation-resistant number the contract already
trusts elsewhere, the QuoterV2 result for the *actual* WBNB→USDT leg of this trade, instead of raw
`slot0`; or read a short TWAP (`observe`) from the pool rather than `slot0`; or cap BNB-in per
transaction. Any of these makes the recorded `usdValue` track what the trade really costs.

---

## Finding 2: `canTrade()` preflight reverts on a created-but-uninitialized TBA (LOW)

**Severity:** LOW (no fund risk; breaks the documented preflight). **Status: CONFIRMED (probe-facts).**

`canTrade` (lines 495–507) is documented as *"everything a relayer needs before trying a trade,
without spending gas."* It guards the deployed check with `if (tba.code.length != 0)` and then calls
`IERC6551Account(tba).permissions(...)` (line 502). The BAP-578 flow is two steps: `registry.createAccount`
(deploys the `AccountProxy`, which *has* code) and then `initialize(impl)` (sets the ERC-1967 slot). In
the window between them the proxy has code but its implementation slot is zero, so it delegatecalls to
`address(0)`, returning empty data; decoding a `bool` from that **reverts**. So `canTrade` throws for an
agent in that window instead of returning a clean `permitted=false`.

Evidence (`probe-facts.test.js`): *"uninitialized wallet: permissions() returns EMPTY data
(delegatecall to address(0))"* and *"canTrade(uninitialized wallet) threw: true"*.

This is a regression from the template's `AgentGasRelay.canRun`, which deliberately routes every
external read through `_tryWord` (a staticcall that cannot revert) precisely so a preflight degrades to
"cannot run" rather than throwing. `_armedTba` (line 514) reverting in the same case is fine (fail-closed
on the write path is correct); only the *view* preflight should not throw.

**Minimal fix.** In `canTrade`, wrap the `permissions` staticcall in a low-level call that treats
non-decodable / empty return data as `permitted = false` (mirror `AgentGasRelay._tryWord`).

---

## Finding 3: Gas settlement: fail-open subsidy is bounded; the FIXED_OVERHEAD vs EIP-3529 margin is safe here (INFO)

**Status: CONFIRMED (poc-gas-settlement).** No drain and no relayer-profit path was found.

- `paid <= relayer's real outlay` for both a buy and a sell (measured `paid` vs `receipt.gasUsed *
  effectiveGasPrice`): BUY paid `0.000485315` vs real `0.000489372`; SELL paid `0.000387275` vs real
  `0.000391344`. Because `units = gasStart - gasleft() + FIXED_OVERHEAD_GAS` (line 587) excludes the
  21,000 intrinsic + calldata cost and `price = min(tx.gasprice, maxGasPriceWei)` (line 589), `owed`
  is always slightly *below* true cost, the correct direction. A stolen relayer key cannot turn
  settlement into profit; it pays validators more than it recovers.
- The EIP-3529 concern the template calls out (overhead must stay under a sell's refund) holds for
  these swaps: a PancakeSwap V3 stock swap clears at most ~one allowance slot, far under the refund
  cap, so `paid` stayed below real cost even on the sell. If a future allowed token cleared many slots
  per trade this margin could narrow, worth a note on the allowlist checklist, not a bug today.
- Fail-open works: with the treasury drained to 1 wei, a sell still succeeds and `settlementFailed`
  stays false with `paid ~ 0` (the relayer eats that tx's gas, the intended dust-exit behaviour).

**Residual (INFO):** a malicious *owner* can arm the agent, keep the TBA funded just below the gas
reserve, and let the relayer subsidize each trade's gas (bounded to ≤ `GAS_UNITS_CEILING * maxGasPriceWei`
≈ 0.02 BNB per trade, and the relayer can simulate `canTrade`/balance first). This is the accepted
template trade-off, not a new issue.

---

## Finding 4: `_sellForBnb` unwraps the router's *entire* WETH9 balance to the TBA (INFO)

`_sellForBnb` (lines 424–443) builds `multicall([exactInput(recipient=ROUTER), unwrapWETH9(minOut,
tba)])`. Per PancakeSwap's `PeripheryPayments.unwrapWETH9`, this withdraws the router's **whole** WETH9
balance and sends it to `tba`. The two sub-calls are atomic within one multicall, so the agent's WETH
never sits in the router across transactions; there is **no path for a third party to sweep the
agent's WETH**, and the reverse (the agent sweeping third-party WETH stuck in the router) is a
*windfall*, never a loss. `received` is measured as the TBA's native-balance delta (line 442), so if
stray router WETH is swept, the emitted `amountOut` over-reports the swap but the agent only gains.
No action needed; noted for completeness. (Direction confirmed by reading the verified periphery source.)

---

## Finding 5: Liveness / DoS surfaces (INFO, pre-launch checklist)

None loses funds, and the owner always retains a direct exit via `TBA.execute` (they hold `execute`
on their own account). Listed so they are on the operational checklist:

- **AccountV3 lock.** `Lockable.lock` (owner-only, up to 365 days) sets a single `lockedUntil`; while
  locked, `execute` reverts in `_beforeExecute`, so every trade reverts. A *seller* could lock an
  agent shortly before sale, DoSing the buyer for up to a year. This is inherent to Tokenbound
  AccountV3, not to this contract, but a marketplace/buyer should check `isLocked()` / `lockedUntil`.
- **`receive()` override gas-bomb.** An owner can set an override (`setOverrides`) on the account's
  `receive` selector so that receiving native BNB reverts; that only blocks BNB-out sells for their
  own agent (USDT-out sells still work), self-griefing.
- **Extreme `bnbToUsd` manipulation → revert.** Pushing the pricing pool to an extreme can make
  `Math.mulDiv` in `bnbToUsd` overflow-revert, which would block BNB buys and BNB-out sells (the sell
  event calls `bnbToUsd(received)`, line 388). Costly on the deep pool; USDT routes unaffected.
- **bStock compliance / pause hook.** The allowed stocks are ERC-8056 "scaled UI" securities tokens
  (`SecuritiesToken`) whose `_update` calls a pause manager and a compliance contract for `from`/`to`/
  `msg.sender`. If the issuer's compliance ever rejects the TBA as a holder, or the token is paused,
  every buy/sell of that stock reverts inside the swap. External to this contract, but it means the
  product's liveness depends on bStocks permitting arbitrary contract holders (they do at the fork
  block; the existing suite trades them successfully).

---

## What was checked and found fine

- **Value-flow invariant.** Every `execute()` the contract issues targets only: `approve(ROUTER, amt)`
  (spender = constant router), `exactInput`/`multicall` with `recipient` forced to `tba` or the router,
  and the gas transfer to `msg.sender` (only when `byRelayer`, line 329). No caller-supplied address
  ever receives value; the multicall calldata is contract-built, not caller-supplied.
- **Auth.** Trades require a registered relayer or the current `ownerOf` (line 315); reads are open by
  design. A stranger is rejected (existing suite).
- **Consent resets on sale.** `permissions` is keyed on root owner (Tokenbound `Permissioned`), so a
  transfer disarms the contract until the new owner re-permits; the custom budget also reverts to
  default because `_effectiveBudget` re-checks `setBy == ownerOf` (lines 552–561). Confirmed by the
  existing suite and by reading `AccountV3`/`Permissioned`.
- **AccountProxy front-run.** `AccountProxy.initialize` only accepts the `initialImplementation` or a
  guardian-trusted implementation; the guardian does **not** trust arbitrary implementations
  (probe-facts). A stranger front-running `initialize` can only install the legitimate impl (harmless)
  or revert; it cannot inject a malicious implementation.
- **`execute` failure semantics.** `LibExecutor._call` bubbles reverts, so a failed swap reverts the
  whole `handleAction` (no silent success); a locked account reverts in `_beforeExecute`.
- **BNB-in exactInput leaves no stuck ETH.** `exactInput` (exact input) consumes the full `msg.value`
  on the first hop; no `refundETH` is needed (verified against the periphery source and by the
  multi-hop BNB test).
- **`bnbToUsd` math / slot0 ABI.** Reading only the first `slot0` word and masking to `uint160` is
  correct (sqrtPriceX96 is the first return value; PancakeSwap's `feeProtocol`-as-`uint32` sits in a
  later word). Token-order handling is correct (`USDT_IS_TOKEN0` verified true on-chain); `bnbToUsd(1)`
  = ~$774 matches spot. `Math.mulDiv` prevents overflow for realistic prices.
- **Rebasing multiplier is UI-only.** bStock `_update` calls `super._update(from,to,value)`, the ERC20
  ledger (`balanceOf`/`transfer`/`approve`) is in raw units; the multiplier only affects `balanceOfUI`
  / the `TransferWithUIAmount` event. So the pool, the quoter and the contract's measure-after all
  operate in one consistent unit within a tx; a multiplier change cannot skew `received`.
- **Budget period-roll.** `_consumeBudget` advances `periodStart` by whole `period` multiples and
  maintains `periodStart <= now < periodStart + period` even across a period-length change or a sale;
  no underflow, no future-dated window.
- **uint128/uint64 truncation.** `spentThisPeriod + usdValue` is bounded by the cap (≤ uint128) before
  the cast (the excess reverts `BudgetExceeded`); `setBudget` bounds `usdPerPeriod ≤ uint128.max` and
  `periodLength ∈ [1, MAX_PERIOD]`.
- **Path / fee / bridge rules.** `_path` forbids a third token on the path (bridge must be the other of
  USDT/WBNB and `!= quote`), `_checkFee` restricts to {100,500,2500,10000}, and the allowlist forbids
  `stock ∈ {USDT, WBNB}` and requires code, so no degenerate or self-referential path.
- **Reentrancy.** `handleAction` is `nonReentrant`; the only external calls that move value are the
  swap and the gas transfer, both after budget debit (CEI), and re-entry is blocked fleet-wide by the
  single mutex.
- **Gas settlement recipient.** Forced to `msg.sender` and only reached when `byRelayer`; re-reading
  `tbaFor` in `_settleGas` returns the same address within the tx.

---

# Focused re-review (payments and anchoring)

Scope: the two features added after the first review, at commit `92f1484`: `approve_payment` +
`isValidSignature` (ERC-1271 over one $U EIP-3009 `TransferWithAuthorization`) and `anchor_notes` +
`verifyAnchored`. Same BSC fork, pinned at block `124365019`. The diff reviewed is
`git diff 1ea2881 -- contracts/StockAgentLogicV1.sol`.

New PoCs (all pass; whole suite **47 passing** at the pinned block):

- `test/review/poc2-payment-digest.test.js`: the digest is exactly $U's, proven with **real $U
  settlements** across edge cases; cross-wallet, recursive-nesting, `receiveWithAuthorization` and
  budget behaviour (Findings context + "fine" list).
- `test/review/poc2-erc1271-other-messages.test.js`: the ERC-1271 "yes" never reaches an ERC-4337
  user op (real EntryPoint v0.6), Permit2, `permit`, or an EIP-191 wrap, each with a positive
  control ("fine" list).
- `test/review/poc2-stops-and-budget.test.js`: Findings 6, 7, 8.
- `test/review/poc2-anchor-day-bounds.test.js`: Finding 9.
- `test/review/poc2-newaction-gas-interactions.test.js`: gas-settlement bounds and interactions for
  the new actions ("fine" list).
- `test/review/lib/poc2-pay.js`: shared helpers; documents the verified $U source facts.

Run: `BSC_FORK_BLOCK=124365019 npx hardhat test test/review/poc2-*.test.js`

**$U ground truth (verified source).** `$U` (`0xcE24439F2D9C6a2289F741120FE202248B666666`) is a
transparent proxy to `StablecoinV2` at `0xbef2…3dfc` (Sourcify, `solc 0.8.28`). Its
`TransferWithAuthorization` typehash constant equals the contract's, its domain separator (name
`United Stables`, version `1`, chain 56, verifyingContract `$U`) equals `PAYMENT_DOMAIN_SEPARATOR`
read at construction, its `_transferOrReceiveWithAuthorization` verifies with OZ `SignatureChecker`
(so a contract `from` is asked over ERC-1271), and `_transfer` has **no ERC777-style hooks** (only
pause/freeze). `permit` is ECDSA-only; `cancelAuthorization` takes no signature. The `AccountV3`
implementation the wallets run (`0x41C8…44eC`) is byte-identical to the Ethereum-verified source used
for this review.

**Bottom line.** The digest is built correctly and the ERC-1271 gate is tight: no user operation,
Permit2 order, `permit`, EIP-191 message, `receiveWithAuthorization`, cross-wallet reuse or recursive
nesting can make `isValidSignature` approve a hash the contract did not build for that wallet
(all proven, most against live BSC contracts). The real change is to the **threat model**, not the
crypto: `approve_payment` is a genuine value-*out* path, so the first review's headline invariant,
"against a stolen relayer key … everything bought or sold stays in the agent's wallet", no longer
holds. Two MEDIUM findings follow from that, three LOW, one INFO. No unbounded drain and no way to
exceed the budget were found.

## Finding 6: `approve_payment` lets a relayer key (or owner) send the whole USD budget out of the wallet as $U to any address (MEDIUM)

**Severity:** MEDIUM. **Status: CONFIRMED (PoC).** `poc2-stops-and-budget.test.js` → "FINDING A".

Buys and sells keep value in the wallet; the only stolen-relayer leak was an *indirect* sandwich.
`approve_payment` adds a **direct** exit: `_approvePayment` (contract lines 426–449) approves a $U
`TransferWithAuthorization` from the wallet to a caller-chosen `to` (any non-zero address other than
the wallet itself), and once `isValidSignature` vouches for it, `$U.transferWithAuthorization` moves
the $U to `to`. The only cap is the shared USD budget (`_consumeBudget`, same one buys use).

**Failure scenario (proven).** With the built-in 50 USD/week budget and a wallet holding 60 $U, a
registered-relayer caller approves and settles `5 U` twelve times to an unrelated address, moving the
**entire 50 U** period budget out; the next approval reverts `BudgetExceeded`. It repeats every
period, and `to` is arbitrary. The same is available to the owner (who could already move funds), so
the material change is the *relayer* now has a direct-theft primitive, not only a sandwich.

**Why not higher.** It is bounded by the budget per period (default 50 U), disclosed in the "Added
after this review" note ("$U can leave the wallet to the payee of an approved payment … counted
against the same budget as buys"), and the Safe can drop the relayer while the owner can revoke.

**Minimal fix.** Restrict `to` to a Safe-kept payee allowlist (mirror `allowedStock`), so a stolen
relayer can pay only real registered services, never an arbitrary address; and/or give payments their
own small sub-budget separate from the buy budget. Keep the default budget small.

## Finding 7: The pause / circuit breaker does not stop an already-approved payment; only a per-agent owner revoke does (MEDIUM)

**Severity:** MEDIUM. **Status: CONFIRMED (PoC).** `poc2-stops-and-budget.test.js` → "FINDING B".

`isValidSignature` (lines 456–458) checks only `approvedPayment[msg.sender][hash]`. It does **not**
consult `paused` or `circuitBreaker`. So after the Safe hits its fleet-wide stop (`setPaused(true)`),
new approvals and trades revert `Paused`, but any payment approved *before* the pause still settles
through $U while the contract is paused (proven). The only thing that stops an in-flight approved
payment is the **owner** revoking the wallet permission, which makes `AccountV3._isValidSigner`
return false so the wallet stops vouching (proven), and that is per-agent, not the Safe's
fleet-wide lever. The exposure per agent during an incident is the remaining budget within the
approval's ≤15-minute `validBefore`.

**Minimal fix.** Have `isValidSignature` return `0xffffffff` when `paused ||
circuitBreaker.globalPause() || circuitBreaker.isContractPaused(address(this))`, so the fleet-wide
stop also halts settlement.

## Finding 8: Approvals are not cleared and not bound to the owner epoch, so one can settle after a revoke or a sale (LOW)

**Severity:** LOW (bounded by the ≤15-minute `validBefore`). **Status: CONFIRMED (PoC).**
`poc2-stops-and-budget.test.js` → "FINDING B" (the re-arm leg); mechanism is identical for a sale.

`approvedPayment[wallet][digest]` is never deleted and is keyed only by wallet, not by which owner
armed the contract. A revoke (or a sale, which voids the owner-keyed `Permissioned` permission) makes
the wallet stop vouching, but the entry survives; the moment the agent is **re-armed**, by the same
owner, or by a buyer after a sale, an approval still inside its `validBefore` window settles again
(proven for revoke+re-arm). Because `validBefore ≤ now + 15 min` at approval time, the exposure is a
≤15-minute window straddling the re-arm, and the $U nonce still limits each authorization to one use.
A buyer who re-arms within 15 minutes of the seller's last approval can have the seller's approved $U
pulled from the wallet.

**Minimal fix.** Bump a per-agent epoch on transfer (or on `setBudget`) and fold it into the digest /
gate so old approvals die with the ownership change; or add an owner/relayer `cancelApproval(digest)`
that also refunds the budget (see Finding 10).

## Finding 9: `anchor_notes` day is caller-chosen, not derived from block time: future days can be pre-empted (write-once), past days back-filled (LOW)

**Severity:** LOW (no funds; defeats the anchoring guarantee itself). **Status: CONFIRMED (PoC).**
`poc2-anchor-day-bounds.test.js`.

`_anchor` (lines 462–474) trusts the `day` in the payload, checking only `20260101 ≤ day ≤ 20991231`
and `phase ∈ {1,2}`, never comparing `day` to `block.timestamp`. Consequences, all proven:

- **Future-day pre-emption.** Anchoring a placeholder root for tomorrow (or `20991231`) today burns
  that write-once slot; the real pre-open anchor for that day then reverts `AlreadyAnchored`
  **forever**: no one, not even the Safe, can clear it.
- **Back-dating.** A past day never anchored can be anchored now, *after* its outcome is known, and
  the repo verifier (`src/verify.js` / `verifyLedger`) reports every page verified; only the raw
  `anchoredAt` timestamp reveals it was written late. The whole point of phase 1 ("proves the page
  existed before the outcome") rests on that timestamp, so consumers must check it, not just `ok`.
- **Impossible dates** (`20261399`, `20260230`) are accepted.
- Because a registered relayer may anchor **any** `tokenId` (the caller is not tied to the agent), a
  compromised fleet relayer can grief the record slots of every armed agent, and a seller can
  pre-empt a buyer's future days before selling.

**Minimal fix.** Derive/bound `day` from `block.timestamp` (e.g. require it to equal the current or
previous UTC day) and reject impossible calendar dates.

## Finding 10: Budget charged at approval is never released, so an unsettled approval permanently consumes it (LOW)

**Severity:** LOW. **Status: CONFIRMED (PoC).** `poc2-stops-and-budget.test.js` → "FINDING C";
over-count also shown in `poc2-payment-digest.test.js`.

`_approvePayment` debits the budget when it records the approval, but nothing credits it back if the
payment is never settled (the seller stalls, the authorization expires, or the same nonce/value is
approved twice: each debit stands, only one can settle). So a stalled or malicious counterparty, or
a relayer approving to a dead payee, can exhaust an agent's period budget for buys and payments alike
without any $U actually moving. Never a fund loss; an availability/accounting gap.

**Minimal fix.** Add an owner/relayer `cancelApproval(digest)` that clears the entry and refunds the
period budget; or track outstanding approvals and release them on expiry. (The contract cannot see
$U settlement, so charge-at-settlement is not available without a callback.)

## What was checked and found fine

- **Digest correctness (proven with real settlements).** `PAYMENT_DOMAIN_SEPARATOR` equals
  `$U.DOMAIN_SEPARATOR()` and the independent ethers domain hash; the typehash string matches $U's
  constant; `abi.encode` field order/types (`from=wallet, to, value, validAfter, validBefore, nonce`)
  are exact. Real `$U.transferWithAuthorization` settlements succeed through **both** $U entry points
  (bytes and v/r/s), for value `1 wei` and exactly `MAX_PAYMENT`, payee numerically below and above
  the wallet, `validAfter` in the past and future, `validBefore` at the exact window edge, and nonces
  `0x00…` and `0xff…`; each moves exactly `value` to exactly `to` and burns the nonce.
- **No cross-message approval.** An ERC-4337 user operation that would drain the wallet, signed with
  the nested "this contract" signature, fails at the **real EntryPoint v0.6** (`FailedOp(0, "AA24
  signature error")`) and returns `SIG_VALIDATION_FAILED` from `validateUserOp`, even when the
  `userOpHash` passed in *is* an approved digest, because `AccountV3` validates over the EIP-191 wrap.
  Permit2 `permitTransferFrom` with the nested signature reverts `InvalidContractSignature`; $U
  `permit` is ECDSA-only (a contract signature can never permit); an EIP-191 `personal_sign` wrap of
  an approved digest and a raw `keccak256(digest)` are both rejected; `receiveWithAuthorization` over
  the same fields uses a different typehash and is refused. Each has a positive control (the owner's
  own signature goes through the same path and works), so the refusals are real.
- **Approvals are per wallet.** `approvedPayment` is keyed by the wallet; a second armed agent's
  wallet returns not-approved for the first's digest and $U refuses it; nesting the check through a
  different wallet is refused; recursive self-nesting (`signer == the wallet`) reaches the same single
  answer and no wider (`keccak256(digest)` still refused). A non-wallet caller of `isValidSignature`
  gets `0xffffffff`.
- **Another EIP-3009 token cannot ride the approval.** The digest binds $U's domain separator
  (`verifyingContract = $U`), so any other token computes a different digest that is not in
  `approvedPayment`.
- **Budget cannot be exceeded or reset by payments.** Payments and buys share `_consumeBudget`; the
  cap holds across both, duplicate/again approvals only over-count (never exceed), and once the cap is
  reached both further payments and buys revert `BudgetExceeded`. The period-roll logic is unchanged
  from the first review.
- **Anchoring integrity.** Write-once per `(tokenId, day, phase)`: a re-anchor reverts
  `AlreadyAnchored`, `root == 0` and `phase ∉ {1,2}` revert `BadAnchor`, an unarmed agent reverts
  `NotPermitted`, a paused contract reverts `Paused`, and a stranger reverts `NotRelayerOrOwner`. A
  rewritten page fails `verifyAnchored` (existing suite). *INFO:* `verifyAnchored` accepts any tree
  node (including the root with an empty proof) as `leaf`, so an on-chain consumer must hash the page
  itself, which `src/verify.js` does via `leafOf`, rather than trusting a caller-supplied `leaf`.
- **Reentrancy unchanged.** `$U._transfer` has no callback hooks, and settlement happens out of band
  (the facilitator calls $U later; `isValidSignature` is a `view`), so the new actions add no
  re-entry into `handleAction`, which remains `nonReentrant`. `_approvePayment` makes only staticcalls
  (`_armedTba`, `_balanceOf`) and moves no value itself.
- **Gas settlement for the new actions.** `approve_payment` and `anchor_notes` now reimburse the
  relayer through the same `_settleGas`; measured `paid ≤ real outlay` and `units` far under the
  ceiling for both (approve ~147k, anchor ~165k even with a 4,007-char `uri`, which is only emitted,
  never stored), and both fail open (`paid ~ 0`, action still succeeds) when the wallet has no BNB,
  the accepted template trade-off, same as trades.

## Resolution of the focused re-review (2026-09-27)

- **Finding 7, fixed.** `isValidSignature` answers no while `paused`, `circuitBreaker.globalPause()`
  or `circuitBreaker.isContractPaused(this)`, so the Safe's stop also halts approved but unsettled
  payments. Regressions:
  - `poc2-stops-and-budget.test.js`, "FINDING B (fixed)": refused while paused, settles after the
    unpause;
  - the payment test in `stock-agent.fork.test.js`.
- **Finding 8, fixed for a sale.** `approvedPayment[wallet][digest]` now stores the owner who
  approved it, and `isValidSignature` requires the wallet's current `owner()` to match. A sale
  therefore voids the seller's pending approvals, even after the buyer re-arms (regression: the sale
  test in `stock-agent.fork.test.js`). Accepted and documented: the SAME owner revoking and
  re-arming inside the 15-minute window revives that owner's own approval.
- **Finding 9, fixed.** `anchor_notes` takes `(phase, root, uri)`, and the contract files the root
  under the block's UTC day number (`today()`), so no future day can be taken and no past day filled
  (regression: `poc2-anchor-day-bounds.test.js`). Accepted and documented in the header: a registered
  relayer could still fill TODAY's slot with a wrong root.
- **INFO, fixed.** `verifyAnchored` takes the page's hash and derives the leaf the way
  StandardMerkleTree does, so the root or an inner node passed as a page is refused (regressions in
  both suites).
- **Finding 10, accepted.** It affects availability, not funds: an approval lives at most 15 minutes,
  and the budget is a cap, not a balance. Cancelling with a refund would have to read $U's
  `authorizationState` to avoid refunding a payment that already settled, which is added surface for
  little gain.
- **Finding 6, accepted by the project's decision (2026-09-27): payees stay open,** so an agent can pay any
  service. The bound is the agent's budget per period. Since the fixes above,
  the Safe's pause and the owner's revoke also stop approved but unsettled payments, and a sale
  voids them. The contract header states the trade-off. The project also ruled that the budget must
  need no user transaction, which the built-in default already provides.
- Suite after the fixes: 46 passing at block 124365019.

## Limits change (2026-09-27, the project's decision)

50 USD a week was found too low, and the project chose two
built-in weekly limits, both in force with no transaction:

- **Buys:** `DEFAULT_USD_PER_PERIOD`, 10,000 USD a week.
- **Service payments (`approve_payment`):** `DEFAULT_PAYMENT_USD_PER_PERIOD`, 100 USD a week, counted
  separately from buys.
- `setBudget(tokenId, buys, payments, period)` changes both in one call: 0 stops that kind, and
  `type(uint128).max` means no limit. `budgetOf` reads the buy limit and `paymentBudgetOf` the
  payment limit. Sells stay unlimited. A sale drops the seller's limits back to the defaults.

What this does to the findings:

- **Finding 6:** money sent out to open payees is now bounded by the payment limit alone (100 USD a
  week by default), never by the buy limit. This is the "own small sub-budget" half of the review's
  minimal fix; payees stay open.
- **Finding 10:** an approval that never settles can use up only the payment limit, so it can no
  longer block buys.
- **Finding 1 (fixed):** the TWAP guard keeps a moved BNB price within about 1 %, which is about 100
  USD of extra buying room a week at the full limit, and what is bought stays in the wallet.
- **Accepted consequence:** a stolen relayer key can push up to 10,000 USD a week of buys through
  pools it has moved first (the sandwich path in the first review's bottom line), where the old
  default capped that at 50 USD. Sells were never limited, so the position itself was always
  exposed this way. The Safe's pause, the circuit breaker and the owner's revoke stop it.

The tests follow the new API. `poc-bnb-budget-bypass.test.js` sets the review's 50 USD limit with
one `setBudget` call to replay its exact numbers. `poc2-payment-digest.test.js` now proves the two
limits are independent: payments that used up their own limit are refused while buys still pass,
and a zero buy limit stops buys while payments still pass.

## Pre-deploy check (2026-09-28): BSC and bStock specifics

A check of BSC and bStock specifics before the immutable deploy. Findings:

- **Front-running (changed).** `minOut` came only from QuoterV2 inside the trade's own transaction,
  so it moves with a pool someone pushed just before and gives no protection against a front-run.
  `buy_stock` and `sell_stock` now take an optional eighth payload word, a `minOut` the relayer
  prices before sending; the trade needs the higher of it and the in-transaction quote less slippage.
  Seven-word payloads still work. `test/review/poc3-front-run-floor.test.js` proves it on the real
  NVDAB/USDT fee-2500 pool: after a 1,500,000 USDT push, a 20 USDT buy without a floor fills 6.14 %
  short, and the same buy with the floor reverts. The pool is deep (a 100,000 USDT push moved it only
  0.18 %), so small trades are not worth sandwiching; the floor matters for large trades and thin
  pools.
- **BNB price average (no change).** BSC blocks now come every 0.45 s, but a pool writes at most one
  observation per second (whole-second timestamps), so the WBNB/USDT pool's 4,500 observations
  always cover at least 75 minutes; on 2026-09-28 they covered 11.7 hours. `observe([1800, 0])`
  answers. The 30-minute window is safe.
- **Gas price (off-chain, fixed in e1abbf5).** BSC nodes quote 0.05 gwei; ethers v5 would pay a
  1.5 gwei tip, which the agents repay. `src/gas.js` sends every transaction at the quote.
- **BORT compatibility (changed).** A read-only sweep of BORT's frontend, runtime, indexer and Android
  app found no page that crashes on this logic, but two reads it makes on every logic contract:
  - `gasReimbursementEnabled()`: the runtime refuses every action, reads included, unless it answers
    true. Added; it answers true, which is accurate: `_settleGas` repays a
    registered relayer from the agent's wallet.
  - `getMetrics(tokenId)` in BORT's shared ABI: without it the marketplace listing hides its stats.
    Added, with one packed storage slot per agent (actions, trades, last active). Only writes count,
    since anyone may call a read; profit and positions read 0, as in BORT's Trading and CTO logics,
    because BORT formats profit as BNB. `test/bort-compat.fork.test.js` calls both through BORT's
    exact ABI strings. A buy now costs 511k gas, up from 487k.
  - Everything else BORT needs is BORT-side glue: the create dropdown, custody read from the agent
    wallet, a panel that creates the wallet and gives the one permission, runtime action schemas,
    and registering the runtime signer as a relayer if chat should trade.
- **BAP-578 learning module (added, the project's decision).** The contract
  now implements BAP-578's ILearningModule on its own record:
  - Each anchor is a learning update: the anchored root becomes `getLearningRoot(tokenId)` and
    `LearningUpdated` fires.
  - `verifyLearning` checks a page against the latest root. Its claim is the page hash, and the leaf
    is derived as in `verifyAnchored`, so an inner node cannot pass. Older roots still verify through
    `verifyAnchored`.
  - `record_learning` (bytes32 dataHash, uint256 interactionCount) works as on BORT's V7 logics:
    `LearningRecorded`, and the result "Learning recorded", so BORT's learning reporter can use it.
  - `getLearningMetrics` follows the reference MerkleTreeLearning formulas. Velocity is learning
    events per day at the last event, a whole-number division. Confidence is 100 per event plus 1.
    Milestones fire at 10, 100 and 1,000 events.
  - Interactions are the agent's counted actions plus what the runtime reported.
  - `test/bort-compat.fork.test.js` drives all of it through BORT's exact ILearningModule ABI. The
    runtime is 22,091 bytes of the 24,576 limit. Deploy and set-up now measure 5.28M gas, about
    0.00026 BNB at 0.05 gwei.
- **bStock tokens (no contract change; research and on-chain reads 2026-09-28).**
  - All five desk stocks are beacon proxies on one beacon. Its owner is a single EOA, which can
    upgrade all five at once.
  - Every transfer checks a shared PauseManager (per token, and `pauseAllTokens`) and a shared
    Compliance module. That module has per-token blocklists plus a global sanctions list, and checks
    msg.sender, from and to.
  - Dividends are ERC-8056 `uiMultiplier` changes, not rebases.
  - A pause or a block therefore stops swaps. PancakeSwap reports it as a failed transfer, not by
    name.
  - Handled off-chain: the relayer checks `isTokenPaused`, `allTokensPaused`, `blockedAddresses`
    and `sanctionedAddresses` before sending, and watches the beacon's implementation for changes.
  - Liquidity sits in PancakeSwap V3 in a different fee tier per pair. MUB/WBNB has no liquidity,
    so the relayer picks tiers per pair and routes MUB through USDT. The contract already takes
    tier and bridge per trade.
  - The desk states in its README that "immutable" covers this contract, not the tokens.

## Project decisions (2026-09-28): positions and $U

- **Scope stays stock-only.** Memecoin trading stays out: a one-permission
  contract is safe because its token list is curated. Any existing BORT agent can trade stocks too by
  giving this contract its one permission. The owner may act directly; BORT's runtime signer relays.
- **Positions (added).** Every trade updates the agent's position in that stock: units bought here,
  their USD cost, when it opened, and stop-loss and take-profit targets set by `set_targets`. It
  also updates lifetime totals: realized profit in USD, and volume bought and sold. The reads are
  `positionOf`, `openPositions` and `tradingBook`. BORT's `getMetrics` now reports the open count,
  and the realized profit converted to BNB, since BORT labels that field in BNB.
  - A sell realizes profit only on units bought here. Stock that reached the wallet directly counts
    as volume only.
  - The targets are data for BORT's triggers and travel with the agent. The contract never acts on
    them, because a trigger anyone could fire would let a caller push the pool first.
  - The book moves no value. A first buy of a stock now costs 649k gas, and a sell 432k.
- **$U as a third side (added).** The payload word that was `bool payWithBnb` / `bool receiveBnb`
  reads as 0 = USDT, 1 = BNB, 2 = $U, so old payloads still work.
  - No bStock has a $U pool (on chain, 2026-09-28: the 80 bStocks pair with USDT, $16.6M across
    37 of them, and a few with WBNB). $U therefore routes through the deep $U/USDT fee-100 pool.
  - A $U buy counts dollar for dollar against the buy limit. Selling into $U lets the agent pay for
    services from its trading.
- **Size.** The runtime code is 24,390 of 24,576 bytes. Getting there took three changes:
  - the optimizer runs lowered from 200 to 50, which costs well under 1 % gas per call;
  - the `get_quote` read action dropped, since callers quote through QuoterV2 directly;
  - the reference module's "Monthly Update" milestone dropped (the 10, 100 and 1,000 milestones
    stay).
- Tests: `test/positions-and-u.fork.test.js`. 76 passing at block 124365019. Deploy and set-up now
  measure 5.78M gas, about 0.00029 BNB at 0.05 gwei.

## Review 3 (2026-09-28): the code added since review 2

A focused adversarial review of `git diff 1195541..168eb2d -- contracts/`, run on the fork, found one
MEDIUM and two LOW. All three are fixed, and the PoCs are now regressions in `test/review/poc4-*.test.js`.

- **Finding 1 (MEDIUM), fixed: callers chose the pools.** Fee tiers and the bridge were payload
  words, and PancakeSwap V3 pools are permissionless.
  - The owner faked 429.63 USD of realized profit for 2.50 USD of fees. They created NVDAB/$U fee
    10000, bought cheaply there, and sold on the real pool.
  - The same freedom let a stolen relayer key route an agent's trades through a pool the thief owns.
  - Fix: `setStock(stock, fee, buyable)` pins each stock's USDT pool. BNB and $U trades cross only
    the fee-100 WBNB/USDT and $U/USDT pools. The payload's bridge and fee words are still accepted but
    ignored.
  - Regression: the same attempt buys at the real price and books only the round trip's fees.
- **Finding 2 (LOW), fixed: partial fills.** A pool that ran dry stopped the swap at the router's
  price limit, and QuoterV2 quoted the same partial fill. The cases shown:
  - a sell closed a position that was still 99.94 % in the wallet;
  - a BNB buy left 0.0927 BNB in the router for a stranger's `refundETH()`;
  - a $U sell left the USDT of a dry second hop for anyone's `sweepToken()`.

  Fix: `_minOut` refuses a quote whose hop ends at the price limit (`PoolExhausted`). With pinned
  pools, callers cannot pick a thin pool, and a thin pool the Safe lists is refused before anything
  moves. An empty listed pool fails the same way on a real node, or runs out of gas walking the tick
  bitmap; either way nothing moves.
- **Finding 3 (LOW), fixed at deploy: gas repayment ran slightly over cost.** Settlement is measured
  before EIP-3529 refunds, and closing a position or bridging earns them. At the 10 gwei cap, a
  stolen key made +0.00328 BNB over five $U round trips.
  - Fix: the deploy kit lowers `maxGasPriceWei` to 1 gwei before the handover. It is one-way; BSC
    quotes 0.05 gwei.
  - Regression: at 10 gwei the relayer loses 0.069 BNB over the same round trips. At 1 gwei its
    margin is under a tenth of what the agent repays. Closing and bridged trades are repaid 1.02 to
    1.09 times their cost.
- **INFO, acted on.**
  - The admission gate is raised from 800,000 to 1,000,000 units; bridged first buys measured up to
    932k.
  - Exit targets now count only for the owner who set them, so a seller cannot leave hair-trigger
    levels for the buyer.
  - A delisted stock keeps its pool (`buyable` false), so its positions can still close.
  - `setStock` refuses $U as a stock.
- **INFO, accepted.** Metrics are self-reported by whoever can write, such as dust buys and
  `record_learning` counts. A buyer should read them as activity, not as evidence.
- **Size.** 24,452 of 24,576 bytes. Space came from four places:
  - eleven constants no caller reads made private;
  - the unused `budgets` getter;
  - `positionOf`'s `held` field (read the token balance directly);
  - the ignored route words, which are no longer decoded.
- 85 passing at block 124365019.

## Review 4 (2026-09-28): the review 3 fix commit

A re-review of `cab2d5e` on the fork found two LOW issues. Both are fixed, and both PoCs are now
regressions (`test/review/poc5-*.test.js`). Nothing lets a caller reach an unlisted pool, and payload
slicing fails closed at every boundary length.

- **Finding 1 (LOW, borderline MEDIUM), fixed: a BNB-side sale booked a router windfall as profit.**
  - Cause: a sale into BNB measured the wallet's balance change across `unwrapWETH9`, which pays out
    the router's whole WBNB.
  - Exploit: an owner put 50 WBNB in the router and sold a 20 USD position in the same transaction.
    The book showed +38,724 USD realized, and the owner took the BNB back out of its own wallet.
  - Fix: a sale now books the in-transaction quote, which is this exact swap in this exact state,
    taken before it runs. The measured amount still guards `minOut` and is still emitted.
  - The same fix keeps anything else that changes the wallet's balance mid-sale out of the book.
- **Finding 2 (LOW), fixed: `positionOf` reverted for a never-minted id.** It read `ownerOf`, which
  reverts. It now reads the owner through `_tryWord`, as `canTrade` does, and that also freed 58 bytes.
- Size 24,422 of 24,576 bytes. 96 passing at block 124365019. That includes `test/runner.fork.test.js`,
  a full runner day on the fork: the Analyst's scripted buy and open anchor, the Trader paying for a
  note over x402 wallet to wallet and verifying it on chain, the close anchor, and an idempotent rerun.
