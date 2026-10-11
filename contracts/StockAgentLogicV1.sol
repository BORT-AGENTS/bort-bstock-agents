// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

interface IBAP578Owner {
    function ownerOf(uint256 tokenId) external view returns (address);
}

interface IVaultTba {
    /// @notice The agent's canonical ERC-6551 account (the same source BORT's guards read).
    function tbaFor(uint256 tokenId) external view returns (address);
}

interface IERC6551Account {
    function execute(address to, uint256 value, bytes calldata data, uint8 operation)
        external
        payable
        returns (bytes memory);

    /// @dev Tokenbound AccountV3 keys consent on (owner, caller), so a sale leaves it behind.
    function permissions(address owner, address caller) external view returns (bool);
}

interface ICircuitBreaker {
    function globalPause() external view returns (bool);
    function isContractPaused(address target) external view returns (bool);
}

interface IERC20Min {
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

/// @dev PancakeSwap V3 SwapRouter (Uniswap V3 SwapRouter shape, deadline inside the struct).
interface IPancakeV3Router {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
    function unwrapWETH9(uint256 amountMinimum, address recipient) external payable;
    function multicall(bytes[] calldata data) external payable returns (bytes[] memory results);
    function WETH9() external view returns (address);
}

interface IQuoterV2 {
    function quoteExactInput(bytes memory path, uint256 amountIn)
        external
        returns (
            uint256 amountOut,
            uint160[] memory sqrtPriceX96AfterList,
            uint32[] memory initializedTicksCrossedList,
            uint256 gasEstimate
        );
}

interface IV3PoolTokens {
    function token0() external view returns (address);
    function token1() external view returns (address);
}

/// @dev The EIP-712 domain of an EIP-3009 token ($U on BSC exposes DOMAIN_SEPARATOR, not eip712Domain).
interface IEIP3009Domain {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/// @dev PancakeSwap V3 pool reads. Its slot0 differs from Uniswap's: feeProtocol is uint32.
interface IPancakeV3PoolOracle {
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint32 feeProtocol,
            bool unlocked
        );

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
}

/**
 * @title StockAgentLogicV1
 * @notice Lets a BAP-578 agent buy and sell tokenized stocks (bStocks) from its own ERC-6551
 *         wallet, paying with USDT, BNB or $U, through PancakeSwap V3. This one contract is the
 *         agent's logic, the keeper of its limits, positions and record, and the payer of its gas,
 *         so an owner arms it with a single permission instead of a set of guards and grants.
 *
 *         OWNER SETUP. `TBA.setPermissions([this], [true])` is the whole consent. It arms two built-in
 *         weekly limits: buys up to DEFAULT_USD_PER_PERIOD (10,000 USD) and service payments up to
 *         DEFAULT_PAYMENT_USD_PER_PERIOD (100 USD). One `setBudget` call raises, lowers or removes
 *         both (owner decision, 2026-09-27); revoking the permission stops everything. The account
 *         keys the permission to its current owner, so selling the agent disarms it until the new
 *         owner permits it again. The agent's `logicAddress` does not have to point here: any
 *         BAP-578 agent whose owner permits this contract can trade stocks.
 *
 *         WHAT THIS CONTRACT CAN MAKE A WALLET DO, AND NOTHING ELSE:
 *           1. approve the router for exactly the amount being swapped;
 *           2. swap through the router along the stock's one listed route: its USDT pool, whose fee
 *              tier the Safe sets, plus the fee-100 WBNB/USDT or $U/USDT pool for a BNB or $U side,
 *              the output going back to the same wallet;
 *           3. pay the relayer that called it for the gas the call burned, at a capped price;
 *           4. vouch (ERC-1271) for one $U payment it approved, see PAYING FOR SERVICES.
 *         The router, the quote assets and the bridge pools are fixed at deployment; the stock list
 *         and each stock's pool are kept by the Safe. No caller chooses a pool, so no one can route
 *         an agent through a pool of their own (review 3, finding 1), and a trade whose quote shows a
 *         pool running dry is refused, so no input is left in the router (finding 2). Apart from the
 *         payee of an approved payment, no parameter names an address that can receive value.
 *
 *         PAYING FOR SERVICES (x402). An agent's wallet cannot sign by itself, and a signing key
 *         permitted on it would also be able to spend from it. Instead `approve_payment` has this
 *         contract compute the exact EIP-3009 `TransferWithAuthorization` digest for one $U
 *         payment from the agent's wallet (at most MAX_PAYMENT, expiring within MAX_PAYMENT_WINDOW,
 *         counted against the agent's own payment limit), and records it. When the
 *         seller settles, $U asks the wallet (ERC-1271), the wallet asks this contract (a
 *         permitted signer, nested signature), and `isValidSignature` says yes only for a digest it
 *         computed for that same wallet. Because every approved digest is built here from payment
 *         fields, it can never match an ERC-4337 operation hash or any other message. Payees are
 *         open by design (owner decision, 2026-09-27): agents may pay any seller. Because payments
 *         leave the wallet, they have their own small limit, separate from the buy limit: a stolen
 *         relayer key could pay at most the agent's remaining payment limit (100 USD a week by
 *         default) to an address of its choosing. The Safe's pause stops that at once, including
 *         payments already approved but not yet settled, and an approval dies if the agent is sold.
 *
 *         POSITIONS. Every trade here updates the agent's position in that stock (units bought here,
 *         their USD cost, when it opened) and its lifetime totals (realized profit, volume), readable
 *         through positionOf, openPositions, tradingBook and BORT's getMetrics. `set_targets` stores
 *         stop-loss and take-profit levels for BORT's triggers; they travel with the agent when it is
 *         sold, and this contract never acts on them itself.
 *
 *         THE OWNER SIGNS ALMOST NOTHING. Arming is one permission, both limits work without any
 *         transaction, and every trade, payment approval and anchor is sent by the relayer, whose gas
 *         the agent's own wallet repays.
 *
 *         THE AGENT'S RECORD. `anchor_notes` stores a Merkle root of the agent's desk pages for the
 *         current UTC day (taken from the block, not the caller), once per phase (1 = before the US
 *         open: notes and session facts; 2 = after the close: outcomes). The first root written for
 *         a day and phase is final, so the record cannot be rewritten after the market has moved,
 *         and `verifyAnchored` lets anyone check a page against it on chain. Anchoring moves no value
 *         except the gas repayment. A registered relayer is trusted to anchor honestly: it could
 *         fill today's slot for an armed agent with a wrong root, and that slot is then final.
 *
 *         WHAT BOUNDS VALUE, STATED PLAINLY. `minOut` comes from PancakeSwap's QuoterV2 in the same
 *         transaction, so it guards against a broken route or a pool that pays short, not against a
 *         caller who moves the pool first. Against a stolen relayer key the bound is: buys cannot
 *         exceed the agent's buy limit per period, everything bought or sold stays in the agent's
 *         wallet, and service payments cannot exceed the payment limit. A stolen key could still
 *         push up to the buy limit through a listed pool it has moved first, which on a deep pool
 *         costs it more than it gains. A USDT buy counts its USDT.
 *         A BNB buy counts its BNB at the WBNB/USDT pool price, and is refused while that price
 *         sits more than MAX_BNB_TICK_DEVIATION ticks (about 1 %) from its BNB_TWAP_WINDOW average,
 *         so moving that pool first cannot make BNB look cheaper and stretch the buy limit (review
 *         finding 1, 2026-09-27). Sells do not use the buy limit, so an exit is never blocked by
 *         it; the cost is that a stolen key could sell a position into a pool it has moved. The
 *         Safe can pause the contract or drop the relayer, and the owner can revoke the permission.
 */
contract StockAgentLogicV1 is Ownable2Step, ReentrancyGuard {
    string public constant name = "StockAgentLogicV1";
    string public constant version = "1.0.0";

    // ── Built-in limits. Permitting this contract means agreeing to these; none is settable. ──
    /// @notice Buy limit per period when the owner has not set one: 10,000 USD (18 decimals).
    uint256 public constant DEFAULT_USD_PER_PERIOD = 10_000e18;
    /// @notice Service-payment (x402) limit per period when the owner has not set one: 100 USD.
    ///         Separate from the buy limit because payments leave the wallet.
    uint256 public constant DEFAULT_PAYMENT_USD_PER_PERIOD = 100e18;
    uint256 public constant DEFAULT_PERIOD = 7 days;
    uint256 private constant MAX_PERIOD = 365 days;
    uint256 private constant DEFAULT_SLIPPAGE_BPS = 100; // 1 %
    uint256 private constant MAX_SLIPPAGE_BPS = 500; // 5 %
    uint256 private constant BPS = 10_000;
    /// @notice BNB buys are refused while the WBNB/USDT price is more than this many ticks (100 ticks
    ///         is about 1 %) away from its average over BNB_TWAP_WINDOW. The pool keeps 4,500
    ///         observations (checked 2026-09-27); normal drift was 2 to 12 ticks.
    uint32 private constant BNB_TWAP_WINDOW = 1800;
    int24 public constant MAX_BNB_TICK_DEVIATION = 100;

    // ── Gas settlement, same shape as BORT's AgentGasRelay: the agent pays for its own trades. ──
    uint256 private constant GAS_UNITS_CEILING = 2_000_000;
    uint256 private constant FIXED_OVERHEAD_GAS = 20_000;
    uint256 private constant ABS_MAX_GAS_PRICE = 10 gwei;
    /// @notice Gas a trade is assumed to cost when checking that the wallet can pay for it.
    ///         Admission only; never used to bill.
    uint256 private constant GATE_GAS_UNITS = 1_000_000;
    uint256 private constant GATE_GAS_PRICE = 1 gwei;
    /// @notice Ratchet-down-only cap on the gas price an agent can be billed at.
    uint256 public maxGasPriceWei = ABS_MAX_GAS_PRICE;

    // ── Wiring, fixed at deployment. ──
    IBAP578Owner public immutable bap578;
    IVaultTba public immutable vaultManager;
    ICircuitBreaker public immutable circuitBreaker;
    address public immutable ROUTER;
    IQuoterV2 public immutable QUOTER;
    address public immutable WBNB;
    address public immutable USDT;
    /// @notice PancakeSwap V3 WBNB/USDT pool used to count BNB spends against the buy limit.
    address public immutable BNB_USD_POOL;
    bool private immutable USDT_IS_TOKEN0;
    /// @notice The EIP-3009 stablecoin agents pay services with ($U, 18 decimals, 1 USD).
    address public immutable PAYMENT_TOKEN;
    bytes32 public immutable PAYMENT_DOMAIN_SEPARATOR;
    bytes32 private constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    /// @notice Largest single service payment, and how far ahead its authorization may expire.
    uint256 public constant MAX_PAYMENT = 5e18;
    uint256 public constant MAX_PAYMENT_WINDOW = 15 minutes;

    // ── Governance (owner = BORT's 2-of-3 Safe). It can refuse or pause, never spend. ──
    mapping(address => bool) public registeredRelayer;
    /// @notice Stocks the agents may buy. A delisted stock keeps its pool, so positions can still close.
    mapping(address => bool) public allowedStock;
    /// @notice The fee tier of each listed stock's USDT pool: the only pool its trades use (0 = not
    ///         listed). BNB and $U trades bridge through the fee-100 WBNB/USDT and $U/USDT pools.
    mapping(address => uint24) public stockPoolFee;
    bool public paused;

    // ── Per-agent limits: buys and service payments, counted separately over the same period. ──
    struct Budget {
        uint128 usdPerPeriod; // owner-set buy limit, used only while `setBy` still owns the agent
        uint64 periodLength; // owner-set period
        address setBy; // the owner who set the limits; after a sale the defaults apply again
        uint64 periodStart;
        uint128 spentThisPeriod; // buys; stays with the agent across a sale, like its other counters
        uint128 paymentUsdPerPeriod; // owner-set payment limit (with the buy limit, same setter)
        uint128 paymentSpentThisPeriod; // service payments this period
    }
    mapping(uint256 => Budget) private budgets;

    /// @dev One decoded trade. `side` is what a buy pays with or a sell receives: SIDE_USDT, SIDE_BNB
    ///      or SIDE_U ($U). `minOutFloor` is the optional eighth payload word: the least output the
    ///      caller will accept, priced before it sent the transaction (0 when absent).
    struct Trade {
        address stock;
        uint256 amountIn;
        uint8 side;
        uint256 slippageBps;
        uint256 minOutFloor;
    }
    /// @dev The fee tier of the WBNB/USDT and $U/USDT pools that BNB and $U trades bridge through.
    uint24 private constant BRIDGE_FEE = 100;
    /// @dev The router's price limits (TickMath MIN_SQRT_RATIO + 1 and MAX_SQRT_RATIO - 1): a swap that
    ///      ends there ran a pool out of liquidity and left part of its input unspent.
    uint160 private constant PRICE_FLOOR = 4295128740;
    uint160 private constant PRICE_CEILING = 1461446703485210103287273052203988822378723970341;
    /// @dev The payload word that was `bool payWithBnb` / `bool receiveBnb` now reads as a side, so a
    ///      payload that says false or true still means USDT or BNB.
    uint8 private constant SIDE_USDT = 0;
    uint8 private constant SIDE_BNB = 1;
    uint8 private constant SIDE_U = 2;

    /// @dev One open position per agent and stock: what was bought through this contract and not yet
    ///      sold here, what it cost in USD, and exit targets for BORT's triggers. The targets count only
    ///      for the owner who set them (`targetsBy`, the low 96 bits of that owner's address), so a
    ///      seller cannot leave hair-trigger levels for the buyer. This contract never acts on them,
    ///      because a trigger anyone could fire would let a caller push the pool first.
    struct Position {
        uint128 units;
        uint128 costUsd;
        uint64 openedAt;
        uint32 stopLossBps;
        uint32 takeProfitBps;
        uint96 targetsBy;
    }
    mapping(uint256 => mapping(address => Position)) private _positions;
    mapping(uint256 => address[]) private _openStocks;
    mapping(uint256 => mapping(address => uint256)) private _openIndex; // position in _openStocks, plus one

    /// @dev Lifetime trading totals per agent, in USD (18 decimals). Realized profit counts only units
    ///      bought here; BNB legs are valued at the pool price of their trade.
    struct Book {
        int128 realizedUsd;
        uint128 boughtUsd;
        uint128 soldUsd;
    }
    mapping(uint256 => Book) private _book;
    uint256 private constant MAX_STOP_LOSS_BPS = 9_999;
    uint256 private constant MAX_TAKE_PROFIT_BPS = 1_000_000;

    /// @notice One anchored root of an agent's desk pages. Written once, never replaced.
    struct Anchor {
        bytes32 root;
        uint64 anchoredAt;
    }
    /// @dev tokenId => UTC day number (days since 1970-01-01, see today()) => phase (1 = before the
    ///      open, 2 = after the close).
    mapping(uint256 => mapping(uint32 => mapping(uint8 => Anchor))) public anchors;

    /// @notice wallet => EIP-3009 digest => the agent owner who approved it (zero if none). An
    ///         approval counts only while that owner still owns the agent, so a sale voids it.
    mapping(address => mapping(bytes32 => address)) public approvedPayment;

    /// @dev Per-agent activity for BORT's shared getMetrics ABI, one storage slot per agent. Only
    ///      writes count (anyone may call a read), and an action that fails reverts, so every counted
    ///      action succeeded.
    struct Activity {
        uint64 actions;
        uint64 trades;
        uint64 lastActive;
    }
    mapping(uint256 => Activity) private _activity;

    /// @dev BAP-578 learning state per agent (ILearningModule). The latest anchored desk root is the
    ///      agent's learning root; anchors and recorded learning batches are its learning events.
    struct Learning {
        bytes32 root;
        uint64 events;
        uint64 interactions; // reported through record_learning
        uint64 lastUpdate;
        uint64 velocity; // learning events per day at the last event (BAP-578 reference formula)
    }
    mapping(uint256 => Learning) private _learning;

    /// @notice BAP-578 ILearningModule.LearningMetrics.
    struct LearningMetrics {
        uint256 totalInteractions;
        uint256 learningEvents;
        uint256 lastUpdateTimestamp;
        uint256 learningVelocity;
        uint256 confidenceScore;
    }

    bytes32 private constant BUY = keccak256("buy_stock");
    bytes32 private constant SELL = keccak256("sell_stock");
    bytes32 private constant CHECK = keccak256("check_balance");
    bytes32 private constant ANCHOR = keccak256("anchor_notes");
    bytes32 private constant PAY = keccak256("approve_payment");
    bytes32 private constant LEARN = keccak256("record_learning");
    bytes32 private constant TARGETS = keccak256("set_targets");

    event RelayerSet(address indexed relayer, bool allowed);
    event StockSet(address indexed stock, uint24 fee, bool buyable);
    event PausedSet(bool paused);
    event MaxGasPriceLowered(uint256 previous, uint256 current);
    event BudgetSet(
        uint256 indexed tokenId, address indexed owner, uint256 usdPerPeriod, uint256 paymentUsdPerPeriod, uint256 periodLength
    );
    event ActionHandled(uint256 indexed tokenId, string action, bool success, bytes result);
    /// @notice One stock trade. `usdValue` is what the trade counted as, in USD with 18 decimals.
    event StockSwapExecuted(
        uint256 indexed tokenId,
        bool indexed isBuy,
        address indexed stock,
        address quote,
        uint256 amountIn,
        uint256 amountOut,
        uint256 usdValue,
        address tba
    );
    event GasSettled(
        uint256 indexed tokenId,
        address indexed relayer,
        address tba,
        uint256 gasUnits,
        uint256 owed,
        uint256 paid,
        bool settlementFailed
    );
    /// @notice A day's desk pages were anchored. `uri` says where the pages can be read.
    event NotesAnchored(uint256 indexed tokenId, uint32 indexed day, uint8 indexed phase, bytes32 root, string uri);
    /// @notice One $U payment from the agent's wallet was approved and counted against its payment limit.
    event PaymentApproved(
        uint256 indexed tokenId, address indexed to, uint256 value, uint256 validBefore, bytes32 nonce, bytes32 digest
    );
    /// @notice BAP-578 learning events, as ILearningModule declares them: every anchor updates the
    ///         agent's learning root.
    event LearningUpdated(uint256 indexed tokenId, bytes32 previousRoot, bytes32 newRoot, uint256 timestamp);
    event LearningMilestone(uint256 indexed tokenId, string milestone, uint256 value, uint256 timestamp);
    /// @notice A batch of learning reported by the runtime (record_learning), as BORT's V5 to V7 logics emit it.
    event LearningRecorded(uint256 indexed tokenId, bytes32 dataHash, uint256 interactionCount, uint256 timestamp);
    /// @notice A position changed after a trade: what is left and its cost, and the profit this trade
    ///         realized in USD (0 for a buy).
    event PositionUpdated(uint256 indexed tokenId, address indexed stock, uint256 units, uint256 costUsd, int256 realizedUsd);
    event PositionTargetsSet(uint256 indexed tokenId, address indexed stock, uint256 stopLossBps, uint256 takeProfitBps);

    error ZeroAddress();
    error NotRelayerOrOwner();
    error NotAgentOwner();
    error Paused();
    error NoTba();
    error NotPermitted();
    error StockNotAllowed(address token);
    error BadFee(uint24 fee);
    error ZeroAmount();
    error SlippageTooHigh(uint256 slippageBps);
    error BudgetExceeded(uint256 left, uint256 requested);
    error InsufficientTreasury(uint256 balance, uint256 required);
    error InsufficientPosition(uint256 held, uint256 requested);
    error OutputBelowMin(uint256 received, uint256 minOut);
    error ApproveFailed();
    error BadBudgetParams();
    error NotARatchet();
    error UnknownAction();
    error BadWiring();
    error BnbPriceUnsettled(int24 spotTick, int24 averageTick);
    error BadAnchor();
    error AlreadyAnchored(uint256 tokenId, uint32 day, uint8 phase);
    error BadPayment();
    error BadLearning();
    error BadSide(uint8 side);
    error NoPosition(address stock);
    error BadTargets();
    error RenounceDisabled();
    error PoolExhausted();

    constructor(
        address bap578_,
        address vaultManager_,
        address circuitBreaker_,
        address router_,
        address quoter_,
        address wbnb_,
        address usdt_,
        address bnbUsdPool_,
        address paymentToken_
    ) {
        if (
            bap578_ == address(0) || vaultManager_ == address(0) || circuitBreaker_ == address(0)
                || router_ == address(0) || quoter_ == address(0) || wbnb_ == address(0) || usdt_ == address(0)
                || bnbUsdPool_ == address(0) || paymentToken_ == address(0)
        ) revert ZeroAddress();
        if (IPancakeV3Router(router_).WETH9() != wbnb_) revert BadWiring();
        address t0 = IV3PoolTokens(bnbUsdPool_).token0();
        address t1 = IV3PoolTokens(bnbUsdPool_).token1();
        if (!((t0 == usdt_ && t1 == wbnb_) || (t0 == wbnb_ && t1 == usdt_))) revert BadWiring();

        bap578 = IBAP578Owner(bap578_);
        vaultManager = IVaultTba(vaultManager_);
        circuitBreaker = ICircuitBreaker(circuitBreaker_);
        ROUTER = router_;
        QUOTER = IQuoterV2(quoter_);
        WBNB = wbnb_;
        USDT = usdt_;
        BNB_USD_POOL = bnbUsdPool_;
        USDT_IS_TOKEN0 = t0 == usdt_;
        PAYMENT_TOKEN = paymentToken_;
        PAYMENT_DOMAIN_SEPARATOR = IEIP3009Domain(paymentToken_).DOMAIN_SEPARATOR();
    }

    // ── Governance ──

    /// @notice Disabled, as in every BORT guard: on an immutable contract it would permanently
    ///         remove the only fleet-wide stop.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    function setRelayer(address relayer, bool allowed) external onlyOwner {
        if (relayer == address(0)) revert ZeroAddress();
        registeredRelayer[relayer] = allowed;
        emit RelayerSet(relayer, allowed);
    }

