// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from '@oz/access/Ownable2Step.sol';
import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {IERC20Permit} from '@oz/token/ERC20/extensions/IERC20Permit.sol';
import {SafeERC20} from '@oz/token/ERC20/utils/SafeERC20.sol';
import {ECDSA} from '@oz/utils/cryptography/ECDSA.sol';
import {EIP712} from '@oz/utils/cryptography/EIP712.sol';
import {IERC165} from '@oz/utils/introspection/IERC165.sol';
import {Math} from '@oz/utils/math/Math.sol';
import {ReentrancyGuard} from '@oz/utils/ReentrancyGuard.sol';
import {NorenAssetOracle} from './NorenAssetOracle.sol';
import {NorenGateway} from './NorenGateway.sol';
import {IReceiver} from './interfaces/IReceiver.sol';
import {INorenVault, INorenReceivables} from './interfaces/INorenVault.sol';
import {INorenLiquidity} from './interfaces/IAquaSwapVM.sol';
import {IWETH} from './interfaces/IWETH.sol';

/// @title NorenCredit
/// @notice Collateralised Pay in 3 and an Arc credit line on Robinhood Chain.
/// - Credit terms come from an EIP-712 attestation signed by the Noren underwriter
///   (borrower, tier, limit, collateral ratio, nonce, expiry) and move with on-chain repayment
///   history: two clean plans lift the tier one step, each late installment drops it one,
///   each liquidation drops it two.
/// - Pay in 3: the borrower locks a Stock Token or ETH, the vault pays the merchant upfront
///   (minus the merchant fee), and the borrower repays three USDG installments, one every
///   `installmentInterval`. Missing two payments (or the final one) past the grace period, or
///   collateral below the liquidation threshold, makes the plan liquidatable.
/// - Liquidation sells the locked collateral to 1inch Aqua maker strategies through SwapVM
///   (NorenLiquidity): proceeds repay the vault, the liquidator keeps the bonus in collateral and
///   the rest goes back to the borrower. `liquidatePlan` (liquidator pays USDG) stays as the
///   fallback when no maker can fill.
/// - Partial Dutch-auction liquidation (NorenDutchAuction): once a plan is liquidatable, anyone can
///   open an auction; each fill sells only enough collateral to restore the plan's health target
///   (or cure the missed installments) and the rest stays locked for the borrower.
/// - Arc credit line: collateral locked here backs a USDC line on Arc. A Chainlink CRE workflow
///   carries CreditLineOpened to Arc and reports Arc utilisation back through onReport.
contract NorenCredit is Ownable2Step, ReentrancyGuard, EIP712, IReceiver, INorenReceivables {
  using SafeERC20 for IERC20;
  using Math for uint256;

  uint256 internal constant BPS = 10_000;
  /// @notice Pay in 3: number of installments per plan (read by the Noren app and checkout).
  uint256 public constant INSTALLMENTS = 3;
  /// @notice Missed installments (each past due plus grace) that make a plan liquidatable.
  uint8 public constant MISSED_TO_DEFAULT = 2;
  uint8 public constant MAX_TIER = 4;
  /// @dev USDC (6 decimals) is valued at $1.00 when sizing an Arc credit line: no USDC feed exists on Robinhood Chain.
  uint256 internal constant USDC6_TO_USD8 = 100;

  bytes32 public constant ATTESTATION_TYPEHASH = keccak256(
    'CreditAttestation(address borrower,uint8 tier,uint256 limitUsdg,uint16 collateralRatioBps,uint256 nonce,uint64 expiry)'
  );

  struct Attestation {
    address borrower;
    uint8 tier;
    uint256 limitUsdg;
    uint16 collateralRatioBps;
    uint256 nonce;
    uint64 expiry;
  }

  struct Profile {
    uint8 tier;
    uint16 ratioBps;
    uint64 expiry;
    uint32 cleanAt;
    uint32 lateAt;
    uint32 defaultsAt;
    uint256 limitUsdg;
  }

  struct History {
    uint32 onTime;
    uint32 late;
    uint32 completed;
    uint32 clean;
    uint32 defaults;
  }

  enum PlanStatus {
    None,
    Active,
    Repaid,
    Liquidated
  }

  struct Plan {
    address borrower;
    address merchant;
    address collateral;
    uint64 start;
    uint32 interval;
    uint32 grace;
    uint8 paid;
    PlanStatus status;
    bool hadLate;
    uint256 collateralAmount;
    uint256 principal;
    uint256 repaid;
    bytes32 invoiceId;
  }

  enum LineStatus {
    None,
    Open,
    Closing,
    Closed,
    Liquidated
  }

  struct Line {
    address borrower;
    address collateral;
    uint64 expiry;
    uint64 asOf;
    uint64 closeRequestedAt;
    LineStatus status;
    uint256 collateralAmount;
    uint256 limitUsdc;
    uint256 drawn;
    uint256 repaid;
  }

  struct Params {
    uint32 installmentInterval; // production: 14 days
    uint32 gracePeriod; // production: 3 days
    uint16 liquidationThresholdBps; // collateral value / debt below this => liquidatable
    uint16 liquidationBonusBps; // liquidator's discount on seized collateral
    uint16 merchantFeeBps; // merchant discount rate on Pay in 3 (vault income)
    uint32 maxLineDuration;
    uint32 reportSkew; // tolerated future skew of an Arc report's asOf
  }

  IERC20 public immutable usdg;
  IWETH public immutable weth;
  NorenAssetOracle public immutable oracle;
  INorenVault public immutable vault;
  NorenGateway public immutable gateway;

  address public underwriter;
  address public forwarder;
  INorenLiquidity public liquidity;
  /// @notice NorenDutchAuction: the only caller of auctionSeize (partial liquidations).
  address public dutchAuction;
  bytes32 public expectedWorkflowId; // zero = not checked
  address public expectedWorkflowOwner; // zero = not checked
  Params public params;

  mapping(address borrower => Profile) public profiles;
  mapping(address borrower => History) public history;
  mapping(address borrower => uint256) public attestationNonce;
  mapping(address borrower => uint256) public creditUsed;
  mapping(uint256 planId => Plan) internal _plans;
  mapping(bytes32 lineId => Line) internal _lines;
  mapping(address borrower => uint256[]) internal _plansOf;
  mapping(address borrower => bytes32[]) internal _linesOf;
  mapping(address account => mapping(address asset => uint256)) public claimable;
  uint256 public nextPlanId = 1;
  uint256 public lineNonce;
  uint256 public planOutstanding;
  uint256 public badDebtUsdg;

  event UnderwriterSet(address indexed underwriter);
  event ForwarderSet(address indexed forwarder);
  event WorkflowPolicySet(bytes32 workflowId, address workflowOwner);
  event ParamsSet(Params params);
  event AttestationApplied(address indexed borrower, uint8 tier, uint256 limitUsdg, uint16 collateralRatioBps, uint256 nonce, uint64 expiry);
  event PlanOpened(
    uint256 indexed planId,
    address indexed borrower,
    address indexed merchant,
    bytes32 invoiceId,
    address collateral,
    uint256 collateralAmount,
    uint256 principalUsdg,
    uint256 collateralValueUsd8
  );
  event InstallmentPaid(uint256 indexed planId, address indexed borrower, uint8 installment, uint256 amountUsdg, bool late);
  event PlanRepaid(uint256 indexed planId, address indexed borrower, bool clean);
  event PlanLiquidated(uint256 indexed planId, address indexed borrower, address indexed liquidator, uint256 paidUsdg, uint256 seized, uint256 badDebtUsdg);
  event CreditLineOpened(address indexed borrower, bytes32 indexed lineId, uint256 limitUsdc6, uint64 expiry, uint256 collateralValueUsd8);
  event CreditLineClosed(bytes32 indexed lineId);
  event CreditLineSettled(bytes32 indexed lineId, address indexed borrower, uint256 collateralReturned);
  event CreditLineLiquidated(bytes32 indexed lineId, address indexed borrower, address indexed liquidator, uint256 paidUsdg, uint256 seized, uint256 badDebtUsdg);
  event ArcUtilisationUpdated(bytes32 indexed lineId, uint256 drawnUsdc6, uint256 repaidUsdc6, uint64 asOf);
  event CollateralCredited(address indexed account, address indexed asset, uint256 amount);
  event LiquiditySet(address indexed liquidity);
  event DutchAuctionSet(address indexed auction);
  /// @notice A Dutch-auction fill took `seized` collateral and repaid `repaidUsdg`; the plan stays
  /// open with `collateralLeft` and `outstandingUsdg` unless `closed`.
  event PlanPartiallyLiquidated(
    uint256 indexed planId, address indexed borrower, uint256 seized, uint256 repaidUsdg, uint256 collateralLeft, uint256 outstandingUsdg, bool closed
  );
  /// @notice positionId = bytes32(planId) for plans, the lineId for Arc lines.
  event CollateralSoldToMakers(
    bytes32 indexed positionId, address indexed collateral, uint256 sold, uint256 bonus, uint256 returned, uint256 proceedsUsdg
  );

  error BadSignature();
  error BadNonce(uint256 expected, uint256 got);
  error AttestationExpired(uint64 expiry);
  error BadAttestation();
  error NoCredit(address borrower);
  error OverLimit(uint256 requested, uint256 available);
  error InsufficientCollateral(uint256 valueUsd8, uint256 requiredUsd8);
  error CollateralNotAccepted(address asset);
  error BadValue();
  error NotBorrower();
  error PlanNotActive();
  error NothingDue();
  error NotLiquidatable();
  error NotForwarder(address caller);
  error BadWorkflow();
  error UnknownLine(bytes32 lineId);
  error LineNotActive(LineStatus status);
  error StaleReport(uint64 asOf, uint64 last);
  error FutureReport(uint64 asOf);
  error BadExpiry(uint64 expiry);
  error DebtOutstanding(uint256 outstandingUsdc6);
  error AwaitingArcReport(uint64 asOf, uint64 closeRequestedAt);
  error BadConfig();
  error NothingToClaim();
  error NoLiquidity();
  error NotAuction();
  error BadReport(uint256 drawnUsdc6, uint256 repaidUsdc6);

  constructor(
    address owner_,
    IERC20 usdg_,
    IWETH weth_,
    NorenAssetOracle oracle_,
    INorenVault vault_,
    NorenGateway gateway_,
    address underwriter_,
    address forwarder_,
    Params memory params_
  ) Ownable(owner_) EIP712('NorenCredit', '1') {
    usdg = usdg_;
    weth = weth_;
    oracle = oracle_;
    vault = vault_;
    gateway = gateway_;
    underwriter = underwriter_;
    forwarder = forwarder_;
    _setParams(params_);
  }

  // ================================================================ admin

  function setUnderwriter(address u) external onlyOwner {
    if (u == address(0)) revert BadConfig();
    underwriter = u;
    emit UnderwriterSet(u);
  }

  function setForwarder(address f) external onlyOwner {
    forwarder = f;
    emit ForwarderSet(f);
  }

  function setLiquidity(INorenLiquidity l) external onlyOwner {
    liquidity = l;
    emit LiquiditySet(address(l));
  }

  /// @dev Set once: the auction may seize plan collateral (auctionSeize), so the owner cannot
  /// later point it at another address.
  function setDutchAuction(address a) external onlyOwner {
    if (a == address(0) || dutchAuction != address(0)) revert BadConfig();
    dutchAuction = a;
    emit DutchAuctionSet(a);
  }

  function setWorkflowPolicy(bytes32 workflowId, address workflowOwner) external onlyOwner {
    expectedWorkflowId = workflowId;
    expectedWorkflowOwner = workflowOwner;
    emit WorkflowPolicySet(workflowId, workflowOwner);
  }

  function setParams(Params calldata p) external onlyOwner {
    _setParams(p);
  }

  function _setParams(Params memory p) internal {
    if (
      p.installmentInterval == 0 || p.liquidationThresholdBps < BPS || p.liquidationBonusBps > 2_000
        || p.merchantFeeBps > 1_000 || p.maxLineDuration == 0
    ) revert BadConfig();
    params = p;
    emit ParamsSet(p);
  }

  // ================================================================ underwriting

  function hashAttestation(Attestation calldata a) public view returns (bytes32) {
    return _hashTypedDataV4(
      keccak256(abi.encode(ATTESTATION_TYPEHASH, a.borrower, a.tier, a.limitUsdg, a.collateralRatioBps, a.nonce, a.expiry))
    );
  }

  function domainSeparator() external view returns (bytes32) {
    return _domainSeparatorV4();
  }

  /// @notice Apply an underwriter attestation. Anyone may relay it; it binds to `a.borrower`.
  /// Nonces are sequential per borrower, so each attestation applies once and in order.
  function applyAttestation(Attestation calldata a, bytes calldata signature) external {
    if (a.expiry <= block.timestamp) revert AttestationExpired(a.expiry);
    uint256 expected = attestationNonce[a.borrower];
    if (a.nonce != expected) revert BadNonce(expected, a.nonce);
    (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(hashAttestation(a), signature);
    if (err != ECDSA.RecoverError.NoError || signer != underwriter) revert BadSignature();
    if (a.borrower == address(0) || a.tier > MAX_TIER || a.collateralRatioBps < minCollateralRatioBps()) {
      revert BadAttestation();
    }
    attestationNonce[a.borrower] = expected + 1;
    History memory h = history[a.borrower];
    profiles[a.borrower] = Profile(a.tier, a.collateralRatioBps, a.expiry, h.clean, h.late, h.defaults, a.limitUsdg);
    emit AttestationApplied(a.borrower, a.tier, a.limitUsdg, a.collateralRatioBps, a.nonce, a.expiry);
  }

  /// @notice The lowest collateral ratio any attestation or tier upgrade can reach.
  function minCollateralRatioBps() public view returns (uint16) {
    return params.liquidationThresholdBps + 1_000;
  }

  /// @notice Effective terms: the attested tier moved by on-chain history since the attestation.
  /// Each tier step changes the collateral ratio by 10 percentage points and the limit by 25%.
  function creditTerms(address borrower)
    public
    view
    returns (uint8 tier, uint256 limitUsdg, uint16 ratioBps, uint256 availableUsdg)
  {
    Profile memory p = profiles[borrower];
    if (p.tier == 0 || p.expiry <= block.timestamp) return (0, 0, 0, 0);
    History memory h = history[borrower];
    int256 up = int256(uint256(h.clean - p.cleanAt) / 2);
    int256 down = int256(uint256(h.late - p.lateAt)) + 2 * int256(uint256(h.defaults - p.defaultsAt));
    int256 t = int256(uint256(p.tier)) + up - down;
    if (t <= 0) return (0, 0, 0, 0);
    if (t > int256(uint256(MAX_TIER))) t = int256(uint256(MAX_TIER));
    tier = uint8(uint256(t));
    int256 delta = t - int256(uint256(p.tier));
    int256 ratio = int256(uint256(p.ratioBps)) - delta * 1_000;
    int256 floor = int256(uint256(minCollateralRatioBps()));
    ratioBps = uint16(uint256(ratio < floor ? floor : ratio));
    limitUsdg = p.limitUsdg * uint256(100 + 25 * delta) / 100;
    uint256 used = creditUsed[borrower];
    availableUsdg = limitUsdg > used ? limitUsdg - used : 0;
  }

  // ================================================================ Pay in 3

  /// @notice Fund a merchant invoice with Pay in 3. Collateral is a Stock Token or WETH; pass
  /// collateral = address(0) and msg.value = collateralAmount to lock native ETH.
  function openPlan(bytes32 invoiceId, address merchant, address collateral, uint256 collateralAmount)
    external
    payable
    nonReentrant
    returns (uint256 planId)
  {
    address c = _intakeAsset(collateral, collateralAmount);
    uint256 principal = gateway.openAmount(merchant, invoiceId);
    (, , uint16 ratioBps, uint256 available) = creditTerms(msg.sender);
    if (ratioBps == 0) revert NoCredit(msg.sender);
    if (principal > available) revert OverLimit(principal, available);
    uint256 valueUsd8 = oracle.riskValueUsd8(c, collateralAmount);
    uint256 requiredUsd8 = oracle.usdgToUsd8(principal, Math.Rounding.Ceil).mulDiv(ratioBps, BPS, Math.Rounding.Ceil);
    if (valueUsd8 < requiredUsd8) revert InsufficientCollateral(valueUsd8, requiredUsd8);

    planId = nextPlanId++;
    Params memory pr = params;
    _plans[planId] = Plan({
      borrower: msg.sender,
      merchant: merchant,
      collateral: c,
      start: uint64(block.timestamp),
      interval: pr.installmentInterval,
      grace: pr.gracePeriod,
      paid: 0,
      status: PlanStatus.Active,
      hadLate: false,
      collateralAmount: collateralAmount,
      principal: principal,
      repaid: 0,
      invoiceId: invoiceId
    });
    _plansOf[msg.sender].push(planId);
    creditUsed[msg.sender] += principal;
    planOutstanding += principal;

    _pullCollateral(collateral, c, collateralAmount);
    gateway.settleByCredit(merchant, invoiceId, msg.sender);
    vault.disburse(merchant, principal - principal * pr.merchantFeeBps / BPS);
    emit PlanOpened(planId, msg.sender, merchant, invoiceId, c, collateralAmount, principal, valueUsd8);
  }

  function installmentAmount(uint256 planId, uint8 installment) public view returns (uint256) {
    uint256 principal = _plans[planId].principal;
    uint256 base = principal / INSTALLMENTS;
    return installment < INSTALLMENTS ? base : principal - base * (INSTALLMENTS - 1);
  }

  /// @notice USDG due in total through installment `n` (0..INSTALLMENTS).
  function cumulativeDue(uint256 planId, uint8 n) public view returns (uint256) {
    if (n >= INSTALLMENTS) return _plans[planId].principal;
    // Same per-installment base as installmentAmount (the last installment takes the remainder).
    // forge-lint: disable-next-line(divide-before-multiply)
    return (_plans[planId].principal / INSTALLMENTS) * n;
  }

  function dueAt(uint256 planId, uint8 installment) public view returns (uint64) {
    Plan storage p = _plans[planId];
    return p.start + uint64(p.interval) * installment;
  }

  /// @notice Pay the next `count` installments in USDG (anyone may pay for the borrower).
  function repay(uint256 planId, uint8 count) public nonReentrant returns (uint256 paidUsdg) {
    Plan storage p = _plans[planId];
    if (p.status != PlanStatus.Active) revert PlanNotActive();
    if (count == 0 || p.paid + count > INSTALLMENTS) revert NothingDue();
    History storage h = history[p.borrower];
    uint256 covered = p.repaid; // a partial liquidation may already have paid part of an installment
    for (uint8 i; i < count; ++i) {
      uint8 n = p.paid + 1;
      uint256 cum = cumulativeDue(planId, n);
      uint256 amt = cum > covered ? cum - covered : 0;
      covered += amt;
      bool late = block.timestamp > dueAt(planId, n);
      if (late) {
        h.late += 1;
        p.hadLate = true;
      } else {
        h.onTime += 1;
      }
      p.paid = n;
      paidUsdg += amt;
      emit InstallmentPaid(planId, p.borrower, n, amt, late);
    }
    p.repaid += paidUsdg;
    planOutstanding -= paidUsdg;
    creditUsed[p.borrower] -= paidUsdg;
    bool done = p.paid == INSTALLMENTS;
    if (done) {
      p.status = PlanStatus.Repaid;
      h.completed += 1;
      if (!p.hadLate) h.clean += 1;
    }
    usdg.safeTransferFrom(msg.sender, address(vault), paidUsdg);
    if (done) {
      _sendOrCredit(p.collateral, p.borrower, p.collateralAmount);
      emit PlanRepaid(planId, p.borrower, !p.hadLate);
    }
  }

  /// @notice repay() after an EIP-2612 USDG permit.
  function repayWithPermit(uint256 planId, uint8 count, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
    external
    returns (uint256)
  {
    try IERC20Permit(address(usdg)).permit(msg.sender, address(this), value, deadline, v, r, s) {} catch {}
    return repay(planId, count);
  }

  /// @notice Unpaid installments that are past their due date plus the grace period.
  function missedInstallments(uint256 planId) public view returns (uint8 missed) {
    Plan storage p = _plans[planId];
    if (p.status != PlanStatus.Active) return 0;
    for (uint8 n = p.paid + 1; n <= INSTALLMENTS; ++n) {
      if (block.timestamp <= uint256(dueAt(planId, n)) + p.grace) break;
      ++missed;
    }
  }

  /// @notice Overdue: two missed installments, or the final one missed. Undercollateralised:
  /// collateral value below liquidationThresholdBps of the outstanding debt.
  function planLiquidatable(uint256 planId) public view returns (bool overdue, bool undercollateralised) {
    Plan storage p = _plans[planId];
    if (p.status != PlanStatus.Active) return (false, false);
    uint8 missed = missedInstallments(planId);
    overdue = missed >= MISSED_TO_DEFAULT || (missed != 0 && p.paid + missed == INSTALLMENTS);
    uint256 debtUsd8 = oracle.usdgToUsd8(p.principal - p.repaid, Math.Rounding.Ceil);
    undercollateralised =
      oracle.valueUsd8(p.collateral, p.collateralAmount) < debtUsd8.mulDiv(params.liquidationThresholdBps, BPS);
  }

  /// @notice Repay a liquidatable plan's whole outstanding USDG to the vault and take collateral
  /// worth the debt plus liquidationBonusBps. The rest of the collateral goes back to the borrower.
  function liquidatePlan(uint256 planId) external nonReentrant returns (uint256 seized) {
    Plan storage p = _plans[planId];
    (bool overdue, bool under) = planLiquidatable(planId);
    if (!overdue && !under) revert NotLiquidatable();
    uint256 outstanding = p.principal - p.repaid;
    p.status = PlanStatus.Liquidated;
    planOutstanding -= outstanding;
    creditUsed[p.borrower] -= outstanding;
    history[p.borrower].defaults += 1;
    uint256 pay;
    uint256 bad;
    (pay, seized, bad) = _seize(p.collateral, p.collateralAmount, oracle.usdgToUsd8(outstanding, Math.Rounding.Ceil), outstanding);
    badDebtUsdg += bad;
    usdg.safeTransferFrom(msg.sender, address(vault), pay);
    IERC20(p.collateral).safeTransfer(msg.sender, seized);
    if (p.collateralAmount > seized) _sendOrCredit(p.collateral, p.borrower, p.collateralAmount - seized);
    emit PlanLiquidated(planId, p.borrower, msg.sender, pay, seized, bad);
  }

  /// @notice Liquidate a plan by selling its collateral to Aqua makers through SwapVM. The caller
  /// pays nothing: the vault receives the outstanding USDG from the sale, the caller receives
  /// collateral worth liquidationBonusBps of the debt, and the rest goes back to the borrower.
  /// Underwater collateral is sold whole (after the bonus share) and the shortfall is bad debt.
  function liquidatePlanViaAqua(uint256 planId) external nonReentrant returns (uint256 proceeds) {
    Plan storage p = _plans[planId];
    (bool overdue, bool under) = planLiquidatable(planId);
    if (!overdue && !under) revert NotLiquidatable();
    uint256 outstanding = p.principal - p.repaid;
    p.status = PlanStatus.Liquidated;
    planOutstanding -= outstanding;
    creditUsed[p.borrower] -= outstanding;
    history[p.borrower].defaults += 1;
    uint256 seized;
    uint256 bad;
    (proceeds, seized, bad) = _sellToMakers(bytes32(planId), p.collateral, p.collateralAmount, outstanding, p.borrower);
    badDebtUsdg += bad;
    emit PlanLiquidated(planId, p.borrower, msg.sender, proceeds, seized, bad);
  }

  /// @notice NorenDutchAuction only: take `seize` collateral from an active plan and book
  /// `repayUsdg` (already sold to makers in the same transaction, paid to the vault) against it.
  /// Installments the repayment covers are marked paid (not on time). The plan closes when nothing
  /// is outstanding (the remaining collateral goes back to the borrower) or when no collateral is
  /// left (the shortfall is bad debt). `firstFill` records the default in the borrower's history.
  function auctionSeize(uint256 planId, uint256 seize, uint256 repayUsdg, bool firstFill)
    external
    nonReentrant
    returns (bool closed, uint256 bad)
  {
    if (msg.sender != dutchAuction || msg.sender == address(0)) revert NotAuction();
    Plan storage p = _plans[planId];
    if (p.status != PlanStatus.Active) revert PlanNotActive();
    uint256 outstanding = p.principal - p.repaid;
    if (seize > p.collateralAmount || repayUsdg > outstanding) revert BadValue();
    p.collateralAmount -= seize;
    if (firstFill) history[p.borrower].defaults += 1;
    if (repayUsdg != 0) {
      p.repaid += repayUsdg;
      planOutstanding -= repayUsdg;
      creditUsed[p.borrower] -= repayUsdg;
      outstanding -= repayUsdg;
      p.hadLate = true;
      while (p.paid < INSTALLMENTS && p.repaid >= cumulativeDue(planId, p.paid + 1)) {
        p.paid += 1;
        emit InstallmentPaid(planId, p.borrower, p.paid, installmentAmount(planId, p.paid), true);
      }
    }
    closed = outstanding == 0 || p.collateralAmount == 0;
    if (closed) {
      bad = outstanding;
      if (bad != 0) {
        badDebtUsdg += bad;
        planOutstanding -= bad;
        creditUsed[p.borrower] -= bad;
      }
      p.status = PlanStatus.Liquidated;
      if (p.collateralAmount != 0) _sendOrCredit(p.collateral, p.borrower, p.collateralAmount);
      emit PlanLiquidated(planId, p.borrower, msg.sender, repayUsdg, seize, bad);
    }
    IERC20(p.collateral).safeTransfer(msg.sender, seize);
    emit PlanPartiallyLiquidated(planId, p.borrower, seize, repayUsdg, p.collateralAmount, outstanding, closed);
  }

  // ================================================================ Arc credit line

  /// @notice Lock collateral for a USDC credit line spendable at Noren merchants on Arc.
  /// The CRE bridge carries CreditLineOpened to NorenCreditLine on Arc.
  function openCreditLine(address collateral, uint256 collateralAmount, uint256 limitUsdc6, uint64 expiry)
    external
    payable
    nonReentrant
    returns (bytes32 lineId)
  {
    address c = _intakeAsset(collateral, collateralAmount);
    if (expiry <= block.timestamp || expiry > block.timestamp + params.maxLineDuration) revert BadExpiry(expiry);
    (, , uint16 ratioBps, uint256 available) = creditTerms(msg.sender);
    if (ratioBps == 0) revert NoCredit(msg.sender);
    if (limitUsdc6 == 0 || limitUsdc6 > available) revert OverLimit(limitUsdc6, available);
    uint256 valueUsd8 = oracle.riskValueUsd8(c, collateralAmount);
    uint256 requiredUsd8 = (limitUsdc6 * USDC6_TO_USD8).mulDiv(ratioBps, BPS, Math.Rounding.Ceil);
    if (valueUsd8 < requiredUsd8) revert InsufficientCollateral(valueUsd8, requiredUsd8);

    lineId = keccak256(abi.encode(block.chainid, address(this), msg.sender, lineNonce++));
    _lines[lineId] = Line({
      borrower: msg.sender,
      collateral: c,
      expiry: expiry,
      asOf: 0,
      closeRequestedAt: 0,
      status: LineStatus.Open,
      collateralAmount: collateralAmount,
      limitUsdc: limitUsdc6,
      drawn: 0,
      repaid: 0
    });
    _linesOf[msg.sender].push(lineId);
    creditUsed[msg.sender] += limitUsdc6;
    _pullCollateral(collateral, c, collateralAmount);
    emit CreditLineOpened(msg.sender, lineId, limitUsdc6, expiry, valueUsd8);
  }

  /// @inheritdoc IReceiver
  /// @dev report = abi.encode(bytes32 lineId, uint256 drawnUsdc6, uint256 repaidUsdc6, uint64 asOf),
  /// written by the CRE bridge from NorenCreditLine Drawn/Repaid events on Arc.
  function onReport(bytes calldata metadata, bytes calldata report) external nonReentrant {
    if (msg.sender != forwarder || forwarder == address(0)) revert NotForwarder(msg.sender);
    _checkWorkflow(metadata);
    (bytes32 lineId, uint256 drawn, uint256 repaid, uint64 asOf) = abi.decode(report, (bytes32, uint256, uint256, uint64));
    Line storage l = _lines[lineId];
    if (l.status == LineStatus.None) revert UnknownLine(lineId);
    if (l.status != LineStatus.Open && l.status != LineStatus.Closing) revert LineNotActive(l.status);
    if (asOf <= l.asOf) revert StaleReport(asOf, l.asOf);
    if (asOf > block.timestamp + params.reportSkew) revert FutureReport(asOf);
    // Arc's drawn and repaid totals only grow, repaid never exceeds drawn, and NorenCreditLine keeps
    // drawn - repaid within the limit this line opened with. A report outside that is refused, so
    // a faulty or compromised report cannot invent debt beyond the line or roll back a repayment.
    if (repaid > drawn || drawn < l.drawn || repaid < l.repaid || drawn - repaid > l.limitUsdc) {
      revert BadReport(drawn, repaid);
    }
    l.drawn = drawn;
    l.repaid = repaid;
    l.asOf = asOf;
    emit ArcUtilisationUpdated(lineId, drawn, repaid, asOf);
    if (l.status == LineStatus.Closing && repaid >= drawn && asOf >= l.closeRequestedAt) _settleLine(lineId, l);
  }

  /// @notice First call: stop the line (CreditLineClosed tells the bridge to zero the Arc limit).
  /// Collateral returns once an Arc report dated at or after the close shows nothing outstanding;
  /// the bridge's report settles it automatically, or call again after it lands.
  function closeCreditLine(bytes32 lineId) external nonReentrant {
    Line storage l = _lines[lineId];
    if (l.borrower != msg.sender) revert NotBorrower();
    if (l.status == LineStatus.Open) {
      l.status = LineStatus.Closing;
      l.closeRequestedAt = uint64(block.timestamp);
      emit CreditLineClosed(lineId);
      return;
    }
    if (l.status != LineStatus.Closing) revert LineNotActive(l.status);
    if (l.asOf < l.closeRequestedAt) revert AwaitingArcReport(l.asOf, l.closeRequestedAt);
    if (l.drawn > l.repaid) revert DebtOutstanding(l.drawn - l.repaid);
    _settleLine(lineId, l);
  }

  /// @notice Arc utilisation as last reported through onReport (read by the CRE bridge).
  function utilisation(bytes32 lineId) external view returns (uint256 drawn, uint256 repaid, uint64 asOf) {
    Line storage l = _lines[lineId];
    if (l.status == LineStatus.None) revert UnknownLine(lineId);
    return (l.drawn, l.repaid, l.asOf);
  }

  function lineOutstanding(bytes32 lineId) public view returns (uint256) {
    Line storage l = _lines[lineId];
    return l.drawn > l.repaid ? l.drawn - l.repaid : 0;
  }

  /// @notice Outstanding Arc debt past the line's expiry plus grace, or collateral value below
  /// liquidationThresholdBps of the outstanding debt.
  function lineLiquidatable(bytes32 lineId) public view returns (bool pastDue, bool undercollateralised) {
    Line storage l = _lines[lineId];
    if (l.status != LineStatus.Open && l.status != LineStatus.Closing) return (false, false);
    uint256 out = lineOutstanding(lineId);
    if (out == 0) return (false, false);
    pastDue = block.timestamp > uint256(l.expiry) + params.gracePeriod;
    undercollateralised = oracle.valueUsd8(l.collateral, l.collateralAmount)
      < (out * USDC6_TO_USD8).mulDiv(params.liquidationThresholdBps, BPS);
  }

  /// @notice Pay a liquidatable line's outstanding Arc debt in USDG to the vault (the Robinhood-side
  /// treasury that settles with the Arc pool) and take collateral worth the debt plus the bonus.
  function liquidateLine(bytes32 lineId) external nonReentrant returns (uint256 seized) {
    Line storage l = _lines[lineId];
    (bool pastDue, bool under) = lineLiquidatable(lineId);
    if (!pastDue && !under) revert NotLiquidatable();
    uint256 out = lineOutstanding(lineId);
    l.status = LineStatus.Liquidated;
    creditUsed[l.borrower] -= l.limitUsdc;
    history[l.borrower].defaults += 1;
    uint256 debtUsd8 = out * USDC6_TO_USD8;
    uint256 debtUsdg = oracle.usd8ToUsdg(debtUsd8, Math.Rounding.Ceil);
    uint256 pay;
    uint256 bad;
    (pay, seized, bad) = _seize(l.collateral, l.collateralAmount, debtUsd8, debtUsdg);
    badDebtUsdg += bad;
    usdg.safeTransferFrom(msg.sender, address(vault), pay);
    IERC20(l.collateral).safeTransfer(msg.sender, seized);
    if (l.collateralAmount > seized) _sendOrCredit(l.collateral, l.borrower, l.collateralAmount - seized);
    emit CreditLineLiquidated(lineId, l.borrower, msg.sender, pay, seized, bad);
    emit CreditLineClosed(lineId);
  }

  /// @notice liquidateLine() with the collateral sold to Aqua makers (see liquidatePlanViaAqua).
  function liquidateLineViaAqua(bytes32 lineId) external nonReentrant returns (uint256 proceeds) {
    Line storage l = _lines[lineId];
    (bool pastDue, bool under) = lineLiquidatable(lineId);
    if (!pastDue && !under) revert NotLiquidatable();
    uint256 out = lineOutstanding(lineId);
    l.status = LineStatus.Liquidated;
    creditUsed[l.borrower] -= l.limitUsdc;
    history[l.borrower].defaults += 1;
    uint256 debtUsdg = oracle.usd8ToUsdg(out * USDC6_TO_USD8, Math.Rounding.Ceil);
    uint256 seized;
    uint256 bad;
    (proceeds, seized, bad) = _sellToMakers(lineId, l.collateral, l.collateralAmount, debtUsdg, l.borrower);
    badDebtUsdg += bad;
    emit CreditLineLiquidated(lineId, l.borrower, msg.sender, proceeds, seized, bad);
    emit CreditLineClosed(lineId);
  }

  // ================================================================ views

  function plan(uint256 planId) external view returns (Plan memory) {
    return _plans[planId];
  }

  function line(bytes32 lineId) external view returns (Line memory) {
    return _lines[lineId];
  }

  function plansOf(address borrower) external view returns (uint256[] memory) {
    return _plansOf[borrower];
  }

  function linesOf(address borrower) external view returns (bytes32[] memory) {
    return _linesOf[borrower];
  }

  /// @inheritdoc INorenReceivables
  function receivablesUsdg() external view returns (uint256) {
    return planOutstanding;
  }

  function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
    return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
  }

  /// @notice Withdraw collateral that could not be pushed (for example while the account was
  /// on the Stock Token blocklist).
  function claim(address asset) external nonReentrant {
    uint256 amt = claimable[msg.sender][asset];
    if (amt == 0) revert NothingToClaim();
    claimable[msg.sender][asset] = 0;
    IERC20(asset).safeTransfer(msg.sender, amt);
  }

  // ================================================================ internal

  function _intakeAsset(address collateral, uint256 amount) internal view returns (address c) {
    if (amount == 0) revert BadValue();
    if (collateral == address(0)) {
      if (msg.value != amount) revert BadValue();
      c = address(weth);
    } else {
      if (msg.value != 0) revert BadValue();
      c = collateral;
    }
    if (c == address(usdg) || !oracle.isSupported(c)) revert CollateralNotAccepted(collateral);
    oracle.checkTransferable(c, msg.sender, address(this));
  }

  function _pullCollateral(address collateral, address c, uint256 amount) internal {
    if (collateral == address(0)) {
      weth.deposit{value: amount}();
    } else {
      uint256 before = IERC20(c).balanceOf(address(this));
      IERC20(c).safeTransferFrom(msg.sender, address(this), amount);
      if (IERC20(c).balanceOf(address(this)) - before < amount) revert BadValue();
    }
  }

  /// @dev Collateral for debt plus bonus, capped at all collateral; when capped the liquidator
  /// pays only what the collateral covers at the bonus discount and the rest is bad debt.
  function _seize(address c, uint256 collateralAmount, uint256 debtUsd8, uint256 debtUsdg)
    internal
    view
    returns (uint256 pay, uint256 seized, uint256 bad)
  {
    uint256 bonus = params.liquidationBonusBps;
    uint256 valueUsd8 = oracle.valueUsd8(c, collateralAmount);
    uint256 claimUsd8 = debtUsd8.mulDiv(BPS + bonus, BPS);
    if (claimUsd8 < valueUsd8) {
      seized = collateralAmount.mulDiv(claimUsd8, valueUsd8);
      pay = debtUsdg;
    } else {
      seized = collateralAmount;
      pay = Math.min(debtUsdg, oracle.usd8ToUsdg(valueUsd8.mulDiv(BPS, BPS + bonus), Math.Rounding.Ceil));
      bad = debtUsdg - pay;
    }
  }

  /// @dev Sell collateral through NorenLiquidity: proceeds to the vault, bonus to the caller,
  /// leftover collateral (and any USDG above the debt) to the borrower.
  function _sellToMakers(bytes32 id, address c, uint256 amount, uint256 debtUsdg, address borrower)
    internal
    returns (uint256 proceeds, uint256 seized, uint256 bad)
  {
    INorenLiquidity l = liquidity;
    if (address(l) == address(0)) revert NoLiquidity();
    IERC20(c).forceApprove(address(l), amount);
    (uint256 got, uint256 sold, uint256 bonus, uint256 excess) =
      l.liquidate(c, amount, debtUsdg, params.liquidationBonusBps, address(vault), msg.sender);
    IERC20(c).forceApprove(address(l), 0);
    proceeds = got;
    seized = sold + bonus;
    bad = debtUsdg - got;
    if (amount > seized) _sendOrCredit(c, borrower, amount - seized);
    if (excess != 0) _sendOrCredit(address(usdg), borrower, excess);
    emit CollateralSoldToMakers(id, c, sold, bonus, amount - seized, got);
  }

  function _settleLine(bytes32 lineId, Line storage l) internal {
    l.status = LineStatus.Closed;
    creditUsed[l.borrower] -= l.limitUsdc;
    History storage h = history[l.borrower];
    h.completed += 1;
    // Only a line that was used and repaid in full counts as clean: closing an unused line must not
    // lift the borrower's tier (creditTerms) for free.
    if (l.drawn != 0) h.clean += 1;
    _sendOrCredit(l.collateral, l.borrower, l.collateralAmount);
    emit CreditLineSettled(lineId, l.borrower, l.collateralAmount);
  }

  /// @dev Push collateral; if the token refuses (blocklist, pause) credit it for claim() instead,
  /// so a borrower-side restriction can never block repayment or a report.
  function _sendOrCredit(address asset, address to, uint256 amount) internal {
    (bool ok, bytes memory ret) = asset.call(abi.encodeCall(IERC20.transfer, (to, amount)));
    if (ok && (ret.length == 0 || abi.decode(ret, (bool))) && asset.code.length != 0) return;
    claimable[to][asset] += amount;
    emit CollateralCredited(to, asset, amount);
  }

  /// @dev CRE metadata = abi.encodePacked(bytes32 workflowId, bytes10 workflowName, address workflowOwner, bytes2 reportName).
  function _checkWorkflow(bytes calldata metadata) internal view {
    bytes32 wantId = expectedWorkflowId;
    address wantOwner = expectedWorkflowOwner;
    if (wantId == bytes32(0) && wantOwner == address(0)) return;
    if (metadata.length < 62) revert BadWorkflow();
    bytes32 id = bytes32(metadata[0:32]);
    address owner_ = address(bytes20(metadata[42:62]));
    if (wantId != bytes32(0) && id != wantId) revert BadWorkflow();
    if (wantOwner != address(0) && owner_ != wantOwner) revert BadWorkflow();
  }
}
