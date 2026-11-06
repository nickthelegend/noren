// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from '@oz/utils/math/Math.sol';
import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {RobinhoodBase} from './RobinhoodBase.sol';
import {NorenCredit, INorenReputationLtv} from '../src/NorenCredit.sol';
import {NorenCreditLens} from '../src/NorenCreditLens.sol';
import {NorenLiquidity} from '../src/NorenLiquidity.sol';
import {NorenDepositVault} from '../src/NorenDepositVault.sol';
import {NorenReputation, INorenCreditHistory} from '../src/NorenReputation.sol';
import {RobinhoodMainnet as RH} from '../script/RobinhoodMainnet.sol';

/// @notice On-chain, private reputation: the attester records which kinds of proof a borrower passed
/// (salted commitments only), NorenReputation derives the tier, and NorenCredit caps every new credit
/// line's LTV at that tier (66 -> 70 -> 75 -> 80%). Fresh Robinhood mainnet fork, real NVDA and feeds.
contract NorenPrivateReputationTest is RobinhoodBase {
  using Math for uint256;

  NorenReputation internal rep;
  NorenCreditLens internal lens;
  NorenDepositVault internal nNVDA;
  address internal stranger = makeAddr('stranger');
  address internal serverAttester = makeAddr('serverAttester');

  function setUp() public override {
    super.setUp();
    vm.startPrank(owner);
    rep = new NorenReputation(owner, INorenCreditHistory(address(credit)), makeAddr('worldIdServer'));
    credit.setReputation(INorenReputationLtv(address(rep)));
    nNVDA = new NorenDepositVault(owner, IERC20(RH.NVDA), oracle, liquidity, false, 'Noren NVDA deposit', 'nNVDA');
    nNVDA.shipStrategy(NorenLiquidity.PegTerms(40, 60, 300, 0, 0, 0));
    nNVDA.setHarvesterAllowed(address(credit), true);
    credit.setShareCollateral(address(nNVDA), true);
    vm.stopPrank();
    lens = new NorenCreditLens(credit);
    // The underwriter's terms allow the 125% floor (80% LTV); the reputation tier decides how much of it.
    _attest(customer, 4, 100_000e6, 12_500);
  }

  function _commit(uint8 kind, string memory proof) internal pure returns (bytes32) {
    return keccak256(abi.encode(kind, keccak256(bytes(proof)), keccak256(abi.encode('salt', proof))));
  }

  function _record(address who, uint8 kind, string memory proof) internal {
    vm.prank(underwriter);
    rep.recordAttestation(who, kind, _commit(kind, proof), 10_000);
  }

  function _deposit(address who, uint256 amount) internal returns (uint256 shares) {
    _fund(RH.NVDA, who, amount);
    vm.startPrank(who);
    nvda.approve(address(nNVDA), amount);
    shares = nNVDA.deposit(amount, who);
    vm.stopPrank();
  }

  function test_PrivRep_onlyTheAttesterRecords() public {
    uint8 kyc = rep.KIND_RECLAIM_KYC();
    bytes32 c = _commit(kyc, 'kyc-1');
    vm.prank(stranger);
    vm.expectRevert(abi.encodeWithSelector(NorenReputation.NotAttester.selector, stranger));
    rep.recordAttestation(customer, kyc, c, 10_000);
    vm.prank(serverAttester);
    vm.expectRevert(abi.encodeWithSelector(NorenReputation.NotAttester.selector, serverAttester));
    rep.recordAttestation(customer, kyc, c, 10_000);
    vm.prank(owner);
    rep.setAttester(serverAttester);
    vm.expectEmit(true, true, false, true, address(rep));
    emit NorenReputation.AttestationRecorded(customer, kyc, c);
    vm.prank(serverAttester);
    rep.recordAttestation(customer, kyc, c, 10_000);
    // the underwriter key may always record
    _record(customer, rep.KIND_RECLAIM_BALANCE(), 'bal-1');
    (, uint256 kinds, uint8 count) = rep.attestationsOf(customer);
    assertEq(kinds, (1 << 2) | (1 << 3));
    assertEq(count, 2);
    assertEq(rep.commitmentOf(customer, kyc), c, 'only the salted commitment is stored');
  }

  function test_PrivRep_replayAndDuplicateKindRejected() public {
    uint8 score = rep.KIND_RECLAIM_CREDIT_SCORE();
    bytes32 c = _commit(score, 'score-1');
    vm.prank(underwriter);
    rep.recordAttestation(customer, score, c, 10_000);
    // the same commitment for another borrower (or kind) is a replay
    vm.prank(underwriter);
    vm.expectRevert(abi.encodeWithSelector(NorenReputation.CommitmentUsed.selector, c));
    rep.recordAttestation(stranger, score, c, 10_000);
    // a second proof of the same kind does not boost twice
    vm.prank(underwriter);
    vm.expectRevert(abi.encodeWithSelector(NorenReputation.KindAlreadyRecorded.selector, customer, score));
    rep.recordAttestation(customer, score, _commit(score, 'score-2'), 10_000);
    vm.startPrank(underwriter);
    vm.expectRevert(abi.encodeWithSelector(NorenReputation.BadKind.selector, uint8(6)));
    rep.recordAttestation(customer, 6, _commit(6, 'x'), 10_000);
    vm.expectRevert(NorenReputation.BadAttestation.selector);
    rep.recordAttestation(customer, 2, bytes32(0), 10_000);
    vm.expectRevert(NorenReputation.BadAttestation.selector);
    rep.recordAttestation(customer, 2, _commit(2, 'kyc'), 10_001);
    vm.stopPrank();
    assertEq(rep.attestationPointsOf(customer), 25);
    assertEq(rep.commitmentFor(score, keccak256('score-1'), keccak256(abi.encode('salt', 'score-1'))), c);
  }

  function test_PrivRep_tierLadderFromAttestationKinds() public {
    _assertTier(0, 6_600);
    _record(customer, rep.KIND_RECLAIM_CREDIT_SCORE(), 's'); // 25 points
    _assertTier(0, 6_600);
    _record(customer, rep.KIND_RECLAIM_KYC(), 'k'); // 50 points
    _assertTier(1, 7_000);
    _record(customer, rep.KIND_WORLD_ID(), 'w'); // 75 points + verified human
    _assertTier(2, 7_500);
    _record(customer, rep.KIND_ONCHAIN_REPAYMENT(), 'r'); // 100 points + repayment milestone
    _assertTier(3, 8_000);
    _record(customer, rep.KIND_RECLAIM_BALANCE(), 'b');
    _record(customer, rep.KIND_RECLAIM_IDENTITY(), 'i');
    _assertTier(3, 8_000); // capped at the top tier
    (uint8 tier, uint256 kinds, uint8 count) = rep.attestationsOf(customer);
    assertEq(tier, 3);
    assertEq(kinds, 63);
    assertEq(count, 6);
  }

  function _assertTier(uint8 tier, uint16 ltv) internal view {
    (, uint8 t, uint16 l,) = rep.reputationOf(customer);
    assertEq(t, tier);
    assertEq(l, ltv);
    assertEq(rep.ltvOf(customer), ltv);
  }

  function test_PrivRep_limitRisesWithCollateralAndWithAttestations() public {
    uint256 shares = _deposit(customer, 4e18);
    (uint256 base, uint256 value, uint16 ltv0) = lens.maxCreditLimit(customer, address(nNVDA), shares / 2);
    assertApproxEqAbs(ltv0, 6_600, 1, 'no reputation yet: 66% LTV');
    assertApproxEqAbs(base, value * 6_600 / 10_000 / 100, value / 1e6 + 1);
    (uint256 doubled,,) = lens.maxCreditLimit(customer, address(nNVDA), shares);
    assertApproxEqRel(doubled, base * 2, 1e15, 'twice the collateral, twice the limit');

    // NorenCredit enforces the reputation cap, not only the lens: 80% is refused at tier 0.
    uint256 at80 = value * 8_000 / 10_000 / 100;
    vm.startPrank(customer);
    IERC20(address(nNVDA)).approve(address(credit), shares);
    vm.expectRevert();
    credit.openCreditLine(address(nNVDA), shares / 2, at80, uint64(block.timestamp + 30 days));
    vm.stopPrank();

    _record(customer, rep.KIND_RECLAIM_CREDIT_SCORE(), 's');
    _record(customer, rep.KIND_RECLAIM_KYC(), 'k');
    (uint256 tier1,,) = lens.maxCreditLimit(customer, address(nNVDA), shares / 2);
    assertGt(tier1, base, 'attestations raise the limit');
    _record(customer, rep.KIND_WORLD_ID(), 'w');
    _record(customer, rep.KIND_ONCHAIN_REPAYMENT(), 'r');
    (uint256 top,, uint16 ltvTop) = lens.maxCreditLimit(customer, address(nNVDA), shares / 2);
    assertEq(ltvTop, 8_000);
    assertGt(top, tier1);
    vm.prank(customer);
    credit.openCreditLine(address(nNVDA), shares / 2, top, uint64(block.timestamp + 30 days));
  }
}
