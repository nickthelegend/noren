// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Outbound side of a message transport (for example a CCIP two-hop sender). Optional: with
/// Chainlink CRE no outbound call is needed, because the workflow's log trigger reads the events.
interface IXChainOutbox {
  /// @notice Send `payload` to `receiver` on `dstChainId`. Returns a transport message id.
  function send(uint64 dstChainId, address receiver, bytes calldata payload) external payable returns (bytes32 messageId);
}

/// @title XChainInbox
/// @notice Shared inbound plumbing for the Noren cross-chain escrow and settler. A message arrives
/// either as a Chainlink CRE report (`onReport`, from the chain's KeystoneForwarder after it verified
/// the DON's signatures) or from an authorised transport adapter (`receiveXChain`, e.g. a CCIP
/// receiver that already checked the source chain and sender). Both paths carry the same payload
/// bytes and end in `_handle`, so the order and fill messages are transport-independent.
abstract contract XChainInbox {
  /// @notice CRE forwarder allowed to call onReport (MockKeystoneForwarder in simulation).
  address public forwarder;
  /// @notice Optional CRE workflow owner pin (zero = off; the simulation forwarder sends no metadata).
  address public expectedWorkflowOwner;
  /// @notice Transport adapters allowed to call receiveXChain (none by default).
  mapping(address adapter => bool) public transports;
  /// @notice Optional outbound transport used in addition to events (none by default).
  IXChainOutbox public outbox;

  event ForwarderSet(address indexed forwarder);
  event ExpectedWorkflowOwnerSet(address indexed workflowOwner);
  event TransportSet(address indexed adapter, bool allowed);
  event OutboxSet(address indexed outbox);
  event OutboxSent(bytes32 indexed messageId, uint64 dstChainId, address receiver);

  error NotForwarder(address caller);
  error NotTransport(address caller);
  error InvalidWorkflowOwner(address got, address expected);

  /// @notice CRE entry point (IReceiver).
  function onReport(bytes calldata metadata, bytes calldata report) external {
    if (msg.sender != forwarder) revert NotForwarder(msg.sender);
    if (expectedWorkflowOwner != address(0)) {
      // metadata = abi.encodePacked(bytes32 workflowId, bytes10 workflowName, address workflowOwner) [+ bytes2 reportId]
      address owner_ = metadata.length >= 62 ? address(bytes20(metadata[42:62])) : address(0);
      if (owner_ != expectedWorkflowOwner) revert InvalidWorkflowOwner(owner_, expectedWorkflowOwner);
    }
    // CRE vouches for the payload's origin: the DON read it from the source chain.
    _handle(report, 0, address(0));
  }

  /// @notice Transport entry point: an adapter delivers `payload` sent by `srcSender` on `srcChainId`.
  function receiveXChain(uint64 srcChainId, address srcSender, bytes calldata payload) external {
    if (!transports[msg.sender]) revert NotTransport(msg.sender);
    _handle(payload, srcChainId, srcSender);
  }

  function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
    // IReceiver (onReport) and IERC165
    return interfaceId == 0x805f2132 || interfaceId == 0x01ffc9a7;
  }

  /// @dev `srcChainId`/`srcSender` are zero for CRE reports; a transport delivery must name the
  /// contract that is expected to have sent the payload.
  function _handle(bytes calldata payload, uint64 srcChainId, address srcSender) internal virtual;

  function _sendOut(uint64 dstChainId, address receiver, bytes memory payload) internal {
    IXChainOutbox o = outbox;
    if (address(o) == address(0)) return;
    bytes32 messageId = o.send(dstChainId, receiver, payload);
    emit OutboxSent(messageId, dstChainId, receiver);
  }

  function _setForwarder(address f) internal {
    forwarder = f;
    emit ForwarderSet(f);
  }
}
