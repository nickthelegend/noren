// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from '@oz/access/Ownable2Step.sol';
import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {IERC20Metadata} from '@oz/token/ERC20/extensions/IERC20Metadata.sol';
import {SafeERC20} from '@oz/token/ERC20/utils/SafeERC20.sol';
import {ReentrancyGuard} from '@oz/utils/ReentrancyGuard.sol';
import {CrossChainOrder, XChainOrderLib} from './XChainOrder.sol';
import {XChainInbox, IXChainOutbox} from './XChainTransport.sol';
import {XChainMessages, PriceRound} from './XChainMessages.sol';
import {NorenEscrowReceipt} from './NorenEscrowReceipt.sol';
import {NorenRelayedFeed} from './NorenRelayedFeed.sol';
import {IAqua, ISwapVMRouter} from './interfaces/IExternal.sol';

/// @notice What the Arc action router (CCTP hook / CCIP receiver) calls for action kind 3, AQUA_ORDER.
interface INorenAquaOrderHandler {
  /// @notice Fill a cross-chain Aqua order whose input tokens already arrived on this chain.
  /// The caller has approved `amountIn` of `tokenIn` to the handler. The handler pulls it only if
  /// the fill succeeds; on any failure it pulls nothing and returns filled = false, so the caller
  /// keeps the funds (and can make them claimable by `beneficiary`).
  /// @param params abi.encode(NorenCrossChainSettler.AquaOrderParams)
  function fillDelivered(address tokenIn, uint256 amountIn, address beneficiary, bytes32 ref, bytes calldata params)
    external
    returns (bool filled, uint256 amountOut, bytes32 orderId);
}

