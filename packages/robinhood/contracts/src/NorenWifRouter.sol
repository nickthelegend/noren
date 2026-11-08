// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {SafeERC20} from '@oz/token/ERC20/utils/SafeERC20.sol';
import {Math} from '@oz/utils/math/Math.sol';

/// @notice Minimal v4 two-hop router. Pool keys and callback settlement follow NoroshiRouter
/// (nickthelegend/noroshi, MIT); this router nets both swaps in one PoolManager unlock.
contract NorenWifRouter {
  using SafeERC20 for IERC20;

  struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }
  struct SwapParams { bool zeroForOne; int256 amountSpecified; uint160 sqrtPriceLimitX96; }

  address public constant WIF = 0x5173b8eA6923c2d40267890D45C46a3480954773;
  address public constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
  IV4Manager public constant manager = IV4Manager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
  IV4State public constant stateView = IV4State(0xF3334192D15450CdD385c8B70e03f9A6bD9E673b);
  uint160 private constant MIN_PRICE = 4295128740;
  uint160 private constant MAX_PRICE = 1461446703485210103287273052203988822378723970341;

  error NotManager();
  error Slippage();
  error BadPool();

  function wifKey() public pure returns (PoolKey memory) {
    return PoolKey(address(0), WIF, 0, 200, 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044);
  }

  function usdgKey() public pure returns (PoolKey memory) {
    return PoolKey(address(0), USDG, 500, 10, address(0));
  }

  function poolId(PoolKey memory key) public pure returns (bytes32) { return keccak256(abi.encode(key)); }

  /// @notice Spot-based display quote with a 3% execution cushion. The swap enforces maxWifIn.
  function quoteWifForUsdg(uint256 amountUsdg) external view returns (uint256) {
    (uint160 usd,,,) = stateView.getSlot0(poolId(usdgKey()));
    (uint160 wif,,,) = stateView.getSlot0(poolId(wifKey()));
    if (usd == 0 || wif == 0) revert BadPool();
    uint256 eth = Math.mulDiv(amountUsdg, 2 ** 192, uint256(usd) * usd, Math.Rounding.Ceil);
    return Math.mulDiv(eth, uint256(wif) * wif, 2 ** 192, Math.Rounding.Ceil) * 103 / 100 + 1;
  }

  /// @notice Exact USDG output. The payer's unused WIF is returned in this transaction.
  function wifForExactUsdg(uint256 amountUsdg, uint256 maxWifIn, address recipient) external returns (uint256 spent) {
    IERC20(WIF).safeTransferFrom(msg.sender, address(this), maxWifIn);
    spent = abi.decode(manager.unlock(abi.encode(uint8(0), amountUsdg, maxWifIn, recipient)), (uint256));
    if (spent > maxWifIn) revert Slippage();
    IERC20(WIF).safeTransfer(msg.sender, maxWifIn - spent);
  }

  /// @notice Convert accrued USDG fee into WIF for the caller to burn.
  function usdgForWif(uint256 amountUsdg, uint256 minWifOut, address recipient) external returns (uint256 out) {
    IERC20(USDG).safeTransferFrom(msg.sender, address(this), amountUsdg);
    out = abi.decode(manager.unlock(abi.encode(uint8(1), amountUsdg, minWifOut, recipient)), (uint256));
  }

  function unlockCallback(bytes calldata data) external returns (bytes memory) {
    if (msg.sender != address(manager)) revert NotManager();
    (uint8 mode, uint256 amount, uint256 limit, address recipient) = abi.decode(data, (uint8, uint256, uint256, address));
    if (mode == 0) {
      int256 usdDelta = manager.swap(usdgKey(), SwapParams(true, int256(amount), MIN_PRICE), '');
      uint256 ethIn = uint256(uint128(-_amount0(usdDelta)));
      int256 wifDelta = manager.swap(wifKey(), SwapParams(false, int256(ethIn), MAX_PRICE), '');
      uint256 wifIn = uint256(uint128(-_amount1(wifDelta)));
      if (wifIn > limit) revert Slippage();
      manager.sync(WIF);
      IERC20(WIF).safeTransfer(address(manager), wifIn);
      manager.settle();
      manager.take(USDG, recipient, amount);
      return abi.encode(wifIn);
    }
    int256 usdDelta = manager.swap(usdgKey(), SwapParams(false, -int256(amount), MAX_PRICE), '');
    uint256 ethOut = uint256(uint128(_amount0(usdDelta)));
    int256 wifDelta = manager.swap(wifKey(), SwapParams(true, -int256(ethOut), MIN_PRICE), '');
    uint256 wifOut = uint256(uint128(_amount1(wifDelta)));
    if (wifOut < limit) revert Slippage();
    manager.sync(USDG);
    IERC20(USDG).safeTransfer(address(manager), amount);
    manager.settle();
    manager.take(WIF, recipient, wifOut);
    return abi.encode(wifOut);
  }

  function _amount0(int256 d) private pure returns (int128) { return int128(d >> 128); }
  function _amount1(int256 d) private pure returns (int128) { return int128(d); }
}

interface IV4Manager {
  function unlock(bytes calldata data) external returns (bytes memory);
  function swap(NorenWifRouter.PoolKey calldata key, NorenWifRouter.SwapParams calldata params, bytes calldata hookData) external returns (int256);
  function sync(address currency) external;
  function settle() external payable returns (uint256);
  function take(address currency, address to, uint256 amount) external;
}

interface IV4State {
  function getSlot0(bytes32 poolId) external view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee);
}
