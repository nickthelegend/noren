// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Noren's shared Arc action router (packages/ccip/src/NorenArcActionRouter.sol on branch `ccip`),
///         vendored here until that branch lands. One router serves both value rails (CCIP and CCTP).
///         The caller transfers `amount` of `token` to the router first, then calls execute. Each (rail, msgId)
///         executes once. `action = abi.encode(uint8 kind, address beneficiary, bytes32 ref, bytes params)`:
///           1 PAY_INVOICE   params = abi.encode(address merchant, bytes32 invoiceId)
///           2 EARN_DEPOSIT  params = abi.encode(address vault)   (allowlisted ERC-4626)
///           3 AQUA_ORDER    params = opaque order bytes (defined by the cross-chain Aqua module)
///           4 CREDIT_LINE   params = abi.encode(bytes32 lineId, uint256 limitUsdc6, uint64 expiry)
///         A failed action or unknown kind becomes a claimable balance for the beneficiary.
interface INorenArcActionRouter {
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
