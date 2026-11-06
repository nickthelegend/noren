// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

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
  function ship(address app, bytes calldata strategy, address[] calldata tokens, uint256[] calldata amounts)
    external
    returns (bytes32 strategyHash);
  function dock(address app, bytes32 strategyHash, address[] calldata tokens) external;
}

/// @notice SwapVM v1.0.2 router ABI (swap(order, tokenIn, tokenOut, amount, takerTraitsAndData)).
/// `traits` is SwapVM's MakerTraits (a uint256). Noren calls the NorenAquaSwapVMRouter build in
/// packages/aqua/swapvm-ext through this ABI only (SwapVM-1.1 Pure Caller Use).
interface ISwapVMRouter {
  struct Order {
    address maker;
    uint256 traits;
    bytes data;
  }

  function AQUA() external view returns (address);
  function NOREN_ORACLE_PEG_OPCODE() external view returns (uint8);
  function hash(Order calldata order) external view returns (bytes32);
  function quote(Order calldata order, address tokenIn, address tokenOut, uint256 amount, bytes calldata takerTraitsAndData)
    external
    view
    returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash);
  function swap(Order calldata order, address tokenIn, address tokenOut, uint256 amount, bytes calldata takerTraitsAndData)
    external
    returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash);
}

/// @notice What NorenGateway and NorenCredit need from NorenLiquidity.
interface INorenLiquidity {
  function bestQuoteForUsdg(address asset, uint256 usdgOut) external view returns (bytes32 strategyHash, uint256 assetIn);
  function sellForUsdg(address asset, uint256 usdgOut, uint256 maxAssetIn, address to)
    external
    returns (uint256 assetIn, bytes32 strategyHash);
  function liquidate(address asset, uint256 amount, uint256 debtUsdg, uint16 bonusBps, address proceedsTo, address bonusTo)
    external
    returns (uint256 proceeds, uint256 sold, uint256 bonus, uint256 excessUsdg);
}
