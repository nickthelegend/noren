// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title NorenArcAction
/// @notice The action ABI shared by every rail that lands value or instructions on Arc (CCIP via NorenCcipGateway,
///         CCTP via NorenArcHook). One encoding, one router: `NorenArcActionRouter.execute`.
/// @dev action = abi.encode(uint8 kind, address beneficiary, bytes32 ref, bytes params)
library NorenArcAction {
  bytes32 internal constant RAIL_CCIP = keccak256("CCIP");
  bytes32 internal constant RAIL_CCTP = keccak256("CCTP");

  /// params = abi.encode(address merchant, bytes32 invoiceId). Pays the delivered USDC to the merchant.
  uint8 internal constant PAY_INVOICE = 1;
  /// params = abi.encode(address vault). ERC-4626 deposit of the delivered token for the beneficiary.
  uint8 internal constant EARN_DEPOSIT = 2;
  /// params = opaque order bytes (cross-chain Aqua order format). Funds are held under `ref` for the Aqua operator.
  uint8 internal constant AQUA_ORDER = 3;
  /// params = abi.encode(bytes32 lineId, uint256 limitUsdc6, uint64 expiry, uint64 asOf). Opens or updates a line.
  uint8 internal constant CREDIT_LINE = 4;
  /// params = abi.encode(bytes32 lineId, address merchant, bytes32 invoiceId, uint256 amountUsdc6).
  /// Pays a merchant from Arc liquidity against a credit line; only the line's borrower may send it.
  uint8 internal constant PAY_ON_CREDIT = 5;
  /// params = abi.encode(bytes32 lineId, uint256 drawnUsdc6, uint256 repaidUsdc6, uint64 asOf).
  /// Arc -> other chains: the line's utilisation, sent by the router itself.
  uint8 internal constant LINE_REPORT = 6;

  struct Action {
    uint8 kind;
    address beneficiary;
    bytes32 ref;
    bytes params;
  }

  function encode(uint8 kind, address beneficiary, bytes32 ref, bytes memory params) internal pure returns (bytes memory) {
    return abi.encode(kind, beneficiary, ref, params);
  }

  function decode(bytes memory action) internal pure returns (Action memory a) {
    (a.kind, a.beneficiary, a.ref, a.params) = abi.decode(action, (uint8, address, bytes32, bytes));
  }
}
