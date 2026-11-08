// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {RobinhoodBase} from './RobinhoodBase.sol';
import {RobinhoodMainnet as RH} from '../script/RobinhoodMainnet.sol';
import {NorenWifRouter} from '../src/NorenWifRouter.sol';
import {NorenGateway} from '../src/NorenGateway.sol';

contract NorenWifEditionTest is RobinhoodBase {
  NorenWifRouter internal router;
  IERC20 internal wif = IERC20(0x5173b8eA6923c2d40267890D45C46a3480954773);

  function setUp() public override {
    super.setUp();
    router = new NorenWifRouter();
    vm.prank(owner); gateway.setWifRouter(router);
  }

  function testWifPaysExactUsdgAndWaivesFee() public {
    bytes32 id = keccak256('wif-pay');
    _invoice(id, 10e6);
    uint256 quote = router.quoteWifForUsdg(10e6);
    _fund(address(wif), customer, quote * 2);
    vm.startPrank(customer);
    wif.approve(address(gateway), quote * 2);
    vm.expectRevert();
    gateway.pay(id, merchant, address(wif), quote - 1);
    uint256 before = usdg.balanceOf(merchant);
    uint256 spent = gateway.pay(id, merchant, address(wif), quote * 2);
    vm.stopPrank();
    assertGt(spent, 0);
    assertEq(usdg.balanceOf(merchant) - before, 10e6);
    assertEq(gateway.accruedUsdg(), 0);
    assertEq(uint256(gateway.invoice(merchant, id).status), uint256(NorenGateway.Status.Paid));
  }

  function testUsdgAndStockAccrueThenBurnRealWif() public {
    bytes32 usdId = keccak256('usdg-pay');
    _invoice(usdId, 1000e6);
    _fund(RH.USDG, customer, 1003e6);
    vm.startPrank(customer);
    usdg.approve(address(gateway), 1003e6);
    uint256 beforeMerchant = usdg.balanceOf(merchant);
    gateway.pay(usdId, merchant, RH.USDG, 1003e6);
    vm.stopPrank();
    assertEq(usdg.balanceOf(merchant) - beforeMerchant, 1000e6);
    assertEq(gateway.accruedUsdg(), 3e6);

    bytes32 stockId = keccak256('stock-pay');
    _invoice(stockId, 25e6);
    (uint256 stockIn,,) = gateway.quote(merchant, stockId, RH.NVDA);
    _fund(RH.NVDA, customer, stockIn);
    vm.startPrank(customer);
    nvda.approve(address(gateway), stockIn);
    gateway.pay(stockId, merchant, RH.NVDA, stockIn);
    vm.stopPrank();
    assertEq(usdg.balanceOf(merchant) - beforeMerchant, 1025e6);
    uint256 fee = gateway.accruedUsdg();
    assertGt(fee, 3e6);
    uint256 supplyBefore = wif.totalSupply();
    uint256 tipBefore = wif.balanceOf(customer);
    vm.prank(customer);
    uint256 burned = gateway.burnAccrued(1);
    assertEq(wif.totalSupply(), supplyBefore - burned);
    assertEq(gateway.totalWifBurned(), burned);
    assertGt(wif.balanceOf(customer), tipBefore);
    assertEq(gateway.accruedUsdg(), 0);
  }

  function testFeeAdminAndThreshold() public {
    vm.expectRevert(); gateway.setWifFeeConfig(20, 9000, 100, 1e6);
    vm.startPrank(owner);
    vm.expectRevert(NorenGateway.BadConfig.selector); gateway.setWifFeeConfig(101, 10_000, 100, 1e6);
    vm.expectRevert(NorenGateway.BadConfig.selector); gateway.setWifFeeConfig(30, 10_001, 100, 1e6);
    vm.expectRevert(NorenGateway.BadConfig.selector); gateway.setWifFeeConfig(30, 10_000, 501, 1e6);
    gateway.setWifFeeConfig(30, 10_000, 100, 10e6);
    vm.stopPrank();
    _invoice(keccak256('small'), 100e6);
    _fund(RH.USDG, customer, 100_300_000);
    vm.startPrank(customer);
    usdg.approve(address(gateway), 100_300_000);
    gateway.pay(keccak256('small'), merchant, RH.USDG, 100_300_000);
    vm.expectRevert();
    gateway.burnAccrued(1);
    vm.stopPrank();
  }
}
