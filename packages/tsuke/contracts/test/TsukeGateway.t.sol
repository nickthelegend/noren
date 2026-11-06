// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from 'forge-std/Vm.sol';
import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {TsukeBase, IStockAdmin} from './TsukeBase.sol';
import {TsukeOracle} from '../src/TsukeOracle.sol';
import {TsukeGateway} from '../src/TsukeGateway.sol';
import {IAggregatorV3} from '../src/interfaces/IAggregatorV3.sol';
import {RobinhoodMainnet as RH} from '../script/RobinhoodMainnet.sol';

contract TsukeGatewayTest is TsukeBase {
  bytes32 internal constant INV = keccak256('inv-1');
  uint128 internal constant AMOUNT = 250e6; // 250 USDG

  function setUp() public override {
    super.setUp();
    _invoice(INV, AMOUNT);
  }

  function test_payWithUsdgGoesStraightToMerchant() public {
    _fund(RH.USDG, customer, AMOUNT);
    vm.startPrank(customer);
    usdg.approve(address(gateway), AMOUNT);
    uint256 paid = gateway.pay(INV, merchant, RH.USDG, AMOUNT);
    vm.stopPrank();
    assertEq(paid, AMOUNT);
    assertEq(usdg.balanceOf(merchant), AMOUNT);
    assertEq(uint8(gateway.invoice(merchant, INV).status), uint8(TsukeGateway.Status.Paid));
  }

  function test_payWithUsdgPermit() public {
    _fund(RH.USDG, customer, AMOUNT);
    uint256 deadline = block.timestamp + 10 minutes;
    (uint8 v, bytes32 r, bytes32 s) = _permitSig(customerKey, RH.USDG, address(gateway), AMOUNT, deadline);
    vm.prank(customer);
    gateway.payWithPermit(INV, merchant, RH.USDG, AMOUNT, deadline, v, r, s);
    assertEq(usdg.balanceOf(merchant), AMOUNT);
  }

  function test_payWithStockTokenVaultBuysAtOraclePlusSpread() public {
    _requireMarketOpen();
    (uint256 q, uint256 price8,) = gateway.quote(merchant, INV, RH.NVDA);
    _fund(RH.NVDA, customer, q);
    uint256 vaultIdle = vault.idleUsdg();
    vm.startPrank(customer);
    nvda.approve(address(gateway), q);
    vm.recordLogs();
    uint256 paid = gateway.pay(INV, merchant, RH.NVDA, q);
    vm.stopPrank();
    assertEq(paid, q);
    assertEq(usdg.balanceOf(merchant), AMOUNT, 'merchant receives full invoice in USDG');
    assertEq(nvda.balanceOf(address(vault)), q, 'vault keeps the stock');
    assertEq(vault.idleUsdg(), vaultIdle - AMOUNT);
    // value received >= invoice USD * (1 + 50 bps spread)
    uint256 invoiceUsd8 = oracle.usdgToUsd8(AMOUNT, _ceil());
    assertGe(oracle.valueUsd8(RH.NVDA, q), invoiceUsd8 * 10_050 / 10_000 - 1);
    assertLe(oracle.valueUsd8(RH.NVDA, q), invoiceUsd8 * 10_051 / 10_000);
    assertEq(price8, oracle.price(RH.NVDA).usd8);
    Vm.Log[] memory logs = vm.getRecordedLogs();
    bool seen;
    for (uint256 i; i < logs.length; ++i) {
      if (logs[i].topics[0] == TsukeGateway.InvoicePaid.selector) seen = true;
    }
    assertTrue(seen, 'InvoicePaid emitted');
  }

  function test_payWithStockTokenPermit() public {
    (uint256 q,,) = gateway.quote(merchant, INV, RH.TSLA);
    _fund(RH.TSLA, customer, q);
    uint256 deadline = block.timestamp + 10 minutes;
    (uint8 v, bytes32 r, bytes32 s) = _permitSig(customerKey, RH.TSLA, address(gateway), q, deadline);
    vm.prank(customer);
    gateway.payWithPermit(INV, merchant, RH.TSLA, q, deadline, v, r, s);
    assertEq(tsla.balanceOf(address(vault)), q);
  }

  function test_payWithNativeEthRefundsExcess() public {
    (uint256 q,,) = gateway.quote(merchant, INV, address(0));
    vm.deal(customer, 1 ether);
    vm.prank(customer);
    gateway.pay{value: q + 0.01 ether}(INV, merchant, address(0), q + 0.01 ether);
    assertEq(customer.balance, 1 ether - q, 'excess refunded');
    assertEq(weth.balanceOf(address(vault)), q);
    assertEq(usdg.balanceOf(merchant), AMOUNT);
  }

  function test_slippageGuard() public {
    (uint256 q,,) = gateway.quote(merchant, INV, RH.NVDA);
    _fund(RH.NVDA, customer, q);
    vm.startPrank(customer);
    nvda.approve(address(gateway), q);
    vm.expectRevert(abi.encodeWithSelector(TsukeGateway.Slippage.selector, q, q - 1));
    gateway.pay(INV, merchant, RH.NVDA, q - 1);
    vm.stopPrank();
  }

  function test_replayPaidInvoiceReverts() public {
    _fund(RH.USDG, customer, 2 * uint256(AMOUNT));
    vm.startPrank(customer);
    usdg.approve(address(gateway), 2 * uint256(AMOUNT));
    gateway.pay(INV, merchant, RH.USDG, AMOUNT);
    vm.expectRevert(abi.encodeWithSelector(TsukeGateway.InvoiceNotOpen.selector, TsukeGateway.Status.Paid));
    gateway.pay(INV, merchant, RH.USDG, AMOUNT);
    vm.stopPrank();
  }

  function test_expiredInvoiceReverts() public {
    vm.warp(vm.getBlockTimestamp() + 1 days + 1);
    vm.expectRevert();
    gateway.pay(INV, merchant, RH.USDG, AMOUNT);
  }

  function test_cancelledInvoiceReverts() public {
    vm.prank(merchant);
    gateway.cancelInvoice(INV);
    vm.expectRevert(abi.encodeWithSelector(TsukeGateway.InvoiceNotOpen.selector, TsukeGateway.Status.Cancelled));
    gateway.pay(INV, merchant, RH.USDG, AMOUNT);
  }

  function test_duplicateInvoiceIdRejected() public {
    vm.prank(merchant);
    vm.expectRevert(TsukeGateway.InvoiceExists.selector);
    gateway.createInvoice(INV, 1e6, uint64(block.timestamp + 1 hours));
  }

  function test_blockedPayerGetsReadableError() public {
    (uint256 q,,) = gateway.quote(merchant, INV, RH.NVDA);
    _fund(RH.NVDA, customer, q);
    vm.prank(customer);
    nvda.approve(address(gateway), q);
    _block(customer);
    vm.prank(customer);
    vm.expectRevert(abi.encodeWithSelector(TsukeOracle.AccountBlocked.selector, RH.NVDA, customer));
    gateway.pay(INV, merchant, RH.NVDA, q);
  }

  function test_pausedStockTokenRejected() public {
    (uint256 q,,) = gateway.quote(merchant, INV, RH.NVDA);
    _fund(RH.NVDA, customer, q);
    vm.prank(RH.STOCK_PAUSER);
    IStockAdmin(RH.NVDA).pause();
    vm.prank(customer);
    vm.expectRevert(abi.encodeWithSelector(TsukeOracle.AssetPaused.selector, RH.NVDA));
    gateway.pay(INV, merchant, RH.NVDA, q);
  }

  function test_unsupportedAssetRejected() public {
    vm.expectRevert(abi.encodeWithSelector(TsukeGateway.AssetNotAccepted.selector, address(0xBEEF)));
    gateway.quote(merchant, INV, address(0xBEEF));
  }

  function test_staleUsdgPriceBlocksPayment() public {
    (,,, uint256 updatedAt,) = IAggregatorV3(RH.FEED_USDG).latestRoundData();
    vm.warp(updatedAt + RH.MAX_AGE_OPEN + 1);
    vm.prank(merchant);
    gateway.createInvoice(keccak256('late'), AMOUNT, uint64(block.timestamp + 1 hours));
    vm.deal(customer, 1 ether);
    vm.prank(customer);
    vm.expectRevert(abi.encodeWithSelector(TsukeOracle.StalePrice.selector, RH.USDG, updatedAt, uint256(RH.MAX_AGE_OPEN)));
    gateway.pay{value: 1 ether}(keccak256('late'), merchant, address(0), 1 ether);
  }

  function test_weekendPaymentAddsClosedMarketHaircut() public {
    _requireMarketOpen();
    (uint256 weekday,,) = gateway.quote(merchant, INV, RH.NVDA);
    _allowFrozen247Feeds();
    vm.warp(_nextAt(6, 1)); // Saturday 01:00 UTC
    vm.prank(merchant);
    gateway.createInvoice(keccak256('sat'), AMOUNT, uint64(block.timestamp + 1 hours));
    (uint256 saturday,, bool closed) = gateway.quote(merchant, keccak256('sat'), RH.NVDA);
    assertTrue(closed);
    assertApproxEqRel(saturday, weekday * 10_550 / 10_050, 1e14, 'spread + 5% haircut on the same price');
  }

  function test_onlyCreditCanSettle() public {
    vm.expectRevert(TsukeGateway.NotCredit.selector);
    gateway.settleByCredit(merchant, INV, customer);
  }

  function test_ethValueRejectedForTokenPayments() public {
    vm.deal(customer, 1 ether);
    vm.prank(customer);
    vm.expectRevert(TsukeGateway.BadValue.selector);
    gateway.pay{value: 1}(INV, merchant, RH.USDG, AMOUNT);
  }

  function _ceil() internal pure returns (Math.Rounding) {
    return Math.Rounding.Ceil;
  }
}

import {Math} from '@oz/utils/math/Math.sol';

contract TsukeGatewayUsdgNoFeedTest is TsukeBase {
  function test_usdgPaymentDoesNotNeedAFreshFeed() public {
    (,,, uint256 updatedAt,) = IAggregatorV3(RH.FEED_USDG).latestRoundData();
    vm.warp(updatedAt + RH.MAX_AGE_OPEN + 1);
    vm.prank(merchant);
    gateway.createInvoice(keccak256('direct'), 10e6, uint64(vm.getBlockTimestamp() + 1 hours));
    _fund(RH.USDG, customer, 10e6);
    vm.startPrank(customer);
    usdg.approve(address(gateway), 10e6);
    gateway.pay(keccak256('direct'), merchant, RH.USDG, 10e6);
    vm.stopPrank();
    assertEq(usdg.balanceOf(merchant), 10e6);
  }
}
