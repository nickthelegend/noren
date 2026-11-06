// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from '@oz/access/Ownable2Step.sol';
import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {SafeERC20} from '@oz/token/ERC20/utils/SafeERC20.sol';
import {ReentrancyGuard} from '@oz/utils/ReentrancyGuard.sol';
import {CrossChainOrder, XChainOrderLib} from './XChainOrder.sol';
import {XChainInbox, IXChainOutbox} from './XChainTransport.sol';
import {IAggregatorV3} from './interfaces/IExternal.sol';
import {XChainMessages, PriceRound} from './XChainMessages.sol';

interface IUiMultiplier {
  function uiMultiplier() external view returns (uint256);
}

/// @title NorenCrossChainEscrow
/// @notice Source side of a Noren cross-chain Aqua swap. A taker locks `amountIn` of a token here
/// (a Robinhood Stock Token, USDG, or USDC on Arc for the reverse direction). The escrow reads the
/// token's Chainlink feed in the same transaction and emits the order and that price round as one
/// message for the destination settler.
///
/// The locked tokens leave only one of two ways:
///   - Released to the maker's payout address, when the destination settler reports the order
///     FILLED (the maker already paid the taker on the destination chain); or
///   - Refunded to the taker, when the settler reports the order EXPIRED (it can never be filled
///     there), or after `refundAfter` with no report at all (liveness fallback).
/// Each order settles once: Open -> Released | Refundable -> Refunded, or Open -> Refunded.
///
/// Messages arrive as Chainlink CRE reports (onReport) or from an authorised transport adapter
/// (receiveXChain); see XChainInbox.
contract NorenCrossChainEscrow is XChainInbox, Ownable2Step, ReentrancyGuard {
  using SafeERC20 for IERC20;
  using XChainOrderLib for CrossChainOrder;

  enum Status {
    None,
    Open,
    Released,
    Refundable,
    Refunded
  }

  struct Escrowed {
    address taker;
    address tokenIn;
    uint256 amountIn;
    address maker;
    uint64 dstChainId;
    address dstSettler;
    uint64 refundAfter;
    Status status;
  }

  struct TokenConfig {
    address feed; // Chainlink <TOKEN>/USD on this chain (zero: no price in the message)
    bool uiMultiplier; // Robinhood Stock Token: send its live uiMultiplier()
    bool enabled;
  }

  /// @notice Minimum time between the destination fill deadline and the source refund fallback, so
  /// a fill that happened right at the deadline still has time to be reported before any refund.
  uint64 public minReleaseWindow = 1 hours;
  /// @notice Longest an order may stay fillable.
  uint64 public maxFillWindow = 1 days;

  mapping(uint64 chainId => address settler) public settlers;
  mapping(address token => TokenConfig) public tokens;
  mapping(bytes32 orderId => Escrowed) internal _orders;

  event OrderOpened(
    bytes32 indexed orderId, address indexed taker, address indexed maker, CrossChainOrder order, PriceRound price
  );
  /// @notice The payload for the destination chain. CRE's log trigger delivers it verbatim.
  event XChainMessage(bytes32 indexed orderId, uint64 indexed toChainId, address indexed to, bytes payload);
  event Released(bytes32 indexed orderId, address indexed maker, address indexed payout, uint256 amountIn, uint256 amountOut);
  event RefundUnlocked(bytes32 indexed orderId);
  event Refunded(bytes32 indexed orderId, address indexed taker, uint256 amountIn, bool viaTimeout);
  event SettlerSet(uint64 indexed chainId, address settler);
  event TokenSet(address indexed token, address feed, bool uiMultiplier, bool enabled);
  event WindowsSet(uint64 minReleaseWindow, uint64 maxFillWindow);

  error BadOrder(string why);
  error TokenNotEnabled(address token);
  error OrderExists(bytes32 orderId);
  error ReceivedShort(uint256 expected, uint256 received);
  error NotOpen(bytes32 orderId, Status status);
  error UnknownOrder(bytes32 orderId);
  error WrongSource(uint64 chainId, address sender);
  error WrongMaker(address reported, address expected);
  error PartialFill(uint256 reported, uint256 escrowed);
  error BadMessage(uint8 kind);
  error NotRefundable(bytes32 orderId, Status status, uint64 refundAfter);
  error ZeroAddress();

  constructor(address owner_, address forwarder_) Ownable(owner_) {
    if (forwarder_ == address(0)) revert ZeroAddress();
    _setForwarder(forwarder_);
  }

  // ================================================================ taker

  /// @notice Lock `o.amountIn` of `o.tokenIn` and publish the order. The caller must be `o.taker`.
  function open(CrossChainOrder calldata o) external nonReentrant returns (bytes32 orderId) {
    if (o.srcChainId != block.chainid || o.srcEscrow != address(this)) revert BadOrder('source');
    if (o.taker != msg.sender) revert BadOrder('taker');
    if (o.amountIn == 0 || o.minAmountOut == 0) revert BadOrder('amount');
    if (o.recipient == address(0) || o.maker == address(0) || o.tokenOut == address(0)) revert BadOrder('address');
    if (settlers[o.dstChainId] == address(0) || settlers[o.dstChainId] != o.dstSettler) revert BadOrder('destination');
    if (o.fillDeadline <= block.timestamp || o.fillDeadline > block.timestamp + maxFillWindow) revert BadOrder('fillDeadline');
    if (o.refundAfter < o.fillDeadline + minReleaseWindow) revert BadOrder('refundAfter');
    TokenConfig memory t = tokens[o.tokenIn];
    if (!t.enabled) revert TokenNotEnabled(o.tokenIn);

    orderId = o.id();
    if (_orders[orderId].status != Status.None) revert OrderExists(orderId);
    _orders[orderId] = Escrowed({
      taker: o.taker,
      tokenIn: o.tokenIn,
      amountIn: o.amountIn,
      maker: o.maker,
      dstChainId: o.dstChainId,
      dstSettler: o.dstSettler,
      refundAfter: o.refundAfter,
      status: Status.Open
    });

    uint256 before = IERC20(o.tokenIn).balanceOf(address(this));
    IERC20(o.tokenIn).safeTransferFrom(msg.sender, address(this), o.amountIn);
    uint256 got = IERC20(o.tokenIn).balanceOf(address(this)) - before;
    if (got != o.amountIn) revert ReceivedShort(o.amountIn, got);

    PriceRound memory p = _price(o.tokenIn, t);
    bytes memory payload = XChainMessages.encodeOrder(o, p);
    emit OrderOpened(orderId, o.taker, o.maker, o, p);
    emit XChainMessage(orderId, o.dstChainId, o.dstSettler, payload);
    _sendOut(o.dstChainId, o.dstSettler, payload);
  }

  /// @notice Return the escrowed tokens to the taker: after an EXPIRED report, or after
  /// `refundAfter` if no report arrived. Anyone may call; the tokens always go to the taker.
  function refund(bytes32 orderId) external nonReentrant {
    Escrowed storage e = _orders[orderId];
    bool viaTimeout = e.status == Status.Open && block.timestamp >= e.refundAfter;
    if (e.status != Status.Refundable && !viaTimeout) revert NotRefundable(orderId, e.status, e.refundAfter);
    e.status = Status.Refunded;
    IERC20(e.tokenIn).safeTransfer(e.taker, e.amountIn);
    emit Refunded(orderId, e.taker, e.amountIn, viaTimeout);
  }

  // ================================================================ messages from the settler

  function _handle(bytes calldata payload, uint64 srcChainId, address srcSender) internal override nonReentrant {
    XChainMessages.Settlement memory s = XChainMessages.decodeSettlement(payload);
    Escrowed storage e = _orders[s.orderId];
    if (e.status == Status.None) revert UnknownOrder(s.orderId);
    // Double release, release after refund and replays all stop here.
    if (e.status != Status.Open) revert NotOpen(s.orderId, e.status);
    // The settlement must come from the settler this order named.
    if (s.dstChainId != e.dstChainId || s.dstSettler != e.dstSettler) revert WrongSource(s.dstChainId, s.dstSettler);
    if (srcSender != address(0) && (srcChainId != e.dstChainId || srcSender != e.dstSettler)) revert WrongSource(srcChainId, srcSender);

    if (s.kind == XChainMessages.FILLED) {
      if (s.maker != e.maker) revert WrongMaker(s.maker, e.maker);
      if (s.amountIn != e.amountIn) revert PartialFill(s.amountIn, e.amountIn);
      if (s.payout == address(0)) revert ZeroAddress();
      e.status = Status.Released;
      IERC20(e.tokenIn).safeTransfer(s.payout, e.amountIn);
      emit Released(s.orderId, s.maker, s.payout, e.amountIn, s.amountOut);
    } else if (s.kind == XChainMessages.EXPIRED) {
      e.status = Status.Refundable;
      emit RefundUnlocked(s.orderId);
    } else {
      revert BadMessage(s.kind);
    }
  }

  // ================================================================ views

  function order(bytes32 orderId) external view returns (Escrowed memory) {
    return _orders[orderId];
  }

  function orderStatus(bytes32 orderId) external view returns (Status) {
    return _orders[orderId].status;
  }

  function idOf(CrossChainOrder calldata o) external pure returns (bytes32) {
    return o.id();
  }

  /// @notice The price round `open` would attach for `token` right now.
  function currentPrice(address token) external view returns (PriceRound memory) {
    return _price(token, tokens[token]);
  }

  function _price(address token, TokenConfig memory t) internal view returns (PriceRound memory p) {
    if (t.feed == address(0)) return p;
    (p.roundId, p.answer, p.startedAt, p.updatedAt, p.answeredInRound) = IAggregatorV3(t.feed).latestRoundData();
    p.decimals = IAggregatorV3(t.feed).decimals();
    p.uiMultiplier = t.uiMultiplier ? IUiMultiplier(token).uiMultiplier() : 1e18;
    p.sourceFeed = t.feed;
  }

  // ================================================================ owner

  function setSettler(uint64 chainId, address settler) external onlyOwner {
    settlers[chainId] = settler;
    emit SettlerSet(chainId, settler);
  }

  function setToken(address token, address feed, bool uiMultiplier_, bool enabled) external onlyOwner {
    tokens[token] = TokenConfig({feed: feed, uiMultiplier: uiMultiplier_, enabled: enabled});
    emit TokenSet(token, feed, uiMultiplier_, enabled);
  }

  function setWindows(uint64 minRelease, uint64 maxFill) external onlyOwner {
    if (minRelease == 0 || maxFill == 0) revert BadOrder('windows');
    minReleaseWindow = minRelease;
    maxFillWindow = maxFill;
    emit WindowsSet(minRelease, maxFill);
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
