// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from 'forge-std/Test.sol';
import {ERC20} from '@oz/token/ERC20/ERC20.sol';
import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {NorenCreditLine} from '../src/NorenCreditLine.sol';
import {IReceiver, IERC165} from '../src/interfaces/IReceiver.sol';

/// @dev Plain 6-decimal ERC-20 for unit tests. Arc's real USDC is a native-backed system contract
///      that stock Anvil cannot execute; the fork run in packages/cre-bridge uses the repo's ForkUSDC shim.
contract TestUSDC is ERC20 {
  constructor() ERC20('Test USDC', 'tUSDC') {}

  function decimals() public pure override returns (uint8) {
    return 6;
  }

  function mint(address to, uint256 amount) external {
    _mint(to, amount);
  }
}

contract NorenCreditLineTest is Test {
  event Drawn(bytes32 indexed lineId, uint256 amount, bytes32 invoiceId, address merchant);
  event Repaid(bytes32 indexed lineId, uint256 amount);
  event CreditLineSynced(bytes32 indexed lineId, address indexed borrower, uint256 limitUsdc6, uint64 expiry);
  event CreditLineFrozen(bytes32 indexed lineId);
  event HumanStarterGranted(
    bytes32 indexed lineId, address indexed borrower, bytes32 indexed nullifierHash, uint256 addedUsdc6, uint256 limitUsdc6, uint64 expiry
  );

  TestUSDC usdc;
  NorenCreditLine credit;
  address forwarder = makeAddr('forwarder');
  address owner = makeAddr('owner');
  address borrower = makeAddr('borrower');
  address merchant = makeAddr('merchant');
  address stranger = makeAddr('stranger');
  bytes32 constant LINE = keccak256('line-1');
  bytes32 constant INV = keccak256('inv-1');
  uint64 expiry;

  function setUp() public {
    vm.warp(1_762_400_000);
    usdc = new TestUSDC();
    credit = new NorenCreditLine(IERC20(address(usdc)), forwarder, owner);
    usdc.mint(address(this), 10_000e6);
    usdc.approve(address(credit), type(uint256).max);
    credit.fund(10_000e6);
    expiry = uint64(block.timestamp + 30 days);
  }

  function _report(address b, bytes32 id, uint256 limit, uint64 exp) internal pure returns (bytes memory) {
    return abi.encode(b, id, limit, exp);
  }

  function _open(uint256 limit) internal {
    vm.prank(forwarder);
    credit.onReport('', _report(borrower, LINE, limit, expiry));
  }

  function _fundBorrower(uint256 amount) internal {
    usdc.mint(borrower, amount);
    vm.prank(borrower);
    usdc.approve(address(credit), type(uint256).max);
  }

  // ------------------------------------------------------------ constructor and interface

  function test_constructor_rejectsZeroAddresses() public {
    vm.expectRevert(NorenCreditLine.ZeroAddress.selector);
    new NorenCreditLine(IERC20(address(0)), forwarder, owner);
    vm.expectRevert(NorenCreditLine.ZeroAddress.selector);
    new NorenCreditLine(IERC20(address(usdc)), address(0), owner);
    vm.expectRevert(NorenCreditLine.ZeroAddress.selector);
    new NorenCreditLine(IERC20(address(usdc)), forwarder, address(0));
  }

  function test_supportsInterface() public view {
    assertTrue(credit.supportsInterface(type(IReceiver).interfaceId));
    assertTrue(credit.supportsInterface(type(IERC165).interfaceId));
    assertFalse(credit.supportsInterface(0xdeadbeef));
  }

  // ------------------------------------------------------------ onReport

  function test_onReport_onlyForwarder() public {
    vm.prank(stranger);
    vm.expectRevert(abi.encodeWithSelector(NorenCreditLine.NotForwarder.selector, stranger));
    credit.onReport('', _report(borrower, LINE, 500e6, expiry));
  }

  function test_onReport_opensLine() public {
    vm.expectEmit(true, true, false, true, address(credit));
    emit CreditLineSynced(LINE, borrower, 500e6, expiry);
    _open(500e6);
    NorenCreditLine.Line memory l = credit.lines(LINE);
    assertEq(l.borrower, borrower);
    assertEq(l.limitUsdc6, 500e6);
    assertEq(l.expiry, expiry);
    assertEq(l.updatedAt, block.timestamp);
    assertFalse(l.closed);
    assertEq(credit.available(LINE), 500e6);
  }

  function test_onReport_rejectsMalformed() public {
    vm.startPrank(forwarder);
    vm.expectRevert(NorenCreditLine.InvalidReport.selector);
    credit.onReport('', abi.encode(borrower, LINE, uint256(1)));
    vm.expectRevert(NorenCreditLine.InvalidReport.selector);
    credit.onReport('', _report(address(0), LINE, 1, expiry));
    vm.expectRevert(NorenCreditLine.InvalidReport.selector);
    credit.onReport('', _report(borrower, bytes32(0), 1, expiry));
    vm.stopPrank();
  }

  function test_onReport_rejectsExpiredOpen() public {
    vm.prank(forwarder);
    vm.expectRevert(abi.encodeWithSelector(NorenCreditLine.ReportExpired.selector, uint64(block.timestamp)));
    credit.onReport('', _report(borrower, LINE, 1e6, uint64(block.timestamp)));
  }

  function test_onReport_closeForUnknownLineReverts() public {
    vm.prank(forwarder);
    vm.expectRevert(abi.encodeWithSelector(NorenCreditLine.UnknownLine.selector, LINE));
    credit.onReport('', _report(borrower, LINE, 0, expiry));
  }

  function test_onReport_borrowerCannotChange() public {
    _open(500e6);
    vm.prank(forwarder);
    vm.expectRevert(abi.encodeWithSelector(NorenCreditLine.BorrowerMismatch.selector, borrower, stranger));
    credit.onReport('', _report(stranger, LINE, 500e6, expiry));
  }

  function test_onReport_updatesLimitAndExpiry() public {
    _open(500e6);
    vm.prank(forwarder);
    credit.onReport('', _report(borrower, LINE, 800e6, expiry + 1 days));
    NorenCreditLine.Line memory l = credit.lines(LINE);
    assertEq(l.limitUsdc6, 800e6);
    assertEq(l.expiry, expiry + 1 days);
  }

  function test_onReport_freezeIsTerminal_blocksReplay() public {
    _open(500e6);
    vm.expectEmit(true, false, false, false, address(credit));
    emit CreditLineFrozen(LINE);
    vm.prank(forwarder);
    credit.onReport('', _report(borrower, LINE, 0, expiry));
    assertTrue(credit.lines(LINE).closed);
    assertEq(credit.available(LINE), 0);
    // Replaying the old "opened" report must not reopen the line.
    vm.prank(forwarder);
    vm.expectRevert(abi.encodeWithSelector(NorenCreditLine.LineClosed.selector, LINE));
    credit.onReport('', _report(borrower, LINE, 500e6, expiry));
  }

  function test_onReport_workflowOwnerPin() public {
    address wfOwner = makeAddr('workflow-owner');
    vm.prank(owner);
    credit.setExpectedWorkflowOwner(wfOwner);
    bytes memory good = abi.encodePacked(bytes32(uint256(1)), bytes10('bridge'), wfOwner, bytes2(0));
    bytes memory bad = abi.encodePacked(bytes32(uint256(1)), bytes10('bridge'), stranger, bytes2(0));
    vm.startPrank(forwarder);
    vm.expectRevert(abi.encodeWithSelector(NorenCreditLine.InvalidWorkflowOwner.selector, address(0), wfOwner));
    credit.onReport('', _report(borrower, LINE, 1e6, expiry));
    vm.expectRevert(abi.encodeWithSelector(NorenCreditLine.InvalidWorkflowOwner.selector, stranger, wfOwner));
    credit.onReport(bad, _report(borrower, LINE, 1e6, expiry));
    credit.onReport(good, _report(borrower, LINE, 1e6, expiry));
    vm.stopPrank();
    assertEq(credit.lines(LINE).limitUsdc6, 1e6);
  }

  function test_onReport_worksWhilePaused() public {
    vm.prank(owner);
    credit.setPaused(true);
    _open(500e6);
    assertEq(credit.lines(LINE).limitUsdc6, 500e6);
    assertEq(credit.available(LINE), 0);
  }

  // ------------------------------------------------------------ payInvoice

  function test_payInvoice_paysMerchantAndEmitsDrawn() public {
    _open(500e6);
    vm.expectEmit(true, false, false, true, address(credit));
    emit Drawn(LINE, 120e6, INV, merchant);
    vm.prank(borrower);
    credit.payInvoice(LINE, merchant, 120e6, INV);
    assertEq(usdc.balanceOf(merchant), 120e6);
    assertEq(usdc.balanceOf(address(credit)), 10_000e6 - 120e6);
    assertEq(credit.outstanding(LINE), 120e6);
    assertEq(credit.available(LINE), 380e6);
    assertEq(credit.totalOutstandingUsdc6(), 120e6);
    assertTrue(credit.invoicePaid(LINE, INV));
  }

  function test_payInvoice_onlyBorrower() public {
    _open(500e6);
    vm.prank(stranger);
    vm.expectRevert(NorenCreditLine.NotBorrower.selector);
    credit.payInvoice(LINE, merchant, 1e6, INV);
  }

  function test_payInvoice_unknownLine() public {
    vm.prank(borrower);
    vm.expectRevert(abi.encodeWithSelector(NorenCreditLine.UnknownLine.selector, LINE));
    credit.payInvoice(LINE, merchant, 1e6, INV);
  }

  function test_payInvoice_limitExceeded() public {
    _open(500e6);
    vm.prank(borrower);
    vm.expectRevert(abi.encodeWithSelector(NorenCreditLine.LimitExceeded.selector, 500e6, 500e6 + 1));
    credit.payInvoice(LINE, merchant, 500e6 + 1, INV);
  }

  function test_payInvoice_exactLimitThenNothingLeft() public {
    _open(500e6);
    vm.startPrank(borrower);
    credit.payInvoice(LINE, merchant, 500e6, INV);
    vm.expectRevert(abi.encodeWithSelector(NorenCreditLine.LimitExceeded.selector, 0, 1));
    credit.payInvoice(LINE, merchant, 1, keccak256('inv-2'));
    vm.stopPrank();
  }

  function test_payInvoice_duplicateInvoiceRejected() public {
    _open(500e6);
    vm.startPrank(borrower);
    credit.payInvoice(LINE, merchant, 10e6, INV);
    vm.expectRevert(abi.encodeWithSelector(NorenCreditLine.InvoiceAlreadyPaid.selector, INV));
    credit.payInvoice(LINE, merchant, 10e6, INV);
    vm.stopPrank();
  }

  function test_payInvoice_poolInsufficient() public {
    _open(500e6);
    vm.prank(owner);
    credit.withdraw(owner, 10_000e6 - 50e6);
    vm.prank(borrower);
    vm.expectRevert(abi.encodeWithSelector(NorenCreditLine.PoolInsufficient.selector, 50e6, 60e6));
    credit.payInvoice(LINE, merchant, 60e6, INV);
  }

  function test_payInvoice_expired() public {
    _open(500e6);
    vm.warp(expiry);
    vm.prank(borrower);
    vm.expectRevert(abi.encodeWithSelector(NorenCreditLine.LineExpired.selector, LINE, expiry));
    credit.payInvoice(LINE, merchant, 1e6, INV);
    assertEq(credit.available(LINE), 0);
  }

  function test_payInvoice_closed() public {
    _open(500e6);
    vm.prank(forwarder);
    credit.onReport('', _report(borrower, LINE, 0, expiry));
    vm.prank(borrower);
    vm.expectRevert(abi.encodeWithSelector(NorenCreditLine.LineClosed.selector, LINE));
    credit.payInvoice(LINE, merchant, 1e6, INV);
  }

  function test_payInvoice_paused() public {
    _open(500e6);
    vm.prank(owner);
    credit.setPaused(true);
    vm.prank(borrower);
    vm.expectRevert(NorenCreditLine.IsPaused.selector);
    credit.payInvoice(LINE, merchant, 1e6, INV);
    vm.prank(owner);
    credit.setPaused(false);
    vm.prank(borrower);
    credit.payInvoice(LINE, merchant, 1e6, INV);
  }

  function test_payInvoice_zeroAmountOrMerchant() public {
    _open(500e6);
    vm.startPrank(borrower);
    vm.expectRevert(NorenCreditLine.ZeroAmount.selector);
    credit.payInvoice(LINE, merchant, 0, INV);
    vm.expectRevert(NorenCreditLine.ZeroAddress.selector);
    credit.payInvoice(LINE, address(0), 1e6, INV);
    vm.stopPrank();
  }

  function test_limitCutBelowOutstanding_blocksDraws() public {
    _open(500e6);
    vm.prank(borrower);
    credit.payInvoice(LINE, merchant, 300e6, INV);
    vm.prank(forwarder);
    credit.onReport('', _report(borrower, LINE, 200e6, expiry));
    assertEq(credit.available(LINE), 0);
    vm.prank(borrower);
    vm.expectRevert(abi.encodeWithSelector(NorenCreditLine.LimitExceeded.selector, 0, 1));
    credit.payInvoice(LINE, merchant, 1, keccak256('inv-2'));
  }

  // ------------------------------------------------------------ repay

  function test_repay_revolves() public {
    _open(500e6);
    _fundBorrower(500e6);
    vm.startPrank(borrower);
    credit.payInvoice(LINE, merchant, 500e6, INV);
    vm.expectEmit(true, false, false, true, address(credit));
    emit Repaid(LINE, 200e6);
    credit.repay(LINE, 200e6);
    assertEq(credit.available(LINE), 200e6);
    credit.payInvoice(LINE, merchant, 200e6, keccak256('inv-2'));
    vm.stopPrank();
    (uint256 drawn, uint256 repaid,) = credit.utilisation(LINE);
    assertEq(drawn, 700e6);
    assertEq(repaid, 200e6);
    assertEq(credit.totalOutstandingUsdc6(), 500e6);
  }

  function test_repay_tooMuch() public {
    _open(500e6);
    _fundBorrower(500e6);
    vm.startPrank(borrower);
    credit.payInvoice(LINE, merchant, 100e6, INV);
    vm.expectRevert(abi.encodeWithSelector(NorenCreditLine.RepayTooMuch.selector, 100e6, 100e6 + 1));
    credit.repay(LINE, 100e6 + 1);
    vm.expectRevert(NorenCreditLine.ZeroAmount.selector);
    credit.repay(LINE, 0);
    vm.stopPrank();
  }

  function test_repay_unknownLine() public {
    vm.expectRevert(abi.encodeWithSelector(NorenCreditLine.UnknownLine.selector, LINE));
    credit.repay(LINE, 1);
  }

  function test_repay_byThirdParty_whilePaused_afterExpiryAndClose() public {
    _open(500e6);
    vm.prank(borrower);
    credit.payInvoice(LINE, merchant, 100e6, INV);
    vm.prank(forwarder);
    credit.onReport('', _report(borrower, LINE, 0, expiry));
    vm.prank(owner);
    credit.setPaused(true);
    vm.warp(expiry + 1);
    usdc.mint(stranger, 100e6);
    vm.startPrank(stranger);
    usdc.approve(address(credit), 100e6);
    credit.repay(LINE, 100e6);
    vm.stopPrank();
    assertEq(credit.outstanding(LINE), 0);
    assertEq(usdc.balanceOf(address(credit)), 10_000e6);
  }

  // ------------------------------------------------------------ asOf clock

  function test_updatedAt_strictlyIncreasesWithinOneBlock() public {
    _open(500e6);
    _fundBorrower(500e6);
    uint64 t0 = credit.lines(LINE).updatedAt;
    vm.startPrank(borrower);
    credit.payInvoice(LINE, merchant, 10e6, INV);
    (,, uint64 t1) = credit.utilisation(LINE);
    credit.repay(LINE, 5e6);
    (,, uint64 t2) = credit.utilisation(LINE);
    vm.stopPrank();
    assertEq(t0, block.timestamp);
    assertEq(t1, t0 + 1);
    assertEq(t2, t0 + 2);
    vm.warp(block.timestamp + 100);
    vm.prank(borrower);
    credit.repay(LINE, 5e6);
    (,, uint64 t3) = credit.utilisation(LINE);
    assertEq(t3, block.timestamp);
  }

  // ------------------------------------------------------------ admin

  function test_admin_onlyOwner() public {
    vm.startPrank(stranger);
    vm.expectRevert(NorenCreditLine.NotOwner.selector);
    credit.setPaused(true);
    vm.expectRevert(NorenCreditLine.NotOwner.selector);
    credit.setForwarder(stranger);
    vm.expectRevert(NorenCreditLine.NotOwner.selector);
    credit.setExpectedWorkflowOwner(stranger);
    vm.expectRevert(NorenCreditLine.NotOwner.selector);
    credit.withdraw(stranger, 1);
    vm.expectRevert(NorenCreditLine.NotOwner.selector);
    credit.transferOwnership(stranger);
    vm.stopPrank();
  }

  function test_admin_setForwarder() public {
    vm.prank(owner);
    credit.setForwarder(stranger);
    assertEq(credit.forwarder(), stranger);
    vm.prank(forwarder);
    vm.expectRevert(abi.encodeWithSelector(NorenCreditLine.NotForwarder.selector, forwarder));
    credit.onReport('', _report(borrower, LINE, 1e6, expiry));
    vm.prank(owner);
    vm.expectRevert(NorenCreditLine.ZeroAddress.selector);
    credit.setForwarder(address(0));
  }

  function test_admin_twoStepOwnership() public {
    vm.prank(owner);
    credit.transferOwnership(stranger);
    assertEq(credit.owner(), owner);
    vm.prank(borrower);
    vm.expectRevert(NorenCreditLine.NotOwner.selector);
    credit.acceptOwnership();
    vm.prank(stranger);
    credit.acceptOwnership();
    assertEq(credit.owner(), stranger);
    assertEq(credit.pendingOwner(), address(0));
  }

  function test_fund_zeroReverts() public {
    vm.expectRevert(NorenCreditLine.ZeroAmount.selector);
    credit.fund(0);
  }

  // ------------------------------------------------------------ kind 2: World ID human starter limit

  bytes32 constant NULLIFIER = keccak256('world-id-nullifier-1');

  function _human(address b, bytes32 nullifier, uint256 limit, uint64 exp) internal pure returns (bytes memory) {
    return abi.encode(uint8(2), b, nullifier, limit, exp);
  }

  function _grant(address b, bytes32 nullifier, uint256 limit) internal {
    vm.prank(forwarder);
    credit.onReport('', _human(b, nullifier, limit, expiry));
  }

  function test_human_opensUnsecuredStarterLine() public {
    bytes32 lineId = credit.starterLineId(borrower);
    vm.expectEmit(true, true, true, true, address(credit));
    emit HumanStarterGranted(lineId, borrower, NULLIFIER, 25e6, 25e6, expiry);
    _grant(borrower, NULLIFIER, 25e6);
    NorenCreditLine.Line memory l = credit.lines(lineId);
    assertEq(l.borrower, borrower);
    assertTrue(l.unsecured);
    assertEq(l.limitUsdc6, 25e6);
    assertEq(l.expiry, expiry);
    assertEq(credit.nullifierUsedBy(NULLIFIER), borrower);
    assertEq(credit.maxStarterLimitUsdc6(), 25e6);
    // Spendable at a merchant like any line.
    vm.prank(borrower);
    credit.payInvoice(lineId, merchant, 25e6, INV);
    assertEq(usdc.balanceOf(merchant), 25e6);
  }

  function test_human_onlyForwarder() public {
    vm.prank(stranger);
    vm.expectRevert(abi.encodeWithSelector(NorenCreditLine.NotForwarder.selector, stranger));
    credit.onReport('', _human(borrower, NULLIFIER, 10e6, expiry));
  }

  function test_human_nullifierReuseRejected_evenForAnotherBorrower() public {
    _grant(borrower, NULLIFIER, 10e6);
    vm.startPrank(forwarder);
    vm.expectRevert(abi.encodeWithSelector(NorenCreditLine.NullifierUsed.selector, NULLIFIER, borrower));
    credit.onReport('', _human(borrower, NULLIFIER, 10e6, expiry));
    vm.expectRevert(abi.encodeWithSelector(NorenCreditLine.NullifierUsed.selector, NULLIFIER, borrower));
    credit.onReport('', _human(stranger, NULLIFIER, 10e6, expiry));
    vm.stopPrank();
    assertEq(credit.lines(credit.starterLineId(stranger)).borrower, address(0));
  }

  function test_human_nullifierStaysSpentAfterFreeze() public {
    _grant(borrower, NULLIFIER, 10e6);
    vm.prank(owner);
    credit.freezeStarterLine(borrower);
    vm.prank(forwarder);
    vm.expectRevert(abi.encodeWithSelector(NorenCreditLine.NullifierUsed.selector, NULLIFIER, borrower));
    credit.onReport('', _human(stranger, NULLIFIER, 10e6, expiry));
  }

  function test_human_capEnforced() public {
    vm.prank(forwarder);
    vm.expectRevert(abi.encodeWithSelector(NorenCreditLine.StarterCapExceeded.selector, 25e6, 25e6 + 1));
    credit.onReport('', _human(borrower, NULLIFIER, 25e6 + 1, expiry));
    assertEq(credit.nullifierUsedBy(NULLIFIER), address(0));
  }

  function test_human_topUpAddsButNeverPastCap() public {
    _grant(borrower, NULLIFIER, 15e6);
    _grant(borrower, keccak256('world-id-nullifier-2'), 10e6);
    assertEq(credit.lines(credit.starterLineId(borrower)).limitUsdc6, 25e6);
    vm.prank(forwarder);
    vm.expectRevert(abi.encodeWithSelector(NorenCreditLine.StarterCapExceeded.selector, 25e6, 26e6));
    credit.onReport('', _human(borrower, keccak256('world-id-nullifier-3'), 1e6, expiry));
  }

  function test_human_capIsOwnerSetAndOnlyOwner() public {
    vm.prank(stranger);
    vm.expectRevert(NorenCreditLine.NotOwner.selector);
    credit.setMaxStarterLimit(100e6);
    vm.prank(owner);
    credit.setMaxStarterLimit(5e6);
    vm.prank(forwarder);
    vm.expectRevert(abi.encodeWithSelector(NorenCreditLine.StarterCapExceeded.selector, 5e6, 6e6));
    credit.onReport('', _human(borrower, NULLIFIER, 6e6, expiry));
  }

  function test_human_rejectsBadFields() public {
    vm.startPrank(forwarder);
    vm.expectRevert(NorenCreditLine.InvalidReport.selector);
    credit.onReport('', _human(address(0), NULLIFIER, 1e6, expiry));
    vm.expectRevert(NorenCreditLine.InvalidReport.selector);
    credit.onReport('', _human(borrower, bytes32(0), 1e6, expiry));
    vm.expectRevert(NorenCreditLine.InvalidReport.selector);
    credit.onReport('', _human(borrower, NULLIFIER, 0, expiry));
    vm.expectRevert(abi.encodeWithSelector(NorenCreditLine.ReportExpired.selector, uint64(block.timestamp)));
    credit.onReport('', _human(borrower, NULLIFIER, 1e6, uint64(block.timestamp)));
    uint64 far = uint64(block.timestamp) + 90 days + 1;
    vm.expectRevert(abi.encodeWithSelector(NorenCreditLine.StarterExpiryTooFar.selector, far, far - 1));
    credit.onReport('', _human(borrower, NULLIFIER, 1e6, far));
    vm.stopPrank();
  }

  function test_human_unknownKindRejected() public {
    vm.prank(forwarder);
    vm.expectRevert(abi.encodeWithSelector(NorenCreditLine.UnknownReportKind.selector, 3));
    credit.onReport('', abi.encode(uint8(3), borrower, NULLIFIER, uint256(1e6), expiry));
  }

  function test_kind1_versionedMatchesLegacy() public {
    vm.prank(forwarder);
    credit.onReport('', abi.encode(uint8(1), borrower, LINE, uint256(500e6), expiry));
    NorenCreditLine.Line memory l = credit.lines(LINE);
    assertEq(l.limitUsdc6, 500e6);
    assertFalse(l.unsecured);
  }

  function test_kind1_cannotTouchStarterLine() public {
    _grant(borrower, NULLIFIER, 10e6);
    bytes32 lineId = credit.starterLineId(borrower);
    vm.startPrank(forwarder);
    vm.expectRevert(abi.encodeWithSelector(NorenCreditLine.NotCollateralLine.selector, lineId));
    credit.onReport('', _report(borrower, lineId, 1_000e6, expiry));
    vm.expectRevert(abi.encodeWithSelector(NorenCreditLine.NotCollateralLine.selector, lineId));
    credit.onReport('', _report(borrower, lineId, 0, expiry));
    vm.stopPrank();
  }

  function test_human_separateFromCollateralLine() public {
    _open(500e6);
    _grant(borrower, NULLIFIER, 25e6);
    assertEq(credit.available(LINE), 500e6);
    assertEq(credit.available(credit.starterLineId(borrower)), 25e6);
  }

  function test_freezeStarterLine_onlyOwnerAndOnlyStarter() public {
    bytes32 lineId = credit.starterLineId(borrower);
    vm.prank(owner);
    vm.expectRevert(abi.encodeWithSelector(NorenCreditLine.UnknownLine.selector, lineId));
    credit.freezeStarterLine(borrower);
    _grant(borrower, NULLIFIER, 10e6);
    vm.prank(stranger);
    vm.expectRevert(NorenCreditLine.NotOwner.selector);
    credit.freezeStarterLine(borrower);
    vm.prank(owner);
    credit.freezeStarterLine(borrower);
    assertEq(credit.available(lineId), 0);
    vm.prank(forwarder);
    vm.expectRevert(abi.encodeWithSelector(NorenCreditLine.LineClosed.selector, lineId));
    credit.onReport('', _human(borrower, keccak256('world-id-nullifier-2'), 1e6, expiry));
  }

  // ------------------------------------------------------------ fuzz

  /// Random draw/repay sequences never push outstanding above the limit, and the global total matches.
  function testFuzz_outstandingNeverExceedsLimit(uint96 limit, uint256[12] calldata steps) public {
    uint256 lim = bound(uint256(limit), 1, 5_000e6);
    _open(lim);
    _fundBorrower(10_000e6);
    for (uint256 i; i < steps.length; ++i) {
      uint256 amount = bound(steps[i], 1, 6_000e6);
      vm.prank(borrower);
      if (steps[i] % 2 == 0) {
        try credit.payInvoice(LINE, merchant, amount, bytes32(i)) {} catch {}
      } else {
        try credit.repay(LINE, amount) {} catch {}
      }
      assertLe(credit.outstanding(LINE), lim);
      assertEq(credit.totalOutstandingUsdc6(), credit.outstanding(LINE));
      (uint256 drawn, uint256 repaid,) = credit.utilisation(LINE);
      assertEq(usdc.balanceOf(merchant), drawn);
      assertEq(usdc.balanceOf(address(credit)), 10_000e6 + repaid - drawn);
    }
  }
}
