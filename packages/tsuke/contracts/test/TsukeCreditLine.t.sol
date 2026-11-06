// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from 'forge-std/Vm.sol';
import {IERC165} from '@oz/utils/introspection/IERC165.sol';
import {TsukeBase} from './TsukeBase.sol';
import {TsukeCredit} from '../src/TsukeCredit.sol';
import {IReceiver} from '../src/interfaces/IReceiver.sol';
import {IRobinhoodStockToken} from '../src/interfaces/IRobinhoodStockToken.sol';
import {RobinhoodMainnet as RH} from '../script/RobinhoodMainnet.sol';

/// @notice The Arc credit line: CreditLineOpened out, CRE onReport in.
contract TsukeCreditLineTest is TsukeBase {
  uint256 internal constant LIMIT = 500e6; // 500 USDC on Arc
  uint256 internal col;
  bytes32 internal lineId;
  uint64 internal expiry;

  function setUp() public override {
    super.setUp();
    _attest(customer, 2, 2_000e6, 14_000);
    // TSLA collateral for 500 USDC at 140% plus 8% headroom (covers a closed-market haircut)
    (col,) = oracle.assetForUsd8(RH.TSLA, LIMIT * 100 * 14_000 / 10_000, 800);
    _fund(RH.TSLA, customer, col);
    vm.prank(customer);
    tsla.approve(address(credit), col);
    expiry = uint64(block.timestamp + 30 days);
  }

  function _open() internal returns (bytes32 id) {
    vm.prank(customer);
    id = credit.openCreditLine(RH.TSLA, col, LIMIT, expiry);
    lineId = id;
  }

  function _report(uint256 drawn, uint256 repaid, uint64 asOf) internal {
    vm.prank(forwarder);
    credit.onReport('', abi.encode(lineId, drawn, repaid, asOf));
  }

  function test_openCreditLineEmitsFixedInterfaceEvent() public {
    uint256 value = oracle.riskValueUsd8(RH.TSLA, col);
    bytes32 expectedId = keccak256(abi.encode(block.chainid, address(credit), customer, uint256(0)));
    vm.expectEmit(true, true, false, true, address(credit));
    emit TsukeCredit.CreditLineOpened(customer, expectedId, LIMIT, expiry, value);
    bytes32 id = _open();
    assertEq(id, expectedId);
    assertEq(tsla.balanceOf(address(credit)), col);
    (,,, uint256 avail) = credit.creditTerms(customer);
    assertEq(avail, 2_000e6 - LIMIT, 'an open line uses credit limit');
    bytes32[] memory ids = credit.linesOf(customer);
    assertEq(ids.length, 1);
    assertEq(ids[0], id);
  }

  function test_eventSignatureMatchesBridgeInterface() public pure {
    assertEq(
      TsukeCredit.CreditLineOpened.selector,
      keccak256('CreditLineOpened(address,bytes32,uint256,uint64,uint256)')
    );
    assertEq(TsukeCredit.CreditLineClosed.selector, keccak256('CreditLineClosed(bytes32)'));
  }

  function test_lineRejectsOverLimitAndBadExpiry() public {
    vm.startPrank(customer);
    vm.expectRevert(abi.encodeWithSelector(TsukeCredit.OverLimit.selector, 2_001e6, 2_000e6));
    credit.openCreditLine(RH.TSLA, col, 2_001e6, expiry);
    uint64 tooLong = uint64(block.timestamp + 91 days);
    vm.expectRevert(abi.encodeWithSelector(TsukeCredit.BadExpiry.selector, tooLong));
    credit.openCreditLine(RH.TSLA, col, LIMIT, tooLong);
    vm.stopPrank();
  }

  function test_lineRequiresCollateralAtTierRatio() public {
    vm.prank(customer);
    vm.expectRevert();
    credit.openCreditLine(RH.TSLA, col / 2, LIMIT, expiry);
  }

  function test_onlyForwarderCanReport() public {
    _open();
    vm.expectRevert(abi.encodeWithSelector(TsukeCredit.NotForwarder.selector, address(this)));
    credit.onReport('', abi.encode(lineId, uint256(1), uint256(0), uint64(block.timestamp)));
  }

  function test_reportUpdatesArcUtilisation() public {
    _open();
    vm.expectEmit(true, false, false, true, address(credit));
    emit TsukeCredit.ArcUtilisationUpdated(lineId, 120e6, 20e6, uint64(block.timestamp));
    _report(120e6, 20e6, uint64(block.timestamp));
    TsukeCredit.Line memory l = credit.line(lineId);
    assertEq(l.drawn, 120e6);
    assertEq(l.repaid, 20e6);
    assertEq(credit.lineOutstanding(lineId), 100e6);
  }

  function test_staleOrReplayedReportRejected() public {
    _open();
    uint64 t = uint64(block.timestamp);
    _report(100e6, 0, t);
    vm.prank(forwarder);
    vm.expectRevert(abi.encodeWithSelector(TsukeCredit.StaleReport.selector, t, t));
    credit.onReport('', abi.encode(lineId, uint256(0), uint256(0), t)); // replay with same asOf
    vm.prank(forwarder);
    vm.expectRevert(abi.encodeWithSelector(TsukeCredit.StaleReport.selector, t - 1, t));
    credit.onReport('', abi.encode(lineId, uint256(0), uint256(0), t - 1)); // older report
  }

  function test_futureReportRejected() public {
    _open();
    uint64 future = uint64(block.timestamp + 301);
    vm.prank(forwarder);
    vm.expectRevert(abi.encodeWithSelector(TsukeCredit.FutureReport.selector, future));
    credit.onReport('', abi.encode(lineId, uint256(0), uint256(0), future));
  }

  function test_unknownLineRejected() public {
    bytes32 bogus = keccak256('nope');
    vm.prank(forwarder);
    vm.expectRevert(abi.encodeWithSelector(TsukeCredit.UnknownLine.selector, bogus));
    credit.onReport('', abi.encode(bogus, uint256(0), uint256(0), uint64(block.timestamp)));
  }

  function test_workflowPolicyChecksMetadata() public {
    _open();
    bytes32 wf = keccak256('tsuke-bridge');
    address wfOwner = makeAddr('workflowOwner');
    vm.prank(owner);
    credit.setWorkflowPolicy(wf, wfOwner);
    bytes memory good = abi.encodePacked(wf, bytes10('tsukebrdge'), wfOwner, bytes2('01'));
    bytes memory bad = abi.encodePacked(keccak256('other'), bytes10('tsukebrdge'), wfOwner, bytes2('01'));
    bytes memory report = abi.encode(lineId, uint256(1e6), uint256(0), uint64(block.timestamp));
    vm.startPrank(forwarder);
    vm.expectRevert(TsukeCredit.BadWorkflow.selector);
    credit.onReport(bad, report);
    vm.expectRevert(TsukeCredit.BadWorkflow.selector);
    credit.onReport('', report);
    credit.onReport(good, report);
    vm.stopPrank();
    assertEq(credit.line(lineId).drawn, 1e6);
  }

  function test_supportsIReceiverInterface() public view {
    assertTrue(credit.supportsInterface(type(IReceiver).interfaceId));
    assertTrue(credit.supportsInterface(type(IERC165).interfaceId));
    assertFalse(credit.supportsInterface(0xffffffff));
  }

  function test_closeWaitsForArcReportThenReturnsCollateral() public {
    _open();
    uint64 t0 = uint64(vm.getBlockTimestamp());
    _report(200e6, 0, t0);
    vm.warp(t0 + 60);
    vm.recordLogs();
    vm.prank(customer);
    credit.closeCreditLine(lineId); // step 1: stop the line
    Vm.Log[] memory logs = vm.getRecordedLogs();
    assertEq(logs[0].topics[0], TsukeCredit.CreditLineClosed.selector);
    assertEq(logs[0].topics[1], lineId);
    // Early withdrawal attempt: no report since the close yet
    vm.prank(customer);
    vm.expectRevert(abi.encodeWithSelector(TsukeCredit.AwaitingArcReport.selector, t0, t0 + 60));
    credit.closeCreditLine(lineId);
    // Report after the close still shows debt: collateral stays
    vm.warp(t0 + 120);
    _report(200e6, 150e6, t0 + 120);
    vm.prank(customer);
    vm.expectRevert(abi.encodeWithSelector(TsukeCredit.DebtOutstanding.selector, 50e6));
    credit.closeCreditLine(lineId);
    assertEq(tsla.balanceOf(customer), 0);
    // Final repayment on Arc reaches Robinhood through CRE and settles the line automatically
    vm.warp(t0 + 180);
    _report(200e6, 200e6, t0 + 180);
    assertEq(uint8(credit.line(lineId).status), uint8(TsukeCredit.LineStatus.Closed));
    assertEq(tsla.balanceOf(customer), col, 'collateral returned');
    (,,, uint256 avail) = credit.creditTerms(customer);
    assertEq(avail, 2_000e6, 'limit released');
    (,, uint32 completed, uint32 clean,) = credit.history(customer);
    assertEq(completed, 1);
    assertEq(clean, 1);
  }

  function test_onlyBorrowerCanClose() public {
    _open();
    vm.expectRevert(TsukeCredit.NotBorrower.selector);
    credit.closeCreditLine(lineId);
  }

  function test_pastDueLineLiquidation() public {
    _open();
    _report(300e6, 100e6, uint64(block.timestamp));
    _allowFrozen247Feeds(); // 30 days on a frozen fork: no new USDG heartbeat can arrive
    _stocksOpenAgainWithFrozenFeeds();
    vm.warp(uint256(expiry) + GRACE);
    (bool pastDue,) = credit.lineLiquidatable(lineId);
    assertFalse(pastDue);
    vm.warp(uint256(expiry) + GRACE + 1);
    (pastDue,) = credit.lineLiquidatable(lineId);
    assertTrue(pastDue);
    uint256 owed = oracle.usd8ToUsdg(200e6 * 100, _ceil());
    _fund(RH.USDG, liquidator, owed);
    uint256 idle = vault.idleUsdg();
    vm.startPrank(liquidator);
    usdg.approve(address(credit), owed);
    vm.recordLogs();
    uint256 seized = credit.liquidateLine(lineId);
    vm.stopPrank();
    assertEq(vault.idleUsdg(), idle + owed, 'treasury receives the outstanding Arc debt');
    assertEq(tsla.balanceOf(liquidator), seized);
    assertEq(tsla.balanceOf(customer), col - seized);
    assertEq(uint8(credit.line(lineId).status), uint8(TsukeCredit.LineStatus.Liquidated));
    Vm.Log[] memory logs = vm.getRecordedLogs();
    bool closedSeen;
    for (uint256 i; i < logs.length; ++i) {
      if (logs[i].topics[0] == TsukeCredit.CreditLineClosed.selector) closedSeen = true;
    }
    assertTrue(closedSeen, 'CreditLineClosed tells the bridge to zero the Arc limit');
    vm.prank(forwarder);
    vm.expectRevert(abi.encodeWithSelector(TsukeCredit.LineNotActive.selector, TsukeCredit.LineStatus.Liquidated));
    credit.onReport('', abi.encode(lineId, uint256(0), uint256(0), uint64(block.timestamp)));
  }

  function test_undercollateralisedLineLiquidation() public {
    _open();
    _report(LIMIT, 0, uint64(block.timestamp)); // fully drawn on Arc
    (, bool under) = credit.lineLiquidatable(lineId);
    assertFalse(under);
    // TSLA 1-for-2 reverse-split-style multiplier cut via the real Stock Token role
    _setMultiplier(RH.TSLA, IRobinhoodStockToken(RH.TSLA).uiMultiplier() / 2);
    (, under) = credit.lineLiquidatable(lineId);
    assertTrue(under);
  }

  function test_nothingDrawnNothingToLiquidate() public {
    _open();
    vm.warp(uint256(expiry) + GRACE + 1);
    (bool pastDue, bool under) = credit.lineLiquidatable(lineId);
    assertFalse(pastDue || under);
  }

  /// @dev After a 30-day jump the frozen stock feeds are 30 days old; widen their max age as well
  /// (config call on the real feeds) so the test exercises liquidation logic, not fork staleness.
  function _stocksOpenAgainWithFrozenFeeds() internal {
    vm.prank(owner);
    oracle.setAsset(RH.TSLA, RH.FEED_TSLA, 60 days, 60 days, true, true);
  }

  function _ceil() internal pure returns (Math.Rounding) {
    return Math.Rounding.Ceil;
  }
}

import {Math} from '@oz/utils/math/Math.sol';
