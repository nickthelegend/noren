// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Minimal interfaces of the live Robinhood Chain contracts the settlement desk calls.

interface IAggregatorV3 {
  function decimals() external view returns (uint8);
  function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @dev Robinhood Stock Tokens: ERC-8056 split multiplier (1e18 = 1 share per token).
interface IStockToken {
  function uiMultiplier() external view returns (uint256);
}

interface IPermit2 {
  function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface IUniversalRouter {
  function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

/// @dev Uniswap v4 types, as used by the Universal Router's V4_SWAP command.
struct PoolKey {
  address currency0;
  address currency1;
  uint24 fee;
  int24 tickSpacing;
  address hooks;
}

/// @dev The Universal Routers deployed on Robinhood Chain (0x8876…0904 and 2.1.2 at 0x204F…0498)
///      decode a sixth field after amountOutMinimum. Checked on a mainnet fork: the five-field layout
///      reverts in unlockCallback, this layout swaps. The field name follows later v4-periphery code
///      and is not verified against the deployed source; 0 sets no per-hop price limit.
struct ExactInputSingleParams {
  PoolKey poolKey;
  bool zeroForOne;
  uint128 amountIn;
  uint128 amountOutMinimum;
  uint256 minHopPriceX36;
  bytes hookData;
}
