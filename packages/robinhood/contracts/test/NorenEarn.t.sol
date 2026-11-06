// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from 'forge-std/console2.sol';
import {Math} from '@oz/utils/math/Math.sol';
import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {ERC4626} from '@oz/token/ERC20/extensions/ERC4626.sol';
import {ISwapVMRouter} from '../src/interfaces/IAquaSwapVM.sol';
import {ReentrancyGuard} from '@oz/utils/ReentrancyGuard.sol';
import {RobinhoodBase} from './RobinhoodBase.sol';
import {NorenAssetOracle} from '../src/NorenAssetOracle.sol';
import {NorenLiquidity} from '../src/NorenLiquidity.sol';
import {NorenDepositVault} from '../src/NorenDepositVault.sol';
import {NorenReputation, INorenCreditHistory} from '../src/NorenReputation.sol';
import {NorenBorrow} from '../src/NorenBorrow.sol';
import {INorenVault, INorenReceivables} from '../src/interfaces/INorenVault.sol';
import {INorenLiquidity} from '../src/interfaces/IAquaSwapVM.sol';
import {RobinhoodMainnet as RH} from '../script/RobinhoodMainnet.sol';

/// @dev Receives native ETH from redeemETH and tries to redeem again from inside receive().
contract ReentrantRedeemer {
  NorenDepositVault internal immutable v;
  bool internal tried;
  bool public reentryBlocked;

  constructor(NorenDepositVault v_) {
    v = v_;
  }

  function depositAndRedeem(uint256 shares) external payable {
    v.depositETH{value: msg.value}(address(this));
    v.redeemETH(shares, payable(address(this)), address(this));
  }

  receive() external payable {
    if (msg.sender != address(v) || tried) return;
    tried = true;
    try v.redeemETH(v.balanceOf(address(this)), payable(address(this)), address(this)) {} catch (bytes memory err) {
      reentryBlocked = bytes4(err) == ReentrancyGuard.ReentrancyGuardReentrantCall.selector;
      if (!reentryBlocked) revert('unexpected');
    }
  }
}

