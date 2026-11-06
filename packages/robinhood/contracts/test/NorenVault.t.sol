// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from '@oz/utils/math/Math.sol';
import {RobinhoodBase} from './RobinhoodBase.sol';
import {NorenVault} from '../src/NorenVault.sol';
import {RobinhoodMainnet as RH} from '../script/RobinhoodMainnet.sol';

contract NorenVaultTest is RobinhoodBase {
  function test_lpDepositAndRedeemAtPar() public view {
    assertEq(vault.totalAssets(), 100_000e6);
    assertEq(vault.convertToAssets(vault.balanceOf(lp)), 100_000e6);
    assertEq(vault.decimals(), 12, 'USDG 6 + 6 decimals of virtual-share offset');
  }

  function test_depositWithUsdgPermit() public {
    _fund(RH.USDG, customer, 1_000e6);
    uint256 deadline = block.timestamp + 1 hours;
    (uint8 v, bytes32 r, bytes32 s) = _permitSig(customerKey, RH.USDG, address(vault), 1_000e6, deadline);
    vm.prank(customer);
    uint256 shares = vault.depositWithPermit(1_000e6, customer, deadline, v, r, s);
    assertGt(shares, 0);
    assertEq(usdg.balanceOf(customer), 0);
  }

  function test_onlyModulesDisburse() public {
    vm.expectRevert(abi.encodeWithSelector(NorenVault.NotModule.selector, address(this)));
    vault.disburse(address(this), 1e6);
  }

  function test_disburseCappedByIdle() public {
    vm.prank(address(gateway));
    vm.expectRevert(abi.encodeWithSelector(NorenVault.InsufficientLiquidity.selector, 100_001e6, 100_000e6));
    vault.disburse(merchant, 100_001e6);
  }

  function test_navCountsStockInventoryAtOraclePrice() public {
    _fund(RH.NVDA, address(vault), 10e18);
    uint256 inv = oracle.usd8ToUsdg(oracle.valueUsd8(RH.NVDA, 10e18), Math.Rounding.Floor);
    assertEq(vault.inventoryUsdg(), inv);
    assertEq(vault.totalAssets(), 100_000e6 + inv);
  }

  function test_withdrawLimitedToIdleUsdg() public {
    // Pay out 60k so only 40k USDG is idle while the rest is stock inventory.
    _fund(RH.NVDA, address(vault), 400e18);
    vm.prank(address(gateway));
    vault.disburse(merchant, 60_000e6);
    assertEq(vault.maxWithdraw(lp), 40_000e6);
    vm.prank(lp);
    vm.expectRevert();
    vault.withdraw(40_001e6, lp, lp);
    vm.prank(lp);
    vault.withdraw(40_000e6, lp, lp);
  }

  function test_buyInventoryAtOraclePlusSpread() public {
    _requireMarketOpen();
    _fund(RH.NVDA, address(vault), 5e18);
    uint256 usd8 = oracle.valueUsd8(RH.NVDA, 2e18);
    uint256 expected = oracle.usd8ToUsdg(Math.mulDiv(usd8, 10_050, 10_000, Math.Rounding.Ceil), Math.Rounding.Ceil);
    _fund(RH.USDG, customer, expected);
    vm.startPrank(customer);
    usdg.approve(address(vault), expected);
    vm.expectRevert(abi.encodeWithSelector(NorenVault.Slippage.selector, expected, expected - 1));
    vault.buyInventory(RH.NVDA, 2e18, expected - 1);
    uint256 paid = vault.buyInventory(RH.NVDA, 2e18, expected);
    vm.stopPrank();
    assertEq(paid, expected);
    assertEq(nvda.balanceOf(customer), 2e18);
    assertEq(nvda.balanceOf(address(vault)), 3e18);
  }

  function test_cannotBuyUsdgAsInventory() public {
    vm.expectRevert(abi.encodeWithSelector(NorenVault.NotInventory.selector, RH.USDG));
    vault.buyInventory(RH.USDG, 1e6, 1e6);
  }

  function test_adminOnly() public {
    vm.expectRevert();
    vault.setModule(address(this), true);
    vm.prank(owner);
    vm.expectRevert(NorenVault.BadConfig.selector);
    vault.setInventorySpread(1_001);
  }
}
