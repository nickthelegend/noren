// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {XC} from '../script/XChainConstants.sol';
import {XChainForkBase, IForkUSDC} from './XChainForkBase.sol';
import {CrossChainOrder} from '../src/XChainOrder.sol';
import {XChainMessages, PriceRound} from '../src/XChainMessages.sol';
import {XChainInbox} from '../src/XChainTransport.sol';
import {NorenCrossChainSettler} from '../src/NorenCrossChainSettler.sol';
import {NorenCrossChainEscrow} from '../src/NorenCrossChainEscrow.sol';
import {NorenEscrowReceipt} from '../src/NorenEscrowReceipt.sol';
import {NorenRelayedFeed} from '../src/NorenRelayedFeed.sol';
import {ISwapVMRouter, IAggregatorV3} from '../src/interfaces/IExternal.sol';

interface IStock {
  function uiMultiplier() external view returns (uint256);
}

/// @notice NVDA Stock Tokens locked on Robinhood Chain (warmed mainnet snapshot fork), USDC paid on
/// Arc (Arc Testnet fork with official Aqua) by a maker's NorenOraclePeg Aqua strategy, priced from
/// the real Chainlink NVDA/USD round the escrow read on Robinhood.
contract XChainRobinhoodArcTest is XChainForkBase {
  /// @dev Holds NVDA, TSLA, AAPL and USDG in the warmed snapshot (packages/robinhood fork-snapshot.sh).
  address internal constant SNAPSHOT_CUSTOMER = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
  uint256 internal constant AMOUNT = 2e18; // 2 NVDA

  function setUp() public {
    _setUpArc();
    uint256 rh = vm.createSelectFork(vm.envString('NOREN_XCHAIN_RH_RPC'));
    assertEq(block.chainid, XC.ROBINHOOD, 'Robinhood Chain mainnet snapshot');
    vm.prank(SNAPSHOT_CUSTOMER);
    IERC20(XC.NVDA).transfer(taker, 10e18);
    _setUpSource(rh, XC.RH_FORWARDER, XC.NVDA, XC.NVDA_USD, true, arc.nvdaRoute);
  }

  function _happyOrder(uint256 nonce) internal returns (CrossChainOrder memory o) {
    o = _order(AMOUNT, 1e6, maker, nvdaStrategy, nonce);
  }

  // ================================================================ happy path

  function test_stockOnRobinhoodPaysUsdcOnArcAndReleasesToMaker() public {
    CrossChainOrder memory o = _happyOrder(1);
    vm.selectFork(srcFork);
    uint256 mult = IStock(XC.NVDA).uiMultiplier();
    (uint80 roundId, int256 answer,, uint256 updatedAt,) = IAggregatorV3(XC.NVDA_USD).latestRoundData();
    uint256 takerNvda = IERC20(XC.NVDA).balanceOf(taker);

    bytes memory payload = _open(o);
    assertEq(IERC20(XC.NVDA).balanceOf(taker), takerNvda - AMOUNT, 'taker locked 2 NVDA');
    assertEq(IERC20(XC.NVDA).balanceOf(address(escrow)), AMOUNT, 'escrow holds 2 NVDA');
    (, CrossChainOrder memory sent, PriceRound memory p) = abi.decode(payload, (uint8, CrossChainOrder, PriceRound));
    assertEq(keccak256(abi.encode(sent)), keccak256(abi.encode(o)), 'payload carries the order');
    assertEq(p.roundId, roundId, 'real Chainlink round');
    assertEq(p.answer, answer);
    assertEq(p.updatedAt, updatedAt);
    assertEq(p.uiMultiplier, mult, 'live uiMultiplier');
    assertEq(p.sourceFeed, XC.NVDA_USD);

    vm.selectFork(arcFork);
    uint256 makerUsdc = _usdc(maker);
    uint256 virtualUsdc = _aquaBalance(maker, nvdaStrategy, XC.ARC_USDC);
    (bytes memory settlement, bytes memory rejection) = _toArc(payload);
    assertEq(rejection.length, 0, 'no rejection');
    uint256 expected = _expectedOut(arc.nvdaUsd, AMOUNT, mult, true);
    assertGt(expected, 100e6, 'two NVDA are worth more than 100 USDC');
    assertEq(_usdc(recipient), expected, 'taker paid on Arc at Chainlink - 50 bps');
    assertEq(makerUsdc - _usdc(maker), expected, 'from the maker wallet');
    assertEq(virtualUsdc - _aquaBalance(maker, nvdaStrategy, XC.ARC_USDC), expected, 'Aqua virtual balance');
    assertEq(arc.rNvda.totalSupply(), 0, 'receipt burned in the fill');
    assertEq(arc.rNvda.uiMultiplier(), mult, 'relayed uiMultiplier');
    assertEq(uint8(arc.settler.orderStatus(arc.settler.idOf(o))), uint8(NorenCrossChainSettler.Status.Filled));

    XChainMessages.Settlement memory s = _decodeSettlement(settlement);
    assertEq(s.kind, XChainMessages.FILLED);
    assertEq(s.payout, makerPayout);
    assertEq(s.amountIn, AMOUNT);
    assertEq(s.amountOut, expected);

    _toSource(settlement);
    assertEq(IERC20(XC.NVDA).balanceOf(makerPayout), AMOUNT, 'maker received the NVDA on Robinhood');
    assertEq(IERC20(XC.NVDA).balanceOf(address(escrow)), 0);
    assertEq(uint8(escrow.orderStatus(s.orderId)), uint8(NorenCrossChainEscrow.Status.Released));
  }

  // ================================================================ replay, double release

  function test_replayedOrderReportCannotFillTwice() public {
    bytes memory payload = _open(_happyOrder(2));
    _toArc(payload);
    uint256 paid = _usdc(recipient);
    vm.selectFork(arcFork);
    vm.prank(XC.ARC_FORWARDER);
    vm.expectRevert();
    arc.settler.onReport('', payload);
    assertEq(_usdc(recipient), paid, 'paid once');
  }

  function test_settlementCannotReleaseTwice() public {
    (bytes memory settlement,) = _toArc(_open(_happyOrder(3)));
    _toSource(settlement);
    vm.selectFork(srcFork);
    vm.prank(srcForwarder);
    vm.expectRevert(abi.encodeWithSelector(NorenCrossChainEscrow.NotOpen.selector, _decodeSettlement(settlement).orderId, NorenCrossChainEscrow.Status.Released));
    escrow.onReport('', settlement);
    assertEq(IERC20(XC.NVDA).balanceOf(makerPayout), AMOUNT, 'released once');
  }

  function test_orderForAnotherSettlerOrEscrowIsRejected() public {
    CrossChainOrder memory o = _happyOrder(4);
    bytes memory payload = _open(o);
    // Same order, but claiming a different source escrow: not the trusted one.
    o.srcEscrow = makeAddr('fake-escrow');
    vm.selectFork(arcFork);
    vm.prank(XC.ARC_FORWARDER);
    vm.expectRevert(abi.encodeWithSelector(NorenCrossChainSettler.UntrustedSource.selector, o.srcChainId, o.srcEscrow));
    arc.settler.onReport('', abi.encode(XChainMessages.ORDER, o, _price(payload)));
  }

  // ================================================================ stale price, expiry and refunds

  function test_stalePriceIsRejectedThenExpiresAndRefunds() public restoresClocks {
    // A strategy whose route only accepts Chainlink rounds younger than 60 s. The snapshot's NVDA
    // round is hours old, so it is stale for this strategy without moving any clock by days.
    vm.selectFork(arcFork);
    NorenCrossChainSettler.Route memory r = arc.settler.route(arc.nvdaRoute);
    r.baseMaxAgeOpen = 60;
    r.baseMaxAgeClosed = 60;
    arc.settler.setRoute(XC.ROBINHOOD, XC.NVDA, r);
    bytes32 strict = _ship(maker, arc.nvdaRoute, _terms(BID, 99), address(arc.rNvda), XC.ARC_USDC, 1_000e6, makerPayout);
    CrossChainOrder memory o = _order(AMOUNT, 1e6, maker, strict, 5);
    bytes memory payload = _open(o);
    assertGt(block.timestamp - _price(payload).updatedAt, 60, 'the real round is older than 60 s');

    (bytes memory settlement, bytes memory rejection) = _toArc(payload);
    assertEq(settlement.length, 0, 'no fill');
    assertEq(bytes4(rejection), bytes4(keccak256('NorenOraclePegStalePrice(address,uint256,uint256)')), 'stale Chainlink price rejected by the SwapVM instruction');
    assertEq(_usdc(recipient), 0);
    assertEq(arc.rNvda.totalSupply(), 0, 'mint rolled back');
    bytes32 id = arc.settler.idOf(o);
    assertEq(uint8(arc.settler.orderStatus(id)), 0, 'still unsettled');

    vm.expectRevert(abi.encodeWithSelector(NorenCrossChainSettler.NotExpired.selector, id, o.fillDeadline));
    arc.settler.expire(o);
    vm.warp(o.fillDeadline + 1);
    vm.recordLogs();
    arc.settler.expire(o);
    bytes memory expired = _message(vm.getRecordedLogs(), address(arc.settler));
    assertEq(_decodeSettlement(expired).kind, XChainMessages.EXPIRED);
    // An expired order can never be filled afterwards.
    vm.prank(XC.ARC_FORWARDER);
    vm.expectRevert(abi.encodeWithSelector(NorenCrossChainSettler.AlreadySettled.selector, id, NorenCrossChainSettler.Status.Expired));
    arc.settler.onReport('', payload);

    vm.selectFork(srcFork);
    vm.expectRevert();
    escrow.refund(id); // not yet: Open and before refundAfter
    _toSource(expired);
    uint256 before = IERC20(XC.NVDA).balanceOf(taker);
    escrow.refund(id);
    assertEq(IERC20(XC.NVDA).balanceOf(taker) - before, AMOUNT, 'taker refunded on Robinhood');
    assertEq(uint8(escrow.orderStatus(id)), uint8(NorenCrossChainEscrow.Status.Refunded));
  }

  function test_timeoutRefundWithoutAnyReportAndLateFillCannotRelease() public restoresClocks {
    CrossChainOrder memory o = _happyOrder(6);
    bytes memory payload = _open(o);
    bytes32 id = _id(o);
    vm.selectFork(srcFork);
    vm.warp(o.refundAfter);
    uint256 before = IERC20(XC.NVDA).balanceOf(taker);
    escrow.refund(id);
    assertEq(IERC20(XC.NVDA).balanceOf(taker) - before, AMOUNT, 'liveness fallback refund');
    // The fill deadline on Arc is at least minReleaseWindow before refundAfter, so a fill that arrives
    // now is past its deadline and is refused on Arc too.
    vm.selectFork(arcFork);
    vm.warp(o.fillDeadline + 1);
    vm.prank(XC.ARC_FORWARDER);
    vm.expectRevert(abi.encodeWithSelector(NorenCrossChainSettler.FillDeadlinePassed.selector, id, o.fillDeadline));
    arc.settler.onReport('', payload);
  }

  function test_refundAfterMustLeaveAReleaseWindow() public {
    CrossChainOrder memory o = _happyOrder(7);
    o.refundAfter = o.fillDeadline + 10 minutes;
    vm.selectFork(srcFork);
    vm.startPrank(taker);
    IERC20(XC.NVDA).approve(address(escrow), AMOUNT);
    vm.expectRevert(abi.encodeWithSelector(NorenCrossChainEscrow.BadOrder.selector, 'refundAfter'));
    escrow.open(o);
    vm.stopPrank();
  }

  // ================================================================ wrong maker, partial fills, slippage

  function test_wrongMakerIsRejectedOnBothChains() public {
    // The taker names `maker` but points at otherMaker's strategy.
    CrossChainOrder memory o = _order(AMOUNT, 1e6, maker, otherNvdaStrategy, 8);
    bytes memory payload = _open(o);
    vm.selectFork(arcFork);
    vm.prank(XC.ARC_FORWARDER);
    vm.expectRevert(abi.encodeWithSelector(NorenCrossChainSettler.WrongMaker.selector, otherMaker, maker));
    arc.settler.onReport('', payload);

    // A settlement naming a different maker than the order is refused by the escrow.
    bytes32 id = _id(o);
    bytes memory forged = XChainMessages.encodeSettlement(
      XChainMessages.Settlement(XChainMessages.FILLED, id, XC.ARC, address(arc.settler), otherMaker, makerPayout, AMOUNT, 1)
    );
    vm.selectFork(srcFork);
    vm.prank(srcForwarder);
    vm.expectRevert(abi.encodeWithSelector(NorenCrossChainEscrow.WrongMaker.selector, otherMaker, maker));
    escrow.onReport('', forged);
  }

  function test_partialFillSettlementIsRefused() public {
    CrossChainOrder memory o = _happyOrder(9);
    _open(o);
    bytes32 id = _id(o);
    bytes memory partialFill = XChainMessages.encodeSettlement(
      XChainMessages.Settlement(XChainMessages.FILLED, id, XC.ARC, address(arc.settler), maker, makerPayout, AMOUNT / 2, 1)
    );
    vm.selectFork(srcFork);
    vm.prank(srcForwarder);
    vm.expectRevert(abi.encodeWithSelector(NorenCrossChainEscrow.PartialFill.selector, AMOUNT / 2, AMOUNT));
    escrow.onReport('', partialFill);
    // And a settlement from a settler the order did not name.
    bytes memory wrongSettler = XChainMessages.encodeSettlement(
      XChainMessages.Settlement(XChainMessages.FILLED, id, XC.ARC, makeAddr('other-settler'), maker, makerPayout, AMOUNT, 1)
    );
    vm.prank(srcForwarder);
    vm.expectRevert(abi.encodeWithSelector(NorenCrossChainEscrow.WrongSource.selector, XC.ARC, makeAddr('other-settler')));
    escrow.onReport('', wrongSettler);
  }

  function test_minAmountOutAboveThePegIsRejectedAndNothingMoves() public {
    CrossChainOrder memory o = _order(AMOUNT, 1_000_000e6, maker, nvdaStrategy, 10);
    bytes memory payload = _open(o);
    uint256 makerUsdc;
    vm.selectFork(arcFork);
    makerUsdc = _usdc(maker);
    (bytes memory settlement, bytes memory rejection) = _toArc(payload);
    assertEq(settlement.length, 0);
    assertGt(rejection.length, 0, 'SwapVM threshold check');
    assertEq(_usdc(maker), makerUsdc);
    assertEq(_usdc(recipient), 0);
  }

  function test_underfundedMakerIsRejected() public {
    bytes memory payload = _open(_happyOrder(11));
    vm.selectFork(arcFork);
    vm.prank(maker);
    IERC20(XC.ARC_USDC).approve(XC.AQUA, 0); // maker revokes Aqua's allowance
    (, bytes memory rejection) = _toArc(payload);
    assertEq(bytes4(rejection), bytes4(keccak256('NorenOraclePegMakerUnderfunded(address,address,uint256,uint256)')));
  }

  function test_fillAfterDeadlineIsRefusedOnArc() public restoresClocks {
    CrossChainOrder memory o = _happyOrder(12);
    bytes memory payload = _open(o);
    vm.selectFork(arcFork);
    vm.warp(o.fillDeadline + 1);
    vm.prank(XC.ARC_FORWARDER);
    vm.expectRevert(abi.encodeWithSelector(NorenCrossChainSettler.FillDeadlinePassed.selector, _id(o), o.fillDeadline));
    arc.settler.onReport('', payload);
  }

  // ================================================================ trust boundaries

  function test_onlyForwarderOrTransportCanDeliver() public {
    bytes memory payload = _open(_happyOrder(13));
    vm.selectFork(arcFork);
    vm.expectRevert(abi.encodeWithSelector(XChainInbox.NotForwarder.selector, address(this)));
    arc.settler.onReport('', payload);
    vm.expectRevert(abi.encodeWithSelector(XChainInbox.NotTransport.selector, address(this)));
    arc.settler.receiveXChain(XC.ROBINHOOD, address(escrow), payload);
    vm.selectFork(srcFork);
    vm.expectRevert(abi.encodeWithSelector(XChainInbox.NotForwarder.selector, address(this)));
    escrow.onReport('', payload);
  }

  function test_transportAdapterPathChecksTheSourceSender() public {
    address adapter = makeAddr('ccip-adapter');
    bytes memory payload = _open(_happyOrder(14));
    vm.selectFork(arcFork);
    arc.settler.setTransport(adapter, true);
    vm.prank(adapter);
    vm.expectRevert(abi.encodeWithSelector(NorenCrossChainSettler.UntrustedSource.selector, XC.ROBINHOOD, makeAddr('someone')));
    arc.settler.receiveXChain(XC.ROBINHOOD, makeAddr('someone'), payload);
    vm.prank(adapter);
    arc.settler.receiveXChain(XC.ROBINHOOD, address(escrow), payload);
    assertGt(_usdc(recipient), 0, 'filled over the transport path');
  }

  function test_workflowOwnerPin() public {
    bytes memory payload = _open(_happyOrder(15));
    vm.selectFork(arcFork);
    address owner_ = makeAddr('workflow-owner');
    arc.settler.setExpectedWorkflowOwner(owner_);
    vm.prank(XC.ARC_FORWARDER);
    vm.expectRevert(abi.encodeWithSelector(XChainInbox.InvalidWorkflowOwner.selector, address(0), owner_));
    arc.settler.onReport('', payload);
    bytes memory metadata = abi.encodePacked(bytes32(uint256(1)), bytes10('xchain'), owner_, bytes2(0));
    vm.prank(XC.ARC_FORWARDER);
    arc.settler.onReport(metadata, payload);
    assertGt(_usdc(recipient), 0);
  }

  // ================================================================ receipts and relayed prices

  function test_receiptsCannotBeMintedHeldOrSwappedOutsideAFill() public {
    vm.selectFork(arcFork);
    vm.expectRevert(abi.encodeWithSelector(NorenEscrowReceipt.OnlySettler.selector, address(this)));
    arc.rNvda.mint(address(this), 1e18);
    // Even a receipt-holding address could not move it: transfers are locked outside the settler's fill.
    vm.prank(address(arc.settler));
    arc.rNvda.mint(address(this), 1e18);
    vm.expectRevert(NorenEscrowReceipt.ReceiptLocked.selector);
    arc.rNvda.transfer(maker, 1e18);
    // So nobody can sell receipts into a maker's strategy directly through the router.
    arc.rNvda.approve(arc.router, 1e18);
    ISwapVMRouter.Order memory ord = arc.settler.strategyOrder(nvdaStrategy);
    bytes memory td = arc.settler.takerData(1, address(this));
    vm.expectRevert(); // ReceiptLocked, surfaced through SwapVM's SafeERC20
    ISwapVMRouter(arc.router).swap(ord, address(arc.rNvda), XC.ARC_USDC, 1e18, td);
  }

  function test_relayedPriceNeverRollsBack() public {
    bytes memory payload = _open(_happyOrder(16));
    _toArc(payload);
    vm.selectFork(arcFork);
    (uint80 r0, int256 a0,, uint256 u0,) = arc.nvdaUsd.latestRoundData();
    PriceRound memory old = _price(payload);
    old.roundId = r0 - 1;
    old.updatedAt = u0 - 1;
    old.answer = a0 * 2;
    vm.prank(XC.ARC_FORWARDER);
    arc.settler.onReport('', abi.encode(XChainMessages.PRICE, address(arc.nvdaUsd), old));
    (uint80 r1, int256 a1,,,) = arc.nvdaUsd.latestRoundData();
    assertEq(r1, r0);
    assertEq(a1, a0, 'older round ignored');
    // A round claiming a different source feed is refused.
    old.roundId = r0 + 1;
    old.updatedAt = u0 + 1;
    old.sourceFeed = XC.TSLA_USD;
    vm.prank(XC.ARC_FORWARDER);
    vm.expectRevert();
    arc.settler.onReport('', abi.encode(XChainMessages.PRICE, address(arc.nvdaUsd), old));
  }

  function test_oneMakerWalletBacksManyOrders() public {
    vm.selectFork(arcFork);
    uint256 makerUsdc = _usdc(maker);
    uint256 paid;
    for (uint256 i; i < 3; i++) {
      (bytes memory settlement,) = _toArc(_open(_happyOrder(100 + i)));
      _toSource(settlement);
      vm.selectFork(arcFork);
      paid = _usdc(recipient);
    }
    assertEq(makerUsdc - _usdc(maker), paid, 'three fills from one wallet');
    vm.selectFork(srcFork);
    assertEq(IERC20(XC.NVDA).balanceOf(makerPayout), 3 * AMOUNT);
    vm.selectFork(arcFork);
    assertEq(arc.settler.strategy(nvdaStrategy).fills, 3);
  }

  // ================================================================ helpers

  function _id(CrossChainOrder memory o) internal pure returns (bytes32) {
    return keccak256(abi.encode(o));
  }

  function _price(bytes memory payload) internal pure returns (PriceRound memory p) {
    (,, p) = abi.decode(payload, (uint8, CrossChainOrder, PriceRound));
  }

  function _decodeSettlement(bytes memory b) internal pure returns (XChainMessages.Settlement memory s) {
    (s.kind, s.orderId, s.dstChainId, s.dstSettler, s.maker, s.payout, s.amountIn, s.amountOut) =
      abi.decode(b, (uint8, bytes32, uint64, address, address, address, uint256, uint256));
  }
}
