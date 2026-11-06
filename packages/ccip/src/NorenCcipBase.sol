// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CCIPReceiver} from "@chainlink/contracts-ccip/contracts/applications/CCIPReceiver.sol";
import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {ExtraArgsCodec} from "@chainlink/contracts-ccip/contracts/libraries/ExtraArgsCodec.sol";
import {FinalityCodec} from "@chainlink/contracts-ccip/contracts/libraries/FinalityCodec.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title NorenCcipBase
/// @notice Shared plumbing for NorenCcipGateway and NorenCcipHub: inbound allowlists (source chain + sender),
///         replay protection on CCIP messageIds, the CCIP 2.0 finality policy, and one `ccipSend` helper that pays
///         fees in native gas or LINK.
/// @dev Unaudited hackathon code.
abstract contract NorenCcipBase is CCIPReceiver, Ownable2Step {
  using SafeERC20 for IERC20;

  enum Peer {
    NONE,
    GATEWAY, // a NorenCcipGateway: the envelope's originChain must equal the CCIP source chain
    HUB // a NorenCcipHub: forwards envelopes from other origins (checked against allowedOrigin)
  }

  /// @notice CCIP chain selector of this chain.
  uint64 public immutable localChain;

  /// @notice Who may send CCIP messages to this contract, per source chain selector.
  mapping(uint64 sourceChain => mapping(address sender => Peer)) public peers;
  /// @notice Faster-than-finality block depth this contract accepts from trusted senders (0 = finality only).
  mapping(uint64 sourceChain => uint16) public minFinalityDepth;
  /// @notice CCIP messageIds already handled (defence in depth on top of the OffRamp's own execution state).
  mapping(bytes32 messageId => bool) public seenMessage;

  event PeerSet(uint64 indexed chain, address indexed peer, Peer kind);
  event MinFinalityDepthSet(uint64 indexed chain, uint16 depth);
  event NativeWithdrawn(address indexed to, uint256 amount);

  error UntrustedSender(uint64 sourceChain, address sender);
  error MessageReplayed(bytes32 messageId);
  error OnlySelf();
  error ZeroAddress();
  error InsufficientFee(uint256 fee, uint256 available);
  error NativeTransferFailed();
  error BadSenderEncoding();

  modifier onlySelf() {
    if (msg.sender != address(this)) revert OnlySelf();
    _;
  }

  constructor(address router, uint64 localChain_, address owner_) CCIPReceiver(router) Ownable(owner_) {
    localChain = localChain_;
  }

  receive() external payable {}

  // ---------------------------------------------------------------- admin

  function setPeer(uint64 chain, address peer, Peer kind) external onlyOwner {
    if (peer == address(0)) revert ZeroAddress();
    peers[chain][peer] = kind;
    emit PeerSet(chain, peer, kind);
  }

  function setMinFinalityDepth(uint64 chain, uint16 depth) external onlyOwner {
    minFinalityDepth[chain] = depth;
    emit MinFinalityDepthSet(chain, depth);
  }

  function withdrawNative(address payable to, uint256 amount) external onlyOwner {
    (bool ok,) = to.call{value: amount}("");
    if (!ok) revert NativeTransferFailed();
    emit NativeWithdrawn(to, amount);
  }

  function withdrawToken(IERC20 token, address to, uint256 amount) external virtual onlyOwner {
    token.safeTransfer(to, amount);
  }

  // ---------------------------------------------------------------- CCIP 2.0 receiver policy

  /// @notice Default verifier set; trusted senders may use faster-than-finality at or above `minFinalityDepth`.
  function getCCVsAndFinalityConfig(uint64 sourceChain, bytes calldata sender)
    external
    view
    override
    returns (address[] memory requiredCCVs, address[] memory optionalCCVs, uint8 optionalThreshold, bytes4 allowedFinalityConfig)
  {
    bytes4 allowed = FinalityCodec.WAIT_FOR_FINALITY_FLAG;
    uint16 depth = minFinalityDepth[sourceChain];
    if (depth != 0 && sender.length == 32 && peers[sourceChain][abi.decode(sender, (address))] != Peer.NONE) {
      allowed = FinalityCodec._encodeBlockDepth(depth);
    }
    return (new address[](0), new address[](0), 0, allowed);
  }

  // ---------------------------------------------------------------- helpers

  /// @dev Validates the CCIP source and marks the messageId seen. Reverting here leaves the message failed in CCIP,
  ///      which the owner can fix (allowlist) and then manually execute from the CCIP explorer.
  function _accept(Client.Any2EVMMessage memory message) internal returns (address sender, Peer kind) {
    if (message.sender.length != 32) revert BadSenderEncoding();
    sender = abi.decode(message.sender, (address));
    kind = peers[message.sourceChainSelector][sender];
    if (kind == Peer.NONE) revert UntrustedSender(message.sourceChainSelector, sender);
    if (seenMessage[message.messageId]) revert MessageReplayed(message.messageId);
    seenMessage[message.messageId] = true;
  }

  function _buildMessage(
    address receiver,
    bytes memory data,
    address token,
    uint256 amount,
    uint32 gasLimit,
    uint16 finalityDepth,
    address feeToken
  ) internal pure returns (Client.EVM2AnyMessage memory m) {
    Client.EVMTokenAmount[] memory tokenAmounts;
    if (amount == 0) {
      tokenAmounts = new Client.EVMTokenAmount[](0);
    } else {
      tokenAmounts = new Client.EVMTokenAmount[](1);
      tokenAmounts[0] = Client.EVMTokenAmount({token: token, amount: amount});
    }
    bytes4 finality = finalityDepth == 0 ? FinalityCodec.WAIT_FOR_FINALITY_FLAG : FinalityCodec._encodeBlockDepth(finalityDepth);
    m = Client.EVM2AnyMessage({
      receiver: abi.encode(receiver),
      data: data,
      tokenAmounts: tokenAmounts,
      feeToken: feeToken,
      extraArgs: ExtraArgsCodec._getBasicEncodedExtraArgsV3(gasLimit, finality)
    });
  }

  /// @dev Sends `m` to `chain`. Native fees come from `nativeAvailable` (already held by this contract);
  ///      LINK (or another fee token) fees must already sit in this contract.
  function _send(uint64 chain, Client.EVM2AnyMessage memory m, uint256 nativeAvailable)
    internal
    returns (bytes32 messageId, uint256 fee)
  {
    IRouterClient router = IRouterClient(getRouter());
    fee = router.getFee(chain, m);
    if (m.tokenAmounts.length != 0) IERC20(m.tokenAmounts[0].token).forceApprove(address(router), m.tokenAmounts[0].amount);
    if (m.feeToken == address(0)) {
      if (fee > nativeAvailable) revert InsufficientFee(fee, nativeAvailable);
      messageId = router.ccipSend{value: fee}(chain, m);
    } else {
      uint256 bal = IERC20(m.feeToken).balanceOf(address(this));
      if (fee > bal) revert InsufficientFee(fee, bal);
      IERC20(m.feeToken).forceApprove(address(router), fee);
      messageId = router.ccipSend(chain, m);
    }
  }
}