/// @title NorenCrossChainSettler
/// @notice Destination side of Noren cross-chain Aqua, on Arc (the liquidity hub). Makers keep
/// USDC (or EURC) in their own wallets and ship 1inch Aqua strategies whose SwapVM program is the
/// Chainlink-pegged NorenOraclePeg instruction. One maker wallet backs strategies for orders from
/// every source chain: Aqua's virtual balances let the same USDC serve them all.
///
/// Two ways in, one fill path:
///  1. Escrowed orders (`onReport` / `receiveXChain`, payload ORDER). The taker's tokens stay locked
///     in a NorenCrossChainEscrow on the source chain (a Robinhood Stock Token, WETH on Base...).
///     The settler mints a NorenEscrowReceipt for exactly the escrowed amount, swaps it through the
///     maker's strategy (the maker pays tokenOut to the taker's recipient), burns the receipt in the
///     same transaction and emits a FILLED message. The escrow then releases the locked tokens to
///     the maker's payout address on the source chain. The source chain's Chainlink round rides
///     along with the order and is written to a NorenRelayedFeed that the strategy reads.
///  2. Delivered orders (`fillDelivered`, called by the Arc action router after CCTP or CCIP).
///     The input tokens (USDC minted by CCTP) are already on Arc and are swapped directly.
///
/// Safety: every order settles at most once (None -> Filled | Expired); the order id commits to both
/// chains and contracts; the strategy must belong to the maker the taker named; fills are
/// all-or-nothing at the exact escrowed amount with the taker's minimum out; the Chainlink staleness,
/// depeg and price-band checks run inside the SwapVM instruction at fill time. A fill that fails
/// (stale price, under-funded maker, slippage) changes nothing and can be retried until the
/// deadline; after it, anyone can expire the order so the escrow refunds the taker.
contract NorenCrossChainSettler is XChainInbox, Ownable2Step, ReentrancyGuard, INorenAquaOrderHandler {
  using SafeERC20 for IERC20;
  using XChainOrderLib for CrossChainOrder;

  uint256 internal constant BPS = 10_000;
  /// @dev SwapVM MakerTraits: useAquaInsteadOfSignature, receiver = maker, no hooks.
  uint256 public constant AQUA_TRAITS = 1 << 254;
  /// @dev SwapVM AquaOpcodes Controls._salt.
  uint8 public constant OP_SALT = 20;
  uint16 public constant ONE_SIDED = type(uint16).max;
  uint16 internal constant TAKER_EXACT_IN = 0x0001;
  uint16 internal constant TAKER_TRANSFER_FROM_AND_AQUA_PUSH = 0x0040;
  uint8 internal constant FLAG_UI_MULTIPLIER = 0x01;
  uint8 internal constant FLAG_MARKET_HOURS = 0x02;

  enum Status {
    None,
    Filled,
    Expired
  }

  /// @notice A tradable route. `inToken` is what the taker sells on this chain: the escrow receipt
  /// (escrowed routes) or the delivered local token (delivered routes). The maker pays `outToken`.
  struct Route {
    address inToken;
    address outToken;
    bool delivered; // true: inToken arrives through the action router; false: escrow receipt
    bool takerSellsBase; // true: base = inToken (maker buys at oracle - bid); false: base = outToken (maker sells at oracle + ask)
    address baseFeed; // Chainlink <BASE>/USD on this chain, or a NorenRelayedFeed of a source-chain feed
    bool relayed; // baseFeed is a NorenRelayedFeed this settler writes
    address quoteFeed; // zero: the quote token is valued at $1
    uint32 baseMaxAgeOpen;
    uint32 baseMaxAgeClosed;
    uint32 quoteMaxAge;
    uint16 quoteMaxDepegBps;
    uint8 flags; // FLAG_UI_MULTIPLIER (base is a Stock Token or its receipt), FLAG_MARKET_HOURS (24/5 feed)
    bool enabled;
  }

  struct PegTerms {
    uint16 bidSpreadBps;
    uint16 askSpreadBps;
    uint16 closedExtraBps;
    uint64 minPriceUsd8;
    uint64 maxPriceUsd8;
    uint64 salt;
  }

  struct Strategy {
    address maker;
    bytes32 routeKey;
    address payout; // maker's address on the source chain (escrowed routes)
    bool active;
    uint32 fills;
    uint256 volumeIn;
    uint256 volumeOut;
    bytes data; // SwapVM program
  }

  struct Fill {
    address maker;
    address payout;
    uint256 amountIn;
    uint256 amountOut;
    uint64 filledAt;
  }

  /// @notice Order bytes of action kind 3 (AQUA_ORDER) in the Arc action router.
  struct AquaOrderParams {
    uint64 srcChainId; // where the value came from (informational, part of the order id)
    address tokenOut;
    uint256 minAmountOut;
    address recipient; // receives tokenOut on this chain
    address maker;
    bytes32 strategyHash;
    uint64 fillDeadline;
    uint256 nonce;
  }

  IAqua public immutable aqua;
  ISwapVMRouter public immutable router;
  uint8 public immutable pegOpcode;

  uint16 public maxSpreadBps = 300;
  /// @notice Trusted escrow per source chain (escrowed routes).
  mapping(uint64 chainId => address escrow) public escrows;
  mapping(bytes32 routeKey => Route) internal _routes;
  mapping(bytes32 strategyHash => Strategy) internal _strategies;
  mapping(address maker => bytes32[]) internal _byMaker;
  mapping(bytes32 orderId => Status) public orderStatus;
  mapping(bytes32 orderId => Fill) internal _fills;

  event RouteSet(bytes32 indexed routeKey, uint64 indexed srcChainId, address indexed srcToken, address outToken, Route route);
  event EscrowSet(uint64 indexed chainId, address escrow);
  event StrategyRegistered(bytes32 indexed strategyHash, address indexed maker, bytes32 indexed routeKey, address payout, uint16 bidSpreadBps, uint16 askSpreadBps);
  event StrategyRemoved(bytes32 indexed strategyHash, address indexed maker);
  event PayoutSet(bytes32 indexed strategyHash, address payout);
  event OrderFilled(
    bytes32 indexed orderId,
    bytes32 indexed strategyHash,
    address indexed maker,
    uint64 srcChainId,
    address recipient,
    address tokenOut,
    uint256 amountIn,
    uint256 amountOut,
    bool delivered
  );
  event OrderExpired(bytes32 indexed orderId, uint64 indexed srcChainId, address srcEscrow);
  event FillRejected(bytes32 indexed orderId, bytes reason);
  /// @notice The payload for the source chain. CRE's log trigger delivers it verbatim.
  event XChainMessage(bytes32 indexed orderId, uint64 indexed toChainId, address indexed to, bytes payload);
  event PriceRelayed(address indexed feed, uint80 roundId, int256 answer, uint256 updatedAt, bool stored);

  error BadConfig();
  error UnknownRoute(bytes32 routeKey);
  error UnknownStrategy(bytes32 strategyHash);
  error StrategyExists(bytes32 strategyHash);
  error StrategyNotShipped(bytes32 strategyHash);
  error SpreadTooWide(uint16 spreadBps, uint16 maxSpreadBps);
  error NotMaker(address caller);
  error AlreadySettled(bytes32 orderId, Status status);
  error WrongDestination(uint64 chainId, address settler);
  error UntrustedSource(uint64 chainId, address sender);
  error FillDeadlinePassed(bytes32 orderId, uint64 fillDeadline);
  error NotExpired(bytes32 orderId, uint64 fillDeadline);
  error WrongMaker(address strategyMaker, address orderMaker);
  error WrongStrategy(bytes32 strategyHash, bytes32 routeKey);
  error WrongFeed(address got, address expected);
  error OnlySelf();
  error FillMismatch(uint256 amountIn, uint256 amountOut);
  error ReceivedShort(uint256 expected, uint256 received);
  error BadMessage(uint8 kind);
  error ZeroAddress();

  constructor(address owner_, address forwarder_, IAqua aqua_, ISwapVMRouter router_) Ownable(owner_) {
    if (forwarder_ == address(0) || address(aqua_) == address(0) || router_.AQUA() != address(aqua_)) revert BadConfig();
    aqua = aqua_;
    router = router_;
    pegOpcode = router_.NOREN_ORACLE_PEG_OPCODE();
    _setForwarder(forwarder_);
  }

  // ================================================================ routes and strategies

  /// @notice Route key: the source chain and token the taker sells, and the token the maker pays.
  /// Delivered routes use srcChainId 0 and the local input token.
  function routeKey(uint64 srcChainId, address srcToken, address outToken) public pure returns (bytes32) {
    return keccak256(abi.encode(srcChainId, srcToken, outToken));
  }

  function route(bytes32 key) external view returns (Route memory) {
    return _routes[key];
  }

  /// @notice The canonical Aqua order for `maker` on route `key`, and its strategy hash.
  /// Ship it with aqua.ship(router, abi.encode(order), [inToken, outToken], [0, outAllocation]).
  function buildOrder(address maker, bytes32 key, PegTerms memory t)
    public
    view
    returns (ISwapVMRouter.Order memory o, bytes32 strategyHash)
  {
    Route memory r = _routes[key];
    if (!r.enabled) revert UnknownRoute(key);
    (address base, address quote) = r.takerSellsBase ? (r.inToken, r.outToken) : (r.outToken, r.inToken);
    // The side the taker uses carries the maker's spread; the other side is closed (taker
    // sells base: buy-only; taker buys base: the maker would have to pay out receipts it never holds).
    uint16 bid = r.takerSellsBase ? t.bidSpreadBps : 9_999;
    uint16 ask = r.takerSellsBase ? ONE_SIDED : t.askSpreadBps;
    bytes memory args = abi.encodePacked(
      abi.encodePacked(base, quote, r.baseFeed, r.quoteFeed),
      abi.encodePacked(r.baseMaxAgeOpen, r.baseMaxAgeClosed, r.quoteMaxAge),
      abi.encodePacked(bid, ask, t.closedExtraBps, r.quoteMaxDepegBps, r.flags),
      abi.encodePacked(t.minPriceUsd8, t.maxPriceUsd8)
    );
    bytes memory program =
      bytes.concat(abi.encodePacked(OP_SALT, uint8(8), t.salt), abi.encodePacked(pegOpcode, uint8(args.length)), args);
    o = ISwapVMRouter.Order({maker: maker, traits: AQUA_TRAITS, data: program});
    strategyHash = keccak256(abi.encode(o));
  }

  /// @notice Register the caller's shipped Aqua strategy for route `key`. `payout` is the maker's
  /// address on the source chain, where escrowed tokens are released (ignored for delivered routes).
  function register(bytes32 key, PegTerms calldata t, address payout) external returns (bytes32 strategyHash) {
    Route memory r = _routes[key];
    uint16 spread = r.takerSellsBase ? t.bidSpreadBps : t.askSpreadBps;
    if (spread > maxSpreadBps) revert SpreadTooWide(spread, maxSpreadBps);
    if (!r.delivered && payout == address(0)) revert ZeroAddress();
    ISwapVMRouter.Order memory o;
    (o, strategyHash) = buildOrder(msg.sender, key, t);
    if (_strategies[strategyHash].active) revert StrategyExists(strategyHash);
    try aqua.safeBalances(msg.sender, address(router), strategyHash, r.inToken, r.outToken) returns (uint256, uint256) {}
    catch {
      revert StrategyNotShipped(strategyHash);
    }
    Strategy storage s = _strategies[strategyHash];
    s.maker = msg.sender;
    s.routeKey = key;
    s.payout = payout;
    s.active = true;
    s.data = o.data;
    _byMaker[msg.sender].push(strategyHash);
    emit StrategyRegistered(strategyHash, msg.sender, key, payout, t.bidSpreadBps, t.askSpreadBps);
  }

  function setPayout(bytes32 strategyHash, address payout) external {
    Strategy storage s = _strategies[strategyHash];
    if (s.maker != msg.sender) revert NotMaker(msg.sender);
    if (payout == address(0)) revert ZeroAddress();
    s.payout = payout;
    emit PayoutSet(strategyHash, payout);
  }

  function remove(bytes32 strategyHash) external {
    Strategy storage s = _strategies[strategyHash];
    if (s.maker != msg.sender && msg.sender != owner()) revert NotMaker(msg.sender);
    s.active = false;
    emit StrategyRemoved(strategyHash, s.maker);
  }

  // ================================================================ escrowed orders (CRE or CCIP)

  function _handle(bytes calldata payload, uint64 srcChainId, address srcSender) internal override nonReentrant {
    uint8 kind = XChainMessages.kindOf(payload);
    if (kind == XChainMessages.ORDER) {
      (, CrossChainOrder memory o, PriceRound memory p) = XChainMessages.decodeOrder(payload);
      _fillEscrowed(o, p, srcChainId, srcSender);
    } else if (kind == XChainMessages.PRICE && srcSender == address(0)) {
      // Price-only reports come from CRE (it read the source feed); transports can't send them.
      (address feed, PriceRound memory p) = XChainMessages.decodePrice(payload);
      _relay(feed, p);
    } else {
      revert BadMessage(kind);
    }
  }

  function _fillEscrowed(CrossChainOrder memory o, PriceRound memory p, uint64 srcChainId, address srcSender) internal {
    bytes32 id = o.id();
    Status st = orderStatus[id];
    if (st != Status.None) revert AlreadySettled(id, st);
    if (o.dstChainId != block.chainid || o.dstSettler != address(this)) revert WrongDestination(o.dstChainId, o.dstSettler);
    address escrow = escrows[o.srcChainId];
    if (escrow == address(0) || escrow != o.srcEscrow) revert UntrustedSource(o.srcChainId, o.srcEscrow);
    if (srcSender != address(0) && (srcChainId != o.srcChainId || srcSender != o.srcEscrow)) revert UntrustedSource(srcChainId, srcSender);
    if (block.timestamp > o.fillDeadline) revert FillDeadlinePassed(id, o.fillDeadline);
    bytes32 key = routeKey(o.srcChainId, o.tokenIn, o.tokenOut);
    Route memory r = _routes[key];
    if (!r.enabled || r.delivered) revert UnknownRoute(key);
    Strategy storage s = _checkStrategy(o.strategyHash, o.maker, key);

    // The source chain's Chainlink round, read by the escrow in the taker's transaction. Written
    // only if newer; the instruction's staleness check then decides whether the fill can happen.
    if (r.relayed && p.updatedAt != 0) {
      if (p.sourceFeed != NorenRelayedFeed(r.baseFeed).sourceFeed()) revert WrongFeed(p.sourceFeed, NorenRelayedFeed(r.baseFeed).sourceFeed());
      bool stored = _relay(r.baseFeed, p);
      if (stored && (r.flags & FLAG_UI_MULTIPLIER) != 0) NorenEscrowReceipt(r.inToken).setUiMultiplier(p.uiMultiplier);
    }

    try this.executeFill(o.strategyHash, r.inToken, r.outToken, o.amountIn, o.minAmountOut, o.recipient, true, address(0)) returns (
      uint256 amountOut
    ) {
      orderStatus[id] = Status.Filled;
      _record(s, id, o.strategyHash, o.srcChainId, o.recipient, r.outToken, o.amountIn, amountOut, false);
      bytes memory msgOut = XChainMessages.encodeSettlement(
        XChainMessages.Settlement({
          kind: XChainMessages.FILLED,
          orderId: id,
          dstChainId: uint64(block.chainid),
          dstSettler: address(this),
          maker: s.maker,
          payout: s.payout,
          amountIn: o.amountIn,
          amountOut: amountOut
        })
      );
      emit XChainMessage(id, o.srcChainId, o.srcEscrow, msgOut);
      _sendOut(o.srcChainId, o.srcEscrow, msgOut);
    } catch (bytes memory reason) {
      emit FillRejected(id, reason);
    }
  }

  /// @notice After the fill deadline, mark an unfilled escrowed order EXPIRED for good and tell the
  /// source escrow, which then lets the taker refund. Anyone may call.
  function expire(CrossChainOrder calldata o) external nonReentrant {
    bytes32 id = o.id();
    Status st = orderStatus[id];
    if (st != Status.None) revert AlreadySettled(id, st);
    if (o.dstChainId != block.chainid || o.dstSettler != address(this)) revert WrongDestination(o.dstChainId, o.dstSettler);
    if (escrows[o.srcChainId] == address(0) || escrows[o.srcChainId] != o.srcEscrow) revert UntrustedSource(o.srcChainId, o.srcEscrow);
    if (block.timestamp <= o.fillDeadline) revert NotExpired(id, o.fillDeadline);
    orderStatus[id] = Status.Expired;
    bytes memory msgOut = XChainMessages.encodeSettlement(
      XChainMessages.Settlement({
        kind: XChainMessages.EXPIRED,
        orderId: id,
        dstChainId: uint64(block.chainid),
        dstSettler: address(this),
        maker: o.maker,
        payout: address(0),
        amountIn: o.amountIn,
        amountOut: 0
      })
    );
    emit OrderExpired(id, o.srcChainId, o.srcEscrow);
    emit XChainMessage(id, o.srcChainId, o.srcEscrow, msgOut);
    _sendOut(o.srcChainId, o.srcEscrow, msgOut);
  }

  // ================================================================ delivered orders (Arc action router)

  /// @inheritdoc INorenAquaOrderHandler
  function fillDelivered(address tokenIn, uint256 amountIn, address beneficiary, bytes32 ref, bytes calldata params)
    external
    nonReentrant
    returns (bool filled, uint256 amountOut, bytes32 orderId)
  {
    if (!transports[msg.sender]) revert NotTransport(msg.sender);
    AquaOrderParams memory a = abi.decode(params, (AquaOrderParams));
    orderId = keccak256(abi.encode(block.chainid, address(this), msg.sender, tokenIn, amountIn, beneficiary, ref, a));
    if (orderStatus[orderId] != Status.None) revert AlreadySettled(orderId, orderStatus[orderId]);
    bytes32 key = routeKey(0, tokenIn, a.tokenOut);
    Route memory r = _routes[key];
    bytes memory reason;
    if (!r.enabled || !r.delivered) reason = abi.encodeWithSelector(UnknownRoute.selector, key);
    else if (block.timestamp > a.fillDeadline) reason = abi.encodeWithSelector(FillDeadlinePassed.selector, orderId, a.fillDeadline);
    else if (amountIn == 0 || a.recipient == address(0)) reason = abi.encodeWithSelector(ZeroAddress.selector);
    else {
      Strategy storage s = _strategies[a.strategyHash];
      if (!s.active) reason = abi.encodeWithSelector(UnknownStrategy.selector, a.strategyHash);
      else if (s.maker != a.maker) reason = abi.encodeWithSelector(WrongMaker.selector, s.maker, a.maker);
      else if (s.routeKey != key) reason = abi.encodeWithSelector(WrongStrategy.selector, a.strategyHash, key);
      else {
        try this.executeFill(a.strategyHash, tokenIn, a.tokenOut, amountIn, a.minAmountOut, a.recipient, false, msg.sender) returns (
          uint256 out
        ) {
          orderStatus[orderId] = Status.Filled;
          _record(s, orderId, a.strategyHash, a.srcChainId, a.recipient, a.tokenOut, amountIn, out, true);
          return (true, out, orderId);
        } catch (bytes memory why) {
          reason = why;
        }
      }
    }
    // Nothing was pulled: the caller keeps the funds for the beneficiary.
    emit FillRejected(orderId, reason);
    return (false, 0, orderId);
  }

  // ================================================================ fill (self-call, so a failure rolls everything back)

  /// @dev Only callable by this contract. Escrowed: mint the receipt, swap, burn it from the maker.
  /// Delivered: pull the input from `payer`, swap.
  function executeFill(
    bytes32 strategyHash,
    address inToken,
    address outToken,
    uint256 amountIn,
    uint256 minAmountOut,
    address recipient,
    bool escrowed,
    address payer
  ) external returns (uint256 amountOut) {
    if (msg.sender != address(this)) revert OnlySelf();
    Strategy storage s = _strategies[strategyHash];
    if (escrowed) {
      NorenEscrowReceipt(inToken).mint(address(this), amountIn);
      NorenEscrowReceipt(inToken).setUnlocked(true);
    } else {
      uint256 before = IERC20(inToken).balanceOf(address(this));
      IERC20(inToken).safeTransferFrom(payer, address(this), amountIn);
      uint256 got = IERC20(inToken).balanceOf(address(this)) - before;
      if (got != amountIn) revert ReceivedShort(amountIn, got);
    }
    IERC20(inToken).forceApprove(address(router), amountIn);
    uint256 outBefore = IERC20(outToken).balanceOf(recipient);
    uint256 ain;
    (ain, amountOut,) = router.swap(
      ISwapVMRouter.Order({maker: s.maker, traits: AQUA_TRAITS, data: s.data}),
      inToken,
      outToken,
      amountIn,
      _takerData(minAmountOut, recipient)
    );
    if (ain != amountIn) revert FillMismatch(ain, amountOut);
    uint256 received = IERC20(outToken).balanceOf(recipient) - outBefore;
    if (recipient != s.maker && received != amountOut) revert ReceivedShort(amountOut, received);
    if (escrowed) {
      // The maker's real payment is the escrowed asset on the source chain.
      NorenEscrowReceipt(inToken).burn(s.maker, amountIn);
      NorenEscrowReceipt(inToken).setUnlocked(false);
    }
  }

  // ================================================================ views

  function strategy(bytes32 strategyHash) external view returns (Strategy memory) {
    return _strategies[strategyHash];
  }

  function strategyOrder(bytes32 strategyHash) external view returns (ISwapVMRouter.Order memory) {
    Strategy storage s = _strategies[strategyHash];
    return ISwapVMRouter.Order({maker: s.maker, traits: AQUA_TRAITS, data: s.data});
  }

  function strategiesOf(address maker) external view returns (bytes32[] memory) {
    return _byMaker[maker];
  }

  function fillOf(bytes32 orderId) external view returns (Fill memory) {
    return _fills[orderId];
  }

  function idOf(CrossChainOrder calldata o) external pure returns (bytes32) {
    return o.id();
  }

  /// @notice Taker data for SwapVM (exact-in, min out, recipient), as used by executeFill.
  function takerData(uint256 minAmountOut, address recipient) external pure returns (bytes memory) {
    return _takerData(minAmountOut, recipient);
  }

  // ================================================================ internals

  function _checkStrategy(bytes32 strategyHash, address orderMaker, bytes32 key) internal view returns (Strategy storage s) {
    s = _strategies[strategyHash];
    if (!s.active) revert UnknownStrategy(strategyHash);
    if (s.maker != orderMaker) revert WrongMaker(s.maker, orderMaker);
    if (s.routeKey != key) revert WrongStrategy(strategyHash, key);
  }

  function _record(
    Strategy storage s,
    bytes32 id,
    bytes32 strategyHash,
    uint64 srcChainId,
    address recipient,
    address outToken,
    uint256 amountIn,
    uint256 amountOut,
    bool delivered
  ) internal {
    s.fills += 1;
    s.volumeIn += amountIn;
    s.volumeOut += amountOut;
    _fills[id] = Fill({maker: s.maker, payout: s.payout, amountIn: amountIn, amountOut: amountOut, filledAt: uint64(block.timestamp)});
    emit OrderFilled(id, strategyHash, s.maker, srcChainId, recipient, outToken, amountIn, amountOut, delivered);
  }

  function _relay(address feed, PriceRound memory p) internal returns (bool stored) {
    NorenRelayedFeed f = NorenRelayedFeed(feed);
    if (f.writer() != address(this)) revert WrongFeed(feed, address(0));
    if (p.sourceFeed != f.sourceFeed()) revert WrongFeed(p.sourceFeed, f.sourceFeed());
    stored = f.relay(
      NorenRelayedFeed.Round({
        roundId: p.roundId,
        answer: p.answer,
        startedAt: p.startedAt,
        updatedAt: p.updatedAt,
        answeredInRound: p.answeredInRound
      })
    );
    emit PriceRelayed(feed, p.roundId, p.answer, p.updatedAt, stored);
  }

  /// @dev SwapVM TakerTraits: 20-byte slice index table, 2-byte flags, threshold (32 bytes) and
  /// the 20-byte recipient. Exact-in, the maker is paid via transferFrom + Aqua.push.
  function _takerData(uint256 threshold, address to) internal pure returns (bytes memory) {
    uint160 end = 52;
    uint160 idx = 32 | (end << 16);
    for (uint256 k = 2; k < 10; ++k) idx |= end << uint160(16 * k);
    return abi.encodePacked(idx, TAKER_TRANSFER_FROM_AND_AQUA_PUSH | TAKER_EXACT_IN, threshold, to);
  }

  // ================================================================ owner

  function setEscrow(uint64 chainId, address escrow) external onlyOwner {
    escrows[chainId] = escrow;
    emit EscrowSet(chainId, escrow);
  }

  /// @notice Configure a route. For an escrowed route, `r.inToken` must be a NorenEscrowReceipt
  /// minted by this settler for (srcChainId, srcToken).
  function setRoute(uint64 srcChainId, address srcToken, Route calldata r) external onlyOwner {
    if (r.inToken == address(0) || r.outToken == address(0) || r.baseFeed == address(0) || r.baseMaxAgeOpen == 0) revert BadConfig();
    if (r.baseMaxAgeClosed < r.baseMaxAgeOpen) revert BadConfig();
    if (r.delivered) {
      if (srcChainId != 0 || srcToken != r.inToken) revert BadConfig();
    } else {
      NorenEscrowReceipt rc = NorenEscrowReceipt(r.inToken);
      if (rc.settler() != address(this) || rc.sourceChainId() != srcChainId || rc.sourceToken() != srcToken) revert BadConfig();
    }
    if (r.relayed && NorenRelayedFeed(r.baseFeed).writer() != address(this)) revert BadConfig();
    // Decimals must be readable: the instruction reads them on every quote.
    IERC20Metadata(r.inToken).decimals();
    IERC20Metadata(r.outToken).decimals();
    bytes32 key = routeKey(srcChainId, srcToken, r.outToken);
    _routes[key] = r;
    emit RouteSet(key, srcChainId, srcToken, r.outToken, r);
  }

  function setMaxSpread(uint16 bps) external onlyOwner {
    if (bps >= 2_000) revert BadConfig();
    maxSpreadBps = bps;
  }

  function setForwarder(address f) external onlyOwner {
    if (f == address(0)) revert ZeroAddress();
    _setForwarder(f);
  }

  function setExpectedWorkflowOwner(address w) external onlyOwner {
    expectedWorkflowOwner = w;
    emit ExpectedWorkflowOwnerSet(w);
  }

  function setTransport(address adapter, bool allowed) external onlyOwner {
    transports[adapter] = allowed;
    emit TransportSet(adapter, allowed);
  }

  function setOutbox(IXChainOutbox o) external onlyOwner {
    outbox = o;
    emit OutboxSet(address(o));
  }
}
