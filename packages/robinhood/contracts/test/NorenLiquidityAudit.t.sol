// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {RobinhoodBase} from './RobinhoodBase.sol';
import {NorenLiquidity} from '../src/NorenLiquidity.sol';
import {NorenVault} from '../src/NorenVault.sol';
import {ISwapVMRouter} from '../src/interfaces/IAquaSwapVM.sol';
import {RobinhoodMainnet as RH} from '../script/RobinhoodMainnet.sol';

/// @notice Regression tests for the audit findings on NorenLiquidity and NorenVault (docs/SECURITY.md),
/// on a fresh Robinhood mainnet fork with the official Aqua registry and real tokens and feeds.
contract NorenLiquidityAuditTest is RobinhoodBase {
  address internal maker = makeAddr('maker');
  address internal squatter = makeAddr('squatter');
  address internal seller = makeAddr('seller');

  /// RH-L-1: permissionless registration lets anyone fill an asset's routing slots. The owner can now
  /// remove a still-shipped strategy and switch on the maker allowlist.
  function test_Audit_RHL1_ownerClearsSquattedSlotsAndAllowlistBlocksSquatter() public {
    vm.prank(owner);
    liquidity.setLimits(300, 300, 2);
    bytes32 s0 = _shipMaker(squatter, RH.NVDA, 1e6, 0, 80, 0);
    _shipMaker(squatter, RH.NVDA, 1e6, 0, 80, 1);

    // A real maker is locked out while the slots are squatted.
    (ISwapVMRouter.Order memory o,) = liquidity.buildOrder(maker, RH.NVDA, _terms(7));
    _ship(maker, o, 1_000e6);
    vm.prank(maker);
    vm.expectRevert(abi.encodeWithSelector(NorenLiquidity.TooManyStrategies.selector, RH.NVDA));
    liquidity.register(RH.NVDA, _terms(7));

    // A stranger still cannot remove a shipped strategy; the owner can.
    vm.prank(seller);
    vm.expectRevert(abi.encodeWithSelector(NorenLiquidity.NotRemovable.selector, s0));
    liquidity.remove(s0);
    vm.prank(owner);
    liquidity.remove(s0);
    assertFalse(liquidity.strategy(s0).active);

    // With the allowlist on, the squatter cannot take the slot back; an approved maker can.
    vm.startPrank(owner);
    liquidity.setMakerAllowlist(true);
    liquidity.setMakerApproved(maker, true);
    vm.stopPrank();
    vm.prank(squatter);
    vm.expectRevert(abi.encodeWithSelector(NorenLiquidity.MakerNotApproved.selector, squatter));
    liquidity.register(RH.NVDA, _terms(0));
    vm.prank(maker);
    bytes32 h = liquidity.register(RH.NVDA, _terms(7));
    assertTrue(liquidity.strategy(h).active);
  }

  /// RH-L-2: a fill NorenAssetOracle cannot price (asset disabled, or a stale feed) booked the whole
  /// USDG paid as maker fee in buyFromMakers, inflating feesPerShare-based yield. It now books 0.
  function test_Audit_RHL2_unpriceableAskFillBooksNoFee() public {
    (ISwapVMRouter.Order memory o, bytes32 h) = liquidity.buildOrder(maker, RH.WETH, _terms(30));
    _fund(RH.WETH, maker, 1 ether);
    address[] memory tokens = _tokens(RH.WETH);
    uint256[] memory amounts = new uint256[](2);
    amounts[1] = 1 ether;
    vm.startPrank(maker);
    IERC20(RH.WETH).approve(RH.AQUA, type(uint256).max);
    aqua.ship(address(swapRouter), abi.encode(o), tokens, amounts);
    liquidity.register(RH.WETH, _terms(30));
    vm.stopPrank();

    // Noren's oracle now refuses the ETH price as stale (1 s max age); the instruction's baked-in feed
    // terms still price the fill. (disableAsset no longer makes price() revert, see audit RH-C-4.)
    vm.prank(owner);
    oracle.setAsset(RH.WETH, RH.FEED_ETH, 1, 1, false, false);
    vm.warp(block.timestamp + 2);
    vm.expectRevert();
    oracle.price(RH.WETH);
    (bytes32 best, uint256 usdgIn) = liquidity.bestAskForAsset(RH.WETH, 0.01 ether);
    assertEq(best, h);
    _fund(RH.USDG, seller, usdgIn);
    vm.startPrank(seller);
    usdg.approve(address(liquidity), usdgIn);
    liquidity.buyFromMakers(RH.WETH, 0.01 ether, usdgIn, seller);
    vm.stopPrank();
    assertEq(IERC20(RH.WETH).balanceOf(seller), 0.01 ether);
    assertEq(liquidity.strategy(h).feesUsdg, 0, 'no fee booked for an unpriced fill');
    assertEq(liquidity.makerFeesUsdg(maker), 0);
    assertEq(liquidity.strategy(h).volumeUsdg, usdgIn);
  }

  /// RH-L-3: sellExactAsset / sellForUsdg with to = 0 or to = NorenLiquidity left the USDG stranded in
  /// NorenLiquidity (no sweep). The caller now receives it.
  function test_Audit_RHL3_sellToZeroOrSelfPaysTheCaller() public {
    _shipMaker(maker, RH.NVDA, 10_000e6, 50, 80, 0);
    _fund(RH.NVDA, seller, 2e18);
    vm.startPrank(seller);
    nvda.approve(address(liquidity), type(uint256).max);
    (uint256 out1,) = liquidity.sellExactAsset(RH.NVDA, 1e17, 1, address(0));
    (uint256 in2,) = liquidity.sellForUsdg(RH.NVDA, 5e6, 1e18, address(liquidity));
    vm.stopPrank();
    assertGt(out1, 0);
    assertGt(in2, 0);
    assertEq(usdg.balanceOf(seller), out1 + 5e6, 'caller got both proceeds');
    assertEq(usdg.balanceOf(address(liquidity)), 0, 'nothing stranded in NorenLiquidity');
  }

  /// RH-V-1: buyInventory for a dust amount whose oracle value floors to 0 transferred inventory for 0 USDG.
  function test_Audit_RHV1_dustInventoryIsNeverFree() public {
    _fund(RH.NVDA, address(vault), 1e18);
    vm.prank(seller);
    vm.expectRevert(abi.encodeWithSelector(NorenVault.DustAmount.selector, uint256(1)));
    vault.buyInventory(RH.NVDA, 1, 0);
    assertEq(nvda.balanceOf(seller), 0);
  }

  // ------------------------------------------------------------ helpers

  function _terms(uint16 bid) internal pure returns (NorenLiquidity.PegTerms memory) {
    return NorenLiquidity.PegTerms(bid, 80, 300, 0, 0, 0);
  }

  function _tokens(address asset) internal pure returns (address[] memory tokens) {
    tokens = new address[](2);
    tokens[0] = RH.USDG;
    tokens[1] = asset;
  }

  function _ship(address who, ISwapVMRouter.Order memory o, uint256 usdgAmount) internal {
    _fund(RH.USDG, who, usdgAmount);
    uint256[] memory amounts = new uint256[](2);
    amounts[0] = usdgAmount;
    vm.startPrank(who);
    usdg.approve(RH.AQUA, type(uint256).max);
    aqua.ship(address(swapRouter), abi.encode(o), _tokens(RH.NVDA), amounts);
    vm.stopPrank();
  }
}
