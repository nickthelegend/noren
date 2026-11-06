// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from '@oz/utils/math/Math.sol';
import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {ISwapVMRouter} from '../src/interfaces/IAquaSwapVM.sol';
import {RobinhoodBase} from './RobinhoodBase.sol';
import {NorenCredit} from '../src/NorenCredit.sol';
import {NorenCreditLens} from '../src/NorenCreditLens.sol';
import {NorenLiquidity} from '../src/NorenLiquidity.sol';
import {NorenDepositVault} from '../src/NorenDepositVault.sol';
import {IRobinhoodStockToken} from '../src/interfaces/IRobinhoodStockToken.sol';
import {RobinhoodMainnet as RH} from '../script/RobinhoodMainnet.sol';

/// @notice Credit lines backed by Noren deposit-vault shares (nNVDA): deposit NVDA into the Aqua
/// maker vault, lock the shares for an Arc credit line at the tier's LTV, let real SwapVM fills earn
/// fees that repay the line, and liquidate through Aqua makers when it goes under. Fresh Robinhood
/// mainnet fork: real NVDA, USDG, Chainlink feeds, the official Aqua registry and the Noren router.
contract NorenShareCreditTest is RobinhoodBase {
  using Math for uint256;

  NorenDepositVault internal nNVDA;
  NorenCreditLens internal lens;

  address internal maker = makeAddr('maker');
  address internal buyer = makeAddr('buyer');
  address internal keeper = makeAddr('keeper');
  address internal stranger = makeAddr('stranger');

  function setUp() public override {
    super.setUp();
    vm.startPrank(owner);
    nNVDA = new NorenDepositVault(owner, IERC20(RH.NVDA), oracle, liquidity, false, 'Noren NVDA deposit', 'nNVDA');
    nNVDA.shipStrategy(NorenLiquidity.PegTerms(40, 60, 300, 0, 0, 0));
    nNVDA.setHarvesterAllowed(address(credit), true);
    credit.setShareCollateral(address(nNVDA), true);
    vm.stopPrank();
    lens = new NorenCreditLens(credit);
    // An independent maker with wider asks (so buyers fill the vault's ask) and bids that buy
    // liquidated NVDA.
    _ship(maker, RH.NVDA, 50_000e6, NorenLiquidity.PegTerms(50, 400, 100, 0, 0, 0));
  }

  // ------------------------------------------------------------ helpers

  function _ship(address m, address asset, uint256 usdgAmount, NorenLiquidity.PegTerms memory t) internal {
    _fund(RH.USDG, m, usdgAmount);
    (ISwapVMRouter.Order memory o,) = liquidity.buildOrder(m, asset, t);
    address[] memory tokens = new address[](2);
    tokens[0] = RH.USDG;
    tokens[1] = asset;
    uint256[] memory amounts = new uint256[](2);
    amounts[0] = usdgAmount;
    vm.startPrank(m);
    usdg.approve(RH.AQUA, type(uint256).max);
    aqua.ship(address(swapRouter), abi.encode(o), tokens, amounts);
    liquidity.register(asset, t);
    vm.stopPrank();
  }

  function _deposit(address who, uint256 amount) internal returns (uint256 shares) {
    _fund(RH.NVDA, who, amount);
    vm.startPrank(who);
    nvda.approve(address(nNVDA), amount);
    shares = nNVDA.deposit(amount, who);
    vm.stopPrank();
  }

  function _openShares(uint256 shares, uint256 limit, uint64 expiry) internal returns (bytes32 id) {
    vm.startPrank(customer);
    IERC20(address(nNVDA)).approve(address(credit), shares);
    id = credit.openCreditLine(address(nNVDA), shares, limit, expiry);
    vm.stopPrank();
  }

  function _report(bytes32 id, uint256 drawn, uint256 repaid) internal {
    // each Arc report carries a later asOf (vm.getBlockTimestamp: via-IR may reuse a cached timestamp)
    uint64 asOf = uint64(vm.getBlockTimestamp());
    if (asOf <= credit.line(id).asOf) asOf = credit.line(id).asOf + 1;
    vm.prank(forwarder);
    credit.onReport('', abi.encode(id, drawn, repaid, asOf));
  }

  /// @dev A trader buys `amountOut` NVDA from the best ask (the vault's), paying its spread as fee.
  function _buy(uint256 amountOut) internal returns (uint256 usdgIn) {
    (, uint256 quoteIn) = liquidity.bestAskForAsset(RH.NVDA, amountOut);
    _fund(RH.USDG, buyer, quoteIn);
    vm.startPrank(buyer);
    usdg.approve(address(liquidity), quoteIn);
    (usdgIn,) = liquidity.buyFromMakers(RH.NVDA, amountOut, quoteIn, buyer);
    vm.stopPrank();
  }

  function _ceil() internal pure returns (Math.Rounding) {
    return Math.Rounding.Ceil;
  }

  // ------------------------------------------------------------ limits

  function test_ShareLine_topTierOpensAt80PercentLtv() public {
    _attest(customer, 4, 100_000e6, 12_500); // 125% ratio = 80% LTV
    uint256 shares = _deposit(customer, 2e18);
    (uint256 limit, uint256 valueUsd8, uint16 ltv) = lens.maxCreditLimit(customer, address(nNVDA), shares);
    assertEq(ltv, 8_000, '125% collateral ratio = 80% LTV');
    assertEq(valueUsd8, nNVDA.sharesValueUsd8(shares, true));
    assertEq(limit, valueUsd8 * 8_000 / 10_000 / 100, 'limit = risk value x 80%');
    assertGt(limit, 200e6, '2 NVDA back more than $200 of credit');

    vm.startPrank(customer);
    IERC20(address(nNVDA)).approve(address(credit), shares);
    uint256 required = ((limit + 1) * 100).mulDiv(12_500, 10_000, _ceil());
    vm.expectRevert(abi.encodeWithSelector(NorenCredit.InsufficientCollateral.selector, valueUsd8, required));
    credit.openCreditLine(address(nNVDA), shares, limit + 1, uint64(block.timestamp + 30 days));
    vm.stopPrank();

    uint64 expiry = uint64(block.timestamp + 30 days);
    bytes32 expectedId = keccak256(abi.encode(block.chainid, address(credit), customer, uint256(0)));
    vm.expectEmit(true, true, false, true, address(credit));
    emit NorenCredit.CreditLineOpened(customer, expectedId, limit, expiry, valueUsd8);
    vm.prank(customer); // shares already approved above
    bytes32 id = credit.openCreditLine(address(nNVDA), shares, limit, expiry);
    assertEq(id, expectedId);
    assertEq(IERC20(address(nNVDA)).balanceOf(address(credit)), shares, 'the shares are locked, still an Aqua maker position');
    assertEq(credit.line(id).collateral, address(nNVDA));
  }

  function test_ShareLine_lowestTierOpensAt66Percent() public {
    _attest(customer, 1, 100_000e6, 15_000); // 150% ratio = 66.67% LTV
    uint256 shares = _deposit(customer, 2e18);
    (uint256 limit, uint256 valueUsd8, uint16 ltv) = lens.maxCreditLimit(customer, address(nNVDA), shares);
    assertEq(ltv, 6_666);
    assertEq(limit, valueUsd8.mulDiv(10_000, 15_000 * 100));
    vm.startPrank(customer);
    IERC20(address(nNVDA)).approve(address(credit), shares);
    vm.expectRevert();
    credit.openCreditLine(address(nNVDA), shares, limit + 1, uint64(block.timestamp + 30 days));
    vm.stopPrank();
    _openShares(shares, limit, uint64(block.timestamp + 30 days));
  }

  function test_ShareLine_limitCappedByAvailableCredit() public {
    _attest(customer, 4, 50e6, 12_500);
    uint256 shares = _deposit(customer, 2e18);
    (uint256 limit,,) = lens.maxCreditLimit(customer, address(nNVDA), shares);
    assertEq(limit, 50e6, 'the attested limit caps the collateral-based limit');
    vm.startPrank(customer);
    IERC20(address(nNVDA)).approve(address(credit), shares);
    vm.expectRevert(abi.encodeWithSelector(NorenCredit.OverLimit.selector, 50e6 + 1, 50e6));
    credit.openCreditLine(address(nNVDA), shares, 50e6 + 1, uint64(block.timestamp + 30 days));
    vm.stopPrank();
  }

  function test_ShareLine_rawTokenPathUnchangedAndSharesRefusedForPlansAndWhenNotAccepted() public {
    _attest(customer, 4, 100_000e6, 12_500);
    // raw NVDA still works and the lens prices it the same way
    _fund(RH.NVDA, customer, 1e18);
    (uint256 rawLimit,,) = lens.maxCreditLimit(customer, RH.NVDA, 1e18);
    vm.startPrank(customer);
    nvda.approve(address(credit), 1e18);
    credit.openCreditLine(RH.NVDA, 1e18, rawLimit, uint64(block.timestamp + 30 days));
    vm.stopPrank();
    // Pay in 3 plans never take shares (the Dutch auction sells raw collateral)
    uint256 shares = _deposit(customer, 1e18);
    _invoice(keccak256('inv'), 50e6);
    vm.startPrank(customer);
    IERC20(address(nNVDA)).approve(address(credit), shares);
    vm.expectRevert(abi.encodeWithSelector(NorenCredit.CollateralNotAccepted.selector, address(nNVDA)));
    credit.openPlan(keccak256('inv'), merchant, address(nNVDA), shares);
    vm.stopPrank();
    // once the owner stops accepting the vault, new lines refuse it
    vm.prank(owner);
    credit.setShareCollateral(address(nNVDA), false);
    vm.startPrank(customer);
    vm.expectRevert(abi.encodeWithSelector(NorenCredit.CollateralNotAccepted.selector, address(nNVDA)));
    credit.openCreditLine(address(nNVDA), shares, 10e6, uint64(block.timestamp + 30 days));
    vm.stopPrank();
    vm.expectRevert(abi.encodeWithSelector(NorenCreditLens.CollateralNotAccepted.selector, address(nNVDA)));
    lens.maxCreditLimit(customer, address(nNVDA), shares);
  }

  // ------------------------------------------------------------ yield

  function test_ShareLine_aquaFillsEarnFeesAndHarvestRepaysTheLine() public {
    _attest(customer, 4, 100_000e6, 12_500);
    uint256 shares = _deposit(customer, 5e18);
    (uint256 limit,,) = lens.maxCreditLimit(customer, address(nNVDA), shares);
    bytes32 id = _openShares(shares, limit / 2, uint64(block.timestamp + 30 days));
    _report(id, 300e6, 0); // 300 USDC spent at Noren merchants on Arc

    vm.prank(keeper);
    vm.expectRevert(NorenCredit.NoYield.selector);
    credit.harvestLineToRepay(id);

    // Real SwapVM fills on the vault's ask: traders pay the 60 bps spread, which is the depositors' fee.
    (uint256 fees0,,) = nNVDA.feeBook();
    _buy(5e17);
    _buy(25e16);
    (uint256 fees1, uint256 fills,) = nNVDA.feeBook();
    assertEq(fills, 2);
    assertGt(fees1, fees0, 'fills booked maker fees');
    (uint256 pending,,) = lens.lineYield(id);
    assertApproxEqAbs(pending, fees1 - fees0, 2, 'the line owns all shares, so all the yield');

    uint256 valueBefore = nNVDA.sharesValueUsd8(shares, false);
    uint256 lenderBefore = usdg.balanceOf(address(vault));
    uint256 keeperBefore = usdg.balanceOf(keeper);
    vm.prank(keeper);
    uint256 out = credit.harvestLineToRepay(id);
    (uint256 pendingAfter, uint256 paid6, uint256 paidG) = lens.lineYield(id);
    assertEq(pendingAfter, 0);
    assertEq(paidG, pending, 'all yield paid out in USDG');
    assertEq(usdg.balanceOf(address(vault)) - lenderBefore, pending, 'the vault (treasury) received the yield');
    assertEq(usdg.balanceOf(keeper), keeperBefore, 'the keeper gets nothing');
    assertEq(credit.lineOutstanding(id), 300e6 - paid6, 'outstanding fell by the yield');
    assertGt(paid6, 0);
    assertEq(credit.line(id).collateralAmount, shares - out, 'only yield shares left the line');
    uint256 valueAfter = nNVDA.sharesValueUsd8(shares - out, false);
    assertApproxEqAbs(valueBefore - valueAfter, oracle.usdgToUsd8(pending, _ceil()), 2e2, 'principal stays locked');

    // A second harvest with no new fills has nothing to take.
    vm.expectRevert(NorenCredit.NoYield.selector);
    credit.harvestLineToRepay(id);
  }

  function test_ShareLine_onlyTheBorrowerClaimsYieldAndOnlyWhenNothingIsOwed() public {
    _attest(customer, 4, 100_000e6, 12_500);
    uint256 shares = _deposit(customer, 5e18);
    bytes32 id = _openShares(shares, 200e6, uint64(block.timestamp + 30 days));
    _buy(5e17);
    (uint256 pending,,) = lens.lineYield(id);
    assertGt(pending, 0);

    vm.prank(stranger);
    vm.expectRevert(NorenCredit.NotBorrower.selector);
    credit.claimLineYield(id);

    _report(id, 50e6, 0);
    vm.prank(customer);
    vm.expectRevert(abi.encodeWithSelector(NorenCredit.DebtOutstanding.selector, 50e6));
    credit.claimLineYield(id);
    _report(id, 50e6, 50e6); // repaid on Arc

    uint256 before = usdg.balanceOf(customer);
    vm.prank(customer);
    uint256 out = credit.claimLineYield(id);
    assertEq(usdg.balanceOf(customer) - before, pending, 'the borrower takes the yield in USDG');
    assertEq(credit.line(id).collateralAmount, shares - out);
    vm.prank(stranger);
    vm.expectRevert(NorenCredit.NotBorrower.selector);
    credit.claimLineYield(id);
  }

  function test_ShareLine_settlementRefundsYieldPaymentsArcMadeUnnecessary() public {
    _attest(customer, 4, 100_000e6, 12_500);
    uint256 shares = _deposit(customer, 5e18);
    bytes32 id = _openShares(shares, 200e6, uint64(block.timestamp + 30 days));
    _report(id, 100e6, 0);
    _buy(5e17);
    credit.harvestLineToRepay(id);
    (, uint256 paid6, uint256 paidG) = lens.lineYield(id);
    assertGt(paidG, 0);
    vm.prank(customer);
    credit.closeCreditLine(id); // Closing
    vm.warp(vm.getBlockTimestamp() + 2);
    uint256 before = usdg.balanceOf(customer);
    _report(id, 100e6, 100e6); // the borrower also repaid everything on Arc: the yield payment is refunded
    assertEq(uint8(credit.line(id).status), uint8(NorenCredit.LineStatus.Closed));
    assertEq(usdg.balanceOf(customer) - before, paidG, 'yield payment refunded');
    assertGt(paid6, 0);
    assertEq(IERC20(address(nNVDA)).balanceOf(customer), credit.line(id).collateralAmount, 'shares returned');
  }

  // ------------------------------------------------------------ liquidation

  function test_ShareLine_pastDueLiquidationRedeemsOnlyWhatTheDebtNeeds() public {
    _attest(customer, 4, 100_000e6, 12_500);
    uint256 shares = _deposit(customer, 5e18);
    (uint256 limit,,) = lens.maxCreditLimit(customer, address(nNVDA), shares);
    uint64 expiry = uint64(block.timestamp + 1 hours);
    bytes32 id = _openShares(shares, limit, expiry);
    uint256 drawn = limit / 4;
    _report(id, drawn, 0);
    vm.expectRevert(NorenCredit.NotLiquidatable.selector);
    credit.liquidateLineViaAqua(id);
    vm.warp(uint256(expiry) + GRACE + 1);
    (bool pastDue,) = credit.lineLiquidatable(id);
    assertTrue(pastDue);

    uint256 debtUsdg = oracle.usd8ToUsdg(drawn * 100, _ceil());
    uint256 lenderBefore = usdg.balanceOf(address(vault));
    vm.prank(keeper);
    uint256 proceeds = credit.liquidateLineViaAqua(id);
    assertEq(proceeds, debtUsdg, 'the whole debt is repaid: no bad debt');
    assertEq(usdg.balanceOf(address(vault)) - lenderBefore, debtUsdg);
    assertEq(credit.badDebtUsdg(), 0);
    uint256 back = IERC20(address(nNVDA)).balanceOf(customer);
    assertGt(back, shares / 2, 'most shares were never redeemed and went back to the borrower');
    assertLt(back, shares);
    assertGt(nvda.balanceOf(keeper), 0, 'the keeper earned the bonus in NVDA');
    assertEq(IERC20(address(nNVDA)).balanceOf(address(credit)), 0);
    assertEq(uint8(credit.line(id).status), uint8(NorenCredit.LineStatus.Liquidated));
    (,,, uint256 avail) = credit.creditTerms(customer);
    assertGt(avail, 0, 'the line limit is released');
  }

  function test_ShareLine_priceDropLiquidationViaAqua() public {
    _attest(customer, 4, 100_000e6, 12_500);
    uint256 shares = _deposit(customer, 5e18);
    (uint256 limit,,) = lens.maxCreditLimit(customer, address(nNVDA), shares);
    bytes32 id = _openShares(shares, limit, uint64(block.timestamp + 30 days));
    _report(id, limit, 0); // fully drawn on Arc
    (, bool under) = credit.lineLiquidatable(id);
    assertFalse(under);
    // NVDA value -13% through the real Stock Token multiplier role (Chainlink feeds are frozen on a fork)
    _setMultiplier(RH.NVDA, IRobinhoodStockToken(RH.NVDA).uiMultiplier() * 87 / 100);
    (, under) = credit.lineLiquidatable(id);
    assertTrue(under, 'below the 110% liquidation threshold');

    uint256 debtUsdg = oracle.usd8ToUsdg(limit * 100, _ceil());
    vm.prank(keeper);
    uint256 proceeds = credit.liquidateLineViaAqua(id);
    assertEq(proceeds, debtUsdg, 'makers bought enough NVDA to repay the debt: no bad debt');
    assertEq(credit.badDebtUsdg(), 0);
    assertGt(nvda.balanceOf(customer), 0, 'unsold NVDA went back to the borrower');
    assertEq(IERC20(address(nNVDA)).balanceOf(address(credit)), 0);
    assertEq(nvda.balanceOf(address(credit)), 0, 'nothing stranded in NorenCredit');
  }

  // ------------------------------------------------------------ vault attacks

  /// @notice First-depositor inflation: deposit 1 wei, donate a large amount, hope the victim's
  /// deposit rounds to few shares. The vault's 6-decimal virtual offset makes the attacker lose most of
  /// the donation and the victim keep (within rounding) everything it deposited.
  function test_ShareVault_firstDepositorDonationAttackFails() public {
    vm.startPrank(owner);
    NorenDepositVault fresh = new NorenDepositVault(owner, IERC20(RH.NVDA), oracle, liquidity, false, 'Noren NVDA deposit', 'nNVDA2');
    vm.stopPrank();
    address attacker = makeAddr('attacker');
    address victim = makeAddr('victim');
    _fund(RH.NVDA, attacker, 10e18 + 1);
    vm.startPrank(attacker);
    nvda.approve(address(fresh), 1);
    fresh.deposit(1, attacker);
    nvda.transfer(address(fresh), 10e18); // donation
    vm.stopPrank();
    _fund(RH.NVDA, victim, 10e18);
    vm.startPrank(victim);
    nvda.approve(address(fresh), 10e18);
    uint256 vShares = fresh.deposit(10e18, victim);
    vm.stopPrank();
    assertGt(vShares, 0);
    (uint256 victimAssets,) = fresh.inKind(vShares);
    (uint256 attackerAssets,) = fresh.inKind(fresh.balanceOf(attacker));
    assertGe(victimAssets, 10e18 * 9_999 / 10_000, 'victim keeps its deposit');
    assertLt(attackerAssets, 10e18, 'attacker loses part of its donation');
  }

  /// @notice A donation to the vault raises every holder's share value pro rata; it cannot make a line
  /// undercollateralised or create credit beyond what was donated to the line's own shares.
  function test_ShareVault_donationOnlyAddsProRataValue() public {
    _attest(customer, 4, 100_000e6, 12_500);
    uint256 shares = _deposit(customer, 1e18);
    _deposit(stranger, 3e18);
    uint256 before = nNVDA.sharesValueUsd8(shares, false);
    _fund(RH.NVDA, stranger, 4e18);
    vm.prank(stranger);
    nvda.transfer(address(nNVDA), 4e18); // doubles the vault
    uint256 afterDonation = nNVDA.sharesValueUsd8(shares, false);
    assertApproxEqRel(afterDonation, before * 2, 1e15, 'the line holder gets exactly its pro-rata quarter');
  }
}
