// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from '@oz/utils/math/Math.sol';
import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {ISwapVMRouter} from '../src/interfaces/IAquaSwapVM.sol';
import {RobinhoodBase} from './RobinhoodBase.sol';
import {NorenLiquidity} from '../src/NorenLiquidity.sol';
import {NorenDepositVault} from '../src/NorenDepositVault.sol';
import {NorenReputation, INorenCreditHistory} from '../src/NorenReputation.sol';
import {NorenBorrow} from '../src/NorenBorrow.sol';
import {INorenVault, INorenReceivables} from '../src/interfaces/INorenVault.sol';
import {RobinhoodMainnet as RH} from '../script/RobinhoodMainnet.sol';

/// @notice Loans that pay themselves down: the realised 1inch Aqua maker fees a borrower's locked
/// nETH / nNVDA shares earn are harvested to repay the USDG loan (NorenBorrow.harvestToRepay).
/// Fresh Robinhood mainnet fork: real WETH, USDG, NVDA, Chainlink feeds, the official Aqua registry
/// and the Noren SwapVM router. Every fee comes from a real SwapVM fill: a trader buying from the
/// vault's ask, or a shopper paying a merchant with ETH or NVDA through NorenGateway.
contract NorenSelfRepayTest is RobinhoodBase {
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
  address internal bob = makeAddr('bob');

  function setUp() public override {
    super.setUp();
    vm.startPrank(owner);
    rep = new NorenReputation(owner, INorenCreditHistory(address(credit)), makeAddr('worldIdServer'));
    borrow = new NorenBorrow(owner, usdg, oracle, INorenVault(address(vault)), INorenReceivables(address(credit)), rep, liquidity);
    rep.setBorrow(borrow);
    vault.setModule(address(borrow), true);
    vault.setCredit(borrow);
    nETH = new NorenDepositVault(owner, IERC20(RH.WETH), oracle, liquidity, true, 'Noren ETH deposit', 'nETH');
    nNVDA = new NorenDepositVault(owner, IERC20(RH.NVDA), oracle, liquidity, false, 'Noren NVDA deposit', 'nNVDA');
    nETH.shipStrategy(NorenLiquidity.PegTerms(25, 40, 0, 0, 0, 0));
    nNVDA.shipStrategy(NorenLiquidity.PegTerms(40, 60, 300, 0, 0, 0));
    nETH.setHarvester(address(borrow));
    nNVDA.setHarvester(address(borrow));
    borrow.addVault(nETH);
    borrow.addVault(nNVDA);
    vm.stopPrank();
    // An independent maker buys liquidated collateral. Its asks are wider than the vaults', so the
    // vaults' asks fill; its bids (100 bps extra while US markets are closed) keep liquidations
    // inside the 3% guard.
    _ship(maker, RH.WETH, 20_000e6, NorenLiquidity.PegTerms(30, 200, 0, 0, 0, 0));
    _ship(maker, RH.NVDA, 20_000e6, NorenLiquidity.PegTerms(50, 400, 100, 0, 0, 0));
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
    IERC20(asset).approve(RH.AQUA, type(uint256).max);
    aqua.ship(address(swapRouter), abi.encode(o), tokens, amounts);
    liquidity.register(asset, t);
    vm.stopPrank();
  }

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

  function _lockAll(address who, NorenDepositVault v) internal returns (uint256 shares) {
    shares = v.balanceOf(who);
    vm.startPrank(who);
    IERC20(address(v)).approve(address(borrow), shares);
    borrow.lock(v, shares);
    vm.stopPrank();
  }

  /// @dev A trader buys `amountOut` of `asset` from the best maker ask (the deposit vault's).
  function _buy(address asset, uint256 amountOut) internal returns (uint256 usdgIn, bytes32 h) {
    (, uint256 quoteIn) = liquidity.bestAskForAsset(asset, amountOut);
    _fund(RH.USDG, buyer, quoteIn);
    vm.startPrank(buyer);
    usdg.approve(address(liquidity), quoteIn);
    (usdgIn, h) = liquidity.buyFromMakers(asset, amountOut, quoteIn, buyer);
    vm.stopPrank();
  }

  /// @dev A shopper pays a merchant invoice of `amountUsdg` with ETH through NorenGateway.
  function _payWithEth(bytes32 id, uint128 amountUsdg) internal returns (uint256 ethIn) {
    _invoice(id, amountUsdg);
    vm.deal(customer, 2 ether);
    vm.prank(customer);
    ethIn = gateway.pay{value: 2 ether}(id, merchant, address(0), 2 ether);
  }

  /// @dev A shopper pays a merchant invoice with NVDA (a stock payment) through NorenGateway.
  function _payWithNvda(bytes32 id, uint128 amountUsdg) internal returns (uint256 nvdaIn) {
    _invoice(id, amountUsdg);
    _fund(RH.NVDA, customer, 2e18);
    vm.startPrank(customer);
    nvda.approve(address(gateway), 2e18);
    nvdaIn = gateway.pay(id, merchant, RH.NVDA, 2e18);
    vm.stopPrank();
  }

  function _fees(NorenDepositVault v) internal view returns (uint256 fees, uint256 fills) {
    (fees, fills,) = v.feeBook();
  }

  function _valueUsdg(NorenDepositVault v, uint256 shares) internal view returns (uint256) {
    return oracle.usd8ToUsdg(v.sharesValueUsd8(shares, false), Math.Rounding.Floor);
  }

  /// @dev 1 ETH and 1 NVDA deposited and locked by alice, then a 500 USDG loan.
  function _ethAndNvdaLoan() internal returns (uint256 ethShares, uint256 nvdaShares) {
    _depositEth(alice, 1 ether);
    _depositNvda(alice, 1e18);
    ethShares = _lockAll(alice, nETH);
    nvdaShares = _lockAll(alice, nNVDA);
    vm.prank(alice);
    borrow.borrow(500e6, alice);
  }

  // ------------------------------------------------------------ tests

  /// @notice The headline flow: 1 ETH + 1 NVDA locked, 500 USDG borrowed, four real Aqua fills
  /// (ETH and NVDA bought from the vaults' asks, a merchant paid with ETH and one with NVDA). A
  /// keeper's harvest reduces the debt by exactly the fees the locked shares earned; only shares
  /// worth that much leave, the rest stays locked and keeps its value.
  function test_harvestRepaysExactlyTheRealisedYield() public {
    (uint256 ethShares, uint256 nvdaShares) = _ethAndNvdaLoan();
    (uint256 y0,,) = borrow.previewYieldRepay(alice);
    assertEq(y0, 0, 'no fills yet, nothing earned');
    uint256 ethValue0 = _valueUsdg(nETH, ethShares);
    uint256 nvdaValue0 = _valueUsdg(nNVDA, nvdaShares);

    (uint256 paidEth, bytes32 hEth) = _buy(RH.WETH, 0.3 ether);
    assertEq(hEth, nETH.strategyHash(), 'the nETH vault ask filled');
    (uint256 paidNvda, bytes32 hNvda) = _buy(RH.NVDA, 0.25e18);
    assertEq(hNvda, nNVDA.strategyHash(), 'the nNVDA vault ask filled');
    _payWithEth(keccak256('shop-eth'), 200e6);
    _payWithNvda(keccak256('shop-nvda'), 20e6);
    assertGt(paidEth + paidNvda, 0);

    (uint256 feesEth, uint256 fillsEth) = _fees(nETH);
    (uint256 feesNvda, uint256 fillsNvda) = _fees(nNVDA);
    assertGt(feesEth, 0);
    assertGt(feesNvda, 0);
    // alice owns every share of both vaults: her yield is all the booked fees (floor rounding)
    (uint256 yEth, uint256 nEth) = borrow.yieldOf(alice, nETH);
    (uint256 yNvda, uint256 nNvda) = borrow.yieldOf(alice, nNVDA);
    assertApproxEqAbs(yEth, feesEth, 1);
    assertApproxEqAbs(yNvda, feesNvda, 1);
    assertLe(yEth, feesEth);
    assertLe(yNvda, feesNvda);
    assertEq(nEth, fillsEth);
    assertEq(nNvda, fillsNvda);
    // the shares' Chainlink value rose by the fees (feeds are frozen on the fork)
    assertApproxEqAbs(_valueUsdg(nETH, ethShares) - ethValue0, feesEth, 2);
    assertApproxEqAbs(_valueUsdg(nNVDA, nvdaShares) - nvdaValue0, feesNvda, 2);

    (uint256 preview, uint256 fills,) = borrow.previewYieldRepay(alice);
    assertEq(preview, yEth + yNvda);
    assertEq(fills, fillsEth + fillsNvda);

    uint256 debt0 = borrow.debtOf(alice);
    uint256 hf0 = borrow.healthFactor(alice);
    uint256 idle0 = vault.idleUsdg();
    uint256 aliceUsdg0 = usdg.balanceOf(alice);
    uint256 ethBurn = nETH.sharesForUsdg(yEth);
    uint256 nvdaBurn = nNVDA.sharesForUsdg(yNvda);

    vm.expectEmit(true, true, true, true, address(borrow));
    emit NorenBorrow.YieldRepaid(alice, address(nETH), keeper, yEth, debt0 - yEth, ethBurn, fillsEth);
    vm.expectEmit(true, true, true, true, address(borrow));
    emit NorenBorrow.YieldRepaid(alice, address(nNVDA), keeper, yNvda, debt0 - yEth - yNvda, nvdaBurn, fillsNvda);
    vm.prank(keeper);
    uint256 repaid = borrow.harvestToRepay(alice);

    assertEq(repaid, preview, 'repaid exactly the realised yield');
    assertEq(debt0 - borrow.debtOf(alice), repaid, 'debt down by exactly the yield');
    assertEq(vault.idleUsdg() - idle0, repaid, 'the USDG went to the lender pool');
    assertEq(usdg.balanceOf(alice), aliceUsdg0, 'nothing paid out to the borrower');
    assertEq(borrow.yieldRepaidUsdg(alice), repaid);
    assertGe(borrow.healthFactor(alice), hf0, 'health only improves');
    // principal shares stay locked, worth what was deposited (within rounding)
    assertEq(borrow.lockedShares(alice, address(nETH)), ethShares - ethBurn);
    assertEq(borrow.lockedShares(alice, address(nNVDA)), nvdaShares - nvdaBurn);
    assertApproxEqAbs(_valueUsdg(nETH, ethShares - ethBurn), ethValue0, 3, 'ETH principal intact');
    assertApproxEqAbs(_valueUsdg(nNVDA, nvdaShares - nvdaBurn), nvdaValue0, 3, 'NVDA principal intact');
    (uint256 left,,) = borrow.previewYieldRepay(alice);
    assertEq(left, 0, 'nothing left to harvest until the next fill');
  }

  /// @notice No fills, no yield: harvesting reverts. Without a loan it reverts too.
  function test_zeroYieldReverts() public {
    _ethAndNvdaLoan();
    skip(1 hours);
    (uint256 y,,) = borrow.previewYieldRepay(alice);
    assertEq(y, 0, 'time alone earns nothing');
    uint256 debt = borrow.debtOf(alice);
    vm.prank(keeper);
    vm.expectRevert(NorenBorrow.NoYield.selector);
    borrow.harvestToRepay(alice);
    assertEq(borrow.debtOf(alice), debt);
    vm.expectRevert(NorenBorrow.NoDebt.selector);
    borrow.harvestToRepay(bob);
  }

  /// @notice Anyone can harvest for a borrower but gains nothing: the keeper's balances do not move,
  /// the USDG goes only to the lender pool against that borrower's debt, and nobody but NorenBorrow
  /// can take USDG out of a vault with harvestUsdg.
  function test_keeperHarvestCannotStealFunds() public {
    _ethAndNvdaLoan();
    _depositEth(bob, 1 ether); // a second depositor who did not lock
    _buy(RH.WETH, 0.4 ether);
    uint256 kUsdg = usdg.balanceOf(keeper);
    uint256 kEth = keeper.balance;
    uint256 bobShares = nETH.balanceOf(bob);
    uint256 bobValue = _valueUsdg(nETH, bobShares);
    uint256 usdgInBorrow = usdg.balanceOf(address(borrow));

    vm.prank(keeper);
    vm.expectRevert(NorenDepositVault.NotHarvester.selector);
    nETH.harvestUsdg(1e6, keeper, address(borrow));

    vm.prank(keeper);
    uint256 repaid = borrow.harvestToRepay(alice);
    assertGt(repaid, 0);
    assertEq(usdg.balanceOf(keeper), kUsdg, 'keeper got no USDG');
    assertEq(keeper.balance, kEth);
    assertEq(nETH.balanceOf(keeper), 0, 'keeper got no shares');
    assertEq(usdg.balanceOf(address(borrow)), usdgInBorrow, 'NorenBorrow keeps nothing');
    assertEq(nETH.balanceOf(bob), bobShares, 'other depositors untouched');
    // their share value is unchanged (1e-6 USDG: the floor of valuing asset and USDG parts separately)
    assertApproxEqAbs(_valueUsdg(nETH, bobShares), bobValue, 1, 'other depositors keep their value');
    // a second call right away has nothing to harvest
    vm.prank(keeper);
    vm.expectRevert(NorenBorrow.NoYield.selector);
    borrow.harvestToRepay(alice);
  }

  /// @notice Fees split by shares held when each fill happened: alice locked half the supply for the
  /// first fill and a third for the second (bob deposited in between).
  function test_yieldFollowsSharesAtEachFill() public {
    uint256 aliceShares = _depositEth(alice, 1 ether);
    _lockAll(alice, nETH);
    vm.prank(alice);
    borrow.borrow(300e6, alice);
    _depositEth(bob, 1 ether);
    (uint256 supply1) = nETH.totalSupply();
    _buy(RH.WETH, 0.2 ether);
    (uint256 fee1,) = _fees(nETH);
    _depositEth(bob, 1 ether);
    uint256 supply2 = nETH.totalSupply();
    _buy(RH.WETH, 0.2 ether);
    (uint256 fee2,) = _fees(nETH);
    (uint256 y,) = borrow.yieldOf(alice, nETH);
    uint256 expected = fee1.mulDiv(aliceShares, supply1) + (fee2 - fee1).mulDiv(aliceShares, supply2);
    assertApproxEqAbs(y, expected, 2);
    uint256 debt0 = borrow.debtOf(alice);
    vm.prank(keeper);
    borrow.harvestToRepay(alice);
    assertEq(debt0 - borrow.debtOf(alice), y);
  }

  /// @notice When the vault holds less USDG than the yield (its bid spent the sale proceeds on a
  /// shopper's ETH), shares worth the yield are redeemed in kind and the ETH part is sold to the best
  /// Aqua maker; the debt drops by what the sale returned (at most 3% below Chainlink).
  function test_sellPathWhenTheVaultHoldsTooLittleUsdg() public {
    (uint256 ethShares,) = _ethAndNvdaLoan();
    (uint256 paid,) = _buy(RH.WETH, 0.3 ether);
    // a shopper's ETH payment uses almost all of that USDG on the vault's bid
    _payWithEth(keccak256('drain'), uint128(paid - 1e6));
    uint256 held = usdg.balanceOf(address(nETH));
    (uint256 y,) = borrow.yieldOf(alice, nETH);
    assertLt(held, y, 'vault holds less USDG than the yield');
    uint256 debt0 = borrow.debtOf(alice);
    uint256 hf0 = borrow.healthFactor(alice);
    uint256 burn = nETH.sharesForUsdg(y);
    vm.prank(keeper);
    uint256 repaid = borrow.harvestToRepay(alice);
    assertLe(repaid, y, 'a sale never repays more than the yield');
    assertGe(repaid, y * (BPS - 300) / BPS, 'within 3% of Chainlink');
    assertEq(debt0 - borrow.debtOf(alice), repaid);
    assertEq(borrow.lockedShares(alice, address(nETH)), ethShares - burn);
    assertGe(borrow.healthFactor(alice), hf0);
  }

  /// @notice Yield above the debt repays the loan in full; the rest stays pending on the locked
  /// shares, and unlocking takes it along in the shares' value.
  function test_yieldAboveDebtClosesTheLoanAndTheRestStaysPending() public {
    _depositEth(alice, 1 ether);
    uint256 shares = _lockAll(alice, nETH);
    vm.prank(alice);
    borrow.borrow(1e6, alice); // 1 USDG
    _buy(RH.WETH, 0.4 ether); // about 3.6 USDG of fees
    (uint256 y,) = borrow.yieldOf(alice, nETH);
    assertGt(y, 1e6);
    uint256 debt0 = borrow.debtOf(alice);
    vm.prank(keeper);
    uint256 repaid = borrow.harvestToRepay(alice);
    assertEq(repaid, debt0, 'repaid the whole debt, no more');
    assertEq(borrow.debtOf(alice), 0, 'loan closed by its own collateral');
    (uint256 rest,) = borrow.yieldOf(alice, nETH);
    assertEq(rest, y - repaid, 'the rest is still pending');
    uint256 locked = borrow.lockedShares(alice, address(nETH));
    assertLt(locked, shares);
    vm.prank(alice);
    borrow.unlock(nETH, locked, alice);
    (uint256 after_,) = borrow.yieldOf(alice, nETH);
    assertEq(after_, 0, 'unlocked shares carry their unharvested yield in their value');
    assertEq(nETH.balanceOf(alice), locked);
  }

  /// @notice An unhealthy position still liquidates: harvesting improves its health but does not
  /// block the keeper. Only the NVDA vault's collateral is sold; the ETH shares stay locked and keep
  /// earning, and their yield still repays the rest of the loan.
  function test_unhealthyPositionStillLiquidatesPartially() public {
    _depositEth(alice, 1 ether);
    _depositNvda(alice, 10e18);
    uint256 ethShares = _lockAll(alice, nETH);
    _lockAll(alice, nNVDA);
    uint256 lim = borrow.borrowLimitUsdg(alice);
    vm.prank(alice);
    borrow.borrow(lim, alice);
    _buy(RH.WETH, 0.3 ether);
    _setMultiplier(RH.NVDA, oracle.multiplier(RH.NVDA) * 4 / 10); // a real uiMultiplier cut, 60%
    uint256 hf0 = borrow.healthFactor(alice);
    assertLt(hf0, 1e18, 'liquidatable');

    vm.prank(keeper);
    borrow.harvestToRepay(alice);
    uint256 hf1 = borrow.healthFactor(alice);
    assertGt(hf1, hf0, 'harvest improved health');
    assertLt(hf1, 1e18, 'but fees do not rescue a 60% drop');
    uint256 ethLocked = borrow.lockedShares(alice, address(nETH));
    assertLt(ethLocked, ethShares);

    uint256 debt1 = borrow.debtOf(alice);
    vm.prank(keeper);
    uint256 repaid = borrow.liquidateViaAqua(alice, nNVDA);
    assertGt(repaid, 0);
    assertLt(repaid, debt1, 'partial: the NVDA collateral covers part of the debt');
    assertEq(borrow.lockedShares(alice, address(nNVDA)), 0, 'NVDA sold to Aqua makers');
    assertEq(borrow.lockedShares(alice, address(nETH)), ethLocked, 'ETH collateral untouched');
    assertEq(borrow.badDebtUsdg(), 0, 'ETH still backs the rest: no write-off');
    assertEq(borrow.debtOf(alice), debt1 - repaid);

    // the ETH shares keep earning, and their new fees keep paying the loan down
    _buy(RH.WETH, 0.2 ether);
    (uint256 y,) = borrow.yieldOf(alice, nETH);
    assertGt(y, 0);
    uint256 debt2 = borrow.debtOf(alice);
    vm.prank(keeper);
    borrow.harvestToRepay(alice);
    assertEq(debt2 - borrow.debtOf(alice), y);
  }

  /// @notice After the fees paid part of the loan, the borrower repays the rest and unlocks: every
  /// remaining (principal) share comes back and redeems for the deposit.
  function test_fullRepayReturnsTheCollateral() public {
    (uint256 ethShares, uint256 nvdaShares) = _ethAndNvdaLoan();
    _buy(RH.WETH, 0.3 ether);
    _buy(RH.NVDA, 0.25e18);
    vm.prank(keeper);
    uint256 byYield = borrow.harvestToRepay(alice);
    assertGt(byYield, 0);
    uint256 rest = borrow.debtOf(alice);
    _fund(RH.USDG, alice, rest);
    vm.startPrank(alice);
    usdg.approve(address(borrow), rest);
    borrow.repay(alice, type(uint256).max);
    assertEq(borrow.debtOf(alice), 0);
    uint256 lockedEth = borrow.lockedShares(alice, address(nETH));
    uint256 lockedNvda = borrow.lockedShares(alice, address(nNVDA));
    borrow.unlock(nETH, lockedEth, alice);
    borrow.unlock(nNVDA, lockedNvda, alice);
    vm.stopPrank();
    assertEq(nETH.balanceOf(alice), lockedEth);
    assertEq(nNVDA.balanceOf(alice), lockedNvda);
    assertLt(lockedEth, ethShares);
    assertLt(lockedNvda, nvdaShares);
    // the principal is the deposit: 1 ETH and 1 NVDA of value (in kind: asset plus sale USDG). The
    // harvest rounds against the harvested amount, so what is left is never below the deposit and
    // above it only by rounding (1e10 wei is about $0.00002).
    assertGe(nETH.convertToAssets(lockedEth), 1 ether - 1e9);
    assertApproxEqAbs(nETH.convertToAssets(lockedEth), 1 ether, 1e10);
    assertGe(nNVDA.convertToAssets(lockedNvda), 1e18 - 1e9);
    assertApproxEqAbs(nNVDA.convertToAssets(lockedNvda), 1e18, 1e10);
    vm.prank(alice);
    (uint256 a, uint256 u) = nETH.redeemInKind(lockedEth, alice, alice);
    assertGt(a, 0);
    assertGt(u, 0);
  }
}