/// @notice Deposit-and-earn, borrow and reputation on a fresh Robinhood mainnet fork: real WETH, USDG,
/// NVDA and Chainlink feeds, the official 1inch Aqua registry and the Noren SwapVM router. Every fee
/// comes from a real SwapVM fill.
contract NorenEarnTest is RobinhoodBase {
  using Math for uint256;

  uint256 internal constant BPS = 10_000;

  NorenReputation internal rep;
  NorenBorrow internal borrow;
  NorenDepositVault internal nETH;
  NorenDepositVault internal nNVDA;

  address internal maker = makeAddr('maker');
  address internal buyer = makeAddr('buyer');
  address internal keeper = makeAddr('keeper');
  address internal alice = makeAddr('alice');
  address internal worldSigner;
  uint256 internal worldKey;

  function setUp() public override {
    super.setUp();
    (worldSigner, worldKey) = makeAddrAndKey('worldIdServer');
    vm.startPrank(owner);
    rep = new NorenReputation(owner, INorenCreditHistory(address(credit)), worldSigner);
    borrow = new NorenBorrow(owner, usdg, oracle, INorenVault(address(vault)), INorenReceivables(address(credit)), rep, liquidity);
    rep.setBorrow(borrow);
    vault.setModule(address(borrow), true);
    vault.setCredit(borrow);
    nETH = new NorenDepositVault(owner, IERC20(RH.WETH), oracle, liquidity, true, 'Noren ETH deposit', 'nETH');
    nNVDA = new NorenDepositVault(owner, IERC20(RH.NVDA), oracle, liquidity, false, 'Noren NVDA deposit', 'nNVDA');
    nETH.shipStrategy(NorenLiquidity.PegTerms(25, 40, 0, 0, 0, 0));
    nNVDA.shipStrategy(NorenLiquidity.PegTerms(40, 60, 300, 0, 0, 0));
    borrow.addVault(nETH);
    borrow.addVault(nNVDA);
    vm.stopPrank();
    // An independent maker with USDG buys liquidated collateral and competes on both sides.
    _ship(maker, RH.WETH, 20_000e6, NorenLiquidity.PegTerms(30, 50, 0, 0, 0, 0));
    _ship(maker, RH.NVDA, 20_000e6, NorenLiquidity.PegTerms(50, 80, 100, 0, 0, 0));
  }

  /// @dev Like _shipMaker with explicit terms (closedExtra 100 bps keeps liquidations inside the 3%
  /// guard when the suite runs on a weekend).
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
    IERC20(asset).approve(RH.AQUA, type(uint256).max);
    aqua.ship(address(swapRouter), abi.encode(o), tokens, amounts);
    liquidity.register(asset, t);
    vm.stopPrank();
  }

  // ------------------------------------------------------------ helpers

  function _depositEth(address who, uint256 amount) internal returns (uint256 shares) {
    vm.deal(who, amount);
    vm.prank(who);
    shares = nETH.depositETH{value: amount}(who);
  }

  function _depositNvda(address who, uint256 amount) internal returns (uint256 shares) {
    _fund(RH.NVDA, who, amount);
    vm.startPrank(who);
    nvda.approve(address(nNVDA), amount);
    shares = nNVDA.deposit(amount, who);
    vm.stopPrank();
  }

  function _buy(address asset, uint256 amountOut) internal returns (uint256 usdgIn) {
    (, uint256 quoteIn) = liquidity.bestAskForAsset(asset, amountOut);
    _fund(RH.USDG, buyer, quoteIn);
    vm.startPrank(buyer);
    usdg.approve(address(liquidity), quoteIn);
    (usdgIn,) = liquidity.buyFromMakers(asset, amountOut, quoteIn, buyer);
    vm.stopPrank();
  }

  function _lockAll(address who, NorenDepositVault v) internal returns (uint256 shares) {
    shares = v.balanceOf(who);
    vm.startPrank(who);
    IERC20(address(v)).approve(address(borrow), shares);
    borrow.lock(v, shares);
    vm.stopPrank();
  }

  function _valueUsdg(address asset, uint256 amount) internal view returns (uint256) {
    return oracle.usd8ToUsdg(oracle.valueUsd8(asset, amount), Math.Rounding.Floor);
  }

  function _signHuman(uint256 key, address account, bytes32 nullifier, uint64 expiry) internal view returns (bytes memory) {
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, rep.hashVerifiedHuman(account, nullifier, expiry));
    return abi.encodePacked(r, s, v);
  }

  function _verifyHuman(address account, bytes32 nullifier) internal {
    uint64 exp = uint64(block.timestamp + 1 hours);
    rep.verifyHuman(account, nullifier, exp, _signHuman(worldKey, account, nullifier, exp));
  }

  function _recordAge(address account, uint256 daysOld) internal {
    uint64 first = uint64(block.timestamp - daysOld * 1 days);
    uint64 exp = uint64(block.timestamp + 1 hours);
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(underwriterKey, rep.hashAccountAge(account, first, exp));
    rep.recordAccountAge(account, first, exp, abi.encodePacked(r, s, v));
  }

  /// @dev Three on-time Pay-in-3 installments, collateralised with native ETH.
  function _payIn3OnTime(address who, bytes32 inv) internal {
    _attest(who, 2, 1_000e6, 13_000);
    _invoice(inv, 300e6);
    vm.deal(who, 1 ether);
    _fund(RH.USDG, who, 300e6);
    vm.startPrank(who);
    uint256 planId = credit.openPlan{value: 0.5 ether}(inv, merchant, address(0), 0.5 ether);
    usdg.approve(address(credit), 300e6);
    credit.repay(planId, 3);
    vm.stopPrank();
  }

  function _borrowLimitFor(address who) internal view returns (uint256) {
    return borrow.borrowLimitUsdg(who);
  }

  // ------------------------------------------------------------ deposit and earn

  function test_depositGetsReceiptSharesAndBacksAquaStrategy() public {
    assertEq(nETH.name(), 'Noren ETH deposit');
    assertEq(nETH.symbol(), 'nETH');
    assertEq(nNVDA.symbol(), 'nNVDA');
    uint256 shares = _depositEth(customer, 2 ether);
    assertEq(nETH.balanceOf(customer), shares);
    assertEq(nETH.convertToAssets(shares), 2 ether, 'receipt shares redeem the full deposit');
    assertEq(weth.balanceOf(address(nETH)), 2 ether, 'native ETH wrapped to real WETH');
    (uint248 virt,) = aqua.rawBalances(address(nETH), address(swapRouter), nETH.strategyHash(), RH.WETH);
    assertEq(virt, 2 ether, 'deposit pushed into the Aqua virtual balance');
    NorenLiquidity.Strategy memory s = liquidity.strategy(nETH.strategyHash());
    assertEq(s.maker, address(nETH));
    assertTrue(s.active);

    uint256 nShares = _depositNvda(alice, 5e18);
    (uint248 nv,) = aqua.rawBalances(address(nNVDA), address(swapRouter), nNVDA.strategyHash(), RH.NVDA);
    assertEq(nv, 5e18);
    assertGt(nShares, 0);
  }

  /// @notice Yield comes only from real fills: a buyer takes ETH at Chainlink + 40 bps, then a
  /// customer pays a merchant with ETH and the vault buys it back at Chainlink - 25 bps. The
  /// depositor's ETH per share rises by exactly the booked spread (the fork's feeds are frozen).
  function test_yieldFromRealMakerFills() public {
    uint256 shares = _depositEth(alice, 10 ether);
    uint256 before = nETH.convertToAssets(shares);
    skip(1 hours);
    assertEq(nETH.convertToAssets(shares), before, 'no fills, no yield: time alone earns nothing');

    // ask side: the vault (40 bps) beats the maker (50 bps)
    (bytes32 h,) = liquidity.bestAskForAsset(RH.WETH, 1 ether);
    assertEq(h, nETH.strategyHash());
    uint256 paid = _buy(RH.WETH, 1 ether);
    uint256 valueUsdg = _valueUsdg(RH.WETH, 1 ether);
    assertEq(weth.balanceOf(buyer), 1 ether);
    assertEq(usdg.balanceOf(address(nETH)), paid, 'USDG from the sale stays in the vault');
    (uint256 fees1, uint256 fills1,) = nETH.feeBook();
    assertEq(fills1, 1);
    assertApproxEqAbs(fees1, paid - valueUsdg, 1, 'fee = USDG in - Chainlink value');
    assertApproxEqRel(paid, valueUsdg * 10_040 / BPS, 1e14, 'ask = Chainlink + 40 bps');
    (uint248 vu,) = aqua.rawBalances(address(nETH), address(swapRouter), h, RH.USDG);
    assertEq(vu, paid, 'sale proceeds pushed to the bid side');

    // bid side: a customer pays a 1,000 USDG invoice with ETH; the vault (25 bps) beats the maker (30)
    bytes32 inv = keccak256('earn-eth');
    _invoice(inv, 1_000e6);
    (,,, bytes32 route) = gateway.quoteRoute(merchant, inv, address(0));
    assertEq(route, h, 'routed to the deposit vault strategy');
    vm.deal(customer, 1 ether);
    vm.prank(customer);
    uint256 ethIn = gateway.pay{value: 1 ether}(inv, merchant, address(0), 1 ether);
    assertEq(usdg.balanceOf(merchant), 1_000e6, 'merchant paid by the vault');
    (uint256 fees2, uint256 fills2, uint256 vol2) = nETH.feeBook();
    assertEq(fills2, 2);
    assertEq(vol2, paid + 1_000e6);
    assertApproxEqAbs(fees2 - fees1, _valueUsdg(RH.WETH, ethIn) - 1_000e6, 1);

    uint256 afterFills = nETH.convertToAssets(shares);
    assertGt(afterFills, before, 'share price rose');
    // gain in ETH = booked fees converted at Chainlink (rounding tolerance 3 wei per conversion)
    uint256 feesInEth = oracle.usdgToUsd8(fees2, Math.Rounding.Floor).mulDiv(1e18, oracle.price(RH.WETH).usd8);
    assertApproxEqAbs(afterFills - before, feesInEth, 1e10, 'share price rises only by the realised fees');
    NorenDepositVault.Stats memory st = nETH.stats();
    assertTrue(st.priced);
    assertEq(st.feesUsdg, fees2);
    assertEq(st.usdgBalance, paid - 1_000e6);
  }

  function test_stockVaultEarnsTheSpread() public {
    uint256 shares = _depositNvda(alice, 10e18);
    uint256 before = nNVDA.convertToAssets(shares);
    uint256 paid = _buy(RH.NVDA, 2e18);
    (uint256 fees,,) = nNVDA.feeBook();
    uint256 spread = 60 + (oracle.marketClosed(block.timestamp) ? 300 : 0);
    assertApproxEqRel(paid, _valueUsdg(RH.NVDA, 2e18) * (BPS + spread) / BPS, 1e14);
    assertApproxEqAbs(fees, paid - _valueUsdg(RH.NVDA, 2e18), 2);
    assertGt(nNVDA.convertToAssets(shares), before);
    // withdraw all the NVDA it still holds, then the rest in kind
    uint256 held = nvda.balanceOf(address(nNVDA));
    uint256 maxW = nNVDA.maxWithdraw(alice);
    assertEq(maxW, held, 'withdrawals capped at the NVDA the vault holds');
  }

  /// @notice Liquidity in use: after a large sale the vault holds USDG instead of ETH. A full
  /// withdrawal in ETH fails with a readable error that names what is available; in-kind works.
  function test_withdrawWhenLiquidityIsInUse() public {
    uint256 shares = _depositEth(alice, 3 ether);
    _buy(RH.WETH, 2.5 ether);
    uint256 held = weth.balanceOf(address(nETH));
    uint256 usdgHeld = usdg.balanceOf(address(nETH));
    assertEq(held, 0.5 ether);
    uint256 want = nETH.previewRedeem(shares);
    vm.prank(alice);
    vm.expectRevert(abi.encodeWithSelector(NorenDepositVault.LiquidityInUse.selector, want, held, usdgHeld));
    nETH.redeem(shares, alice, alice);

    // a partial withdrawal within what is held works
    vm.prank(alice);
    nETH.withdraw(0.4 ether, alice, alice);
    assertEq(weth.balanceOf(alice), 0.4 ether);

    // the rest in kind: pro-rata WETH + USDG, no price needed
    uint256 rest = nETH.balanceOf(alice);
    vm.prank(alice);
    (uint256 a, uint256 u) = nETH.redeemInKind(rest, alice, alice);
    assertEq(nETH.totalSupply(), 0);
    assertEq(a, 0.1 ether);
    assertEq(u, usdgHeld);
    assertEq(usdg.balanceOf(alice), usdgHeld);
  }

  function test_inKindRedemptionWorksWhileAFeedIsStale() public {
    uint256 shares = _depositEth(alice, 1 ether);
    _buy(RH.WETH, 0.5 ether);
    vm.warp(block.timestamp + 30 days); // fork feeds are frozen: ETH/USD and USDG/USD are now stale
    vm.expectRevert();
    nETH.totalAssets();
    NorenDepositVault.Stats memory st = nETH.stats();
    assertFalse(st.priced, 'stats say NAV is unpriced instead of reverting');
    vm.prank(alice);
    (uint256 a, uint256 u) = nETH.redeemInKind(shares, alice, alice);
    assertEq(a, 0.5 ether);
    assertGt(u, 0);
  }

  function test_reentrantEthRedeemIsBlocked() public {
    ReentrantRedeemer r = new ReentrantRedeemer(nETH);
    vm.deal(address(this), 2 ether);
    // the first redeem of half the shares re-enters for the rest from receive(): blocked
    uint256 sharesFor1 = nETH.previewDeposit(1 ether);
    r.depositAndRedeem{value: 1 ether}(sharesFor1 / 2);
    assertTrue(r.reentryBlocked());
    assertEq(nETH.balanceOf(address(r)), sharesFor1 - sharesFor1 / 2, 'second half still in the vault');
  }

  function test_sharePriceUnaffectedByLaterDeposits() public {
    uint256 a = _depositEth(alice, 1 ether);
    _buy(RH.WETH, 0.3 ether);
    uint256 px = nETH.convertToAssets(a);
    _depositEth(customer, 5 ether);
    assertApproxEqAbs(nETH.convertToAssets(a), px, 2);
  }

  // ------------------------------------------------------------ borrow

  /// @notice Nick's example at the base tier: 1 ETH deposited, borrow up to 66% of its Chainlink value.
  function test_borrowAtBaseLtv66() public {
    _depositEth(alice, 1 ether);
    _lockAll(alice, nETH);
    uint256 value = _valueUsdg(RH.WETH, 1 ether);
    uint256 limit = _borrowLimitFor(alice);
    assertEq(rep.ltvOf(alice), 6_600);
    assertApproxEqAbs(limit, value * 6_600 / BPS, 2);
    vm.startPrank(alice);
    vm.expectRevert(abi.encodeWithSelector(NorenBorrow.ExceedsLimit.selector, limit + 1, limit));
    borrow.borrow(limit + 1, alice);
    borrow.borrow(limit, alice);
    vm.stopPrank();
    assertEq(usdg.balanceOf(alice), limit, 'USDG from the lender pool');
    assertEq(borrow.debtOf(alice), limit);
    uint256 hf = borrow.healthFactor(alice);
    assertApproxEqRel(hf, uint256(8_500) * 1e18 / 6_600, 1e14, 'HF = 85% / 66%');
  }

  /// @notice World ID, account age, a repaid loan and three on-time installments lift the LTV
  /// 66 -> 70 -> 75 -> 80%, and 80% is the cap.
  function test_ltvTiersFromMilestonesUpToThe80Cap() public {
    _allowFrozen247Feeds();
    _depositEth(alice, 1 ether);
    _lockAll(alice, nETH);
    (uint256 pts, uint8 tier, uint16 ltv,) = rep.reputationOf(alice);
    assertEq(pts, 0);
    assertEq(tier, 0);
    assertEq(ltv, 6_600);

    _verifyHuman(alice, keccak256('alice-nullifier'));
    (pts, tier, ltv,) = rep.reputationOf(alice);
    assertEq(pts, 50);
    assertEq(tier, 1);
    assertEq(ltv, 7_000);

    _recordAge(alice, 200);
    (pts, tier, ltv,) = rep.reputationOf(alice);
    assertEq(pts, 90);
    assertEq(tier, 2);
    assertEq(ltv, 7_500);
    uint256 m = rep.milestonesOf(alice);
    assertTrue(m & rep.M_ACCOUNT_180D() != 0 && m & rep.M_VERIFIED_HUMAN() != 0);

    // a repaid loan (>= 10 USDG, open >= 1 day)
    vm.prank(alice);
    borrow.borrow(100e6, alice);
    skip(1 days + 1);
    _fund(RH.USDG, alice, 1e6);
    vm.startPrank(alice);
    usdg.approve(address(borrow), type(uint256).max);
    borrow.repay(alice, type(uint256).max);
    vm.stopPrank();
    (uint32 repaidLoans,) = borrow.record(alice);
    assertEq(repaidLoans, 1);
    assertGt(borrow.interestPaidUsdg(), 0, 'lender pool earned interest');

    _payIn3OnTime(alice, keccak256('alice-p3'));
    (pts, tier, ltv,) = rep.reputationOf(alice);
    assertEq(pts, 145);
    assertEq(tier, 3);
    assertEq(ltv, 8_000);
    assertTrue(rep.milestonesOf(alice) & rep.M_CLEAN_RECORD() != 0);

    // 80% of the deposit's Chainlink value, and not one wei more
    uint256 value = _valueUsdg(RH.WETH, weth.balanceOf(address(nETH)));
    uint256 limit = _borrowLimitFor(alice);
    assertApproxEqAbs(limit, value * 8_000 / BPS, 2);
    vm.startPrank(alice);
    vm.expectRevert(abi.encodeWithSelector(NorenBorrow.ExceedsLimit.selector, limit + 1, limit));
    borrow.borrow(limit + 1, alice);
    borrow.borrow(limit, alice);
    vm.stopPrank();
    // even more milestones never go above 80%
    _depositEth(customer, 1 ether);
    assertLe(rep.ltvOf(alice), borrow.MAX_LTV_BPS());
    assertEq(rep.tierTable(3).ltvBps, 8_000);
  }

  /// @notice The film's credit story, numbers from the contracts: 1 ETH deposited, then World ID,
  /// then on-time repayments (Pay in 3 and a repaid loan). No account-age attestation is used.
  function test_creditLimitGrowthStory() public {
    _allowFrozen247Feeds();
    _depositEth(alice, 1 ether);
    _lockAll(alice, nETH);
    uint256[4] memory totals;
    uint16[4] memory ltvs;

    (totals[0],,) = rep.creditLimitOf(alice);
    ltvs[0] = rep.ltvOf(alice);
    _verifyHuman(alice, keccak256('story'));
    (totals[1],,) = rep.creditLimitOf(alice);
    ltvs[1] = rep.ltvOf(alice);
    _payIn3OnTime(alice, keccak256('story-1'));
    (totals[2],,) = rep.creditLimitOf(alice);
    ltvs[2] = rep.ltvOf(alice);
    vm.prank(alice);
    borrow.borrow(200e6, alice);
    skip(1 days + 1);
    _fund(RH.USDG, alice, 1e6);
    vm.startPrank(alice);
    usdg.approve(address(borrow), type(uint256).max);
    borrow.repay(alice, type(uint256).max);
    vm.stopPrank();
    _payIn3OnTime(alice, keccak256('story-2'));
    (totals[3],,) = rep.creditLimitOf(alice);
    ltvs[3] = rep.ltvOf(alice);

    assertEq(ltvs[0], 6_600);
    assertEq(ltvs[1], 7_000);
    assertEq(ltvs[2], 7_500);
    assertEq(ltvs[3], 8_000);
    for (uint256 i = 1; i < 4; ++i) assertGt(totals[i], totals[i - 1]);
    assertEq(rep.limitMultiplierOf(alice), 20_000, 'Pay-in-3 limit multiplier 2x at the top tier');
    console2.log('CREDIT_STORY deposit_only_usd6', totals[0], 'ltv_bps', ltvs[0]);
    console2.log('CREDIT_STORY plus_world_id_usd6', totals[1], 'ltv_bps', ltvs[1]);
    console2.log('CREDIT_STORY plus_on_time_usd6', totals[2], 'ltv_bps', ltvs[2]);
    console2.log('CREDIT_STORY plus_repaid_loan_usd6', totals[3], 'ltv_bps', ltvs[3]);
  }

  function test_tinyOrSameDayLoansDoNotFarmMilestones() public {
    _depositEth(alice, 1 ether);
    _lockAll(alice, nETH);
    vm.startPrank(alice);
    borrow.borrow(5e6, alice);
    usdg.approve(address(borrow), type(uint256).max);
    borrow.repay(alice, type(uint256).max);
    borrow.borrow(50e6, alice);
    borrow.repay(alice, type(uint256).max); // same block: under the 1-day minimum
    vm.stopPrank();
    (uint32 repaidLoans,) = borrow.record(alice);
    assertEq(repaidLoans, 0);
  }

  function test_lockedSharesKeepEarningAndRaiseTheLimit() public {
    _depositEth(alice, 2 ether);
    _lockAll(alice, nETH);
    uint256 limit0 = _borrowLimitFor(alice);
    _buy(RH.WETH, 1 ether);
    assertGt(_borrowLimitFor(alice), limit0, 'fees on locked shares raise the limit');
  }

  function test_partialUnlockOnlyWhileHealthy() public {
    uint256 shares = _depositEth(alice, 2 ether);
    _lockAll(alice, nETH);
    uint256 limit = _borrowLimitFor(alice);
    vm.prank(alice);
    borrow.borrow(limit / 2, alice);
    // unlocking 40% keeps debt within the limit of the rest
    vm.prank(alice);
    borrow.unlock(nETH, shares * 40 / 100, alice);
    assertEq(nETH.balanceOf(alice), shares * 40 / 100);
    // unlocking another 20% would not
    uint256 more = shares * 20 / 100;
    vm.prank(alice);
    vm.expectRevert();
    borrow.unlock(nETH, more, alice);
  }

  function test_lenderPoolCountsLoansAndEarnsInterest() public {
    _allowFrozen247Feeds();
    _depositEth(alice, 1 ether);
    _lockAll(alice, nETH);
    uint256 nav0 = vault.totalAssets();
    vm.prank(alice);
    borrow.borrow(500e6, alice);
    assertApproxEqAbs(vault.totalAssets(), nav0, 1, 'loan is a receivable: NAV unchanged by the draw');
    skip(365 days / 12);
    uint256 debt = borrow.debtOf(alice);
    assertApproxEqRel(debt, 500e6 + 500e6 * 500 / BPS / 12, 1e15, '5% APR for a month');
    assertApproxEqAbs(vault.totalAssets(), nav0 + (debt - 500e6), 1);
    _fund(RH.USDG, alice, 10e6);
    vm.startPrank(alice);
    usdg.approve(address(borrow), type(uint256).max);
    borrow.repay(alice, type(uint256).max);
    vm.stopPrank();
    assertEq(borrow.debtOf(alice), 0);
    assertEq(borrow.totalDebtUsdg(), 0);
    assertApproxEqAbs(borrow.interestPaidUsdg(), debt - 500e6, 1);
    assertApproxEqAbs(vault.idleUsdg() + vault.receivablesUsdg(), nav0 + borrow.interestPaidUsdg(), 1);
  }

  function test_lenderWithdrawalCappedAtIdleWhileLent() public {
    _depositEth(alice, 50 ether);
    _lockAll(alice, nETH);
    uint256 lim = _borrowLimitFor(alice);
    vm.prank(alice);
    borrow.borrow(lim, alice);
    uint256 idle = vault.idleUsdg();
    assertEq(vault.maxWithdraw(lp), idle, 'only idle USDG can leave while loans are out');
    vm.prank(lp);
    vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxWithdraw.selector, lp, 100_000e6, vault.maxWithdraw(lp)));
    vault.withdraw(100_000e6, lp, lp);
  }

  // ------------------------------------------------------------ liquidation

  /// @notice NVDA collateral at 66%; a real uiMultiplier cut (corporate-action role) pushes the health
  /// factor below 1. The keeper liquidates through Aqua makers: lender pool repaid, keeper paid in
  /// NVDA, the rest back to the borrower, reputation reduced.
  function test_liquidationViaAquaAfterPriceDrop() public {
    _verifyHuman(alice, keccak256('liq'));
    _depositNvda(alice, 10e18);
    _lockAll(alice, nNVDA);
    uint256 limit = _borrowLimitFor(alice);
    vm.prank(alice);
    borrow.borrow(limit, alice);
    vm.expectRevert();
    borrow.liquidateViaAqua(alice, nNVDA);

    uint256 liqPx = borrow.liquidationPriceUsd8(alice, nNVDA);
    uint256 px = oracle.price(RH.NVDA).usd8;
    assertLt(liqPx, px);
    // move value to 0.1% above the liquidation price: still healthy; 0.1% below: liquidatable
    uint256 m0 = oracle.multiplier(RH.NVDA);
    _setMultiplier(RH.NVDA, m0.mulDiv(liqPx * 1_001, px * 1_000));
    assertGe(borrow.healthFactor(alice), 1e18);
    _setMultiplier(RH.NVDA, m0.mulDiv(liqPx * 999, px * 1_000));
    assertLt(borrow.healthFactor(alice), 1e18);

    uint256 debt = borrow.debtOf(alice);
    uint256 idle0 = vault.idleUsdg();
    uint256 alice0 = nvda.balanceOf(alice);
    (uint256 pts0,,,) = rep.reputationOf(alice);
    vm.prank(keeper);
    uint256 repaid = borrow.liquidateViaAqua(alice, nNVDA);
    assertEq(repaid, debt, 'covered: the whole debt repaid');
    assertEq(vault.idleUsdg() - idle0, debt, 'lender pool received the debt in USDG');
    assertEq(borrow.debtOf(alice), 0);
    assertGt(nvda.balanceOf(keeper), 0, 'keeper bonus in NVDA');
    uint256 keeperUsdg = _valueUsdg(RH.NVDA, nvda.balanceOf(keeper));
    assertApproxEqRel(keeperUsdg, debt * 500 / BPS, 1e15, 'bonus = 5% of the debt');
    assertGt(nvda.balanceOf(alice), alice0, 'rest of the collateral back to the borrower');
    assertEq(borrow.lockedShares(alice, address(nNVDA)), 0);
    (, uint32 liqs) = borrow.record(alice);
    assertEq(liqs, 1);
    (uint256 pts1,,,) = rep.reputationOf(alice);
    assertEq(pts0, 50);
    assertEq(pts1, 0, 'liquidation: -60 points');
    NorenLiquidity.Strategy memory ms = liquidity.strategy(liquidity.strategiesFor(RH.NVDA)[1]);
    assertEq(ms.maker, maker, 'collateral sold to the Aqua maker');
    assertEq(ms.fills, 1);
  }

  function test_underwaterLiquidationRecordsBadDebt() public {
    _depositNvda(alice, 10e18);
    _lockAll(alice, nNVDA);
    uint256 lim = _borrowLimitFor(alice);
    vm.prank(alice);
    borrow.borrow(lim, alice);
    _setMultiplier(RH.NVDA, oracle.multiplier(RH.NVDA) / 2);
    uint256 debt = borrow.debtOf(alice);
    vm.prank(keeper);
    uint256 repaid = borrow.liquidateViaAqua(alice, nNVDA);
    assertLt(repaid, debt);
    assertEq(borrow.badDebtUsdg(), debt - repaid);
    assertEq(borrow.debtOf(alice), 0);
    assertEq(borrow.totalDebtUsdg(), 0);
  }

  function test_latePaymentAndLiquidationReduceReputation() public {
    _verifyHuman(alice, keccak256('n'));
    _recordAge(alice, 40);
    (uint256 pts0,,,) = rep.reputationOf(alice);
    assertEq(pts0, 70);
    _attest(alice, 2, 1_000e6, 13_000);
    bytes32 inv = keccak256('late');
    _allowFrozen247Feeds();
    _invoice(inv, 300e6);
    vm.deal(alice, 1 ether);
    _fund(RH.USDG, alice, 300e6);
    vm.startPrank(alice);
    uint256 planId = credit.openPlan{value: 0.5 ether}(inv, merchant, address(0), 0.5 ether);
    usdg.approve(address(credit), 300e6);
    skip(INTERVAL + 1); // first installment now late
    credit.repay(planId, 1);
    vm.stopPrank();
    (uint256 pts1,,,) = rep.reputationOf(alice);
    assertEq(pts1, pts0 - 15, 'late installment: -15');
    assertEq(rep.milestonesOf(alice) & rep.M_CLEAN_RECORD(), 0);
  }

  // ------------------------------------------------------------ World ID attestation

  function test_verifiedHumanAttestationRules() public {
    bytes32 n1 = keccak256('human-1');
    uint64 exp = uint64(block.timestamp + 1 hours);
    bytes memory sig = _signHuman(worldKey, alice, n1, exp);

    // wrong key
    (, uint256 otherKey) = makeAddrAndKey('notWorld');
    bytes memory bad = _signHuman(otherKey, alice, n1, exp);
    vm.expectRevert(NorenReputation.BadSignature.selector);
    rep.verifyHuman(alice, n1, exp, bad);
    // tampered: signature for alice relayed for another account
    vm.expectRevert(NorenReputation.BadSignature.selector);
    rep.verifyHuman(customer, n1, exp, sig);

    rep.verifyHuman(alice, n1, exp, sig);
    assertEq(rep.humanOf(n1), alice);
    // replay
    vm.expectRevert(abi.encodeWithSelector(NorenReputation.NullifierUsed.selector, n1, alice));
    rep.verifyHuman(alice, n1, exp, sig);
    // the same human (nullifier) on a second wallet
    bytes memory sig2 = _signHuman(worldKey, customer, n1, exp);
    vm.expectRevert(abi.encodeWithSelector(NorenReputation.NullifierUsed.selector, n1, alice));
    rep.verifyHuman(customer, n1, exp, sig2);
    // a second nullifier for an account that already has one
    bytes32 n2 = keccak256('human-2');
    bytes memory sig3 = _signHuman(worldKey, alice, n2, exp);
    vm.expectRevert(abi.encodeWithSelector(NorenReputation.AlreadyVerified.selector, alice, n1));
    rep.verifyHuman(alice, n2, exp, sig3);
    // expired
    bytes memory sig4 = _signHuman(worldKey, customer, n2, exp);
    vm.warp(exp);
    vm.expectRevert(abi.encodeWithSelector(NorenReputation.AttestationExpired.selector, exp));
    rep.verifyHuman(customer, n2, exp, sig4);
  }

  function test_accountAgeOnlyFromTheUnderwriterAndOnlyGrows() public {
    uint64 first = uint64(block.timestamp - 100 days);
    uint64 exp = uint64(block.timestamp + 1 hours);
    (, uint256 otherKey) = makeAddrAndKey('notUnderwriter');
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(otherKey, rep.hashAccountAge(alice, first, exp));
    vm.expectRevert(NorenReputation.BadSignature.selector);
    rep.recordAccountAge(alice, first, exp, abi.encodePacked(r, s, v));
    _recordAge(alice, 100);
    (v, r, s) = vm.sign(underwriterKey, rep.hashAccountAge(alice, first, exp));
    vm.expectRevert(abi.encodeWithSelector(NorenReputation.NotOlder.selector, first, first));
    rep.recordAccountAge(alice, first, exp, abi.encodePacked(r, s, v));
  }

  function test_creditLimitOfSumsDepositsAtTierLtvPlusStarter() public {
    _depositEth(alice, 1 ether);
    _depositNvda(alice, 2e18);
    _lockAll(alice, nNVDA); // locked and wallet shares both count
    (uint256 total, uint256 secured, uint256 starter) = rep.creditLimitOf(alice);
    uint256 v = nETH.sharesValueUsd8(nETH.balanceOf(alice), true) + nNVDA.sharesValueUsd8(borrow.lockedShares(alice, address(nNVDA)), true);
    assertApproxEqAbs(secured, oracle.usd8ToUsdg(v * 6_600 / BPS, Math.Rounding.Floor), 1);
    assertEq(starter, 0);
    assertEq(total, secured);
    _verifyHuman(alice, keccak256('starter'));
    (total, secured, starter) = rep.creditLimitOf(alice);
    assertEq(starter, 25e6, 'World ID starter line on Arc: 25 USDC');
    assertApproxEqAbs(secured, oracle.usd8ToUsdg(v * 7_000 / BPS, Math.Rounding.Floor), 1);
    assertEq(total, secured + starter);
  }

  function test_onlyListedVaultsAndCapsHold() public {
    NorenDepositVault rogue = new NorenDepositVault(address(this), IERC20(RH.WETH), oracle, liquidity, true, 'x', 'x');
    vm.expectRevert(abi.encodeWithSelector(NorenBorrow.NotVault.selector, address(rogue)));
    borrow.lock(rogue, 1);
    vm.prank(owner);
    vm.expectRevert(NorenBorrow.BadConfig.selector);
    borrow.setParams(8_000, 500, 500, 10e6, 1 days); // liquidation LTV must sit above the 80% cap
    vm.prank(owner);
    vm.expectRevert(NorenReputation.BadConfig.selector);
    rep.setStarter(101e6);
  }

  /// @notice Audit RH-C-4: once the oracle disables an asset its locked shares stop counting toward
  /// the borrow limit (no new risk), while the health factor still values them for liquidation.
  function test_Audit_RHC4_disabledAssetLeavesBorrowLimitNotHealth() public {
    _depositEth(alice, 1 ether);
    _lockAll(alice, nETH);
    uint256 limit = _borrowLimitFor(alice);
    vm.prank(alice);
    borrow.borrow(limit / 2, alice);
    uint256 hf = borrow.healthFactor(alice);
    vm.prank(owner);
    oracle.disableAsset(RH.WETH);
    assertEq(borrow.borrowLimitUsdg(alice), 0, 'no new borrowing against a disabled asset');
    assertEq(borrow.healthFactor(alice), hf, 'still valued for liquidation');
    uint256 debt = borrow.debtOf(alice);
    vm.prank(alice);
    vm.expectRevert(abi.encodeWithSelector(NorenBorrow.ExceedsLimit.selector, debt + 1, 0));
    borrow.borrow(1, alice);
  }
}
