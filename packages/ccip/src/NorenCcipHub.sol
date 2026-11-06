// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {NorenCcipBase} from "./NorenCcipBase.sol";
import {NorenCcipEnvelope} from "./libraries/NorenCcipEnvelope.sol";

/// @title NorenCcipHub
/// @notice Relays Noren envelopes between chains that share no CCIP lane (Robinhood Chain <-> Arc via Base Sepolia).
///         `_ccipReceive` accepts only allowlisted NorenCcipGateways, checks the envelope's origin is the CCIP source,
///         stamps `prevMessageId` with the inbound messageId and calls the official Router's `ccipSend` to the final
///         gateway, paying the second hop from the hub's own native (or LINK) balance.
/// @dev If forwarding fails (fee balance empty, route missing, lane paused) the inbound message still succeeds:
///      the envelope's hash is stored as PENDING and anyone can call `retryForward` with the envelope bytes from
///      the ForwardPending event (optionally sending native gas for the
///      fee). Tokens that arrive on a hop whose onward lane cannot carry them stay in hub custody, claimable by the
///      origin sender on this chain. Unaudited hackathon code.
contract NorenCcipHub is NorenCcipBase, ReentrancyGuard {
  using SafeERC20 for IERC20;
  using NorenCcipEnvelope for NorenCcipEnvelope.Envelope;

  enum ForwardStatus {
    NONE,
    FORWARDED,
    PENDING
  }

  struct HubRoute {
    address finalReceiver; // NorenCcipGateway on the final chain
    uint32 gasLimit; // ccipReceive gas on the final hop
    uint16 finalityDepth; // requested block depth on the final hop (0 = finality)
  }

  struct Custody {
    address owner; // origin sender (same EOA on this chain)
    address token;
    uint256 amount;
  }

  /// @notice Fee token for the second hop: address(0) = native gas, otherwise e.g. LINK held by the hub.
  address public feeToken;

  mapping(uint64 finalChain => HubRoute) public routes;
  mapping(bytes32 inboundId => ForwardStatus) public forwardStatus;
  mapping(bytes32 inboundId => bytes32 outboundId) public forwardedAs;
  /// @notice keccak256 of a PENDING envelope; the bytes are in the ForwardPending event (cheaper than storage).
  mapping(bytes32 inboundId => bytes32 envelopeHash) public pendingEnvelopeHash;
  mapping(bytes32 inboundId => Custody) public custody;
  /// @notice originKey -> inbound messageId, so the same Noren message is never forwarded twice.
  mapping(bytes32 originKey => bytes32 inboundId) public relayedBy;

  event HubRouteSet(uint64 indexed finalChain, address finalReceiver, uint32 gasLimit, uint16 finalityDepth);
  event FeeTokenSet(address feeToken);
  event Forwarded(
    bytes32 indexed inboundId,
    bytes32 indexed outboundId,
    uint64 indexed finalChain,
    uint64 originChain,
    uint64 nonce,
    address feeToken,
    uint256 fee
  );
  event ForwardPending(bytes32 indexed inboundId, uint64 indexed finalChain, bytes envelope, bytes reason);
  event CustodyTaken(bytes32 indexed inboundId, address indexed owner, address token, uint256 amount);
  event CustodyReleased(bytes32 indexed inboundId, address indexed to, address token, uint256 amount);
  event DuplicateDropped(bytes32 indexed inboundId, bytes32 indexed firstInboundId);

  error OriginMismatch(uint64 originChain, uint64 sourceChain);
  error NotAGateway(uint64 sourceChain, address sender);
  error NotPending(bytes32 inboundId);
  error NoHubRoute(uint64 finalChain);
  error NotCustodyOwner(address caller);
  error NoCustody(bytes32 inboundId);
  error EnvelopeMismatch(bytes32 inboundId);

  constructor(address router, uint64 localChain_, address owner_) NorenCcipBase(router, localChain_, owner_) {}

  // ---------------------------------------------------------------- admin

  function setHubRoute(uint64 finalChain, HubRoute calldata r) external onlyOwner {
    if (r.finalReceiver == address(0)) revert ZeroAddress();
    routes[finalChain] = r;
    emit HubRouteSet(finalChain, r.finalReceiver, r.gasLimit, r.finalityDepth);
  }

  function setFeeToken(address feeToken_) external onlyOwner {
    feeToken = feeToken_;
    emit FeeTokenSet(feeToken_);
  }

  // ---------------------------------------------------------------- receive + forward

  function _ccipReceive(Client.Any2EVMMessage memory message) internal override {
    (address sender, Peer kind) = _accept(message);
    if (kind != Peer.GATEWAY) revert NotAGateway(message.sourceChainSelector, sender);
    NorenCcipEnvelope.Envelope memory e = NorenCcipEnvelope.decode(message.data);
    if (e.originChain != message.sourceChainSelector) revert OriginMismatch(e.originChain, message.sourceChainSelector);

    if (message.destTokenAmounts.length != 0) {
      // Onward lanes into Arc carry no tokens today; keep them here for the origin sender instead of losing them.
      Client.EVMTokenAmount memory t = message.destTokenAmounts[0];
      custody[message.messageId] = Custody({owner: e.originSender, token: t.token, amount: t.amount});
      emit CustodyTaken(message.messageId, e.originSender, t.token, t.amount);
    }

    bytes32 key = NorenCcipEnvelope.originKey(e.originChain, e.nonce);
    bytes32 first = relayedBy[key];
    if (first != bytes32(0)) {
      emit DuplicateDropped(message.messageId, first);
      return;
    }
    relayedBy[key] = message.messageId;

    e.prevMessageId = message.messageId;
    bytes memory env = e.encode();
    try this.forward(message.messageId, env) {}
    catch (bytes memory reason) {
      forwardStatus[message.messageId] = ForwardStatus.PENDING;
      pendingEnvelopeHash[message.messageId] = keccak256(env);
      emit ForwardPending(message.messageId, e.finalChain, env, reason);
    }
  }

  /// @dev Self-call so a failed second hop does not revert the inbound CCIP execution.
  function forward(bytes32 inboundId, bytes calldata env) external onlySelf returns (bytes32 outboundId) {
    NorenCcipEnvelope.Envelope memory e = NorenCcipEnvelope.decode(env);
    HubRoute memory r = routes[e.finalChain];
    if (r.finalReceiver == address(0) || r.finalReceiver != e.finalReceiver) revert NoHubRoute(e.finalChain);
    Client.EVM2AnyMessage memory m = _buildMessage(r.finalReceiver, env, address(0), 0, r.gasLimit, r.finalityDepth, feeToken);
    uint256 fee;
    (outboundId, fee) = _send(e.finalChain, m, address(this).balance);
    forwardStatus[inboundId] = ForwardStatus.FORWARDED;
    forwardedAs[inboundId] = outboundId;
    emit Forwarded(inboundId, outboundId, e.finalChain, e.originChain, e.nonce, feeToken, fee);
  }

  /// @notice Retries a PENDING forward with the envelope from its ForwardPending event. Anyone may call; send
  ///         native gas to top up the hub for the fee.
  function retryForward(bytes32 inboundId, bytes calldata envelope) external payable nonReentrant returns (bytes32 outboundId) {
    if (forwardStatus[inboundId] != ForwardStatus.PENDING) revert NotPending(inboundId);
    if (keccak256(envelope) != pendingEnvelopeHash[inboundId]) revert EnvelopeMismatch(inboundId);
    delete pendingEnvelopeHash[inboundId];
    outboundId = this.forward(inboundId, envelope);
  }

  /// @notice The origin sender (same address on this chain) or the owner releases tokens held in custody.
  function releaseCustody(bytes32 inboundId, address to) external nonReentrant {
    Custody memory c = custody[inboundId];
    if (c.amount == 0) revert NoCustody(inboundId);
    if (msg.sender != c.owner && msg.sender != owner()) revert NotCustodyOwner(msg.sender);
    delete custody[inboundId];
    IERC20(c.token).safeTransfer(to, c.amount);
    emit CustodyReleased(inboundId, to, c.token, c.amount);
  }

  /// @notice Quotes the hub's second-hop fee for a payload of `payloadLength` bytes to `finalChain`.
  function quoteForward(uint64 finalChain, uint256 payloadLength) external view returns (uint256) {
    HubRoute memory r = routes[finalChain];
    if (r.finalReceiver == address(0)) revert NoHubRoute(finalChain);
    NorenCcipEnvelope.Envelope memory e;
    e.version = NorenCcipEnvelope.VERSION;
    e.finalChain = finalChain;
    e.finalReceiver = r.finalReceiver;
    e.payload = new bytes(payloadLength);
    Client.EVM2AnyMessage memory m = _buildMessage(r.finalReceiver, e.encode(), address(0), 0, r.gasLimit, r.finalityDepth, feeToken);
    return IRouterClient(getRouter()).getFee(finalChain, m);
  }
}
