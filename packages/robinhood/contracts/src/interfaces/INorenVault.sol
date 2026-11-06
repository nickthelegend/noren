// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface INorenVault {
  function disburse(address to, uint256 amountUsdg) external;
}

interface INorenReceivables {
  /// @notice USDG (6 decimals) owed to the vault by open Pay-in-4 plans and liquidations in flight.
  function receivablesUsdg() external view returns (uint256);
}
