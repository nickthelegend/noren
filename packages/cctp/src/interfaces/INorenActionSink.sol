// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Copied from packages/ccip/src/interfaces/INorenActionSink.sol (branch `ccip`, de4428b).
/// Where a rail (CCIP gateway or CCTP hook) hands a delivered message. On Arc this is NorenArcActionRouter.
/// @dev The rail transfers `amount` of `token` to the sink before calling. `rail` is keccak256("CCIP") or
///      keccak256("CCTP"); `msgId` is the CCIP messageId or the CCTP nonce; `source` is the CCIP chain selector or
///      the CCTP domain; `sourceSender` is the account that started the transfer on the source chain.
///      A sink must not revert for a well-formed call: it books failures as claimable balances instead.
interface INorenActionSink {
  function execute(
    bytes32 rail,
    bytes32 msgId,
    uint64 source,
    address sourceSender,
    address token,
    uint256 amount,
    bytes calldata action
  ) external returns (bool ok);
}
