// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title NorenCcipEnvelope
/// @notice The one message format every Noren CCIP hop carries. A gateway wraps an app payload in an envelope;
///         a hub forwards the envelope unchanged except for `prevMessageId`; the final gateway unwraps it and hands
///         the payload to its app (on Arc: the NorenArcActionRouter, shared with the CCTP rail).
/// @dev `nonce` is per origin gateway, so `(originChain, nonce)` identifies one Noren message across every hop.
///      CCIP 2.0 lanes execute out of order, so receivers key idempotency on that pair and never assume ordering.
library NorenCcipEnvelope {
  uint8 internal constant VERSION = 1;

  struct Envelope {
    uint8 version;
    uint64 originChain; // CCIP chain selector of the chain the user sent from
    address originSender; // msg.sender of NorenCcipGateway.send on the origin chain
    uint64 nonce; // origin gateway's outbound counter
    uint64 finalChain; // CCIP chain selector of the destination
    address finalReceiver; // NorenCcipGateway on the destination
    bytes32 prevMessageId; // CCIP messageId of the previous hop (0 on the first hop; set by a hub)
    bytes payload; // app payload (on Arc: the shared Noren action, see NorenArcAction)
  }

  error UnsupportedVersion(uint8 version);

  function encode(Envelope memory e) internal pure returns (bytes memory) {
    return abi.encode(e);
  }

  function decode(bytes memory data) internal pure returns (Envelope memory e) {
    e = abi.decode(data, (Envelope));
    if (e.version != VERSION) revert UnsupportedVersion(e.version);
  }

  /// @dev Identifies one Noren message across all hops (a hub re-sending it must not deliver it twice).
  function originKey(uint64 originChain, uint64 nonce) internal pure returns (bytes32) {
    return keccak256(abi.encode(originChain, nonce));
  }
}
