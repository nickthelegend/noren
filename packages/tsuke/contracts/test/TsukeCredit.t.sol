// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from '@oz/utils/math/Math.sol';
import {TsukeBase} from './TsukeBase.sol';
import {TsukeCredit} from '../src/TsukeCredit.sol';
import {TsukeGateway} from '../src/TsukeGateway.sol';
import {IRobinhoodStockToken} from '../src/interfaces/IRobinhoodStockToken.sol';
import {RobinhoodMainnet as RH} from '../script/RobinhoodMainnet.sol';

/// @notice Underwriting and Pay in 4 on the Robinhood mainnet fork.
contract TsukeCreditTest is TsukeBase {
  bytes32 internal constant INV = keccak256('bnpl-1');
  uint128 internal constant PRICE = 400e6; // 400 USDG purchase

  function setUp() public override {
    super.setUp();
    _invoice(INV, PRICE);
  }

  // ------------------------------------------------------------ attestations

  function _att(address b, uint8 tier, uint256 limit, uint16 ratio) internal view returns (TsukeCredit.Attestation memory) {
    return TsukeCredit.Attestation(b, tier, limit, ratio, credit.attestationNonce(b), uint64(block.timestamp + 30 days));
  }

  function test_applyAttestationSetsTerms() public {
    _attest(customer, 2, 1_000e6, 14_000);
    (uint8 tier, uint256 limit, uint16 ratio, uint256 avail) = credit.creditTerms(customer);
    assertEq(tier, 2);
    assertEq(limit, 1_000e6);
    assertEq(ratio, 14_000);
    assertEq(avail, 1_000e6);
    assertEq(credit.attestationNonce(customer), 1);
  }

  function test_attestationDigestMatchesEip712() public view {
    TsukeCredit.Attestation memory a = _att(customer, 3, 2_500e6, 13_000);
    bytes32 structHash = keccak256(
      abi.encode(credit.ATTESTATION_TYPEHASH(), a.borrower, a.tier, a.limitUsdg, a.collateralRatioBps, a.nonce, a.expiry)
    );
    bytes32 domain = keccak256(
      abi.encode(
        keccak256('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
        keccak256('TsukeCredit'),
        keccak256('1'),
        block.chainid,
        address(credit)
      )
    );
    assertEq(credit.hashAttestation(a), keccak256(abi.encodePacked('\x19\x01', domain, structHash)));
  }

  function test_rejectsSignatureFromWrongKey() public {
    (, uint256 mallory) = makeAddrAndKey('mallory');
    TsukeCredit.Attestation memory a = _att(customer, 4, 1_000_000e6, 12_000);
    bytes memory sig = _sign(mallory, a);
    vm.expectRevert(TsukeCredit.BadSignature.selector);
    credit.applyAttestation(a, sig);
  }

  function test_rejectsTamperedAttestation() public {
    TsukeCredit.Attestation memory a = _att(customer, 1, 250e6, 15_000);
    bytes memory sig = _sign(underwriterKey, a);
    a.limitUsdg = 250_000e6; // borrower edits the limit after signing
    vm.expectRevert(TsukeCredit.BadSignature.selector);
    credit.applyAttestation(a, sig);
  }

  function test_rejectsReplayedAttestation() public {
    TsukeCredit.Attestation memory a = _att(customer, 4, 5_000e6, 12_500);
    bytes memory sig = _sign(underwriterKey, a);
    credit.applyAttestation(a, sig);
    // A later downgrade is applied, then the borrower tries to replay the old generous one.
    _attest(customer, 1, 100e6, 15_000);
    vm.expectRevert(abi.encodeWithSelector(TsukeCredit.BadNonce.selector, 2, 0));
    credit.applyAttestation(a, sig);
  }

  function test_rejectsExpiredAttestation() public {
    TsukeCredit.Attestation memory a = _att(customer, 2, 1_000e6, 14_000);
    a.expiry = uint64(block.timestamp + 10);
    bytes memory sig = _sign(underwriterKey, a);
    vm.warp(vm.getBlockTimestamp() + 11);
    vm.expectRevert(abi.encodeWithSelector(TsukeCredit.AttestationExpired.selector, a.expiry));
    credit.applyAttestation(a, sig);
  }

  function test_rejectsRatioBelowOnChainFloor() public {
    TsukeCredit.Attestation memory a = _att(customer, 4, 1_000e6, 11_500); // floor is 12_000
    bytes memory sig = _sign(underwriterKey, a);
    vm.expectRevert(TsukeCredit.BadAttestation.selector);
    credit.applyAttestation(a, sig);
  }

  function test_rejectsMalformedSignature() public {
    TsukeCredit.Attestation memory a = _att(customer, 2, 1_000e6, 14_000);
    vm.expectRevert(TsukeCredit.BadSignature.selector);
    credit.applyAttestation(a, hex'1234');
  }

  function test_profileExpiresWithAttestation() public {
    _attest(customer, 2, 1_000e6, 14_000);
    vm.warp(vm.getBlockTimestamp() + 30 days + 1);
    (uint8 tier,,,) = credit.creditTerms(customer);
    assertEq(tier, 0);
  }

  // ------------------------------------------------------------ Pay in 4

  function _nvdaFor(uint256 usdg, uint16 ratio) internal view returns (uint256 amt) {
    (amt,) = oracle.assetForUsd8(RH.NVDA, oracle.usdgToUsd8(usdg, Math.Rounding.Ceil) * ratio / 10_000, 0);
    amt = amt * 10_100 / 10_000; // 1% buffer for the closed-market haircut / rounding
    if (oracle.marketClosed(block.timestamp)) amt = amt * 10_600 / 10_000;
  }

  function _openPlan(uint256 collateral) internal returns (uint256 planId) {
    _prepare(collateral);
    vm.prank(customer);
    planId = credit.openPlan(INV, merchant, RH.NVDA, collateral);
  }

  function _prepare(uint256 collateral) internal {
    _fund(RH.NVDA, customer, collateral);
    vm.prank(customer);
    nvda.approve(address(credit), collateral);
  }

  function test_openPlanPaysMerchantUpfrontAndLocksStock() public {
    _attest(customer, 2, 1_000e6, 14_000);
    uint256 col = _nvdaFor(PRICE, 14_000);
    uint256 idle = vault.idleUsdg();
    uint256 planId = _openPlan(col);
    assertEq(usdg.balanceOf(merchant), PRICE * 9_700 / 10_000, 'merchant paid minus 3% fee');
    assertEq(vault.idleUsdg(), idle - PRICE * 9_700 / 10_000);
    assertEq(vault.receivablesUsdg(), PRICE);
    assertEq(nvda.balanceOf(address(credit)), col);
    assertEq(uint8(gateway.invoice(merchant, INV).status), uint8(TsukeGateway.Status.Paid));
    TsukeCredit.Plan memory p = credit.plan(planId);
    assertEq(p.principal, PRICE);
    assertEq(p.borrower, customer);
    (,,, uint256 avail) = credit.creditTerms(customer);
    assertEq(avail, 1_000e6 - PRICE);
    // NAV grew by the merchant fee: LPs earn it
    assertEq(vault.totalAssets(), 100_000e6 + PRICE * 300 / 10_000);
  }

  function test_noAttestationNoCredit() public {
    _prepare(10e18);
    vm.prank(customer);
    vm.expectRevert(abi.encodeWithSelector(TsukeCredit.NoCredit.selector, customer));
    credit.openPlan(INV, merchant, RH.NVDA, 10e18);
  }

  function test_overLimitRejected() public {
    _attest(customer, 1, 300e6, 15_000);
    _prepare(10e18);
    vm.prank(customer);
    vm.expectRevert(abi.encodeWithSelector(TsukeCredit.OverLimit.selector, PRICE, 300e6));
    credit.openPlan(INV, merchant, RH.NVDA, 10e18);
  }

  function test_insufficientCollateralRejected() public {
    _attest(customer, 2, 1_000e6, 14_000);
    uint256 col = _nvdaFor(PRICE, 12_000); // below the 140% the tier requires
    _prepare(col);
    uint256 value = oracle.riskValueUsd8(RH.NVDA, col);
    uint256 required = Math.mulDiv(oracle.usdgToUsd8(PRICE, Math.Rounding.Ceil), 14_000, 10_000, Math.Rounding.Ceil);
    vm.prank(customer);
    vm.expectRevert(abi.encodeWithSelector(TsukeCredit.InsufficientCollateral.selector, value, required));
    credit.openPlan(INV, merchant, RH.NVDA, col);
  }

  function test_fourInstallmentsReturnCollateralAndRecordCleanPlan() public {
    _attest(customer, 2, 1_000e6, 14_000);
    uint256 col = _nvdaFor(PRICE, 14_000);
    uint256 planId = _openPlan(col);
    _fund(RH.USDG, customer, PRICE);
    vm.startPrank(customer);
    usdg.approve(address(credit), PRICE);
    for (uint8 i = 1; i <= 4; ++i) {
      assertEq(nvda.balanceOf(customer), 0, 'collateral locked until the last installment');
      credit.repay(planId, 1);
      vm.warp(vm.getBlockTimestamp() + INTERVAL - 60);
    }
    vm.stopPrank();
    assertEq(nvda.balanceOf(customer), col, 'collateral returned');
    assertEq(uint8(credit.plan(planId).status), uint8(TsukeCredit.PlanStatus.Repaid));
    (uint32 onTime, uint32 late, uint32 completed, uint32 clean,) = credit.history(customer);
    assertEq(onTime, 4);
    assertEq(late, 0);
    assertEq(completed, 1);
    assertEq(clean, 1);
    assertEq(vault.receivablesUsdg(), 0);
    assertEq(vault.idleUsdg(), 100_000e6 + PRICE * 300 / 10_000, 'vault whole plus fee');
  }

  function test_installmentsSumToPrincipal() public {
    _attest(customer, 2, 1_000e6, 14_000);
    vm.prank(merchant);
    gateway.createInvoice(keccak256('odd'), 333_333_333, uint64(block.timestamp + 1 days));
    uint256 col = _nvdaFor(333_333_333, 14_000);
    _fund(RH.NVDA, customer, col);
    vm.startPrank(customer);
    nvda.approve(address(credit), col);
    uint256 planId = credit.openPlan(keccak256('odd'), merchant, RH.NVDA, col);
    vm.stopPrank();
    uint256 sum;
    for (uint8 i = 1; i <= 4; ++i) sum += credit.installmentAmount(planId, i);
    assertEq(sum, 333_333_333);
  }

  function test_earlyCollateralWithdrawalImpossible() public {
    _attest(customer, 2, 1_000e6, 14_000);
    uint256 col = _nvdaFor(PRICE, 14_000);
    uint256 planId = _openPlan(col);
    _fund(RH.USDG, customer, PRICE);
    vm.startPrank(customer);
    usdg.approve(address(credit), PRICE);
    credit.repay(planId, 3);
    vm.expectRevert(TsukeCredit.NothingToClaim.selector);
    credit.claim(RH.NVDA);
    vm.expectRevert(TsukeCredit.NothingDue.selector);
    credit.repay(planId, 2); // cannot overpay past installment 4
    vm.stopPrank();
    assertEq(nvda.balanceOf(address(credit)), col);
    assertEq(nvda.balanceOf(customer), 0);
    (bool overdue, bool under) = credit.planLiquidatable(planId);
    assertFalse(overdue || under);
    vm.prank(liquidator);
    vm.expectRevert(TsukeCredit.NotLiquidatable.selector);
    credit.liquidatePlan(planId);
  }

  function test_overdueLiquidationMakesVaultWholeAndPaysBonus() public {
    _attest(customer, 2, 1_000e6, 14_000);
    uint256 col = _nvdaFor(PRICE, 14_000);
    uint256 planId = _openPlan(col);
    _fund(RH.USDG, customer, 100e6);
    vm.startPrank(customer);
    usdg.approve(address(credit), 100e6);
    credit.repay(planId, 1);
    vm.stopPrank();
    // installment 2 due at start + 2*INTERVAL; liquidatable after grace
    vm.warp(credit.dueAt(planId, 2) + GRACE);
    (bool overdue,) = credit.planLiquidatable(planId);
    assertFalse(overdue, 'not before grace ends');
    vm.warp(vm.getBlockTimestamp() + 1);
    (overdue,) = credit.planLiquidatable(planId);
    assertTrue(overdue);

    uint256 outstanding = PRICE - 100e6;
    uint256 debtUsd8 = oracle.usdgToUsd8(outstanding, Math.Rounding.Ceil);
    uint256 claimUsd8 = debtUsd8 * 10_500 / 10_000;
    uint256 expectedSeize = col * claimUsd8 / oracle.valueUsd8(RH.NVDA, col);
    _fund(RH.USDG, liquidator, outstanding);
    uint256 idle = vault.idleUsdg();
    vm.startPrank(liquidator);
    usdg.approve(address(credit), outstanding);
    uint256 seized = credit.liquidatePlan(planId);
    vm.stopPrank();
    assertEq(seized, expectedSeize);
    assertEq(nvda.balanceOf(liquidator), seized);
    assertEq(nvda.balanceOf(customer), col - seized, 'remainder back to the borrower');
    assertEq(vault.idleUsdg(), idle + outstanding, 'vault made whole');
    assertEq(vault.receivablesUsdg(), 0);
    assertApproxEqRel(oracle.valueUsd8(RH.NVDA, seized), claimUsd8, 1e12, 'liquidator receives debt + 5%');
    (,,,, uint32 defaults) = credit.history(customer);
    assertEq(defaults, 1);
    (uint8 tier,,,) = credit.creditTerms(customer);
    assertEq(tier, 0, 'a liquidation drops tier 2 by two steps');
  }

  function test_priceDropLiquidationViaReverseSplit() public {
    _attest(customer, 2, 1_000e6, 14_000);
    uint256 col = _nvdaFor(PRICE, 14_000);
    uint256 planId = _openPlan(col);
    (, bool under) = credit.planLiquidatable(planId);
    assertFalse(under);
    // A real corporate action on the Stock Token: the multiplier updater cuts uiMultiplier to 70%.
    uint256 m = IRobinhoodStockToken(RH.NVDA).uiMultiplier();
    _setMultiplier(RH.NVDA, m * 70 / 100);
    (, under) = credit.planLiquidatable(planId);
    assertTrue(under, '140% * 0.7 = 98% < 110% threshold');
    _fund(RH.USDG, liquidator, PRICE);
    vm.startPrank(liquidator);
    usdg.approve(address(credit), PRICE);
    uint256 seized = credit.liquidatePlan(planId);
    vm.stopPrank();
    // 98% collateral < 105% claim: liquidator takes everything, pays value/1.05, rest is bad debt
    assertEq(seized, col);
    uint256 value = oracle.valueUsd8(RH.NVDA, col);
    uint256 pay = oracle.usd8ToUsdg(Math.mulDiv(value, 10_000, 10_500, Math.Rounding.Floor), Math.Rounding.Ceil);
    assertEq(usdg.balanceOf(liquidator), PRICE - pay);
    assertEq(credit.badDebtUsdg(), PRICE - pay);
  }

  function test_healthyPlanNotLiquidatable() public {
    _attest(customer, 2, 1_000e6, 14_000);
    uint256 planId = _openPlan(_nvdaFor(PRICE, 14_000));
    vm.expectRevert(TsukeCredit.NotLiquidatable.selector);
    credit.liquidatePlan(planId);
  }

  function test_lateInstallmentDowngradesTier() public {
    _attest(customer, 3, 2_500e6, 13_000);
    uint256 planId = _openPlan(_nvdaFor(PRICE, 13_000));
    vm.warp(credit.dueAt(planId, 1) + 1); // late but inside grace
    _fund(RH.USDG, customer, 100e6);
    vm.startPrank(customer);
    usdg.approve(address(credit), 100e6);
    credit.repay(planId, 1);
    vm.stopPrank();
    (uint8 tier, uint256 limit, uint16 ratio,) = credit.creditTerms(customer);
    assertEq(tier, 2);
    assertEq(ratio, 14_000, 'one step down = +10 points of collateral');
    assertEq(limit, 2_500e6 * 75 / 100, 'one step down = -25% limit');
  }

  function test_twoCleanPlansUpgradeTier() public {
    _attest(customer, 2, 1_000e6, 14_000);
    for (uint256 k; k < 2; ++k) {
      bytes32 id = keccak256(abi.encode('clean', k));
      vm.prank(merchant);
      gateway.createInvoice(id, 100e6, uint64(block.timestamp + 1 days));
      uint256 col = _nvdaFor(100e6, 14_000);
      _fund(RH.NVDA, customer, col);
      _fund(RH.USDG, customer, 100e6);
      vm.startPrank(customer);
      nvda.approve(address(credit), col);
      uint256 planId = credit.openPlan(id, merchant, RH.NVDA, col);
      usdg.approve(address(credit), 100e6);
      credit.repay(planId, 4); // early payoff counts as on time
      vm.stopPrank();
    }
    (uint8 tier, uint256 limit, uint16 ratio,) = credit.creditTerms(customer);
    assertEq(tier, 3);
    assertEq(ratio, 13_000);
    assertEq(limit, 1_250e6);
  }

  function test_ethCollateralPlan() public {
    _attest(customer, 2, 1_000e6, 14_000);
    (uint256 wei_,) = oracle.assetForUsd8(RH.WETH, oracle.usdgToUsd8(PRICE, Math.Rounding.Ceil) * 14_100 / 10_000, 0);
    vm.deal(customer, wei_);
    vm.prank(customer);
    uint256 planId = credit.openPlan{value: wei_}(INV, merchant, address(0), wei_);
    assertEq(credit.plan(planId).collateral, RH.WETH);
    assertEq(weth.balanceOf(address(credit)), wei_);
  }

  function test_ethValueMismatchRejected() public {
    _attest(customer, 2, 1_000e6, 14_000);
    vm.deal(customer, 1 ether);
    vm.prank(customer);
    vm.expectRevert(TsukeCredit.BadValue.selector);
    credit.openPlan{value: 1 ether}(INV, merchant, address(0), 2 ether);
  }

  function test_usdgNotAcceptedAsCollateral() public {
    _attest(customer, 2, 1_000e6, 14_000);
    vm.prank(customer);
    vm.expectRevert(abi.encodeWithSelector(TsukeCredit.CollateralNotAccepted.selector, RH.USDG));
    credit.openPlan(INV, merchant, RH.USDG, 1_000e6);
  }

  function test_blockedBorrowerCollateralIsCreditedNotLost() public {
    _attest(customer, 2, 1_000e6, 14_000);
    uint256 col = _nvdaFor(PRICE, 14_000);
    uint256 planId = _openPlan(col);
    _fund(RH.USDG, customer, PRICE);
    vm.prank(customer);
    usdg.approve(address(credit), PRICE);
    _block(customer); // Robinhood blocklists the borrower mid-plan
    vm.prank(customer);
    credit.repay(planId, 4); // repayment still succeeds
    assertEq(credit.claimable(customer, RH.NVDA), col);
    vm.prank(customer);
    vm.expectRevert(); // the token itself refuses while blocked
    credit.claim(RH.NVDA);
    _unblock(customer);
    vm.prank(customer);
    credit.claim(RH.NVDA);
    assertEq(nvda.balanceOf(customer), col);
  }

  function test_repayWithUsdgPermit() public {
    _attest(customer, 2, 1_000e6, 14_000);
    uint256 planId = _openPlan(_nvdaFor(PRICE, 14_000));
    _fund(RH.USDG, customer, 100e6);
    uint256 deadline = block.timestamp + 1 hours;
    (uint8 v, bytes32 r, bytes32 s) = _permitSig(customerKey, RH.USDG, address(credit), 100e6, deadline);
    vm.prank(customer);
    credit.repayWithPermit(planId, 1, 100e6, deadline, v, r, s);
    assertEq(credit.plan(planId).paid, 1);
  }

  function test_cannotRepayLiquidatedPlan() public {
    _attest(customer, 2, 1_000e6, 14_000);
    uint256 planId = _openPlan(_nvdaFor(PRICE, 14_000));
    vm.warp(credit.dueAt(planId, 1) + GRACE + 1);
    _fund(RH.USDG, liquidator, PRICE);
    vm.startPrank(liquidator);
    usdg.approve(address(credit), PRICE);
    credit.liquidatePlan(planId);
    vm.expectRevert(TsukeCredit.PlanNotActive.selector);
    credit.repay(planId, 1);
    vm.stopPrank();
  }

  function test_paramsGuarded() public {
    TsukeCredit.Params memory p = _params(INTERVAL, GRACE);
    p.liquidationThresholdBps = 9_000; // below 100% would allow under-collateralised credit
    vm.prank(owner);
    vm.expectRevert(TsukeCredit.BadConfig.selector);
    credit.setParams(p);
    vm.expectRevert();
    credit.setUnderwriter(address(this));
  }
}