    /// @notice List a stock with the fee tier of its USDT pool, the only pool its trades will use, so no
    ///         caller can route an agent through a pool of their own. `buyable` false stops buys but
    ///         keeps sells, so positions can still close; fee 0 removes the stock.
    function setStock(address stock, uint24 fee, bool buyable) external onlyOwner {
        if (
            stock == address(0) || stock.code.length == 0 || stock == USDT || stock == WBNB || stock == PAYMENT_TOKEN
        ) revert StockNotAllowed(stock);
        if (fee == 0 ? buyable : (fee != 100 && fee != 500 && fee != 2500 && fee != 10000)) revert BadFee(fee);
        stockPoolFee[stock] = fee;
        allowedStock[stock] = buyable;
        emit StockSet(stock, fee, buyable);
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    /// @notice Lower the gas price agents can be billed at. There is no way to raise it.
    function lowerMaxGasPrice(uint256 newMax) external onlyOwner {
        if (newMax == 0 || newMax >= maxGasPriceWei) revert NotARatchet();
        emit MaxGasPriceLowered(maxGasPriceWei, newMax);
        maxGasPriceWei = newMax;
    }

    // ── Owner: the one optional setting ──

    /// @notice Set this agent's limits in one call: buys and service payments per period. Zero
    ///         stops that kind; type(uint128).max means no limit. Sells are never limited.
    function setBudget(uint256 tokenId, uint256 usdPerPeriod, uint256 paymentUsdPerPeriod, uint256 periodLength)
        external
    {
        if (bap578.ownerOf(tokenId) != msg.sender) revert NotAgentOwner();
        if (
            periodLength == 0 || periodLength > MAX_PERIOD || usdPerPeriod > type(uint128).max
                || paymentUsdPerPeriod > type(uint128).max
        ) revert BadBudgetParams();
        Budget storage b = budgets[tokenId];
        b.usdPerPeriod = uint128(usdPerPeriod);
        b.paymentUsdPerPeriod = uint128(paymentUsdPerPeriod);
        b.periodLength = uint64(periodLength);
        b.setBy = msg.sender;
        emit BudgetSet(tokenId, msg.sender, usdPerPeriod, paymentUsdPerPeriod, periodLength);
    }

    // ── The entry point BORT's runtime already speaks (same ABI as the V8 logics) ──

    /**
     * @notice Actions:
     *   buy_stock   (address stock, uint8 payWith, uint256 amountIn, address bridge, uint24 fee1, uint24 fee2, uint256 slippageBps)
     *   sell_stock  (address stock, uint256 amountIn, uint8 receiveIn, address bridge, uint24 fee1, uint24 fee2, uint256 slippageBps)
     *               payWith / receiveIn: 0 = USDT, 1 = BNB, 2 = $U (a bool false or true still reads as USDT
     *               or BNB). $U has no stock pools of its own; it routes through the USDT bridge.
     *   set_targets (address stock, uint32 stopLossBps, uint32 takeProfitBps)   exit targets of an open
     *               position, for BORT's triggers; 0 clears one
     *   anchor_notes (uint8 phase, bytes32 root, string uri)   phase 1|2; the day is the block's UTC day
     *   approve_payment (address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce)
     *   record_learning (bytes32 dataHash, uint256 interactionCount)   BAP-578 learning, as BORT's V7 logics
     *   check_balance (address stock)
     *   `bridge` is address(0) for a direct pool (fee1 only, fee2 = 0), or USDT/WBNB for one middle hop
     *   (fee1 = first pool, fee2 = second pool). `slippageBps` 0 means DEFAULT_SLIPPAGE_BPS.
     *   buy_stock and sell_stock take an optional eighth word, `uint256 minOut`: the least output the
     *   caller accepts, priced before sending. The trade then needs the higher of it and the
     *   in-transaction quote less slippage, so a pool pushed just before the trade makes it revert.
     *   Trades and anchors are callable by a Safe-registered relayer or by the agent's owner, for an
     *   armed agent only; reads by anyone.
     */
    function handleAction(uint256 tokenId, string calldata action, bytes calldata payload)
        external
        nonReentrant
        returns (bool success, bytes memory result)
    {
        uint256 gasStart = gasleft();
        bytes32 a = keccak256(bytes(action));
        bool isWrite = a == BUY || a == SELL || a == ANCHOR || a == PAY || a == LEARN || a == TARGETS;
        bool byRelayer = registeredRelayer[msg.sender];

        if (isWrite) {
            if (!byRelayer && msg.sender != bap578.ownerOf(tokenId)) revert NotRelayerOrOwner();
            if (paused || circuitBreaker.globalPause() || circuitBreaker.isContractPaused(address(this))) revert Paused();
            if (a == BUY) result = _buy(tokenId, _decodeBuy(payload));
            else if (a == SELL) result = _sell(tokenId, _decodeSell(payload));
            else if (a == PAY) result = _approvePayment(tokenId, payload);
            else if (a == LEARN) result = _recordLearning(tokenId, payload);
            else if (a == TARGETS) result = _setTargets(tokenId, payload);
            else result = _anchor(tokenId, payload);
        } else if (a == CHECK) {
            result = _checkBalance(tokenId, payload);
        } else {
            revert UnknownAction();
        }

        success = true;
        emit ActionHandled(tokenId, action, true, result);
        if (isWrite) {
            Activity storage act = _activity[tokenId];
            act.actions += 1;
            if (a == BUY || a == SELL) act.trades += 1;
            act.lastActive = uint64(block.timestamp);
        }
        // Only a relayer is reimbursed: an owner acting on their own agent pays their own gas.
        if (isWrite && byRelayer) _settleGas(tokenId, gasStart);
    }

    // ── Paying for services (x402, $U) ──

    function _approvePayment(uint256 tokenId, bytes calldata payload) internal returns (bytes memory) {
        (address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce) =
            abi.decode(payload, (address, uint256, uint256, uint256, bytes32));
        address tba = _armedTba(tokenId);
        if (
            to == address(0) || to == tba || value == 0 || value > MAX_PAYMENT || validAfter >= validBefore
                || validBefore <= block.timestamp || validBefore > block.timestamp + MAX_PAYMENT_WINDOW
        ) revert BadPayment();
        uint256 held = _balanceOf(PAYMENT_TOKEN, tba);
        if (held < value) revert InsufficientTreasury(held, value);
        // $U is a 1 USD stablecoin with 18 decimals, so the value is its USD value. Payments have
        // their own limit, apart from buys, because they leave the wallet.
        _consumePayment(tokenId, value);

        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                PAYMENT_DOMAIN_SEPARATOR,
                keccak256(abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, tba, to, value, validAfter, validBefore, nonce))
            )
        );
        approvedPayment[tba][digest] = bap578.ownerOf(tokenId);
        emit PaymentApproved(tokenId, to, value, validBefore, nonce, digest);
        return abi.encode(digest);
    }

    /**
     * @notice ERC-1271. An agent's wallet asks this when it checks a signature that names this contract
     *         as the signer (AccountV3's nested form: r = this contract, s = 65, v = 0). The answer is
     *         yes only for a digest that approve_payment computed for that same wallet (msg.sender),
     *         only while the owner who approved it still owns the agent (review finding 8), and never
     *         while the contract or the fleet is paused, so the Safe's stop also halts payments that
     *         were approved but not yet settled (review finding 7).
     */
    function isValidSignature(bytes32 hash, bytes calldata) external view returns (bytes4) {
        address approvedBy = approvedPayment[msg.sender][hash];
        if (approvedBy == address(0)) return bytes4(0xffffffff);
        if (paused || circuitBreaker.globalPause() || circuitBreaker.isContractPaused(address(this))) {
            return bytes4(0xffffffff);
        }
        (bool ok, uint256 ownerWord) = _tryWord(msg.sender, abi.encodeWithSignature("owner()"));
        if (!ok || address(uint160(ownerWord)) != approvedBy) return bytes4(0xffffffff);
        return bytes4(0x1626ba7e);
    }

    // ── The agent's record ──

    /// @dev The day is the block's UTC day number (days since 1970-01-01), never the caller's choice, so
    ///      no one can fill a past day after the fact or take a future day's slot (review finding 9).
    function _anchor(uint256 tokenId, bytes calldata payload) internal returns (bytes memory) {
        (uint8 phase, bytes32 root, string memory uri) = abi.decode(payload, (uint8, bytes32, string));
        if (root == bytes32(0) || (phase != 1 && phase != 2)) revert BadAnchor();
        // Only an agent whose owner armed this contract keeps its record here.
        _armedTba(tokenId);
        uint32 day = today();
        Anchor storage x = anchors[tokenId][day][phase];
        if (x.anchoredAt != 0) revert AlreadyAnchored(tokenId, day, phase);
        x.root = root;
        x.anchoredAt = uint64(block.timestamp);
        emit NotesAnchored(tokenId, day, phase, root, uri);
        _noteLearning(tokenId, root, 0);
        return abi.encode(day, block.timestamp);
    }

    /// @dev record_learning: a batch of the agent's learning, reported by the runtime as it does for
    ///      BORT's V7 logics. Moves no value except the gas repayment.
    function _recordLearning(uint256 tokenId, bytes calldata payload) internal returns (bytes memory) {
        (bytes32 dataHash, uint256 interactionCount) = abi.decode(payload, (bytes32, uint256));
        if (dataHash == bytes32(0) || interactionCount > type(uint32).max) revert BadLearning();
        _armedTba(tokenId);
        _noteLearning(tokenId, bytes32(0), interactionCount);
        emit LearningRecorded(tokenId, dataHash, interactionCount, block.timestamp);
        return abi.encode("Learning recorded");
    }

    /// @dev One BAP-578 learning event: counters, velocity and milestones as in the reference
    ///      MerkleTreeLearning module, plus LearningUpdated when the event brings a new root.
    function _noteLearning(uint256 tokenId, bytes32 newRoot, uint256 interactionCount) internal {
        Learning storage l = _learning[tokenId];
        if (l.lastUpdate != 0 && block.timestamp > l.lastUpdate) l.velocity = uint64(1 days / (block.timestamp - l.lastUpdate));
        l.events += 1;
        l.interactions += uint64(interactionCount);
        l.lastUpdate = uint64(block.timestamp);
        if (newRoot != bytes32(0)) {
            emit LearningUpdated(tokenId, l.root, newRoot, block.timestamp);
            l.root = newRoot;
        }
        if (l.events == 10) emit LearningMilestone(tokenId, "First Decade", 10, block.timestamp);
        else if (l.events == 100) emit LearningMilestone(tokenId, "Century Mark", 100, block.timestamp);
        else if (l.events == 1000) emit LearningMilestone(tokenId, "Millennium", 1000, block.timestamp);
    }

    // ── BAP-578 learning module (ILearningModule): the desk record is the agent's learning tree ──

    /// @notice BAP-578 learning metrics. Interactions are the agent's actions plus what the runtime
    ///         reported; velocity and confidence follow the reference MerkleTreeLearning formulas
    ///         (events per day at the last event; 100 per event plus 1).
    function getLearningMetrics(uint256 tokenId) external view returns (LearningMetrics memory m) {
        Learning storage l = _learning[tokenId];
        m.totalInteractions = uint256(_activity[tokenId].actions) + l.interactions;
        m.learningEvents = l.events;
        m.lastUpdateTimestamp = l.lastUpdate;
        m.learningVelocity = l.velocity;
        m.confidenceScore = l.events == 0 ? 0 : uint256(l.events) * 100 + 1;
    }

    /// @notice The agent's BAP-578 learning root: its latest anchored desk root.
    function getLearningRoot(uint256 tokenId) external view returns (bytes32) {
        return _learning[tokenId].root;
    }

    /// @notice BAP-578 verifyLearning against the latest root. `claim` is a page hash (keccak256 of the
    ///         page's canonical JSON), and the leaf is derived as in verifyAnchored, so an inner node of
    ///         the tree cannot pass as a claim. Older roots: verifyAnchored(day, phase).
    function verifyLearning(uint256 tokenId, bytes32 claim, bytes32[] calldata proof) external view returns (bool) {
        bytes32 root = _learning[tokenId].root;
        if (root == bytes32(0)) return false;
        return MerkleProof.verifyCalldata(proof, root, _pageLeaf(claim));
    }

    /// @dev The leaf OpenZeppelin's StandardMerkleTree builds for a page hash.
    function _pageLeaf(bytes32 pageHash) private pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(pageHash))));
    }

    /// @notice The current UTC day number (days since 1970-01-01): the key `anchor_notes` writes under.
    function today() public view returns (uint32) {
        return uint32(block.timestamp / 1 days);
    }

    /// @notice Check one page of an agent's record against the root anchored for that day and phase.
    /// @param pageHash keccak256 of the page's canonical JSON. The leaf is derived here, exactly as
    ///        OpenZeppelin's StandardMerkleTree builds it, so an inner node of the tree cannot be passed
    ///        off as a page.
    /// @return ok True if the page is in the anchored tree. `anchoredAt` is when the root was written
    ///         (0 if nothing was anchored), which is what proves the page existed before the outcome.
    function verifyAnchored(uint256 tokenId, uint32 day, uint8 phase, bytes32 pageHash, bytes32[] calldata proof)
        external
        view
        returns (bool ok, uint64 anchoredAt)
    {
        Anchor storage x = anchors[tokenId][day][phase];
        anchoredAt = x.anchoredAt;
        ok = anchoredAt != 0 && MerkleProof.verifyCalldata(proof, x.root, _pageLeaf(pageHash));
    }

    // ── Trades ──

    function _decodeBuy(bytes calldata payload) internal pure returns (Trade memory t) {
        (t.stock, t.side, t.amountIn) = abi.decode(payload[:96], (address, uint8, uint256));
        _decodeTail(payload, t);
    }

    function _decodeSell(bytes calldata payload) internal pure returns (Trade memory t) {
        (t.stock, t.amountIn, t.side) = abi.decode(payload[:96], (address, uint256, uint8));
        _decodeTail(payload, t);
    }

    /// @dev Words 3 to 5 (bridge, fee1, fee2) are read by no one: every stock trades through its listed
    ///      pool. Word 6 is the slippage; the optional word 7 is the caller's floor.
    function _decodeTail(bytes calldata payload, Trade memory t) private pure {
        t.slippageBps = abi.decode(payload[192:224], (uint256));
        t.minOutFloor = _floorWord(payload);
    }

    /// @dev The token a side pays with or receives.
    function _quoteOf(uint8 side) internal view returns (address) {
        if (side == SIDE_USDT) return USDT;
        if (side == SIDE_BNB) return WBNB;
        if (side == SIDE_U) return PAYMENT_TOKEN;
        revert BadSide(side);
    }

    /// @dev The optional eighth word of a trade payload; seven-word payloads carry no floor.
    function _floorWord(bytes calldata payload) private pure returns (uint256) {
        return payload.length >= 8 * 32 ? abi.decode(payload[7 * 32:8 * 32], (uint256)) : 0;
    }

    /// @dev The output a trade must reach: the in-transaction quote less slippage, or the caller's
    ///      floor when that is higher. The quote runs inside this transaction, so it moves with a pool
    ///      someone pushed just before; only a floor priced before sending stops a front-run.
    function _requiredOut(bytes memory path, Trade memory t) internal returns (uint256 minOut, uint256 quoted) {
        (minOut, quoted) = _minOut(path, t.amountIn, t.slippageBps);
        if (t.minOutFloor > minOut) minOut = t.minOutFloor;
    }

    function _buy(uint256 tokenId, Trade memory t) internal returns (bytes memory) {
        if (t.amountIn == 0) revert ZeroAmount();
        if (!allowedStock[t.stock]) revert StockNotAllowed(t.stock);
        (bytes memory path, address quote) = _route(t.stock, t.side, true);

        address tba = _armedTba(tokenId);
        bool withBnb = t.side == SIDE_BNB;
        if (withBnb) _requireBnbPriceSettled();
        // USDT and $U are dollar stablecoins with 18 decimals, so they count one to one.
        uint256 usdValue = withBnb ? bnbToUsd(t.amountIn) : t.amountIn;
        _consumeBudget(tokenId, usdValue);
        _requireFunds(tba, quote, t);

        (uint256 minOut,) = _requiredOut(path, t);
        uint256 before = _balanceOf(t.stock, tba);
        if (!withBnb) _approveRouter(tba, quote, t.amountIn);
        // Native BNB goes in as value; the router wraps it because the path starts at WBNB.
        _exactInput(tba, withBnb ? t.amountIn : 0, path, tba, t.amountIn, minOut);

        // Measure: the wallet's own balance is trusted, the router's return value is not.
        uint256 afterBal = _balanceOf(t.stock, tba);
        uint256 received = afterBal > before ? afterBal - before : 0;
        if (received == 0 || received < minOut) revert OutputBelowMin(received, minOut);

        _bookBuy(tokenId, t.stock, received, usdValue);
        emit StockSwapExecuted(tokenId, true, t.stock, quote, t.amountIn, received, usdValue, tba);
        return abi.encode(received);
    }

    function _sell(uint256 tokenId, Trade memory t) internal returns (bytes memory) {
        if (t.amountIn == 0) revert ZeroAmount();
        // A delisted stock that keeps its pool can still be sold, so its positions can close.
        (bytes memory path, address quote) = _route(t.stock, t.side, false);

        address tba = _armedTba(tokenId);
        uint256 held = _balanceOf(t.stock, tba);
        if (held < t.amountIn) revert InsufficientPosition(held, t.amountIn);

        (uint256 minOut, uint256 quoted) = _requiredOut(path, t);
        // The book takes the quote, which is this exact swap in this exact state, not the wallet's
        // balance change: unwrapWETH9 pays out the router's WHOLE WBNB, so WBNB anyone left there
        // would otherwise count as proceeds (review 4). The measured amount still guards minOut.
        uint256 usdValue = t.side == SIDE_BNB ? bnbToUsd(quoted) : quoted;
        _approveRouter(tba, t.stock, t.amountIn);
        uint256 received = t.side == SIDE_BNB
            ? _sellForBnb(tba, path, t.amountIn, minOut)
            : _sellForToken(tba, quote, path, t.amountIn, minOut);
        if (received == 0 || received < minOut) revert OutputBelowMin(received, minOut);

        _bookSell(tokenId, t.stock, t.amountIn, usdValue);
        emit StockSwapExecuted(tokenId, false, t.stock, quote, t.amountIn, received, usdValue, tba);
        return abi.encode(received);
    }

    /// @dev A buy must leave the wallet able to pay for this trade's own gas.
    function _requireFunds(address tba, address quote, Trade memory t) internal view {
        bool withBnb = t.side == SIDE_BNB;
        uint256 needBnb = (withBnb ? t.amountIn : 0) + GATE_GAS_UNITS * GATE_GAS_PRICE;
        if (tba.balance < needBnb) revert InsufficientTreasury(tba.balance, needBnb);
        if (!withBnb) {
            uint256 quoteHeld = _balanceOf(quote, tba);
            if (quoteHeld < t.amountIn) revert InsufficientTreasury(quoteHeld, t.amountIn);
        }
    }

    // ── Positions: what the agent bought here, what it cost, and what it made ──

    function _bookBuy(uint256 tokenId, address stock, uint256 units, uint256 usd) internal {
        Position storage p = _positions[tokenId][stock];
        if (p.units == 0) {
            p.openedAt = uint64(block.timestamp);
            _openStocks[tokenId].push(stock);
            _openIndex[tokenId][stock] = _openStocks[tokenId].length;
        }
        p.units += uint128(units);
        p.costUsd += uint128(usd);
        _book[tokenId].boughtUsd += uint128(usd);
        emit PositionUpdated(tokenId, stock, p.units, p.costUsd, 0);
    }

    /// @dev Realizes profit on the units this contract bought. Units that reached the wallet some other
    ///      way have no known cost, so their share of the proceeds counts as volume only.
    function _bookSell(uint256 tokenId, address stock, uint256 units, uint256 usd) internal {
        Book storage b = _book[tokenId];
        b.soldUsd += uint128(usd);
        Position storage p = _positions[tokenId][stock];
        if (p.units == 0) return;
        uint256 tracked = units < p.units ? units : p.units;
        uint256 cost = (uint256(p.costUsd) * tracked) / p.units;
        int256 realized = int256((usd * tracked) / units) - int256(cost);
        b.realizedUsd += int128(realized);
        p.units -= uint128(tracked);
        p.costUsd -= uint128(cost);
        emit PositionUpdated(tokenId, stock, p.units, p.costUsd, realized);
        if (p.units == 0) _closePosition(tokenId, stock);
    }

    function _closePosition(uint256 tokenId, address stock) internal {
        address[] storage open = _openStocks[tokenId];
        uint256 i = _openIndex[tokenId][stock] - 1;
        address last = open[open.length - 1];
        open[i] = last;
        _openIndex[tokenId][last] = i + 1;
        open.pop();
        delete _openIndex[tokenId][stock];
        delete _positions[tokenId][stock];
    }

    /// @dev set_targets: exit targets for an open position, as the owner or the runtime set them.
    function _setTargets(uint256 tokenId, bytes calldata payload) internal returns (bytes memory) {
        (address stock, uint32 stopLossBps, uint32 takeProfitBps) = abi.decode(payload, (address, uint32, uint32));
        if (stopLossBps > MAX_STOP_LOSS_BPS || takeProfitBps > MAX_TAKE_PROFIT_BPS) revert BadTargets();
        _armedTba(tokenId);
        Position storage p = _positions[tokenId][stock];
        if (p.units == 0) revert NoPosition(stock);
        p.stopLossBps = stopLossBps;
        p.takeProfitBps = takeProfitBps;
        p.targetsBy = uint96(uint160(bap578.ownerOf(tokenId)));
        emit PositionTargetsSet(tokenId, stock, stopLossBps, takeProfitBps);
        return abi.encode(stopLossBps, takeProfitBps);
    }

    function _exactInput(address tba, uint256 value, bytes memory path, address recipient, uint256 amountIn, uint256 minOut)
        internal
    {
        IERC6551Account(tba).execute(
            ROUTER,
            value,
            abi.encodeWithSelector(
                IPancakeV3Router.exactInput.selector,
                IPancakeV3Router.ExactInputParams({
                    path: path,
                    recipient: recipient,
                    deadline: block.timestamp,
                    amountIn: amountIn,
                    amountOutMinimum: minOut
                })
            ),
            0
        );
    }

    /// @dev Swap into WBNB held by the router, then unwrap it to native BNB paid to the wallet.
    function _sellForBnb(address tba, bytes memory path, uint256 amountIn, uint256 minOut)
        internal
        returns (uint256 received)
    {
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeWithSelector(
            IPancakeV3Router.exactInput.selector,
            IPancakeV3Router.ExactInputParams({
                path: path,
                recipient: ROUTER,
                deadline: block.timestamp,
                amountIn: amountIn,
                amountOutMinimum: minOut
            })
        );
        calls[1] = abi.encodeWithSelector(IPancakeV3Router.unwrapWETH9.selector, minOut, tba);
        uint256 before = tba.balance;
        IERC6551Account(tba).execute(ROUTER, 0, abi.encodeWithSelector(IPancakeV3Router.multicall.selector, calls), 0);
        received = tba.balance > before ? tba.balance - before : 0;
    }

    function _sellForToken(address tba, address token, bytes memory path, uint256 amountIn, uint256 minOut)
        internal
        returns (uint256 received)
    {
        uint256 before = _balanceOf(token, tba);
        _exactInput(tba, 0, path, tba, amountIn, minOut);
        uint256 afterBal = _balanceOf(token, tba);
        received = afterBal > before ? afterBal - before : 0;
    }

    // ── Reads ──

    function _checkBalance(uint256 tokenId, bytes calldata payload) internal view returns (bytes memory) {
        address stock = payload.length >= 32 ? abi.decode(payload, (address)) : address(0);
        address tba = vaultManager.tbaFor(tokenId);
        return abi.encode(tba.balance, _balanceOf(USDT, tba), stock == address(0) ? 0 : _balanceOf(stock, tba));
    }

    /// @notice Value of `amountWei` BNB in USD (18 decimals) at the WBNB/USDT pool's current price.
    function bnbToUsd(uint256 amountWei) public view returns (uint256) {
        (uint160 sqrtPriceX96,,,,,,) = IPancakeV3PoolOracle(BNB_USD_POOL).slot0();
        // price of token0 in token1, as a Q128 number: sqrtP^2 / 2^64.
        uint256 priceX128 = Math.mulDiv(sqrtPriceX96, sqrtPriceX96, 1 << 64);
        // Both tokens have 18 decimals on BSC, so no decimal adjustment is needed.
        return USDT_IS_TOKEN0
            ? Math.mulDiv(amountWei, 1 << 128, priceX128) // token1 (WBNB) -> token0 (USDT)
            : Math.mulDiv(amountWei, priceX128, 1 << 128); // token0 (WBNB) -> token1 (USDT)
    }

    /// @notice What this agent may still spend on buys in the current period, and on what terms.
    function budgetOf(uint256 tokenId)
        external
        view
        returns (uint256 usdPerPeriod, uint256 periodLength, uint256 spent, uint256 left, bool custom)
    {
        Budget storage b = budgets[tokenId];
        (usdPerPeriod,, periodLength, custom) = _effectiveBudget(tokenId, b);
        spent = block.timestamp >= uint256(b.periodStart) + periodLength ? 0 : b.spentThisPeriod;
        left = usdPerPeriod > spent ? usdPerPeriod - spent : 0;
    }

    /// @notice What this agent may still pay for services in the current period, and on what terms.
    function paymentBudgetOf(uint256 tokenId)
        external
        view
        returns (uint256 usdPerPeriod, uint256 periodLength, uint256 spent, uint256 left, bool custom)
    {
        Budget storage b = budgets[tokenId];
        (, usdPerPeriod, periodLength, custom) = _effectiveBudget(tokenId, b);
        spent = block.timestamp >= uint256(b.periodStart) + periodLength ? 0 : b.paymentSpentThisPeriod;
        left = usdPerPeriod > spent ? usdPerPeriod - spent : 0;
    }

    // ── BORT compatibility: the reads BORT's dapp and runtime make on every agent's logic ──

    /// @notice BORT's runtime sends actions only to logic contracts that repay its gas. This one does,
    ///         from the agent's own wallet, for a registered relayer (see _settleGas).
    function gasReimbursementEnabled() external pure returns (bool) {
        return true;
    }

    /// @notice BORT's shared metrics ABI (MetricsTracker), read by its listing page and runtime.
    ///         `lifetimePnL` is the realized USD profit converted to BNB at the current pool price,
    ///         because BORT shows that field in BNB (tradingBook has the USD figure);
    ///         `activePositions` counts the stocks with an open position here.
    function getMetrics(uint256 tokenId)
        external
        view
        returns (
            uint256 totalActions,
            uint256 successfulActions,
            uint256 totalTrades,
            int256 lifetimePnL,
            uint256 totalInteractions,
            uint256 lastActive,
            uint256 activePositions
        )
    {
        Activity storage act = _activity[tokenId];
        totalActions = act.actions;
        successfulActions = act.actions;
        totalTrades = act.trades;
        lifetimePnL = _usdToBnb(_book[tokenId].realizedUsd);
        totalInteractions = uint256(act.actions) + _learning[tokenId].interactions;
        lastActive = act.lastActive;
        activePositions = _openStocks[tokenId].length;
    }

    /// @notice One position: the units bought here and not yet sold here, their USD cost (18 decimals),
    ///         when it opened, and its exit targets (0 = none, and 0 after a sale until the new owner
    ///         sets them). The wallet's balance can differ when stock moves in or out of it directly.
    function positionOf(uint256 tokenId, address stock)
        external
        view
        returns (uint256 units, uint256 costUsd, uint256 openedAt, uint256 stopLossBps, uint256 takeProfitBps)
    {
        Position storage p = _positions[tokenId][stock];
        units = p.units;
        costUsd = p.costUsd;
        openedAt = p.openedAt;
        // Read through _tryWord, as canTrade does, so an id that was never minted reads, not reverts.
        (bool ok, uint256 ownerWord) = _tryWord(address(bap578), abi.encodeWithSelector(IBAP578Owner.ownerOf.selector, tokenId));
        if (ok && p.targetsBy == uint96(ownerWord)) {
            stopLossBps = p.stopLossBps;
            takeProfitBps = p.takeProfitBps;
        }
    }

    /// @notice The stocks this agent has an open position in.
    function openPositions(uint256 tokenId) external view returns (address[] memory) {
        return _openStocks[tokenId];
    }

    /// @notice Lifetime totals in USD (18 decimals): realized profit, volume bought and sold here, and
    ///         the number of open positions.
    function tradingBook(uint256 tokenId)
        external
        view
        returns (int256 realizedUsd, uint256 boughtUsd, uint256 soldUsd, uint256 openCount)
    {
        Book storage b = _book[tokenId];
        return (b.realizedUsd, b.boughtUsd, b.soldUsd, _openStocks[tokenId].length);
    }

    /// @dev A signed USD amount in BNB at the WBNB/USDT pool's current price.
    function _usdToBnb(int256 usd) internal view returns (int256) {
        uint256 usdPerBnb = bnbToUsd(1 ether);
        if (usd == 0 || usdPerBnb == 0) return 0;
        uint256 bnb = Math.mulDiv(uint256(usd < 0 ? -usd : usd), 1 ether, usdPerBnb);
        return usd < 0 ? -int256(bnb) : int256(bnb);
    }

    /// @notice Everything a relayer needs before trying a trade, without spending gas.
    function canTrade(uint256 tokenId)
        external
        view
        returns (address tba, bool permitted, bool live, uint256 bnbBalance, uint256 usdtBalance)
    {
        tba = vaultManager.tbaFor(tokenId);
        // A diagnosis must answer, not throw: an unminted agent, or a wallet that is created but not
        // yet initialized (its proxy delegates to nothing and returns no data), reads as not permitted.
        (bool okOwner, uint256 ownerWord) =
            _tryWord(address(bap578), abi.encodeWithSelector(IBAP578Owner.ownerOf.selector, tokenId));
        if (okOwner) {
            (bool okPerm, uint256 permWord) = _tryWord(
                tba, abi.encodeWithSelector(IERC6551Account.permissions.selector, address(uint160(ownerWord)), address(this))
            );
            permitted = okPerm && permWord != 0;
        }
        live = !paused && !circuitBreaker.globalPause() && !circuitBreaker.isContractPaused(address(this));
        bnbBalance = tba.balance;
        usdtBalance = _balanceOf(USDT, tba);
    }

    // ── Internals ──

    function _armedTba(uint256 tokenId) internal view returns (address tba) {
        tba = vaultManager.tbaFor(tokenId);
        if (tba.code.length == 0) revert NoTba();
        if (!IERC6551Account(tba).permissions(bap578.ownerOf(tokenId), address(this))) revert NotPermitted();
    }

    /// @dev The one route a stock trades on: its listed USDT pool, plus the fee-100 bridge pool for a BNB
    ///      or $U side. No caller chooses a pool, so no one can route an agent through a pool they own.
    function _route(address stock, uint8 side, bool buying) internal view returns (bytes memory path, address quote) {
        uint24 fee = stockPoolFee[stock];
        if (fee == 0) revert StockNotAllowed(stock);
        quote = _quoteOf(side);
        if (side == SIDE_USDT) {
            path = buying ? abi.encodePacked(USDT, fee, stock) : abi.encodePacked(stock, fee, USDT);
        } else {
            path = buying
                ? abi.encodePacked(quote, BRIDGE_FEE, USDT, fee, stock)
                : abi.encodePacked(stock, fee, USDT, BRIDGE_FEE, quote);
        }
    }

    /// @dev Refuses a BNB buy while the WBNB/USDT spot price is far from its recent average, so a pool
    ///      moved in the same block cannot make the BNB spend count as fewer dollars.
    function _requireBnbPriceSettled() internal view {
        (, int24 spot,,,,,) = IPancakeV3PoolOracle(BNB_USD_POOL).slot0();
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = BNB_TWAP_WINDOW;
        (int56[] memory cumulative,) = IPancakeV3PoolOracle(BNB_USD_POOL).observe(secondsAgos);
        int24 average = int24((cumulative[1] - cumulative[0]) / int56(uint56(BNB_TWAP_WINDOW)));
        int24 gap = spot > average ? spot - average : average - spot;
        if (gap > MAX_BNB_TICK_DEVIATION) revert BnbPriceUnsettled(spot, average);
    }

    /// @dev A staticcall that cannot revert, returning the first word of the answer. Same helper as
    ///      AgentGasRelay._tryWord: a short or empty answer counts as a failure, not as zero.
    function _tryWord(address target, bytes memory callData) private view returns (bool ok, uint256 word) {
        if (target.code.length == 0) return (false, 0);
        (bool success, bytes memory ret) = target.staticcall(callData);
        if (!success || ret.length < 32) return (false, 0);
        assembly {
            word := mload(add(ret, 32))
        }
        ok = true;
    }

    /// @dev The least output to accept (the quote less slippage) and the quote itself.
    function _minOut(bytes memory path, uint256 amountIn, uint256 slippageBps) internal returns (uint256, uint256) {
        if (slippageBps == 0) slippageBps = DEFAULT_SLIPPAGE_BPS;
        if (slippageBps > MAX_SLIPPAGE_BPS) revert SlippageTooHigh(slippageBps);
        (uint256 expected, uint160[] memory priceAfter,,) = QUOTER.quoteExactInput(path, amountIn);
        // A pool that runs dry stops the swap at the router's price limit with part of the input unspent
        // and left in the router, where anyone can take it. The quote shows it; refuse the trade.
        for (uint256 i; i < priceAfter.length; ++i) {
            if (priceAfter[i] == PRICE_FLOOR || priceAfter[i] == PRICE_CEILING) revert PoolExhausted();
        }
        return ((expected * (BPS - slippageBps)) / BPS, expected);
    }

    function _approveRouter(address tba, address token, uint256 amount) internal {
        bytes memory ret = IERC6551Account(tba).execute(
            token, 0, abi.encodeWithSelector(IERC20Min.approve.selector, ROUTER, amount), 0
        );
        if (ret.length >= 32 && !abi.decode(ret, (bool))) revert ApproveFailed();
    }

    /// @dev The limits in force: the owner's, while the owner who set them still owns the agent,
    ///      otherwise the built-in defaults.
    function _effectiveBudget(uint256 tokenId, Budget storage b)
        internal
        view
        returns (uint256 buyCap, uint256 paymentCap, uint256 periodLength, bool custom)
    {
        if (b.setBy != address(0) && b.setBy == bap578.ownerOf(tokenId)) {
            return (b.usdPerPeriod, b.paymentUsdPerPeriod, b.periodLength, true);
        }
        return (DEFAULT_USD_PER_PERIOD, DEFAULT_PAYMENT_USD_PER_PERIOD, DEFAULT_PERIOD, false);
    }

    /// @dev Starts a new period when the current one has ended. Periods are whole multiples of
    ///      `period` counted from the first one; both counters reset together.
    function _roll(Budget storage b, uint256 period) internal {
        if (block.timestamp >= uint256(b.periodStart) + period) {
            uint256 elapsed = block.timestamp - b.periodStart;
            b.periodStart = uint64(b.periodStart + (elapsed / period) * period);
            b.spentThisPeriod = 0;
            b.paymentSpentThisPeriod = 0;
        }
    }

    function _consumeBudget(uint256 tokenId, uint256 usdValue) internal {
        Budget storage b = budgets[tokenId];
        (uint256 cap,, uint256 period,) = _effectiveBudget(tokenId, b);
        _roll(b, period);
        uint256 left = cap > b.spentThisPeriod ? cap - b.spentThisPeriod : 0;
        if (usdValue > left) revert BudgetExceeded(left, usdValue);
        b.spentThisPeriod = uint128(b.spentThisPeriod + usdValue);
    }

    function _consumePayment(uint256 tokenId, uint256 usdValue) internal {
        Budget storage b = budgets[tokenId];
        (, uint256 cap, uint256 period,) = _effectiveBudget(tokenId, b);
        _roll(b, period);
        uint256 left = cap > b.paymentSpentThisPeriod ? cap - b.paymentSpentThisPeriod : 0;
        if (usdValue > left) revert BudgetExceeded(left, usdValue);
        b.paymentSpentThisPeriod = uint128(b.paymentSpentThisPeriod + usdValue);
    }

    function _balanceOf(address token, address who) internal view returns (uint256 bal) {
        (bool ok, bytes memory r) = token.staticcall(abi.encodeWithSelector(IERC20Min.balanceOf.selector, who));
        if (ok && r.length >= 32) bal = abi.decode(r, (uint256));
    }

    /// @dev Reimburse the relayer from the agent's wallet for the gas this call burned. Never
    ///      reverts: the trade already happened, and undoing it over a reimbursement would burn the
    ///      gas anyway. A shortfall or a failed transfer is recorded in the event instead.
    function _settleGas(uint256 tokenId, uint256 gasStart) internal {
        address tba = vaultManager.tbaFor(tokenId);
        uint256 units = gasStart - gasleft() + FIXED_OVERHEAD_GAS;
        if (units > GAS_UNITS_CEILING) units = GAS_UNITS_CEILING;
        uint256 price = tx.gasprice < maxGasPriceWei ? tx.gasprice : maxGasPriceWei;
        uint256 owed = units * price;
        uint256 paid = owed < tba.balance ? owed : tba.balance;
        bool failed;
        if (paid > 0) {
            (bool ok,) = tba.call(abi.encodeWithSelector(IERC6551Account.execute.selector, msg.sender, paid, "", 0));
            if (!ok) {
                paid = 0;
                failed = true;
            }
        }
        emit GasSettled(tokenId, msg.sender, tba, units, owed, paid, failed);
    }
}
