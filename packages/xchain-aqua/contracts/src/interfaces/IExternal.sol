// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC165} from '@oz/utils/introspection/IERC165.sol';

/// @notice Chainlink CRE consumer interface. The KeystoneForwarder calls onReport after verifying
/// the DON signatures on a report, and checks ERC-165 support first.
interface IReceiver is IERC165 {
  function onReport(bytes calldata metadata, bytes calldata report) external;
}

/// @notice Chainlink Data Feeds proxy interface (AggregatorV3Interface).
interface IAggregatorV3 {
  function decimals() external view returns (uint8);
  function description() external view returns (string memory);
  function latestRoundData()
    external
    view
    returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @notice The parts of 1inch Aqua (registry 0x1111113ccf1426a8e30e2bff5e005d929bf6a90a) that Noren
/// calls, written from the published ABI. Noren only calls Aqua; it contains no Aqua source.
interface IAqua {
  function rawBalances(address maker, address app, bytes32 strategyHash, address token)
    external
    view
    returns (uint248 balance, uint8 tokensCount);
  function safeBalances(address maker, address app, bytes32 strategyHash, address token0, address token1)
    external
    view
    returns (uint256 balance0, uint256 balance1);
}

/// @notice SwapVM v1.0.2 router ABI. Noren calls the NorenAquaSwapVMRouter build in
/// packages/aqua/swapvm-ext through this ABI only (SwapVM-1.1 Pure Caller Use).
interface ISwapVMRouter {
  struct Order {
    address maker;
    uint256 traits;
    bytes data;
  }

  function AQUA() external view returns (address);
  function NOREN_ORACLE_PEG_OPCODE() external view returns (uint8);
  function swap(Order calldata order, address tokenIn, address tokenOut, uint256 amount, bytes calldata takerTraitsAndData)
    external
    returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash);
}
