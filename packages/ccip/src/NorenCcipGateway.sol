// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {NorenCcipBase} from "./NorenCcipBase.sol";
import {NorenCcipEnvelope} from "./libraries/NorenCcipEnvelope.sol";
import {NorenArcAction} from "./libraries/NorenArcAction.sol";
import {INorenActionSink} from "./interfaces/INorenActionSink.sol";

/// @title NorenCcipGateway
/// @notice Noren's CCIP endpoint on each chain (Arc, Robinhood Chain, Ethereum Sepolia, Base Sepolia, ...).
///         `send` wraps an app payload in a NorenCcipEnvelope and calls the official Chainlink CCIP Router's
///         `ccipSend`, directly to the destination gateway when a lane exists, or to a NorenCcipHub when it does not
///         (Robinhood <-> Arc goes through Base Sepolia). `_ccipReceive` checks the source chain and sender against
///         the allowlist, de-duplicates on `(originChain, nonce)`, records the delivery on-chain and hands the payload
///         (plus any tokens) to this chain's app: NorenArcActionRouter on Arc, NorenCcipInbox elsewhere.
/// @dev Defensive receiver: once a message passes validation, a failing app never reverts the CCIP execution;
///      the message is stored as FAILED and can be retried (anyone) or its tokens recovered (owner).
///      Unaudited hackathon code.
contract NorenCcipGateway is NorenCcipBase, ReentrancyGuard {
  using SafeERC20 for IERC20;
  using NorenCcipEnvelope for NorenCcipEnvelope.Envelope;

  enum Status {
    NONE,
    DELIVERED,
    FAILED,
    RECOVERED
  }

  /// @notice How to reach a final destination chain.
  struct Route {
    uint64 nextChain; // the chain the first hop goes to (= the final chain for a direct lane, or the hub's chain)
    address nextReceiver; // the destination gateway (direct) or the hub
    address finalReceiver; // the NorenCcipGateway on the final chain
    uint32 gasLimit; // ccipReceive gas on the next hop
    uint16 finalityDepth; // requested block depth (0 = wait for finality)
  }

  struct Delivery {
    Status status;
    uint64 originChain;
    uint64 nonce;
    uint64 sourceChain; // CCIP source of the last hop (the hub's chain when routed)
    uint40 deliveredAt;
    address originSender;
    address token;
    uint256 amount;
    bytes32 prevMessageId;
    bytes32 payloadHash;
  }

  /// @notice App that receives delivered payloads (NorenArcActionRouter on Arc, NorenCcipInbox elsewhere).
  INorenActionSink public app;
  /// @notice Outbound counter; `(localChain, nonce)` names a Noren message across all hops.
  uint64 public nonce;

  mapping(uint64 finalChain => Route) public routes;
  /// @notice Origin chains a hub may forward from (a direct GATEWAY peer is always its own origin).
  mapping(uint64 originChain => bool) public allowedOrigin;
  /// @notice CCIP messageId -> delivery record.
  mapping(bytes32 messageId => Delivery) public deliveries;
  /// @notice originKey(originChain, nonce) -> the CCIP messageId that delivered it.
  mapping(bytes32 originKey => bytes32 messageId) public deliveredBy;
  /// @notice Failed messages keep their payload for retry.
  mapping(bytes32 messageId => bytes payload) public failedPayload;
  /// @notice Tokens delivered with no app configured, claimable by the origin sender.
  mapping(address account => mapping(address token => uint256)) public claimable;
  /// @notice Tokens owed to users (claimables and FAILED deliveries); `withdrawToken` can never take them.
  mapping(address token => uint256) public reserved;

  event RouteSet(uint64 indexed finalChain, uint64 nextChain, address nextReceiver, address finalReceiver, uint32 gasLimit, uint16 finalityDepth);
  event AllowedOriginSet(uint64 indexed originChain, bool allowed);
  event AppSet(address indexed app);
  event Sent(
    bytes32 indexed messageId,
    uint64 indexed nonce,
    uint64 indexed finalChain,
    uint64 nextChain,
    address originSender,
    address token,
    uint256 amount,
    address feeToken,
    uint256 fee,
    bytes32 payloadHash
  );
  event Delivered(
    bytes32 indexed messageId,
    uint64 indexed originChain,
    uint64 indexed nonce,
    bytes32 prevMessageId,
    address originSender,
    address token,
    uint256 amount,
    bytes32 payloadHash,
    bool appOk
  );
  event DuplicateIgnored(bytes32 indexed messageId, uint64 indexed originChain, uint64 indexed nonce, bytes32 firstMessageId);
  event MessageFailed(bytes32 indexed messageId, bytes reason);
  event MessageRetried(bytes32 indexed messageId);
  event MessageRecovered(bytes32 indexed messageId, address to);
  event Claimed(address indexed account, address indexed token, uint256 amount);
  event NonceBumped(uint64 nonce);

  error NoRoute(uint64 finalChain);
  error WrongDestination(uint64 finalChain, address finalReceiver);
  error OriginMismatch(uint64 originChain, uint64 sourceChain);
  error OriginNotAllowed(uint64 originChain);
  error TooManyTokens(uint256 count);
  error NotFailed(bytes32 messageId);
  error NothingToClaim();
  error AppDeclined(bytes32 messageId);
  error UnexpectedNative(uint256 value);
  error ExceedsFree(uint256 amount, uint256 free);
  error NonceNotHigher(uint64 nonce, uint64 current);

  constructor(address router, uint64 localChain_, address owner_) NorenCcipBase(router, localChain_, owner_) {}

  // ---------------------------------------------------------------- admin

  function setRoute(uint64 finalChain, Route calldata r) external onlyOwner {
    if (r.nextReceiver == address(0) || r.finalReceiver == address(0)) revert ZeroAddress();
    routes[finalChain] = r;
    emit RouteSet(finalChain, r.nextChain, r.nextReceiver, r.finalReceiver, r.gasLimit, r.finalityDepth);
  }

  function setAllowedOrigin(uint64 originChain, bool allowed) external onlyOwner {
    allowedOrigin[originChain] = allowed;
    emit AllowedOriginSet(originChain, allowed);
  }

  function setApp(INorenActionSink app_) external onlyOwner {
    app = app_;
    emit AppSet(address(app_));
  }

  /// @notice Moves the outbound nonce forward (never back). A replacement gateway on the same chain starts above its
  ///         predecessor's last nonce, so receivers keyed on `(originChain, nonce)` don't treat its messages as
  ///         duplicates of the old gateway's.
  function bumpNonce(uint64 to) external onlyOwner {
    if (to <= nonce) revert NonceNotHigher(to, nonce);
    nonce = to;
    emit NonceBumped(to);
  }

  /// @notice Owner withdrawal of surplus tokens only: balances owed to users (`reserved`) stay put.
  function withdrawToken(IERC20 token, address to, uint256 amount) external override onlyOwner {
    uint256 bal = token.balanceOf(address(this));
    uint256 res = reserved[address(token)];
    uint256 free = bal > res ? bal - res : 0;
    if (amount > free) revert ExceedsFree(amount, free);
    token.safeTransfer(to, amount);
  }

  // ---------------------------------------------------------------- send

  /// @notice Quotes the first-hop CCIP fee for `send` (a hub pays the second hop from its own balance).
  function quote(uint64 finalChain, bytes calldata payload, address token, uint256 amount, address feeToken)
    external
    view
    returns (uint256 fee)
  {
    Route memory r = _route(finalChain);
    bytes memory data = _envelope(msg.sender, nonce + 1, finalChain, r.finalReceiver, payload).encode();
    Client.EVM2AnyMessage memory m = _buildMessage(r.nextReceiver, data, token, amount, r.gasLimit, r.finalityDepth, feeToken);
    return _router().getFee(r.nextChain, m);
  }

  /// @notice Sends `payload` (and optionally `amount` of `token`) to the Noren gateway on `finalChain`.
  /// @param feeToken address(0) pays in native gas (send at least the quoted fee; the rest is refunded);
  ///        otherwise the fee is pulled from the caller in that token (e.g. LINK; approve this gateway first).
  function send(uint64 finalChain, bytes calldata payload, address token, uint256 amount, address feeToken)
    external
    payable
    nonReentrant
    returns (bytes32 messageId)
  {
    // An ERC-20 fee pays nothing from msg.value, which would otherwise stay stuck in the gateway.
    if (feeToken != address(0) && msg.value != 0) revert UnexpectedNative(msg.value);
    Route memory r = _route(finalChain);
    uint64 n = ++nonce;
    bytes memory data = _envelope(msg.sender, n, finalChain, r.finalReceiver, payload).encode();
    Client.EVM2AnyMessage memory m = _buildMessage(r.nextReceiver, data, token, amount, r.gasLimit, r.finalityDepth, feeToken);

    if (amount != 0) IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
    uint256 fee;
    if (feeToken != address(0)) {
      fee = _router().getFee(r.nextChain, m);
      IERC20(feeToken).safeTransferFrom(msg.sender, address(this), fee);
    }
    (messageId, fee) = _send(r.nextChain, m, msg.value);
    if (feeToken == address(0) && msg.value > fee) {
      (bool ok,) = payable(msg.sender).call{value: msg.value - fee}("");
      if (!ok) revert NativeTransferFailed();
    }
    emit Sent(messageId, n, finalChain, r.nextChain, msg.sender, token, amount, feeToken, fee, keccak256(payload));
  }

  // ---------------------------------------------------------------- receive

  function _ccipReceive(Client.Any2EVMMessage memory message) internal override {
    (, Peer kind) = _accept(message);
    NorenCcipEnvelope.Envelope memory e = NorenCcipEnvelope.decode(message.data);
    if (e.finalChain != localChain || e.finalReceiver != address(this)) revert WrongDestination(e.finalChain, e.finalReceiver);
    if (kind == Peer.GATEWAY) {
      if (e.originChain != message.sourceChainSelector) revert OriginMismatch(e.originChain, message.sourceChainSelector);
    } else if (!allowedOrigin[e.originChain]) {
      revert OriginNotAllowed(e.originChain);
    }

    address token;
    uint256 amount;
    if (message.destTokenAmounts.length > 1) revert TooManyTokens(message.destTokenAmounts.length);
    if (message.destTokenAmounts.length == 1) {
      token = message.destTokenAmounts[0].token;
      amount = message.destTokenAmounts[0].amount;
    }

    Delivery storage d = deliveries[message.messageId];
    d.originChain = e.originChain;
    d.nonce = e.nonce;
    d.sourceChain = message.sourceChainSelector;
    d.deliveredAt = uint40(block.timestamp);
    d.originSender = e.originSender;
    d.token = token;
    d.amount = amount;
    d.prevMessageId = e.prevMessageId;
    d.payloadHash = keccak256(e.payload);

    bytes32 key = NorenCcipEnvelope.originKey(e.originChain, e.nonce);
    bytes32 first = deliveredBy[key];
    if (first != bytes32(0)) {
      // Same Noren message delivered twice (e.g. a hub forward retried): keep any tokens recoverable, run nothing.
      d.status = Status.FAILED;
      failedPayload[message.messageId] = e.payload;
      if (amount != 0) reserved[token] += amount;
      emit DuplicateIgnored(message.messageId, e.originChain, e.nonce, first);
      return;
    }
    deliveredBy[key] = message.messageId;

    try this.deliver(message.messageId, e.originChain, e.originSender, token, amount, e.payload) returns (bool appOk) {
      if (!appOk && amount == 0) {
        // The app declined an instruction that carried no value (e.g. Arc liquidity short): keep it retryable.
        d.status = Status.FAILED;
        failedPayload[message.messageId] = e.payload;
        emit MessageFailed(message.messageId, "app declined");
        return;
      }
      d.status = Status.DELIVERED;
      emit Delivered(message.messageId, e.originChain, e.nonce, e.prevMessageId, e.originSender, token, amount, d.payloadHash, appOk);
    } catch (bytes memory reason) {
      d.status = Status.FAILED;
      failedPayload[message.messageId] = e.payload;
      if (amount != 0) reserved[token] += amount;
      emit MessageFailed(message.messageId, reason);
    }
  }

  /// @dev Self-call so a failing app can be caught without reverting the CCIP execution.
  function deliver(bytes32 messageId, uint64 originChain, address originSender, address token, uint256 amount, bytes calldata payload)
    external
    onlySelf
    returns (bool appOk)
  {
    INorenActionSink sink = app;
    if (address(sink) == address(0)) {
      if (amount != 0) {
        claimable[originSender][token] += amount;
        reserved[token] += amount;
      }
      return true;
    }
    if (amount != 0) IERC20(token).safeTransfer(address(sink), amount);
    return sink.execute(NorenArcAction.RAIL_CCIP, messageId, originChain, originSender, token, amount, payload);
  }

  /// @notice Re-runs a FAILED message (e.g. after the app was fixed or funded). Anyone may call.
  function retryFailed(bytes32 messageId) external nonReentrant {
    Delivery storage d = deliveries[messageId];
    if (d.status != Status.FAILED) revert NotFailed(messageId);
    bytes32 key = NorenCcipEnvelope.originKey(d.originChain, d.nonce);
    if (deliveredBy[key] != messageId) revert NotFailed(messageId); // a duplicate copy can only be recovered
    // Leaves the reserve here: deliver() hands it to the app or books it as a claimable again.
    if (d.amount != 0) reserved[d.token] -= d.amount;
    bool appOk = this.deliver(messageId, d.originChain, d.originSender, d.token, d.amount, failedPayload[messageId]);
    if (!appOk && d.amount == 0) revert AppDeclined(messageId);
    d.status = Status.DELIVERED;
    delete failedPayload[messageId];
    emit MessageRetried(messageId);
    emit Delivered(messageId, d.originChain, d.nonce, d.prevMessageId, d.originSender, d.token, d.amount, d.payloadHash, appOk);
  }

  /// @notice Owner sends a FAILED message's tokens to `to` and closes it.
  function recoverFailed(bytes32 messageId, address to) external onlyOwner nonReentrant {
    Delivery storage d = deliveries[messageId];
    if (d.status != Status.FAILED) revert NotFailed(messageId);
    d.status = Status.RECOVERED;
    delete failedPayload[messageId];
    if (d.amount != 0) {
      reserved[d.token] -= d.amount;
      IERC20(d.token).safeTransfer(to, d.amount);
    }
    emit MessageRecovered(messageId, to);
  }

  /// @notice Claims tokens delivered while no app was configured.
  function claim(address token) external nonReentrant {
    uint256 amt = claimable[msg.sender][token];
    if (amt == 0) revert NothingToClaim();
    claimable[msg.sender][token] = 0;
    reserved[token] -= amt;
    IERC20(token).safeTransfer(msg.sender, amt);
    emit Claimed(msg.sender, token, amt);
  }

  // ---------------------------------------------------------------- views

  function statusOf(bytes32 messageId) external view returns (Status) {
    return deliveries[messageId].status;
  }

  function deliveredMessage(uint64 originChain, uint64 originNonce) external view returns (bytes32) {
    return deliveredBy[NorenCcipEnvelope.originKey(originChain, originNonce)];
  }

  // ---------------------------------------------------------------- internals

  function _route(uint64 finalChain) private view returns (Route memory r) {
    r = routes[finalChain];
    if (r.nextReceiver == address(0)) revert NoRoute(finalChain);
  }

  function _envelope(address sender, uint64 n, uint64 finalChain, address finalReceiver, bytes calldata payload)
    private
    view
    returns (NorenCcipEnvelope.Envelope memory)
  {
    return NorenCcipEnvelope.Envelope({
      version: NorenCcipEnvelope.VERSION,
      originChain: localChain,
      originSender: sender,
      nonce: n,
      finalChain: finalChain,
      finalReceiver: finalReceiver,
      prevMessageId: bytes32(0),
      payload: payload
    });
  }

  function _router() private view returns (IRouterClient) {
    return IRouterClient(getRouter());
  }
}
