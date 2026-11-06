// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from 'forge-std/console2.sol';
import {Math} from '@oz/utils/math/Math.sol';
import {RobinhoodBase} from './RobinhoodBase.sol';
import {NorenAssetOracle} from '../src/NorenAssetOracle.sol';
import {NorenCredit} from '../src/NorenCredit.sol';
import {NorenDutchAuction} from '../src/NorenDutchAuction.sol';
import {ISwapVMRouter} from '../src/interfaces/IAquaSwapVM.sol';
import {RobinhoodMainnet as RH} from '../script/RobinhoodMainnet.sol';

/// @notice Partial Dutch-auction liquidations on a fresh Robinhood mainnet fork: the official Aqua
/// registry, the modified SwapVM router with NorenDutchDecay (opcode 35) + NorenOraclePeg, real
/// NVDA, USDG and Chainlink feeds. Price drops use the real Stock Token uiMultiplier admin path.
contract NorenDutchTest is RobinhoodBase {
  using Math for uint256;

  uint256 internal constant BPS = 10_000;
  uint256 internal constant WAD = 1e18;
  uint128 internal constant PRICE = 400e6;
  uint16 internal constant START = 50; // 0.5%
  uint16 internal constant CAP = 800; // 8%
  uint32 internal constant DURATION = 1 hours;
  uint16 internal constant KEEPER_SHARE = 2_500; // 25% of the discount
  uint16 internal constant TARGET = 11_000; // health 1.10 after a fill

  NorenDutchAuction internal auction;
  address internal maker = makeAddr('dutchMaker');
  address internal pegMaker = makeAddr('pegMaker');
  address internal keeper = makeAddr('keeper');
  address internal attacker = makeAddr('attacker');
  bytes32 internal dutchHash;

  function setUp() public override {
    super.setUp();
    // A fork freezes the 24/7 USDG and ETH feeds at the fork block; auctions warp through hours.
    // NVDA keeps its production limits (25 h open market, 3 days in the closed window).
    _allowFrozen247Feeds();
    auction = new NorenDutchAuction(owner, credit, swapRouter, START, CAP, DURATION, KEEPER_SHARE, TARGET);
    vm.prank(owner);
    credit.setDutchAuction(address(auction));
    dutchHash = _shipDutch(maker, 20_000e6, 0);
  }

  // ------------------------------------------------------------ helpers

  function _shipDutch(address who, uint256 usdgAmount, uint64 salt) internal returns (bytes32 h) {
    _fund(RH.USDG, who, usdgAmount);
    (ISwapVMRouter.Order memory o,) = auction.buildOrder(who, RH.NVDA, salt);
    address[] memory tokens = new address[](2);
    tokens[0] = RH.USDG;
    tokens[1] = RH.NVDA;
    uint256[] memory amounts = new uint256[](2);
    amounts[0] = usdgAmount;
    vm.startPrank(who);
    usdg.approve(RH.AQUA, type(uint256).max);
    aqua.ship(address(swapRouter), abi.encode(o), tokens, amounts);
    h = auction.register(RH.NVDA, salt);
    vm.stopPrank();
  }

  function _nvdaFor(uint256 usdgAmt, uint16 ratio) internal view returns (uint256 amt) {
    (amt,) = oracle.assetForUsd8(RH.NVDA, oracle.usdgToUsd8(usdgAmt, Math.Rounding.Ceil) * ratio / 10_000, 0);
    amt = amt * 10_100 / 10_000;
    if (oracle.marketClosed(block.timestamp)) amt = amt * 10_600 / 10_000;
  }

  function _openPlan(bytes32 id) internal returns (uint256 planId, uint256 col) {
    _attest(customer, 2, 1_000e6, 14_000);
    col = _nvdaFor(PRICE, 14_000);
    _invoice(id, PRICE);
    _fund(RH.NVDA, customer, col);
    vm.startPrank(customer);
    nvda.approve(address(credit), col);
    planId = credit.openPlan(id, merchant, RH.NVDA, col);
    vm.stopPrank();
  }

  /// @dev Scale NVDA's value so the plan's health is `healthBps` / 10_000 (real multiplier admin path).
  function _dropToHealth(uint256 planId, uint256 healthBps) internal {
    uint256 h = auction.healthOf(planId);
    _setMultiplier(RH.NVDA, oracle.multiplier(RH.NVDA).mulDiv(healthBps * 1e14, h));
  }

  function _defaults(address who) internal view returns (uint32 d) {
    (,,,, d) = credit.history(who);
  }

  function _health(uint256 planId) internal view returns (uint256) {
    return auction.healthOf(planId);
  }

  function _valueUsdg(uint256 nvdaAmt) internal view returns (uint256) {
    return oracle.usd8ToUsdg(oracle.valueUsd8(RH.NVDA, nvdaAmt), Math.Rounding.Floor);
  }

  function _outstanding(uint256 planId) internal view returns (uint256) {
    NorenCredit.Plan memory p = credit.plan(planId);
    return p.status == NorenCredit.PlanStatus.Active ? p.principal - p.repaid : 0;
  }

  /// @dev Borrower's equity in a plan: collateral value still locked minus what is still owed.
  function _equityUsdg(uint256 planId) internal view returns (int256) {
    NorenCredit.Plan memory p = credit.plan(planId);
    if (p.status != NorenCredit.PlanStatus.Active) return 0;
    return int256(_valueUsdg(p.collateralAmount)) - int256(p.principal - p.repaid);
  }

  // ------------------------------------------------------------ setup

  function test_dutchStrategySetup() public {
    (ISwapVMRouter.Order memory o, bytes32 h) = auction.buildOrder(maker, RH.NVDA, 0);
    assertEq(h, dutchHash);
    assertEq(h, swapRouter.hash(o), 'Noren-built hash = SwapVM Aqua order hash');
    assertEq(o.traits, uint256(1) << 254, 'Aqua order, no hooks, maker is the receiver');
    assertEq(uint8(o.data[10]), 35, 'program: Salt, then NorenDutchDecay (opcode 35)');
    assertEq(uint8(o.data[42]), 34, 'then NorenOraclePeg (opcode 34)');
    assertEq(auction.strategiesFor(RH.NVDA).length, 1);
    vm.prank(maker);
    vm.expectPartialRevert(NorenDutchAuction.StrategyNotShipped.selector);
    auction.register(RH.NVDA, 1);
  }

  function test_cannotOpenWhileHealthy() public {
    (uint256 planId,) = _openPlan(keccak256('healthy'));
    assertGt(_health(planId), WAD);
    vm.prank(attacker);
    vm.expectRevert(abi.encodeWithSelector(NorenDutchAuction.NotLiquidatable.selector, planId));
    auction.openAuction(planId);
    assertEq(auction.dutchAuctionStart(bytes32(planId)), 0);
  }

  // ------------------------------------------------------------ the discount over time

  function test_discountGrowsOverTime() public {
    (uint256 planId,) = _openPlan(keccak256('decay'));
    _dropToHealth(planId, 9_900); // collateral 108.9% of the debt: restorable even at the 8% cap
    auction.openAuction(planId);
    uint256 t0 = vm.getBlockTimestamp();
    uint256[6] memory at = [uint256(0), 10 minutes, 20 minutes, 30 minutes, 1 hours, 3 hours];
    uint256 prevPerUsdg;
    for (uint256 i; i < at.length; ++i) {
      vm.warp(t0 + at[i]);
      uint256 expected = uint256(START) * 1e14 + uint256(CAP - START) * 1e14 * Math.min(at[i], DURATION) / DURATION;
      assertEq(auction.discountWad(planId), expected, 'linear from 0.5% to the 8% cap');
      NorenDutchAuction.Status memory s = auction.auctionStatus(planId);
      assertEq(s.discountWad, expected);
      assertEq(s.keeperDiscountWad + s.makerDiscountWad, expected, 'keeper share comes out of the discount');
      NorenDutchAuction.Fill memory f = auction.previewFill(planId, type(uint256).max);
      uint256 perUsdg = (f.collateralSold + f.keeperBonus) * 1e18 / f.repayUsdg;
      if (i != 0 && at[i] <= DURATION) assertGt(perUsdg, prevPerUsdg, 'more collateral per USDG as the discount grows');
      if (at[i] > DURATION) assertApproxEqRel(perUsdg, prevPerUsdg, 1e6, 'flat at the cap (wei rounding)');
      console2.log('minute', at[i] / 60, 'discount bps', expected / 1e14);
      console2.log('  NVDA sold+bonus per 1 USDG repaid (1e18)', perUsdg);
      prevPerUsdg = perUsdg;
    }
  }

  // ------------------------------------------------------------ partial fills

  function test_partialFillRestoresHealthTargetExactly() public {
    (uint256 planId, uint256 col) = _openPlan(keccak256('partial'));
    _dropToHealth(planId, 9_600);
    assertLt(_health(planId), WAD);
    vm.prank(keeper);
    auction.openAuction(planId);
    vm.warp(vm.getBlockTimestamp() + 10 minutes);

    NorenDutchAuction.Fill memory pf = auction.previewFill(planId, type(uint256).max);
    uint256 d = auction.discountWad(planId);
    uint256 dk = d * KEEPER_SHARE / BPS;
    uint256 idle = vault.idleUsdg();
    uint256 makerUsdg = usdg.balanceOf(maker);
    uint256 debtBefore = _outstanding(planId);

    vm.prank(keeper);
    NorenDutchAuction.Fill memory f = auction.fill(planId, type(uint256).max);

    assertEq(f.repayUsdg, pf.repayUsdg, 'preview = fill');
    assertEq(f.collateralSold, pf.collateralSold);
    assertFalse(f.sellAll);
    uint256 h = _health(planId);
    assertGe(h, uint256(TARGET) * 1e14, 'health restored to at least 1.10');
    assertLe(h, uint256(TARGET) * 1e14 + 1e10, 'and to 1.10 exactly (within 1e-8)');
    assertEq(f.healthAfterWad, h);
    assertLt(f.repayUsdg, debtBefore, 'partial: only part of the debt');
    assertEq(_outstanding(planId), debtBefore - f.repayUsdg);
    assertEq(vault.idleUsdg(), idle + f.repayUsdg, 'maker USDG straight to the lender pool');
    assertEq(makerUsdg - usdg.balanceOf(maker), f.repayUsdg);
    assertEq(nvda.balanceOf(maker), f.collateralSold, 'maker bought the collateral');
    assertEq(nvda.balanceOf(keeper), f.keeperBonus, 'keeper paid in collateral');
    assertEq(f.keeperBonus, f.collateralSold.mulDiv(dk, WAD), 'keeper bonus = its share of the discount');
    assertEq(usdg.balanceOf(keeper), 0, 'keeper paid nothing');
    NorenCredit.Plan memory p = credit.plan(planId);
    assertEq(uint8(p.status), uint8(NorenCredit.PlanStatus.Active), 'plan stays open');
    assertEq(p.collateralAmount, col - f.collateralSold - f.keeperBonus, 'the rest stays with the borrower');
    assertEq(nvda.balanceOf(address(auction)), 0);
    // Borrower's whole cost = discount x value sold (no bonus on top)
    uint256 soldValue = _valueUsdg(f.collateralSold);
    uint256 cost = soldValue + _valueUsdg(f.keeperBonus) - f.repayUsdg;
    assertApproxEqAbs(cost, soldValue.mulDiv(d, WAD), 3, 'borrower cost = discount x value sold');
    assertEq(auction.dutchAuctionStart(bytes32(planId)), 0, 'healthy again: auction closed');
    assertEq(_defaults(customer), 1);
    NorenDutchAuction.Strategy memory s = auction.strategy(dutchHash);
    assertEq(s.fills, 1);
    assertEq(s.usdgPaid, f.repayUsdg);
    console2.log('repaid USDG (1e6)', f.repayUsdg);
    console2.log('NVDA sold / keeper bonus (1e18)', f.collateralSold, f.keeperBonus);
    console2.log('health after (1e18)', h);
  }

  function test_multipleFillsUntilHealthy() public {
    (uint256 planId,) = _openPlan(keccak256('multi'));
    _dropToHealth(planId, 9_600);
    auction.openAuction(planId);
    vm.warp(vm.getBlockTimestamp() + 5 minutes);
    NorenDutchAuction.Fill memory need = auction.previewFill(planId, type(uint256).max);

    vm.prank(keeper);
    NorenDutchAuction.Fill memory f1 = auction.fill(planId, need.repayUsdg / 3);
    assertEq(f1.repayUsdg, need.repayUsdg / 3);
    assertLt(_health(planId), WAD, 'still unhealthy after a capped fill');
    assertGt(auction.dutchAuctionStart(bytes32(planId)), 0, 'auction stays open');
    uint256 d1 = f1.discountWad;

    vm.warp(vm.getBlockTimestamp() + 10 minutes);
    vm.prank(keeper);
    NorenDutchAuction.Fill memory f2 = auction.fill(planId, type(uint256).max);
    assertGt(f2.discountWad, d1, 'second fill continues the same auction clock');
    uint256 h = _health(planId);
    assertGe(h, uint256(TARGET) * 1e14);
    assertLe(h, uint256(TARGET) * 1e14 + 1e10);
    assertEq(auction.auction(planId).fills, 2);
    assertEq(auction.dutchAuctionStart(bytes32(planId)), 0, 'closed once healthy');
    assertEq(_defaults(customer), 1, 'one default for one auction');
    assertEq(uint8(credit.plan(planId).status), uint8(NorenCredit.PlanStatus.Active));
    vm.prank(keeper);
    vm.expectRevert(abi.encodeWithSelector(NorenDutchAuction.AuctionNotOpen.selector, planId));
    auction.fill(planId, type(uint256).max);
  }

  /// @notice Same plan, same price drop: the old full liquidation (sell to a 50 bps peg maker, 5%
  /// keeper bonus on the whole debt) vs one Dutch fill. The borrower ends with more equity.
  function test_borrowerKeepsMoreThanFullLiquidation() public {
    _shipMaker(pegMaker, RH.NVDA, 10_000e6, 50, 80, 0);
    (uint256 planId, uint256 col) = _openPlan(keccak256('compare'));
    _dropToHealth(planId, 9_600);
    uint256 snap = vm.snapshotState();

    vm.prank(keeper);
    credit.liquidatePlanViaAqua(planId);
    uint256 fullBack = nvda.balanceOf(customer);
    uint256 fullEquity = _valueUsdg(fullBack); // debt cleared, collateral returned
    vm.revertToState(snap);

    auction.openAuction(planId);
    vm.warp(vm.getBlockTimestamp() + 20 minutes);
    vm.prank(keeper);
    NorenDutchAuction.Fill memory f = auction.fill(planId, type(uint256).max);
    NorenCredit.Plan memory p = credit.plan(planId);
    int256 dutchEquity = _equityUsdg(planId);
    assertGt(dutchEquity, int256(fullEquity), 'borrower keeps more equity with the Dutch fill');
    assertGt(p.collateralAmount, fullBack, 'and more NVDA');
    console2.log('collateral NVDA (1e18)', col);
    console2.log('Dutch: NVDA kept in the plan, debt left (1e6)', p.collateralAmount, p.principal - p.repaid);
    console2.log('Dutch: equity USDG (1e6), discount bps', uint256(dutchEquity), f.discountWad / 1e14);
    console2.log('Full:  NVDA returned, equity USDG (1e6)', fullBack, fullEquity);
  }

  function test_overdueFillPaysOnlyTheMissedInstallments() public {
    (uint256 planId, uint256 col) = _openPlan(keccak256('overdue'));
    vm.warp(credit.dueAt(planId, 2) + GRACE + 1); // installments 1 and 2 missed
    (bool overdue, bool under) = credit.planLiquidatable(planId);
    assertTrue(overdue);
    assertFalse(under);
    auction.openAuction(planId);
    vm.prank(keeper);
    NorenDutchAuction.Fill memory f = auction.fill(planId, type(uint256).max);
    assertEq(f.repayUsdg, credit.cumulativeDue(planId, 2), 'exactly the two missed installments');
    NorenCredit.Plan memory p = credit.plan(planId);
    assertEq(p.paid, 2);
    assertEq(uint8(p.status), uint8(NorenCredit.PlanStatus.Active));
    (overdue, under) = credit.planLiquidatable(planId);
    assertFalse(overdue || under);
    assertEq(auction.dutchAuctionStart(bytes32(planId)), 0);
    // the borrower pays the last installment normally and gets the rest of the collateral back
    uint256 last = credit.installmentAmount(planId, 3);
    _fund(RH.USDG, customer, last);
    vm.startPrank(customer);
    usdg.approve(address(credit), last);
    credit.repay(planId, 1);
    vm.stopPrank();
    assertEq(uint8(credit.plan(planId).status), uint8(NorenCredit.PlanStatus.Repaid));
    assertEq(nvda.balanceOf(customer), col - f.collateralSold - f.keeperBonus);
    assertEq(credit.planOutstanding(), 0);
  }

  /// @notice No bad debt on the tested price paths: health 0.99 / 0.97 / 0.95 (collateral 108.9% /
  /// 106.7% / 104.5% of the debt) filled at the start and after 20 minutes, and health 0.99 filled at
  /// the 8% cap. A fill restores the target only while collateral value >= c x debt, c = (1 + dk) /
  /// (1 - dm) (1.005 at the start, 1.085 at the cap); below that the sell-all path records bad debt
  /// (test_underwaterSellsAllAndRecordsBadDebt).
  function test_noBadDebtOnTestedPricePaths() public {
    uint16[6] memory healths = [uint16(9_900), 9_700, 9_500, 9_700, 9_500, 9_900];
    uint32[6] memory waits = [uint32(0), 0, 0, 20 minutes, 20 minutes, 2 hours];
    for (uint256 i; i < healths.length; ++i) {
      uint256 snap = vm.snapshotState();
      (uint256 planId,) = _openPlan(keccak256(abi.encode('paths', i)));
      _dropToHealth(planId, healths[i]);
      auction.openAuction(planId);
      vm.warp(vm.getBlockTimestamp() + waits[i]);
      vm.prank(keeper);
      NorenDutchAuction.Fill memory f = auction.fill(planId, type(uint256).max);
      assertEq(f.badDebtUsdg, 0);
      assertEq(credit.badDebtUsdg(), 0);
      assertFalse(f.sellAll);
      assertGe(_health(planId), uint256(TARGET) * 1e14);
      vm.revertToState(snap);
    }
  }

  /// @notice Below the point where any sale can restore the target, everything is sold (keeper share
  /// first) and the shortfall is recorded as bad debt instead of being hidden.
  function test_underwaterSellsAllAndRecordsBadDebt() public {
    (uint256 planId, uint256 col) = _openPlan(keccak256('underwater'));
    _dropToHealth(planId, 8_800); // collateral worth 96.8% of the debt
    auction.openAuction(planId);
    vm.prank(keeper);
    NorenDutchAuction.Fill memory f = auction.fill(planId, type(uint256).max);
    assertTrue(f.sellAll);
    assertEq(f.collateralSold + f.keeperBonus, col);
    assertEq(uint8(credit.plan(planId).status), uint8(NorenCredit.PlanStatus.Liquidated));
    assertEq(credit.badDebtUsdg(), PRICE - f.repayUsdg);
    assertEq(credit.planOutstanding(), 0);
  }

  // ------------------------------------------------------------ attacks

  /// @notice Nobody but the auction house can sell into a Dutch strategy, so an attacker cannot dump
  /// their own NVDA on the maker at the auction discount, even while an auction is open.
  function test_attackerCannotTakeTheDiscountDirectly() public {
    (uint256 planId,) = _openPlan(keccak256('direct'));
    _dropToHealth(planId, 9_500);
    auction.openAuction(planId);
    vm.warp(vm.getBlockTimestamp() + 2 hours); // full discount
    _fund(RH.NVDA, attacker, 1e18);
    ISwapVMRouter.Order memory o = auction.order(dutchHash);
    // instruction args = the open auction's id; exact-in 1 NVDA
    bytes memory td = abi.encodePacked(
      uint160(32 | (32 << 16) | (32 << 32) | (32 << 48) | (32 << 64) | (32 << 80) | (32 << 96) | (32 << 112) | (32 << 128) | (64 << 144)),
      uint16(0x0041),
      uint256(0),
      bytes32(planId)
    );
    vm.startPrank(attacker);
    nvda.approve(address(swapRouter), 1e18);
    vm.expectRevert(abi.encodeWithSignature('NorenDutchDecayTakerNotHouse(address)', attacker));
    swapRouter.swap(o, RH.NVDA, RH.USDG, 1e18, td);
    vm.stopPrank();
  }

  /// @notice Early-fill attack: opening an auction on a healthy plan to grab collateral at a
  /// discount is refused, and no fill can run before an auction is open.
  function test_earlyFillAtBadPriceRejected() public {
    (uint256 planId,) = _openPlan(keccak256('early'));
    vm.prank(attacker);
    vm.expectRevert(abi.encodeWithSelector(NorenDutchAuction.AuctionNotOpen.selector, planId));
    auction.fill(planId, type(uint256).max);
    vm.prank(attacker);
    vm.expectRevert(abi.encodeWithSelector(NorenDutchAuction.NotLiquidatable.selector, planId));
    auction.openAuction(planId);
    // Opened legitimately: the first fill is at the 0.5% start discount, never more, and the maker
    // never pays above the oracle.
    _dropToHealth(planId, 9_500);
    auction.openAuction(planId);
    vm.prank(attacker);
    NorenDutchAuction.Fill memory f = auction.fill(planId, type(uint256).max);
    assertEq(f.discountWad, uint256(START) * 1e14);
    assertLe(f.repayUsdg, _valueUsdg(f.collateralSold), 'maker paid at most the oracle value');
    assertGe(f.repayUsdg, _valueUsdg(f.collateralSold).mulDiv(BPS - START, BPS) - 1, 'and no less than 0.5% under it');
  }

  function test_fillAfterRecoveryRejected() public {
    (uint256 planId,) = _openPlan(keccak256('recover'));
    uint256 m = oracle.multiplier(RH.NVDA);
    _dropToHealth(planId, 9_500);
    auction.openAuction(planId);
    vm.warp(vm.getBlockTimestamp() + 30 minutes);
    _setMultiplier(RH.NVDA, m); // price back up: healthy again
    vm.prank(keeper);
    vm.expectRevert(abi.encodeWithSelector(NorenDutchAuction.NotLiquidatable.selector, planId));
    auction.fill(planId, type(uint256).max);
    auction.closeAuction(planId);
    assertEq(auction.dutchAuctionStart(bytes32(planId)), 0);
    assertEq(_defaults(customer), 0, 'no fill, no default');
  }

  function test_closeRefusedWhileStillLiquidatable() public {
    (uint256 planId,) = _openPlan(keccak256('close'));
    _dropToHealth(planId, 9_500);
    auction.openAuction(planId);
    vm.expectRevert(abi.encodeWithSelector(NorenDutchAuction.StillLiquidatable.selector, planId));
    auction.closeAuction(planId);
    vm.expectRevert(abi.encodeWithSelector(NorenDutchAuction.AuctionAlreadyOpen.selector, planId));
    auction.openAuction(planId);
  }

  function test_staleOracleBlocksFills() public {
    (uint256 planId,) = _openPlan(keccak256('stale'));
    _dropToHealth(planId, 9_500);
    auction.openAuction(planId);
    vm.warp(_nextAt(3, 15) + 7 days); // a Wednesday afternoon, far past NVDA's 25 h maximum age
    vm.prank(keeper);
    vm.expectPartialRevert(NorenAssetOracle.StalePrice.selector);
    auction.fill(planId, type(uint256).max);
    NorenDutchAuction.Status memory s = auction.auctionStatus(planId);
    assertTrue(s.open);
    assertEq(s.healthWad, 0);
    assertGt(bytes(s.error).length, 0, 'status explains the stale feed');
  }

  function test_onlyTheAuctionCanSeize() public {
    (uint256 planId,) = _openPlan(keccak256('seize'));
    vm.prank(attacker);
    vm.expectRevert(NorenCredit.NotAuction.selector);
    credit.auctionSeize(planId, 1, 0, false);
  }

  function test_badAuctionConfigRejected() public {
    vm.expectRevert(NorenDutchAuction.BadConfig.selector);
    new NorenDutchAuction(owner, credit, swapRouter, 900, 800, DURATION, KEEPER_SHARE, TARGET);
    vm.expectRevert(NorenDutchAuction.BadConfig.selector);
    new NorenDutchAuction(owner, credit, swapRouter, START, 2_001, DURATION, KEEPER_SHARE, TARGET);
    vm.expectRevert(NorenDutchAuction.BadConfig.selector);
    new NorenDutchAuction(owner, credit, swapRouter, START, CAP, DURATION, KEEPER_SHARE, 9_000);
  }
}
