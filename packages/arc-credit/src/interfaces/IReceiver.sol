// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IERC165 {
  function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

/// @notice Chainlink CRE consumer interface. The KeystoneForwarder calls onReport after it has
///         verified the DON's signatures over the report.
interface IReceiver is IERC165 {
  function onReport(bytes calldata metadata, bytes calldata report) external;
}
