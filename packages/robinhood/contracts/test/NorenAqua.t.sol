// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from 'forge-std/console2.sol';
import {Math} from '@oz/utils/math/Math.sol';
import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {ReentrancyGuard} from '@oz/utils/ReentrancyGuard.sol';
import {RobinhoodBase} from './RobinhoodBase.sol';
import {NorenAssetOracle} from '../src/NorenAssetOracle.sol';
import {NorenCredit} from '../src/NorenCredit.sol';
import {NorenGateway} from '../src/NorenGateway.sol';
import {NorenLiquidity} from '../src/NorenLiquidity.sol';
import {ISwapVMRouter, INorenLiquidityMaker} from '../src/interfaces/IAquaSwapVM.sol';
import {IRobinhoodStockToken} from '../src/interfaces/IRobinhoodStockToken.sol';
import {RobinhoodMainnet as RH} from '../script/RobinhoodMainnet.sol';

interface IV4Quoter {
  struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
  }

  struct QuoteExactSingleParams {
    PoolKey poolKey;
    bool zeroForOne;
    uint128 exactAmount;
    bytes hookData;
  }

  function quoteExactInputSingle(QuoteExactSingleParams memory params) external returns (uint256 amountOut, uint256 gasEstimate);
}

/// @notice Noren on 1inch Aqua + SwapVM, on a fresh Robinhood mainnet fork: the official Aqua
/// registry at its real address, the modified SwapVM router redeployed against it, real USDG,
/// WETH, Stock Tokens and Chainlink feeds. Every balance delta is a real ERC-20 transfer.
contract NorenAquaTest is RobinhoodBase {
  using Math for uint256;

  uint256 internal constant BPS = 10_000;
  uint16 internal constant CLOSED_EXTRA = 300; // _shipMaker's closedExtraBps
  uint128 internal constant PRICE = 400e6;
  uint256 internal constant FIRST = 133_333_333;

  address internal maker = makeAddr('maker');
  address internal maker2 = makeAddr('maker2');
  address internal keeper = makeAddr('keeper');

  // ------------------------------------------------------------ helpers

  function _closed() internal view returns (bool) {
    return oracle.marketClosed(block.timestamp);
  }

  /// @dev Effective bid of a stock strategy right now (closedExtra applies while markets are closed).
  function _bid(uint16 bps) internal view returns (uint256) {
    return bps + (_closed() ? CLOSED_EXTRA : 0);
  }

  /// @dev Raw `asset` a maker with `bidBps` needs to pay out `usdgOut` (ceil), the instruction's math.
  function _makerIn(address asset, uint256 usdgOut, uint256 bidBps) internal view returns (uint256) {
    NorenAssetOracle.Price memory p = oracle.price(asset);
    uint256 m = oracle.multiplier(asset);
    uint256 usdgPx = oracle.price(RH.USDG).usd8;
    return usdgOut.mulDiv(usdgPx * 1e18 * 1e18 * BPS, p.usd8 * m * 1e6 * (BPS - bidBps), Math.Rounding.Ceil);
  }

  function _makerOut(address asset, uint256 assetIn, uint256 bidBps) internal view returns (uint256) {
    NorenAssetOracle.Price memory p = oracle.price(asset);
    uint256 m = oracle.multiplier(asset);
    uint256 usdgPx = oracle.price(RH.USDG).usd8;
    return assetIn.mulDiv(p.usd8 * m * 1e6 * (BPS - bidBps), usdgPx * 1e18 * 1e18 * BPS);
  }

  function _valueUsdg(address asset, uint256 amount) internal view returns (uint256) {
    return oracle.usd8ToUsdg(oracle.valueUsd8(asset, amount), Math.Rounding.Floor);
  }

  function _nvdaFor(uint256 usdgAmt, uint16 ratio) internal view returns (uint256 amt) {
    (amt,) = oracle.assetForUsd8(RH.NVDA, oracle.usdgToUsd8(usdgAmt, Math.Rounding.Ceil) * ratio / 10_000, 0);
    amt = amt * 10_100 / 10_000;
    if (_closed()) amt = amt * 10_600 / 10_000;
  }

  function _openPlan(bytes32 id, uint256 collateral) internal returns (uint256 planId) {
    _invoice(id, PRICE);
    _fund(RH.NVDA, customer, collateral);
    vm.startPrank(customer);
    nvda.approve(address(credit), collateral);
    planId = credit.openPlan(id, merchant, RH.NVDA, collateral);
    vm.stopPrank();
  }

  function _terms(uint16 bid) internal pure returns (NorenLiquidity.PegTerms memory) {
    return NorenLiquidity.PegTerms(bid, 80, CLOSED_EXTRA, 0, 0, 0);
  }

  // ------------------------------------------------------------ maker strategy setup

  function test_makerStrategySetup() public {
    (ISwapVMRouter.Order memory o, bytes32 h) = liquidity.buildOrder(maker, RH.NVDA, _terms(50));
    assertEq(h, swapRouter.hash(o), 'Noren-built hash = SwapVM Aqua order hash');
    assertEq(o.traits, uint256(1) << 254, 'Aqua order, no hooks, maker is the receiver');

    // registering before shipping fails loudly
    vm.prank(maker);
    vm.expectRevert(abi.encodeWithSelector(NorenLiquidity.StrategyNotShipped.selector, h));
    liquidity.register(RH.NVDA, _terms(50));

    bytes32 shipped = _shipMaker(maker, RH.NVDA, 10_000e6, 50, 80, 0);
    assertEq(shipped, h);
    NorenLiquidity.Strategy memory s = liquidity.strategy(h);
    assertEq(s.maker, maker);
    assertTrue(s.active);
    assertEq(s.bidSpreadBps, 50);
    (uint256 u, uint256 n) = liquidity.balances(h);
    assertEq(u, 10_000e6, 'Aqua virtual USDG');
    assertEq(n, 0);
    assertEq(usdg.balanceOf(maker), 10_000e6, 'USDG never left the maker wallet');
    assertEq(liquidity.strategiesFor(RH.NVDA).length, 1);
    assertEq(liquidity.strategiesOf(maker)[0], h);
    (uint248 raw, uint8 count) = aqua.rawBalances(maker, address(swapRouter), h, RH.USDG);
    assertEq(raw, 10_000e6);
    assertEq(count, 2);
  }

  function test_spreadAboveCapCannotRegister() public {
    vm.expectRevert(abi.encodeWithSelector(NorenLiquidity.SpreadTooWide.selector, uint16(301), uint16(300)));
    vm.prank(maker);
    liquidity.register(RH.NVDA, _terms(301));
  }

  function test_dockedStrategyCanBeRemovedByAnyone() public {
    bytes32 h = _shipMaker(maker, RH.NVDA, 1_000e6, 50, 80, 0);
    vm.expectRevert(abi.encodeWithSelector(NorenLiquidity.NotRemovable.selector, h));
    liquidity.remove(h);
    address[] memory tokens = new address[](2);
    tokens[0] = RH.USDG;
    tokens[1] = RH.NVDA;
    vm.prank(maker);
    aqua.dock(address(swapRouter), h, tokens);
    liquidity.remove(h);
    assertEq(liquidity.strategiesFor(RH.NVDA).length, 0);
  }

  // ------------------------------------------------------------ pay with stocks

  function test_payWithStockSwapsThroughMakerWithRealTransfers() public {
    bytes32 h = _shipMaker(maker, RH.NVDA, 10_000e6, 50, 80, 0);
    bytes32 inv = keccak256('aqua-pay');
    _invoice(inv, 500e6);
    uint256 expectedIn = _makerIn(RH.NVDA, 500e6, _bid(50));
    (uint256 quoted,,, bytes32 route) = gateway.quoteRoute(merchant, inv, RH.NVDA);
    assertEq(route, h);
    assertEq(quoted, expectedIn);

    _fund(RH.NVDA, customer, 5e18);
    uint256 idle = vault.idleUsdg();
    uint256 vaultNvda = nvda.balanceOf(address(vault));
    vm.startPrank(customer);
    nvda.approve(address(gateway), quoted);
    vm.expectEmit(true, true, true, true, address(gateway));
    emit NorenGateway.InvoiceRoutedToMaker(merchant, inv, h, expectedIn);
    gateway.pay(inv, merchant, RH.NVDA, quoted);
    vm.stopPrank();

    assertEq(usdg.balanceOf(merchant), 500e6, 'merchant receives the full invoice');
    assertEq(usdg.balanceOf(maker), 10_000e6 - 500e6, 'maker paid it from its own wallet');
    assertEq(nvda.balanceOf(maker), expectedIn, 'maker received the stock');
    assertEq(nvda.balanceOf(customer), 5e18 - expectedIn);
    assertEq(vault.idleUsdg(), idle, 'vault liquidity untouched');
    assertEq(nvda.balanceOf(address(vault)), vaultNvda, 'vault holds no new inventory');
    assertEq(nvda.balanceOf(address(gateway)) + nvda.balanceOf(address(liquidity)) + nvda.balanceOf(address(swapRouter)), 0);
    (uint256 u, uint256 n) = liquidity.balances(h);
    assertEq(u, 10_000e6 - 500e6);
    assertEq(n, expectedIn);

    // fee accrued to the maker: Chainlink value of the stock bought minus the USDG paid
    uint256 fee = _valueUsdg(RH.NVDA, expectedIn) - 500e6;
    assertEq(liquidity.makerFeesUsdg(maker), fee);
    NorenLiquidity.Strategy memory s = liquidity.strategy(h);
    assertEq(s.fills, 1);
    assertEq(s.volumeUsdg, 500e6);
    assertEq(s.feesUsdg, fee);
    assertApproxEqRel(fee, 500e6 * _bid(50) / (BPS - _bid(50)), 0.002e18, 'fee = bid spread');
  }

  function test_payWithEthSwapsThroughWethMakerAndRefundsExcess() public {
    _shipMaker(maker, RH.WETH, 10_000e6, 30, 50, 0);
    bytes32 inv = keccak256('aqua-eth');
    _invoice(inv, 300e6);
    (uint256 quoted,,, bytes32 route) = gateway.quoteRoute(merchant, inv, address(0));
    assertTrue(route != bytes32(0));
    assertEq(quoted, _makerIn(RH.WETH, 300e6, 30), 'ETH has no closed window');
    vm.deal(customer, 1 ether);
    vm.prank(customer);
    gateway.pay{value: 1 ether}(inv, merchant, address(0), 1 ether);
    assertEq(usdg.balanceOf(merchant), 300e6);
    assertEq(weth.balanceOf(maker), quoted, 'maker holds WETH');
    assertEq(customer.balance, 1 ether - quoted, 'excess ETH refunded');
  }

  function test_bestMakerWins() public {
    _shipMaker(maker, RH.NVDA, 5_000e6, 80, 80, 0);
    bytes32 cheap = _shipMaker(maker2, RH.NVDA, 5_000e6, 40, 80, 0);
    (bytes32 h, uint256 ain) = liquidity.bestQuoteForUsdg(RH.NVDA, 250e6);
    assertEq(h, cheap);
    assertEq(ain, _makerIn(RH.NVDA, 250e6, _bid(40)));
  }

  /// @notice A maker whose Aqua virtual balance exceeds its real wallet is skipped at quote time.
  /// With no other maker the payment falls back to the vault, and with the fallback off it fails loudly.
  function test_underfundedMakerSkippedThenVaultFallbackOrError() public {
    bytes32 h = _shipMaker(maker, RH.NVDA, 10_000e6, 50, 80, 0);
    vm.prank(maker);
    usdg.transfer(maker2, 9_900e6); // keeps 100 USDG while promising 10,000
    (bytes32 best,) = liquidity.bestQuoteForUsdg(RH.NVDA, 500e6);
    assertEq(best, bytes32(0));
    (bytes32 small,) = liquidity.bestQuoteForUsdg(RH.NVDA, 50e6);
    assertEq(small, h, 'a fill the wallet can cover still quotes');

    bytes32 inv = keccak256('aqua-fallback');
    _invoice(inv, 500e6);
    (uint256 quoted,,, bytes32 route) = gateway.quoteRoute(merchant, inv, RH.NVDA);
    assertEq(route, bytes32(0), 'vault route');
    _fund(RH.NVDA, customer, quoted);
    vm.startPrank(customer);
    nvda.approve(address(gateway), quoted);
    vm.expectEmit(true, true, false, true, address(gateway));
    emit NorenGateway.InvoiceRoutedToVault(merchant, inv, quoted);
    gateway.pay(inv, merchant, RH.NVDA, quoted);
    vm.stopPrank();
    assertEq(usdg.balanceOf(merchant), 500e6);

    bytes32 inv2 = keccak256('aqua-no-fallback');
    _invoice(inv2, 500e6);
    vm.prank(owner);
    gateway.setLiquidity(liquidity, false);
    vm.expectRevert(abi.encodeWithSelector(NorenGateway.NoMakerLiquidity.selector, RH.NVDA, uint256(500e6)));
    gateway.quote(merchant, inv2, RH.NVDA);
  }

  // ------------------------------------------------------------ vault-backed maker (Aqua virtual balance)

  /// @notice Idle lender-pool USDG backs a maker strategy without leaving the vault: Aqua records a
  /// virtual balance, a fill pulls exactly the invoice, and the stock lands in the vault as inventory.
  function test_vaultIdleUsdgBacksAMakerStrategy() public {
    INorenLiquidityMaker.PegTerms memory t = INorenLiquidityMaker.PegTerms(40, 80, CLOSED_EXTRA, 0, 0, 0);
    vm.prank(owner);
    bytes32 h = vault.shipAquaStrategy(INorenLiquidityMaker(address(liquidity)), RH.NVDA, t, 50_000e6);
    assertEq(liquidity.strategy(h).maker, address(vault));
    assertEq(vault.idleUsdg(), 100_000e6, 'no USDG moved at ship');
    uint256 navBefore = vault.totalAssets();

    bytes32 inv = keccak256('vault-maker');
    _invoice(inv, 500e6);
    (uint256 quoted,,, bytes32 route) = gateway.quoteRoute(merchant, inv, RH.NVDA);
    assertEq(route, h);
    _fund(RH.NVDA, customer, quoted);
    vm.startPrank(customer);
    nvda.approve(address(gateway), quoted);
    gateway.pay(inv, merchant, RH.NVDA, quoted);
    vm.stopPrank();
    assertEq(usdg.balanceOf(merchant), 500e6);
    assertEq(vault.idleUsdg(), 100_000e6 - 500e6, 'the fill pulled exactly the invoice from the vault');
    assertEq(nvda.balanceOf(address(vault)), quoted, 'stock is vault inventory');
    uint256 fee = liquidity.makerFeesUsdg(address(vault));
    assertGt(fee, 0);
    assertApproxEqAbs(vault.totalAssets(), navBefore + fee, 1, 'NAV grows by the spread fee');
    (uint256 u, uint256 n) = liquidity.balances(h);
    assertEq(u, 50_000e6 - 500e6);
    assertEq(n, quoted);

    // LP withdrawals come first: with idle below the fill the strategy stops quoting
    uint256 shares = vault.convertToShares(99_300e6); // leaves ~200 USDG idle
    vm.prank(lp);
    vault.redeem(shares, lp, lp);
    (bytes32 best,) = liquidity.bestQuoteForUsdg(RH.NVDA, 500e6);
    assertEq(best, bytes32(0), 'virtual balance never outruns real vault liquidity');

    vm.prank(owner);
    vault.dockAquaStrategy(INorenLiquidityMaker(address(liquidity)), h, RH.NVDA);
    assertEq(liquidity.strategiesFor(RH.NVDA).length, 0);
    vm.expectRevert();
    vault.shipAquaStrategy(INorenLiquidityMaker(address(liquidity)), RH.NVDA, t, 1e6); // owner only
  }

  // ------------------------------------------------------------ Pay in 3

  function test_payIn3ScheduleAndLiquidationPrice() public {
    _attest(customer, 2, 1_000e6, 14_000);
    uint256 col = _nvdaFor(PRICE, 14_000);
    uint256 planId = _openPlan(keccak256('pay-in-3'), col);
    assertEq(credit.INSTALLMENTS(), 3, 'Pay in 3');
    assertEq(credit.MISSED_TO_DEFAULT(), 2);
    NorenCredit.Plan memory p = credit.plan(planId);
    for (uint8 k = 1; k <= 3; ++k) assertEq(credit.dueAt(planId, k), p.start + uint64(INTERVAL) * k);
    assertEq(credit.installmentAmount(planId, 1) + credit.installmentAmount(planId, 2) + credit.installmentAmount(planId, 3), PRICE);
    assertEq(credit.installmentAmount(planId, 3), PRICE - 2 * FIRST);

    // "your NVDA liquidates if NVDA < $X": X = debt * 110% / shares, the formula the SDK uses
    uint256 debtUsd8 = oracle.usdgToUsd8(PRICE, Math.Rounding.Ceil);
    uint256 shares18 = col * oracle.multiplier(RH.NVDA) / 1e18;
    uint256 liqPx = debtUsd8.mulDiv(11_000 * 1e18, BPS * shares18, Math.Rounding.Ceil);
    uint256 px = oracle.price(RH.NVDA).usd8;
    console2.log('NVDA price usd8', px);
    console2.log('liquidation price usd8', liqPx);
    assertLt(liqPx, px);
    // a multiplier move that puts the effective price 0.1% above X keeps it safe, 0.1% below liquidates
    uint256 m = oracle.multiplier(RH.NVDA);
    _setMultiplier(RH.NVDA, m.mulDiv(liqPx * 1001, px * 1000));
    (, bool under) = credit.planLiquidatable(planId);
    assertFalse(under);
    _setMultiplier(RH.NVDA, m.mulDiv(liqPx * 999, px * 1000));
    (, under) = credit.planLiquidatable(planId);
    assertTrue(under);
    _setMultiplier(RH.NVDA, m);

    // three on-time installments return the collateral
    _fund(RH.USDG, customer, PRICE);
    vm.startPrank(customer);
    usdg.approve(address(credit), PRICE);
    for (uint8 k = 1; k <= 3; ++k) credit.repay(planId, 1);
    vm.stopPrank();
    assertEq(nvda.balanceOf(customer), col);
    assertEq(uint8(credit.plan(planId).status), uint8(NorenCredit.PlanStatus.Repaid));
  }

  // ------------------------------------------------------------ liquidation through SwapVM

  function test_missedPaymentsLiquidationSellsCollateralToMakerExactDeltas() public {
    bytes32 h = _shipMaker(maker, RH.NVDA, 10_000e6, 50, 80, 0);
    _attest(customer, 2, 1_000e6, 14_000);
    uint256 col = _nvdaFor(PRICE, 14_000);
    uint256 planId = _openPlan(keccak256('liq'), col);
    _fund(RH.USDG, customer, FIRST);
    vm.startPrank(customer);
    usdg.approve(address(credit), FIRST);
    credit.repay(planId, 1);
    vm.stopPrank();
    vm.warp(credit.dueAt(planId, 3) + GRACE + 1); // missed installments 2 and 3
    (bool overdue,) = credit.planLiquidatable(planId);
    assertTrue(overdue);

    uint256 outstanding = PRICE - FIRST;
    uint256 sold = _makerIn(RH.NVDA, outstanding, _bid(50));
    uint256 debtUsd8 = oracle.usdgToUsd8(outstanding, Math.Rounding.Ceil);
    uint256 bonus = col.mulDiv(debtUsd8 * 500 / BPS, oracle.valueUsd8(RH.NVDA, col));
    uint256 idle = vault.idleUsdg();
    uint256 makerUsdg = usdg.balanceOf(maker);

    vm.prank(keeper);
    uint256 proceeds = credit.liquidatePlanViaAqua(planId);

    assertEq(proceeds, outstanding);
    assertEq(vault.idleUsdg(), idle + outstanding, 'vault (lender pool) repaid in full');
    assertEq(vault.receivablesUsdg(), 0);
    assertEq(makerUsdg - usdg.balanceOf(maker), outstanding, 'maker paid the vault');
    assertEq(nvda.balanceOf(maker), sold, 'maker bought the collateral at oracle - spread');
    assertEq(nvda.balanceOf(keeper), bonus, 'keeper bonus: collateral worth 5% of the debt');
    assertEq(nvda.balanceOf(customer), col - sold - bonus, 'remainder back to the borrower');
    assertEq(nvda.balanceOf(address(credit)) + nvda.balanceOf(address(liquidity)), 0);
    assertEq(usdg.balanceOf(keeper), 0, 'keeper paid nothing');
    assertEq(credit.badDebtUsdg(), 0);
    assertEq(liquidity.makerFeesUsdg(maker), _valueUsdg(RH.NVDA, sold) - outstanding);
    assertEq(uint8(credit.plan(planId).status), uint8(NorenCredit.PlanStatus.Liquidated));
    assertEq(liquidity.strategy(h).fills, 1);
  }

  function test_underwaterLiquidationSellsAllAndRecordsBadDebt() public {
    _shipMaker(maker, RH.NVDA, 10_000e6, 50, 80, 0);
    _attest(customer, 2, 1_000e6, 14_000);
    uint256 col = _nvdaFor(PRICE, 14_000);
    uint256 planId = _openPlan(keccak256('liq-under'), col);
    _setMultiplier(RH.NVDA, oracle.multiplier(RH.NVDA) * 70 / 100); // real corporate-action path
    (, bool under) = credit.planLiquidatable(planId);
    assertTrue(under);

    uint256 bonus = col.mulDiv(500, BPS + 500);
    uint256 out = _makerOut(RH.NVDA, col - bonus, _bid(50));
    uint256 idle = vault.idleUsdg();
    vm.prank(keeper);
    uint256 proceeds = credit.liquidatePlanViaAqua(planId);
    assertEq(proceeds, out);
    assertLt(out, PRICE);
    assertEq(vault.idleUsdg(), idle + out);
    assertEq(nvda.balanceOf(keeper), bonus);
    assertEq(nvda.balanceOf(maker), col - bonus);
    assertEq(nvda.balanceOf(customer), 0);
    assertEq(credit.badDebtUsdg(), PRICE - out);
  }

  function test_arcLineLiquidationThroughMakers() public {
    _shipMaker(maker, RH.TSLA, 10_000e6, 50, 80, 0);
    _attest(customer, 2, 2_000e6, 14_000);
    (uint256 col,) = oracle.assetForUsd8(RH.TSLA, 500e6 * 100 * 14_000 / BPS, 800);
    _fund(RH.TSLA, customer, col);
    vm.startPrank(customer);
    tsla.approve(address(credit), col);
    bytes32 lineId = credit.openCreditLine(RH.TSLA, col, 500e6, uint64(block.timestamp + 30 days));
    vm.stopPrank();
    vm.prank(forwarder);
    credit.onReport('', abi.encode(lineId, uint256(500e6), uint256(0), uint64(block.timestamp)));
    _setMultiplier(RH.TSLA, oracle.multiplier(RH.TSLA) * 72 / 100); // 151% * 0.72 = ~109% of the Arc debt
    (, bool under) = credit.lineLiquidatable(lineId);
    assertTrue(under);

    uint256 debtUsdg = oracle.usd8ToUsdg(500e6 * 100, Math.Rounding.Ceil);
    uint256 idle = vault.idleUsdg();
    vm.prank(keeper);
    uint256 proceeds = credit.liquidateLineViaAqua(lineId);
    assertEq(proceeds, debtUsdg);
    assertEq(vault.idleUsdg(), idle + debtUsdg, 'treasury receives the Arc debt in USDG');
    assertEq(tsla.balanceOf(maker), _makerIn(RH.TSLA, debtUsdg, _bid(50)));
    assertGt(tsla.balanceOf(keeper), 0);
    assertEq(tsla.balanceOf(customer), col - tsla.balanceOf(maker) - tsla.balanceOf(keeper));
    assertEq(uint8(credit.line(lineId).status), uint8(NorenCredit.LineStatus.Liquidated));
  }

  // ------------------------------------------------------------ attacks

  /// @notice Price manipulation beyond the spread: a maker that quotes far below Chainlink cannot
  /// buy liquidated collateral cheaply. The sale must clear within 3% of the Chainlink value; the
  /// liquidator-pays-USDG path stays available.
  function test_wideSpreadMakerCannotBuyLiquidationsCheaply() public {
    vm.prank(owner);
    liquidity.setLimits(900, 300, 8); // let a 9% maker register
    _shipMaker(maker, RH.NVDA, 10_000e6, 900, 80, 0);
    _attest(customer, 2, 1_000e6, 14_000);
    uint256 planId = _openPlan(keccak256('liq-wide'), _nvdaFor(PRICE, 14_000));
    vm.warp(credit.dueAt(planId, 2) + GRACE + 1);
    vm.prank(keeper);
    vm.expectPartialRevert(NorenLiquidity.LiquidationSlippage.selector);
    credit.liquidatePlanViaAqua(planId);
    // fallback: a liquidator brings USDG
    _fund(RH.USDG, liquidator, PRICE);
    vm.startPrank(liquidator);
    usdg.approve(address(credit), PRICE);
    credit.liquidatePlan(planId);
    vm.stopPrank();
    assertEq(uint8(credit.plan(planId).status), uint8(NorenCredit.PlanStatus.Liquidated));
  }

  /// @notice Stale oracle: once the Chainlink round is older than the maximum age, makers stop
  /// quoting, the vault refuses the asset, and the Aqua liquidation cannot run.
  function test_staleOracleStopsMakersVaultAndLiquidations() public {
    _shipMaker(maker, RH.NVDA, 10_000e6, 50, 80, 0);
    _attest(customer, 2, 1_000e6, 14_000);
    uint256 planId = _openPlan(keccak256('liq-stale'), _nvdaFor(PRICE, 14_000));
    vm.prank(merchant);
    gateway.createInvoice(keccak256('stale-pay'), 100e6, uint64(block.timestamp + 30 days));
    vm.warp(_nextAt(3, 15) + 7 days); // a Wednesday afternoon, well past the 25 h maximum age
    (bytes32 h,) = liquidity.bestQuoteForUsdg(RH.NVDA, 100e6);
    assertEq(h, bytes32(0), 'no maker quotes on a stale feed');
    vm.expectPartialRevert(NorenAssetOracle.StalePrice.selector);
    gateway.quote(merchant, keccak256('stale-pay'), RH.NVDA);
    // the plan is overdue by now, but valuing its collateral needs a fresh price
    assertEq(credit.missedInstallments(planId), 3);
    vm.prank(keeper);
    vm.expectRevert();
    credit.liquidatePlanViaAqua(planId);
  }

  /// @notice Reentrancy: an ETH payer re-enters NorenGateway from its refund callback. The gateway's
  /// lock rejects it; the outer payment still completes once.
  function test_reentrantEthRefundCannotPayTwice() public {
    _shipMaker(maker, RH.WETH, 10_000e6, 30, 50, 0);
    bytes32 a = keccak256('reenter-a');
    bytes32 b = keccak256('reenter-b');
    _invoice(a, 100e6);
    _invoice(b, 100e6);
    ReentrantPayer attacker = new ReentrantPayer(gateway, merchant, b);
    vm.deal(address(attacker), 1 ether);
    attacker.attack(a);
    assertEq(attacker.reentryError(), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
    assertEq(uint8(gateway.invoice(merchant, a).status), uint8(NorenGateway.Status.Paid));
    assertEq(uint8(gateway.invoice(merchant, b).status), uint8(NorenGateway.Status.Open));
    assertEq(usdg.balanceOf(merchant), 100e6);
  }

  /// @notice A maker cannot sneak a hooked order into Noren's routing: the registry only accepts the
  /// canonical hook-free order it builds itself.
  function test_hookedOrderCannotRegister() public {
    (ISwapVMRouter.Order memory o, bytes32 canonical) = liquidity.buildOrder(maker, RH.NVDA, _terms(50));
    o.traits |= uint256(1) << 250; // hasPreTransferOutHook (hook target = maker)
    address[] memory tokens = new address[](2);
    tokens[0] = RH.USDG;
    tokens[1] = RH.NVDA;
    uint256[] memory amounts = new uint256[](2);
    amounts[0] = 1_000e6;
    _fund(RH.USDG, maker, 1_000e6);
    vm.startPrank(maker);
    usdg.approve(RH.AQUA, type(uint256).max);
    aqua.ship(address(swapRouter), abi.encode(o), tokens, amounts);
    vm.expectRevert(abi.encodeWithSelector(NorenLiquidity.StrategyNotShipped.selector, canonical));
    liquidity.register(RH.NVDA, _terms(50));
    vm.stopPrank();
  }

  // ------------------------------------------------------------ best execution vs Uniswap v4

  /// @notice Logs the Aqua maker quote next to the live Uniswap v4 NVDA/USDG pool for a small and a
  /// large sale. The maker price is pegged to Chainlink, so it does not move with size.
  function test_bestExecutionAgainstUniswapV4() public {
    _shipMaker(maker, RH.NVDA, 50_000e6, 50, 80, 0);
    IV4Quoter.PoolKey memory key = IV4Quoter.PoolKey(RH.USDG, RH.NVDA, 3000, 60, address(0));
    uint128[2] memory sizes = [uint128(1e18), uint128(50e18)];
    uint256[2] memory makerOut;
    uint256[2] memory v4Out;
    for (uint256 i; i < 2; ++i) {
      (, makerOut[i]) = liquidity.bestQuoteForAsset(RH.NVDA, sizes[i]);
      try IV4Quoter(RH.V4_QUOTER).quoteExactInputSingle(IV4Quoter.QuoteExactSingleParams(key, false, sizes[i], '')) returns (
        uint256 out, uint256
      ) {
        v4Out[i] = out;
      } catch {}
      uint256 fair = _valueUsdg(RH.NVDA, sizes[i]);
      console2.log('NVDA sold (raw)', sizes[i]);
      console2.log('  Chainlink value USDG6', fair);
      console2.log('  Aqua maker USDG6', makerOut[i]);
      console2.log('  Uniswap v4 USDG6', v4Out[i]);
      assertGt(makerOut[i], 0);
      assertApproxEqRel(makerOut[i], fair * (BPS - _bid(50)) / BPS, 0.001e18, 'maker = Chainlink - spread at any size');
    }
    if (v4Out[1] != 0) assertGt(makerOut[1], v4Out[1], 'at 50 NVDA the pegged maker beats the v4 pool');
  }
}

/// @dev Pays with ETH, overpays, and tries to pay a second invoice from inside the refund.
contract ReentrantPayer {
  NorenGateway internal immutable gateway;
  address internal immutable merchant;
  bytes32 internal immutable second;
  bytes4 public reentryError;
  bool internal entered;

  constructor(NorenGateway g, address m, bytes32 b) {
    gateway = g;
    merchant = m;
    second = b;
  }

  function attack(bytes32 invoiceId) external {
    gateway.pay{value: 0.5 ether}(invoiceId, merchant, address(0), 0.5 ether);
  }

  receive() external payable {
    if (msg.sender != address(gateway) || entered) return;
    entered = true;
    try gateway.pay{value: 0.1 ether}(second, merchant, address(0), 0.1 ether) {} catch (bytes memory err) {
      reentryError = bytes4(err);
    }
  }
}
