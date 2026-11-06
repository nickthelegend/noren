// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The parts of the Robinhood Chain Stock Token (beacon proxy) that Tsuke reads.
/// Selectors were read from the live implementation behind beacon
/// 0xe10b6f6B275de231345c20D14Ab812db62151b00 on chain 4663.
interface IRobinhoodStockToken {
  /// @notice 1e18-scaled shares per raw token (dividends and splits move it).
  function uiMultiplier() external view returns (uint256);
  function newUIMultiplier() external view returns (uint256);
  function effectiveAt() external view returns (uint256);
  function paused() external view returns (bool);
  function tokenPaused() external view returns (bool);
  function ACCESS_CONTROLLED_REGISTRY() external view returns (address);
}

/// @notice Robinhood's access-controlled registry (also the Stock Token beacon).
interface IRobinhoodRegistry {
  function isBlocked(address account) external view returns (bool);
  function paused() external view returns (bool);
}
