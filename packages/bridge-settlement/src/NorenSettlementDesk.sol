// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {IERC20Metadata} from '@oz/token/ERC20/extensions/IERC20Metadata.sol';
import {SafeERC20} from '@oz/token/ERC20/utils/SafeERC20.sol';
import {ReentrancyGuard} from '@oz/utils/ReentrancyGuard.sol';
import {IReceiver, IERC165} from './interfaces/IReceiver.sol';
import {IAggregatorV3, IStockToken, IPermit2, IUniversalRouter, PoolKey, ExactInputSingleParams} from './interfaces/IExternal.sol';

/// @title NorenSettlementDesk
/// @notice Moves a Noren merchant's value from Robinhood Chain to USDC on Arc.
///   1. Optional: sell Stock Tokens for USDG on a live Uniswap v4 pool, refusing any fill below the
///      Chainlink price minus a slippage bound.
///   2. The merchant requests a settlement of USDG to an Arc address, with a max slippage.
///   3. A Chainlink CRE workflow reads live Relay and Across quotes (HTTP, DON consensus) and
///      the Chainlink USDG/USD and USDC/USD feeds, and writes an approve or reject report here.
///   4. A keeper executes the approved deposit into the real Relay Depository or Across SpokePool.
///      The desk checks the calldata: target, token, amount, depositor and, for Across, the
///      recipient, output token, Arc chain id and output amount against the approved minimum.
///   The Arc-side fill is done by Relay's solver or an Across relayer; it is not on this chain.
/// @dev Unaudited. With the CRE simulation MockKeystoneForwarder no DON signature is checked.
contract NorenSettlementDesk is IReceiver, ReentrancyGuard {
  using SafeERC20 for IERC20;

  enum Status {
    None,
    Requested,
    Approved,
    Rejected,
    Executed,
    Cancelled
  }

  enum Route {
    None,
    Relay,
    Across
  }

  struct Settlement {
    address merchant;
    uint64 requestedAt;
    uint16 maxSlippageBps;
    Status status;
    Route route;
    address arcRecipient;
    uint64 validUntil;
    uint256 amountUsdg6;
    uint256 minOutUsdc6;
    uint256 quotedOutUsdc6;
  }

  uint8 public constant REPORT_APPROVE = 1;
  uint8 public constant REPORT_REJECT = 2;
  /// @notice Hard ceiling on any slippage, whatever a merchant or a report asks for.
  uint16 public constant MAX_SLIPPAGE_CAP_BPS = 500;
  /// @notice A request the workflow has not answered can be cancelled after this.
  uint64 public constant REQUEST_TIMEOUT = 1 hours;
  uint256 public constant ARC_CHAIN_ID = 5042;
  /// @dev Relay Depository depositErc20(address depositor, address token, uint256 amount, bytes32 id).
  bytes4 public constant RELAY_DEPOSIT_ERC20 = 0xe8017952;
  /// @dev Across SpokePool deposit(bytes32 depositor, bytes32 recipient, bytes32 inputToken,
  ///      bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId,
  ///      bytes32 exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityParameter, bytes message).
  bytes4 public constant ACROSS_DEPOSIT = 0xad5425c6;
  bytes1 internal constant V4_SWAP = 0x10;

  IERC20 public immutable usdg;
  IAggregatorV3 public immutable usdgUsdFeed;
  address public immutable relayDepository;
  address public immutable acrossSpokePool;
  address public immutable arcUsdc;
  IUniversalRouter public immutable universalRouter;
  IPermit2 public immutable permit2;

  address public owner;
  address public forwarder;
  address public keeper;
  address public expectedWorkflowOwner;
  /// @notice Oldest Chainlink round the stock sale accepts (stock feeds stop while US markets are closed).
  uint64 public maxFeedAge = 4 days;
  uint256 public nonce;
  /// @notice USDG held for open requests (Requested, Approved or Rejected). Only the balance above it is recoverable.
  uint256 public escrowedUsdg6;

  mapping(address stockToken => address chainlinkUsdFeed) public stockFeed;
  mapping(bytes32 id => Settlement) private _settlements;

  event SettlementRequested(bytes32 indexed id, address indexed merchant, address arcRecipient, uint256 amountUsdg6, uint16 maxSlippageBps);
  event SettlementApproved(
    bytes32 indexed id, Route route, uint256 minOutUsdc6, uint256 quotedOutUsdc6, uint256 usdgUsd8, uint256 usdcUsd8, uint64 validUntil
  );
  event SettlementRejected(bytes32 indexed id, uint256 bestQuotedOutUsdc6, uint256 fairOutUsdc6);
  event SettlementExecuted(bytes32 indexed id, Route route, address target, bytes32 orderRef, uint256 minOutUsdc6);
  event SettlementCancelled(bytes32 indexed id);
  event StockSold(address indexed merchant, address indexed stock, uint256 amountIn, uint256 usdgOut, uint256 floorUsdg6, uint256 stockUsd8);
  event StockFeedSet(address indexed stock, address feed);
  event RolesSet(address forwarder, address keeper, address expectedWorkflowOwner);
  event Recovered(address indexed token, address indexed to, uint256 amount);
  event MaxFeedAgeSet(uint64 maxFeedAge);

  error NotOwner();
  error NotKeeper();
  error NotMerchant();
  error NotForwarder(address caller);
  error InvalidWorkflowOwner(address got, address expected);
  error InvalidReport();
  error BadStatus(Status status);
  error BadSlippage(uint16 bps);
  error ZeroAmount();
  error ZeroAddress();
  error ApprovalExpired(uint64 validUntil);
  error MinOutBelowFloor(uint256 minOut, uint256 floor);
  error BadCalldata(string what);
  error RouteNotApproved(Route route);
  error DepositFailed(bytes reason);
  error WrongPullAmount(uint256 pulled, uint256 expected);
  error UnknownStock(address stock);
  error BadPoolKey();
  error StalePrice(address feed, uint256 updatedAt);
  error InvalidPrice(address feed, int256 answer);
  error SwapBelowFloor(uint256 out, uint256 floor);
  error TooEarly(uint64 at);
  error ExceedsRecoverable(uint256 recoverable, uint256 requested);

  modifier onlyOwner() {
    if (msg.sender != owner) revert NotOwner();
    _;
  }

  constructor(
    IERC20 usdg_,
    IAggregatorV3 usdgUsdFeed_,
    address relayDepository_,
    address acrossSpokePool_,
    address arcUsdc_,
    IUniversalRouter universalRouter_,
    IPermit2 permit2_,
    address forwarder_,
    address keeper_,
    address owner_
  ) {
    if (
      address(usdg_) == address(0) || address(usdgUsdFeed_) == address(0) || relayDepository_ == address(0)
        || acrossSpokePool_ == address(0) || arcUsdc_ == address(0) || address(universalRouter_) == address(0)
        || address(permit2_) == address(0) || forwarder_ == address(0) || keeper_ == address(0) || owner_ == address(0)
    ) revert ZeroAddress();
    usdg = usdg_;
    usdgUsdFeed = usdgUsdFeed_;
    relayDepository = relayDepository_;
    acrossSpokePool = acrossSpokePool_;
    arcUsdc = arcUsdc_;
    universalRouter = universalRouter_;
    permit2 = permit2_;
    forwarder = forwarder_;
    keeper = keeper_;
    owner = owner_;
    emit RolesSet(forwarder_, keeper_, address(0));
  }

  // ---------------------------------------------------------------- merchant

  /// @notice Request a settlement of `amountUsdg6` USDG (pulled from the caller) to USDC at `arcRecipient` on Arc.
  function requestSettlement(uint256 amountUsdg6, address arcRecipient, uint16 maxSlippageBps) external nonReentrant returns (bytes32 id) {
    if (amountUsdg6 == 0) revert ZeroAmount();
    usdg.safeTransferFrom(msg.sender, address(this), amountUsdg6);
    id = _request(msg.sender, amountUsdg6, arcRecipient, maxSlippageBps);
  }

  /// @notice Sell `amountIn` of a Stock Token for USDG on a Uniswap v4 pool, then request settlement of
  ///         the USDG received. The fill must clear max(minUsdgOut, Chainlink value x (1 - maxSwapSlippageBps)).
  function sellStockAndRequest(
    PoolKey calldata key,
    uint128 amountIn,
    uint128 minUsdgOut,
    uint16 maxSwapSlippageBps,
    address arcRecipient,
    uint16 maxSlippageBps
  ) external nonReentrant returns (bytes32 id, uint256 usdgOut) {
    if (amountIn == 0) revert ZeroAmount();
    if (maxSwapSlippageBps > MAX_SLIPPAGE_CAP_BPS) revert BadSlippage(maxSwapSlippageBps);
    if (key.hooks != address(0)) revert BadPoolKey();
    bool zeroForOne;
    address stock;
    if (key.currency1 == address(usdg)) {
      (zeroForOne, stock) = (true, key.currency0);
    } else if (key.currency0 == address(usdg)) {
      (zeroForOne, stock) = (false, key.currency1);
    } else {
      revert BadPoolKey();
    }
    address feed = stockFeed[stock];
    if (feed == address(0)) revert UnknownStock(stock);

    uint256 floor = stockFloorUsdg6(stock, amountIn, maxSwapSlippageBps);
    uint128 minOut = minUsdgOut > floor ? minUsdgOut : uint128(floor);

    IERC20(stock).safeTransferFrom(msg.sender, address(this), amountIn);
    uint256 before = usdg.balanceOf(address(this));
    _swapExactInSingle(key, zeroForOne, stock, amountIn, minOut);
    usdgOut = usdg.balanceOf(address(this)) - before;
    if (usdgOut < minOut) revert SwapBelowFloor(usdgOut, minOut);
    emit StockSold(msg.sender, stock, amountIn, usdgOut, floor, _price8(IAggregatorV3(feed)));
    id = _request(msg.sender, usdgOut, arcRecipient, maxSlippageBps);
  }

  /// @notice Send a rejected or expired-approval request back to the workflow for a fresh quote.
  function retry(bytes32 id) external {
    Settlement storage s = _settlements[id];
    if (s.merchant != msg.sender) revert NotMerchant();
    if (!(s.status == Status.Rejected || (s.status == Status.Approved && block.timestamp > s.validUntil))) revert BadStatus(s.status);
    s.status = Status.Requested;
    s.requestedAt = uint64(block.timestamp);
    emit SettlementRequested(id, s.merchant, s.arcRecipient, s.amountUsdg6, s.maxSlippageBps);
  }

  /// @notice Refund the USDG of a request that was rejected, never answered, or approved but not executed in time.
  function cancel(bytes32 id) external nonReentrant {
    Settlement storage s = _settlements[id];
    if (s.merchant != msg.sender) revert NotMerchant();
    bool ok = s.status == Status.Rejected || (s.status == Status.Approved && block.timestamp > s.validUntil)
      || (s.status == Status.Requested && block.timestamp > s.requestedAt + REQUEST_TIMEOUT);
    if (!ok) {
      if (s.status == Status.Requested) revert TooEarly(s.requestedAt + REQUEST_TIMEOUT);
      revert BadStatus(s.status);
    }
    s.status = Status.Cancelled;
    escrowedUsdg6 -= s.amountUsdg6;
    usdg.safeTransfer(s.merchant, s.amountUsdg6);
    emit SettlementCancelled(id);
  }

  // ---------------------------------------------------------------- CRE receiver

  /// @inheritdoc IReceiver
  /// @dev report = abi.encode(uint8 kind, bytes32 id, uint8 route, uint256 minOutUsdc6, uint256 quotedOutUsdc6,
  ///      uint256 usdgUsd8, uint256 usdcUsd8, uint64 validUntil). kind 1 approves, kind 2 rejects.
  function onReport(bytes calldata metadata, bytes calldata report) external override {
    if (msg.sender != forwarder) revert NotForwarder(msg.sender);
    if (expectedWorkflowOwner != address(0)) {
      address workflowOwner = metadata.length >= 62 ? address(bytes20(metadata[42:62])) : address(0);
      if (workflowOwner != expectedWorkflowOwner) revert InvalidWorkflowOwner(workflowOwner, expectedWorkflowOwner);
    }
    if (report.length != 256) revert InvalidReport();
    (uint8 kind, bytes32 id, uint8 route, uint256 minOut, uint256 quotedOut, uint256 usdgUsd8, uint256 usdcUsd8, uint64 validUntil) =
      abi.decode(report, (uint8, bytes32, uint8, uint256, uint256, uint256, uint256, uint64));
    Settlement storage s = _settlements[id];
    if (s.status != Status.Requested) revert BadStatus(s.status);

    if (kind == REPORT_REJECT) {
      s.status = Status.Rejected;
      uint256 fair = usdcUsd8 == 0 ? 0 : s.amountUsdg6 * usdgUsd8 / usdcUsd8;
      emit SettlementRejected(id, quotedOut, fair);
      return;
    }
    if (kind != REPORT_APPROVE) revert InvalidReport();
    if (route != uint8(Route.Relay) && route != uint8(Route.Across)) revert InvalidReport();
    if (validUntil <= block.timestamp) revert ApprovalExpired(validUntil);
    // Whatever the report says, never accept a minimum below amount x (1 - the hard cap).
    uint256 floor = s.amountUsdg6 * (10_000 - MAX_SLIPPAGE_CAP_BPS) / 10_000;
    if (minOut < floor || quotedOut < minOut) revert MinOutBelowFloor(minOut, floor);
    // And never below the merchant's own bound, at the prices the report itself attests (the workflow's formula).
    if (usdgUsd8 == 0 || usdcUsd8 == 0) revert InvalidReport();
    uint256 merchantFloor = (s.amountUsdg6 * usdgUsd8 / usdcUsd8) * (10_000 - s.maxSlippageBps) / 10_000;
    if (minOut < merchantFloor) revert MinOutBelowFloor(minOut, merchantFloor);
    s.status = Status.Approved;
    s.route = Route(route);
    s.minOutUsdc6 = minOut;
    s.quotedOutUsdc6 = quotedOut;
    s.validUntil = validUntil;
    emit SettlementApproved(id, Route(route), minOut, quotedOut, usdgUsd8, usdcUsd8, validUntil);
  }

  function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
    return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
  }

  // ---------------------------------------------------------------- keeper

  /// @notice Execute an approved settlement with deposit calldata from the Relay or Across API.
  ///         Relay: only if the workflow approved the Relay route (its output is committed off-chain by
  ///         the quote). Across: always allowed, because its output amount is in the calldata and checked here.
  function executeSettlement(bytes32 id, Route route, bytes calldata data) external nonReentrant {
    if (msg.sender != keeper) revert NotKeeper();
    Settlement storage s = _settlements[id];
    if (s.status != Status.Approved) revert BadStatus(s.status);
    if (block.timestamp > s.validUntil) revert ApprovalExpired(s.validUntil);
    if (data.length < 4) revert BadCalldata('short');

    address target;
    bytes32 orderRef;
    if (route == Route.Relay) {
      if (s.route != Route.Relay) revert RouteNotApproved(route);
      orderRef = _checkRelay(s, data);
      target = relayDepository;
    } else if (route == Route.Across) {
      _checkAcross(s, data);
      orderRef = keccak256(data);
      target = acrossSpokePool;
    } else {
      revert RouteNotApproved(route);
    }

    s.status = Status.Executed;
    escrowedUsdg6 -= s.amountUsdg6;
    uint256 before = usdg.balanceOf(address(this));
    usdg.forceApprove(target, s.amountUsdg6);
    (bool ok, bytes memory ret) = target.call(data);
    if (!ok) revert DepositFailed(ret);
    usdg.forceApprove(target, 0);
    uint256 pulled = before - usdg.balanceOf(address(this));
    if (pulled != s.amountUsdg6) revert WrongPullAmount(pulled, s.amountUsdg6);
    emit SettlementExecuted(id, route, target, orderRef, s.minOutUsdc6);
  }

  // ---------------------------------------------------------------- views

  function settlement(bytes32 id) external view returns (Settlement memory) {
    return _settlements[id];
  }

  /// @notice Chainlink value of `amountIn` stock in USDG (6 dp), minus `slippageBps`. Reverts on a stale or bad round.
  function stockFloorUsdg6(address stock, uint256 amountIn, uint16 slippageBps) public view returns (uint256) {
    address feed = stockFeed[stock];
    if (feed == address(0)) revert UnknownStock(stock);
    uint256 stockUsd8 = _price8(IAggregatorV3(feed));
    uint256 usdgUsd8 = _price8(usdgUsdFeed);
    // shares (18 dp) = raw amount x uiMultiplier / 1e18; usd8 = shares x price8 / 1e(stock decimals)
    uint256 shares = amountIn * IStockToken(stock).uiMultiplier() / 1e18;
    uint256 valueUsd8 = shares * stockUsd8 / 10 ** IERC20Metadata(stock).decimals();
    uint256 valueUsdg6 = valueUsd8 * 1e6 / usdgUsd8;
    return valueUsdg6 * (10_000 - slippageBps) / 10_000;
  }

  // ---------------------------------------------------------------- admin

  function setStockFeed(address stock, address feed) external onlyOwner {
    stockFeed[stock] = feed;
    emit StockFeedSet(stock, feed);
  }

  function setRoles(address forwarder_, address keeper_, address expectedWorkflowOwner_) external onlyOwner {
    if (forwarder_ == address(0) || keeper_ == address(0)) revert ZeroAddress();
    forwarder = forwarder_;
    keeper = keeper_;
    expectedWorkflowOwner = expectedWorkflowOwner_;
    emit RolesSet(forwarder_, keeper_, expectedWorkflowOwner_);
  }

  function setMaxFeedAge(uint64 maxFeedAge_) external onlyOwner {
    maxFeedAge = maxFeedAge_;
    emit MaxFeedAgeSet(maxFeedAge_);
  }

  /// @notice Moves tokens the desk holds beyond open requests, for example an Across or Relay refund of a deposit
  ///         that was never filled (refunds go to the depositor, which is this desk), back out. Escrowed USDG of open
  ///         requests can never be taken.
  function recover(IERC20 token, address to, uint256 amount) external onlyOwner nonReentrant {
    if (to == address(0)) revert ZeroAddress();
    uint256 recoverable = token.balanceOf(address(this));
    if (address(token) == address(usdg)) recoverable = recoverable > escrowedUsdg6 ? recoverable - escrowedUsdg6 : 0;
    if (amount > recoverable) revert ExceedsRecoverable(recoverable, amount);
    token.safeTransfer(to, amount);
    emit Recovered(address(token), to, amount);
  }

  // ---------------------------------------------------------------- internals

  function _request(address merchant, uint256 amountUsdg6, address arcRecipient, uint16 maxSlippageBps) private returns (bytes32 id) {
    if (arcRecipient == address(0)) revert ZeroAddress();
    if (maxSlippageBps == 0 || maxSlippageBps > MAX_SLIPPAGE_CAP_BPS) revert BadSlippage(maxSlippageBps);
    id = keccak256(abi.encode(block.chainid, address(this), nonce++));
    escrowedUsdg6 += amountUsdg6;
    _settlements[id] = Settlement({
      merchant: merchant,
      requestedAt: uint64(block.timestamp),
      maxSlippageBps: maxSlippageBps,
      status: Status.Requested,
      route: Route.None,
      arcRecipient: arcRecipient,
      validUntil: 0,
      amountUsdg6: amountUsdg6,
      minOutUsdc6: 0,
      quotedOutUsdc6: 0
    });
    emit SettlementRequested(id, merchant, arcRecipient, amountUsdg6, maxSlippageBps);
  }

  function _checkRelay(Settlement storage s, bytes calldata data) private view returns (bytes32 orderId) {
    if (bytes4(data[0:4]) != RELAY_DEPOSIT_ERC20 || data.length != 4 + 32 * 4) revert BadCalldata('relay selector or length');
    (address depositor, address token, uint256 amount, bytes32 id) = abi.decode(data[4:], (address, address, uint256, bytes32));
    if (depositor != address(this)) revert BadCalldata('relay depositor');
    if (token != address(usdg)) revert BadCalldata('relay token');
    if (amount != s.amountUsdg6) revert BadCalldata('relay amount');
    return id;
  }

  function _checkAcross(Settlement storage s, bytes calldata data) private view {
    if (bytes4(data[0:4]) != ACROSS_DEPOSIT) revert BadCalldata('across selector');
    (
      bytes32 depositor,
      bytes32 recipient,
      bytes32 inputToken,
      bytes32 outputToken,
      uint256 inputAmount,
      uint256 outputAmount,
      uint256 destinationChainId,
      ,
      ,
      ,
      ,
      bytes memory message
    ) = abi.decode(data[4:], (bytes32, bytes32, bytes32, bytes32, uint256, uint256, uint256, bytes32, uint32, uint32, uint32, bytes));
    if (depositor != _b32(address(this))) revert BadCalldata('across depositor');
    if (recipient != _b32(s.arcRecipient)) revert BadCalldata('across recipient');
    if (inputToken != _b32(address(usdg))) revert BadCalldata('across input token');
    if (outputToken != _b32(arcUsdc)) revert BadCalldata('across output token');
    if (inputAmount != s.amountUsdg6) revert BadCalldata('across amount');
    if (destinationChainId != ARC_CHAIN_ID) revert BadCalldata('across destination');
    if (outputAmount < s.minOutUsdc6) revert BadCalldata('across output below approved minimum');
    if (message.length != 0) revert BadCalldata('across message');
  }

  function _swapExactInSingle(PoolKey calldata key, bool zeroForOne, address stock, uint128 amountIn, uint128 minOut) private {
    IERC20(stock).forceApprove(address(permit2), amountIn);
    permit2.approve(stock, address(universalRouter), uint160(amountIn), uint48(block.timestamp));
    // V4_SWAP: SWAP_EXACT_IN_SINGLE (0x06), SETTLE_ALL (0x0c), TAKE_ALL (0x0f)
    bytes memory actions = abi.encodePacked(uint8(0x06), uint8(0x0c), uint8(0x0f));
    bytes[] memory params = new bytes[](3);
    params[0] = abi.encode(ExactInputSingleParams({poolKey: key, zeroForOne: zeroForOne, amountIn: amountIn, amountOutMinimum: minOut, minHopPriceX36: 0, hookData: ''}));
    params[1] = abi.encode(stock, uint256(amountIn));
    params[2] = abi.encode(address(usdg), uint256(minOut));
    bytes[] memory inputs = new bytes[](1);
    inputs[0] = abi.encode(actions, params);
    universalRouter.execute(abi.encodePacked(V4_SWAP), inputs, block.timestamp);
    IERC20(stock).forceApprove(address(permit2), 0);
  }

  function _price8(IAggregatorV3 feed) private view returns (uint256) {
    (, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
    if (answer <= 0) revert InvalidPrice(address(feed), answer);
    if (updatedAt > block.timestamp || block.timestamp - updatedAt > maxFeedAge) revert StalePrice(address(feed), updatedAt);
    uint8 dec = feed.decimals();
    uint256 raw = uint256(answer);
    return dec == 8 ? raw : dec > 8 ? raw / 10 ** (dec - 8) : raw * 10 ** (8 - dec);
  }

  function _b32(address a) private pure returns (bytes32) {
    return bytes32(uint256(uint160(a)));
  }
}
