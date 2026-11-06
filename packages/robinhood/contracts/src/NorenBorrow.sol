// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from '@oz/access/Ownable2Step.sol';
import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {IERC20Metadata} from '@oz/token/ERC20/extensions/IERC20Metadata.sol';
import {SafeERC20} from '@oz/token/ERC20/utils/SafeERC20.sol';
import {Math} from '@oz/utils/math/Math.sol';
import {ReentrancyGuard} from '@oz/utils/ReentrancyGuard.sol';
import {NorenAssetOracle} from './NorenAssetOracle.sol';
import {NorenDepositVault} from './NorenDepositVault.sol';
import {NorenReputation, INorenBorrowRecord} from './NorenReputation.sol';
import {INorenVault, INorenReceivables} from './interfaces/INorenVault.sol';
import {INorenLiquidity} from './interfaces/IAquaSwapVM.sol';

/// @title NorenBorrow
/// @notice Borrow USDG from the Noren lender pool (NorenVault) against Noren deposit shares (nETH,
/// nNVDA, ...). Locked shares stay in their vault's Aqua strategy and keep earning its spread fees.
///
/// - Borrow limit = sum of locked shares' Chainlink value (closed-market haircut on stocks) x the
///   account's LTV from NorenReputation: 66% base, 70 / 75 / 80% with reputation, never above 80%.
/// - Health factor = Chainlink value (no haircut) x liquidationLtvBps / debt; below 1 the position
///   is liquidatable. Repay at any time; unlock shares while the position stays within its limit.
/// - Debt accrues simple-per-interaction interest at `borrowRateBps` a year for the lender pool.
/// - Liquidation (`liquidateViaAqua`) redeems the seized shares in kind, applies their USDG to the
///   debt and sells the asset to Aqua makers through NorenLiquidity.liquidate, the same path as
///   NorenCredit.liquidatePlanViaAqua: proceeds to the lender pool, a 5% bonus in collateral to the
///   keeper, the rest back to the borrower. Debt left with no collateral is written off as bad debt.
/// - Loans that pay themselves down (`harvestToRepay`): the realised Aqua maker fees a position's
///   locked shares earned since it locked them (or since the last harvest) are taken out of the
///   vault in USDG and repay the debt. Anyone may call it as a keeper; the USDG goes only to the
///   lender pool against this account's debt, the principal shares stay locked, and the health
///   factor can only improve.
/// This contract is the lender pool's receivables source: NorenCredit's plus outstanding loans.
contract NorenBorrow is Ownable2Step, ReentrancyGuard, INorenReceivables, INorenBorrowRecord {
  using SafeERC20 for IERC20;
  using Math for uint256;

  uint256 internal constant BPS = 10_000;
  uint256 internal constant RAY = 1e27;
  uint256 internal constant YEAR = 365 days;
  uint16 public constant MAX_LTV_BPS = 8_000;
  uint8 public constant MAX_VAULTS = 8;
  /// @dev Matches NorenDepositVault's fee-per-share scale.
  uint256 internal constant ACC = 1e36;
  /// @notice Worst price a harvest may accept when it has to sell the asset part to Aqua makers.
  uint16 public constant HARVEST_MAX_SLIPPAGE_BPS = 300;

  struct Account {
    uint256 scaledDebt; // debt / borrowIndex (RAY)
    uint256 principal; // USDG borrowed and not yet repaid (interest excluded)
    uint256 peakPrincipal; // largest principal of the current loan (milestone check)
    uint64 openedAt; // when the current loan started (debt went from 0 to > 0)
    uint32 repaidLoans;
    uint32 liquidations;
  }

  IERC20 public immutable usdg;
  NorenAssetOracle public immutable oracle;
  /// @notice The lender pool (NorenVault, nvUSDG). This contract is one of its modules.
  INorenVault public immutable lender;
  /// @notice NorenCredit: its Pay-in-3 receivables are added to ours for the lender pool's NAV.
  INorenReceivables public immutable credit;
  NorenReputation public immutable reputation;
  INorenLiquidity public liquidity;

  uint16 public liquidationLtvBps = 8_500;
  uint16 public liquidationBonusBps = 500;
  uint16 public borrowRateBps = 500;
  /// @notice A loan counts toward the repaid-loan milestone only from this principal and age on.
  uint256 public minMilestonePrincipal = 10e6;
  uint32 public minMilestoneAge = 1 days;

  NorenDepositVault[] internal _vaults;
  mapping(address vault => bool) public isVault;
  mapping(address account => Account) internal _accounts;
  mapping(address account => mapping(address vault => uint256)) public lockedShares;
  mapping(address account => mapping(address asset => uint256)) public claimable;

  uint256 public borrowIndex = RAY;
  uint64 public lastAccrual;
  uint64 public immutable startedAt;
  uint256 public totalScaledDebt;
  uint256 public totalPrincipal;
  uint256 public interestPaidUsdg;
  uint256 public badDebtUsdg;

  /// @notice Vault fees-per-share at the position's last settlement (lock, unlock, harvest).
  mapping(address account => mapping(address vault => uint256)) public feeIndexOf;
  /// @notice Realised fee yield (USDG) settled on the locked shares and not yet harvested.
  mapping(address account => mapping(address vault => uint256)) internal _pendingYield;
  /// @notice The vault's fill count when this position started earning or was last harvested.
  mapping(address account => mapping(address vault => uint256)) public fillMarkOf;
  /// @notice USDG of debt repaid by harvested yield, per account and in total.
  mapping(address account => uint256) public yieldRepaidUsdg;
  uint256 public totalYieldRepaidUsdg;

  event VaultAdded(address indexed vault, address indexed asset);
  event ParamsSet(uint16 liquidationLtvBps, uint16 liquidationBonusBps, uint16 borrowRateBps, uint256 minMilestonePrincipal, uint32 minMilestoneAge);
  event LiquiditySet(address indexed liquidity);
  event Locked(address indexed account, address indexed vault, uint256 shares);
  event Unlocked(address indexed account, address indexed vault, uint256 shares, address to);
  event Borrowed(address indexed account, uint256 amountUsdg, address to, uint256 debtUsdg, uint256 limitUsdg);
  event Repaid(address indexed account, address indexed payer, uint256 amountUsdg, uint256 interestUsdg, uint256 debtUsdg);
  event LoanRepaid(address indexed account, uint256 peakPrincipalUsdg, bool countsForMilestone);
  event LoanLiquidated(
    address indexed account,
    address indexed vault,
    address indexed keeper,
    uint256 shares,
    uint256 repaidUsdg,
    uint256 assetSold,
    uint256 bonus,
    uint256 badDebtUsdg
  );
  event CollateralCredited(address indexed account, address indexed asset, uint256 amount);
  /// @notice `usdg` of `account`'s debt repaid from the realised fees of its locked `vault` shares
  /// (`shares` redeemed, `fills` = vault fills since the position's previous harvest or lock).
  event YieldRepaid(
    address indexed account,
    address indexed vault,
    address indexed keeper,
    uint256 usdg,
    uint256 debtAfter,
    uint256 shares,
    uint256 fills
  );

  error NotVault(address vault);
  error TooManyVaults();
  error ZeroAmount();
  error ExceedsLimit(uint256 debtUsdg, uint256 limitUsdg);
  error InsufficientLocked(uint256 requested, uint256 locked);
  error Healthy(uint256 healthFactor);
  error NoDebt();
  error NoLiquidity();
  error NothingToClaim();
  error BadConfig();
  error NoYield();
  error HealthWorse(uint256 before, uint256 afterHarvest);

  constructor(
    address owner_,
    IERC20 usdg_,
    NorenAssetOracle oracle_,
    INorenVault lender_,
    INorenReceivables credit_,
    NorenReputation reputation_,
    INorenLiquidity liquidity_
  ) Ownable(owner_) {
    if (oracle_.usdg() != address(usdg_)) revert BadConfig();
    usdg = usdg_;
    oracle = oracle_;
    lender = lender_;
    credit = credit_;
    reputation = reputation_;
    liquidity = liquidity_;
    startedAt = uint64(block.timestamp);
    lastAccrual = uint64(block.timestamp);
  }

  // ================================================================ admin

  function addVault(NorenDepositVault v) external onlyOwner {
    if (isVault[address(v)] || v.oracle() != oracle) revert BadConfig();
    if (_vaults.length >= MAX_VAULTS) revert TooManyVaults();
    isVault[address(v)] = true;
    _vaults.push(v);
    emit VaultAdded(address(v), v.asset());
  }

  function setLiquidity(INorenLiquidity l) external onlyOwner {
    liquidity = l;
    emit LiquiditySet(address(l));
  }

  function setParams(uint16 liqLtv, uint16 bonus, uint16 rate, uint256 minPrincipal, uint32 minAge) external onlyOwner {
    if (liqLtv <= MAX_LTV_BPS || liqLtv >= BPS || bonus > 1_500 || rate > 5_000) revert BadConfig();
    _accrue();
    liquidationLtvBps = liqLtv;
    liquidationBonusBps = bonus;
    borrowRateBps = rate;
    minMilestonePrincipal = minPrincipal;
    minMilestoneAge = minAge;
    emit ParamsSet(liqLtv, bonus, rate, minPrincipal, minAge);
  }

  // ================================================================ positions

  /// @notice Lock deposit shares as collateral (they keep earning in their vault).
  function lock(NorenDepositVault v, uint256 shares) external nonReentrant {
    _requireVault(v);
    if (shares == 0) revert ZeroAmount();
    _settleYield(msg.sender, v);
    IERC20(address(v)).safeTransferFrom(msg.sender, address(this), shares);
    lockedShares[msg.sender][address(v)] += shares;
    emit Locked(msg.sender, address(v), shares);
  }

  /// @notice Unlock shares (partial withdraw). Allowed while the remaining debt stays within the
  /// borrow limit of the remaining collateral.
  function unlock(NorenDepositVault v, uint256 shares, address to) external nonReentrant {
    _requireVault(v);
    uint256 locked = lockedShares[msg.sender][address(v)];
    if (shares == 0) revert ZeroAmount();
    if (shares > locked) revert InsufficientLocked(shares, locked);
    _accrue();
    _settleYield(msg.sender, v);
    // The leaving shares carry their part of the unharvested yield in their value.
    _pendingYield[msg.sender][address(v)] = _pendingYield[msg.sender][address(v)].mulDiv(locked - shares, locked);
    lockedShares[msg.sender][address(v)] = locked - shares;
    uint256 debt = debtOf(msg.sender);
    if (debt != 0) {
      uint256 limit = borrowLimitUsdg(msg.sender);
      if (debt > limit) revert ExceedsLimit(debt, limit);
    }
    IERC20(address(v)).safeTransfer(to == address(0) ? msg.sender : to, shares);
    emit Unlocked(msg.sender, address(v), shares, to == address(0) ? msg.sender : to);
  }

  /// @notice Borrow USDG from the lender pool, up to the borrow limit.
  function borrow(uint256 amountUsdg, address to) external nonReentrant {
    if (amountUsdg == 0) revert ZeroAmount();
    _accrue();
    Account storage a = _accounts[msg.sender];
    uint256 debt = debtOf(msg.sender);
    uint256 limit = borrowLimitUsdg(msg.sender);
    if (debt + amountUsdg > limit) revert ExceedsLimit(debt + amountUsdg, limit);
    if (debt == 0) {
      a.openedAt = uint64(block.timestamp);
      a.peakPrincipal = 0;
    }
    uint256 scaled = amountUsdg.mulDiv(RAY, borrowIndex, Math.Rounding.Ceil);
    a.scaledDebt += scaled;
    totalScaledDebt += scaled;
    a.principal += amountUsdg;
    totalPrincipal += amountUsdg;
    if (a.principal > a.peakPrincipal) a.peakPrincipal = a.principal;
    address recipient = to == address(0) ? msg.sender : to;
    lender.disburse(recipient, amountUsdg);
    emit Borrowed(msg.sender, amountUsdg, recipient, debt + amountUsdg, limit);
  }

  /// @notice Repay up to `amountUsdg` of `account`'s debt (anyone may repay). type(uint256).max repays all.
  function repay(address account, uint256 amountUsdg) external nonReentrant returns (uint256 paid) {
    _accrue();
    uint256 debt = debtOf(account);
    if (debt == 0) revert NoDebt();
    paid = Math.min(amountUsdg, debt);
    if (paid == 0) revert ZeroAmount();
    usdg.safeTransferFrom(msg.sender, address(lender), paid);
    uint256 interest = _reduceDebt(account, paid, debt);
    emit Repaid(account, msg.sender, paid, interest, debt - paid);
    if (paid == debt) _closeLoan(account);
  }

  /// @notice Liquidate `account`'s collateral in vault `v` through Aqua makers. The caller pays
  /// nothing and receives the bonus in the vault's asset.
  function liquidateViaAqua(address account, NorenDepositVault v) external nonReentrant returns (uint256 repaidUsdg) {
    _requireVault(v);
    _accrue();
    uint256 hf = healthFactor(account);
    if (hf >= 1e18) revert Healthy(hf);
    uint256 shares = lockedShares[account][address(v)];
    if (shares == 0) revert InsufficientLocked(1, 0);
    lockedShares[account][address(v)] = 0;
    // Seized shares are redeemed with their unharvested yield in them.
    _pendingYield[account][address(v)] = 0;
    feeIndexOf[account][address(v)] = v.feesPerShare();
    uint256 debt = debtOf(account);
    (uint256 amt, uint256 u) = v.redeemInKind(shares, address(this), address(this));
    address asset = v.asset();

    // USDG the vault held for these shares repays first.
    uint256 fromUsdg = Math.min(u, debt);
    if (fromUsdg != 0) usdg.safeTransfer(address(lender), fromUsdg);
    if (u > fromUsdg) _sendOrCredit(address(usdg), account, u - fromUsdg);
    uint256 left = debt - fromUsdg;

    uint256 proceeds;
    uint256 sold;
    uint256 bonus;
    if (left != 0 && amt != 0) {
      INorenLiquidity l = liquidity;
      if (address(l) == address(0)) revert NoLiquidity();
      IERC20(asset).forceApprove(address(l), amt);
      uint256 excess;
      (proceeds, sold, bonus, excess) = l.liquidate(asset, amt, left, liquidationBonusBps, address(lender), msg.sender);
      IERC20(asset).forceApprove(address(l), 0);
      if (excess != 0) _sendOrCredit(address(usdg), account, excess);
    }
    if (amt > sold + bonus) _sendOrCredit(asset, account, amt - sold - bonus);

    repaidUsdg = fromUsdg + proceeds;
    if (repaidUsdg != 0) _reduceDebt(account, repaidUsdg, debt);
    Account storage a = _accounts[account];
    a.liquidations += 1;
    uint256 bad;
    if (a.scaledDebt != 0 && !_hasCollateral(account)) {
      bad = debtOf(account);
      _writeOff(account, bad);
    } else if (a.scaledDebt == 0) {
      a.peakPrincipal = 0;
      a.openedAt = 0;
    }
    emit LoanLiquidated(account, address(v), msg.sender, shares, repaidUsdg, sold, bonus, bad);
  }

  /// @notice Repay `account`'s debt with the realised Aqua maker fees its locked shares earned since
  /// they were locked or last harvested. Anyone may call it (a keeper); the caller receives nothing.
  /// Per vault: the yield is taken in USDG straight from the vault when it holds enough USDG
  /// (`harvestUsdg`, shares worth exactly the yield at Chainlink, rounded up); otherwise shares worth
  /// the yield are redeemed in kind and their asset part is sold to the best Aqua maker
  /// (NorenLiquidity.sellExactAsset, within HARVEST_MAX_SLIPPAGE_BPS of Chainlink). Only yield
  /// shares leave; reverts with NoYield when nothing was earned, NoDebt without a loan, and
  /// HealthWorse if the health factor would drop. Yield above the debt stays pending.
  function harvestToRepay(address account) external nonReentrant returns (uint256 repaidUsdg) {
    _accrue();
    uint256 debt = debtOf(account);
    if (debt == 0) revert NoDebt();
    uint256 hf0 = healthFactor(account);
    for (uint256 i; i < _vaults.length && repaidUsdg < debt; ++i) {
      NorenDepositVault v = _vaults[i];
      if (lockedShares[account][address(v)] == 0 && _pendingYield[account][address(v)] == 0) continue;
      _settleYield(account, v);
      uint256 y = _pendingYield[account][address(v)];
      if (y == 0 || lockedShares[account][address(v)] == 0) continue;
      uint256 take = Math.min(y, debt - repaidUsdg);
      (uint256 got, uint256 shares) = _harvest(account, v, take);
      if (got == 0) continue;
      _pendingYield[account][address(v)] = y - take;
      (, uint256 fillsNow,) = v.feeBook();
      uint256 fills = fillsNow - fillMarkOf[account][address(v)];
      fillMarkOf[account][address(v)] = fillsNow;
      if (got > debt - repaidUsdg) {
        // a sale can only return less than the yield, but never repay more than is owed
        _sendOrCredit(address(usdg), account, got - (debt - repaidUsdg));
        got = debt - repaidUsdg;
      }
      repaidUsdg += got;
      emit YieldRepaid(account, address(v), msg.sender, got, debt - repaidUsdg, shares, fills);
    }
    if (repaidUsdg == 0) revert NoYield();
    usdg.safeTransfer(address(lender), repaidUsdg);
    uint256 interest = _reduceDebt(account, repaidUsdg, debt);
    yieldRepaidUsdg[account] += repaidUsdg;
    totalYieldRepaidUsdg += repaidUsdg;
    emit Repaid(account, msg.sender, repaidUsdg, interest, debt - repaidUsdg);
    if (repaidUsdg == debt) _closeLoan(account);
    uint256 hf1 = healthFactor(account);
    if (hf1 < hf0) revert HealthWorse(hf0, hf1);
  }

  /// @notice Withdraw tokens that could not be pushed (e.g. a blocklisted Stock Token account).
  function claim(address asset) external nonReentrant {
    uint256 amt = claimable[msg.sender][asset];
    if (amt == 0) revert NothingToClaim();
    claimable[msg.sender][asset] = 0;
    IERC20(asset).safeTransfer(msg.sender, amt);
  }

  // ================================================================ views

  /// @notice Realised fee yield (USDG) on `who`'s locked `v` shares not yet harvested, and the
  /// vault's fills since the position started earning or was last harvested.
  function yieldOf(address who, NorenDepositVault v) public view returns (uint256 usdgAmount, uint256 fills) {
    uint256 locked = lockedShares[who][address(v)];
    usdgAmount = _pendingYield[who][address(v)];
    if (locked == 0) return (usdgAmount, 0);
    usdgAmount += locked.mulDiv(v.feesPerShare() - feeIndexOf[who][address(v)], ACC);
    (, uint256 f,) = v.feeBook();
    fills = f - fillMarkOf[who][address(v)];
  }

  /// @notice What `harvestToRepay(who)` would repay now (before any sale spread): the unharvested
  /// yield over every locked vault, capped at the debt.
  function previewYieldRepay(address who) external view returns (uint256 usdgAmount, uint256 fills, uint256 debtUsdg) {
    for (uint256 i; i < _vaults.length; ++i) {
      (uint256 y, uint256 f) = yieldOf(who, _vaults[i]);
      usdgAmount += y;
      fills += f;
    }
    debtUsdg = debtOf(who);
    if (usdgAmount > debtUsdg) usdgAmount = debtUsdg;
  }

  function vaults() external view returns (NorenDepositVault[] memory) {
    return _vaults;
  }

  function accountOf(address who) external view returns (Account memory) {
    return _accounts[who];
  }

  /// @inheritdoc INorenBorrowRecord
  function record(address who) external view returns (uint32 repaidLoans, uint32 liquidations) {
    Account storage a = _accounts[who];
    return (a.repaidLoans, a.liquidations);
  }

  /// @notice Borrow index including interest accrued since the last interaction.
  function currentIndex() public view returns (uint256) {
    uint256 dt = block.timestamp - lastAccrual;
    if (dt == 0) return borrowIndex;
    return borrowIndex + borrowIndex.mulDiv(uint256(borrowRateBps) * dt, BPS * YEAR);
  }

  function debtOf(address who) public view returns (uint256) {
    return _accounts[who].scaledDebt.mulDiv(currentIndex(), RAY, Math.Rounding.Ceil);
  }

  function totalDebtUsdg() public view returns (uint256) {
    return totalScaledDebt.mulDiv(currentIndex(), RAY, Math.Rounding.Ceil);
  }

  /// @inheritdoc INorenReceivables
  /// @dev Pay-in-3 receivables (NorenCredit) plus outstanding loans with accrued interest.
  function receivablesUsdg() external view returns (uint256) {
    return credit.receivablesUsdg() + totalDebtUsdg();
  }

  /// @notice Chainlink value (USD, 8 decimals) of locked collateral; `risk` = closed-market haircut.
  /// The risk value (borrow limit) leaves out vaults whose asset the oracle no longer accepts for
  /// new risk (NorenAssetOracle.disableAsset); the health factor still counts them.
  function collateralValueUsd8(address who, bool risk) public view returns (uint256 v) {
    for (uint256 i; i < _vaults.length; ++i) {
      uint256 s = lockedShares[who][address(_vaults[i])];
      if (s == 0 || (risk && !oracle.isSupported(_vaults[i].asset()))) continue;
      v += _vaults[i].sharesValueUsd8(s, risk);
    }
  }

  /// @notice Locked collateral's risk value x the account's reputation LTV (66-80%), in USDG.
  function borrowLimitUsdg(address who) public view returns (uint256) {
    uint256 v = collateralValueUsd8(who, true);
    if (v == 0) return 0;
    return oracle.usd8ToUsdg(v.mulDiv(_ltv(who), BPS), Math.Rounding.Floor);
  }

  /// @notice 1e18 = liquidation boundary; type(uint256).max with no debt.
  function healthFactor(address who) public view returns (uint256) {
    uint256 debt = debtOf(who);
    if (debt == 0) return type(uint256).max;
    uint256 debtUsd8 = oracle.usdgToUsd8(debt, Math.Rounding.Ceil);
    return collateralValueUsd8(who, false).mulDiv(uint256(liquidationLtvBps) * 1e18, BPS * debtUsd8);
  }

  /// @notice Price of `v`'s asset (USD, 8 decimals) at which the health factor reaches 1, other
  /// collateral and the vault's USDG part held constant. 0 when no debt or no asset in `v`.
  function liquidationPriceUsd8(address who, NorenDepositVault v) external view returns (uint256) {
    uint256 debt = debtOf(who);
    uint256 shares = lockedShares[who][address(v)];
    if (debt == 0 || shares == 0) return 0;
    (uint256 a, uint256 u) = v.inKind(shares);
    if (a == 0) return 0;
    uint256 needUsd8 = oracle.usdgToUsd8(debt, Math.Rounding.Ceil).mulDiv(BPS, liquidationLtvBps, Math.Rounding.Ceil);
    uint256 other = collateralValueUsd8(who, false) - v.sharesValueUsd8(shares, false);
    other += u == 0 ? 0 : oracle.usdgToUsd8(u, Math.Rounding.Floor);
    if (other >= needUsd8) return 0;
    address asset = v.asset();
    uint256 dec = IERC20Metadata(asset).decimals();
    // assetValueUsd8 = a * mult / 1e18 * price8 / 10^dec  =>  price8 = need * 10^dec * 1e18 / (a * mult)
    return (needUsd8 - other).mulDiv(10 ** dec * 1e18, a * oracle.multiplier(asset), Math.Rounding.Ceil);
  }

  /// @notice Deposit value (wallet + locked shares, Chainlink, haircut) x `ltvBps`, in USDG. Used by
  /// NorenReputation.creditLimitOf.
  function securedCapacityUsdg(address who, uint16 ltvBps) external view returns (uint256) {
    uint256 v;
    for (uint256 i; i < _vaults.length; ++i) {
      NorenDepositVault vault = _vaults[i];
      uint256 s = lockedShares[who][address(vault)] + vault.balanceOf(who);
      if (s != 0 && oracle.isSupported(vault.asset())) v += vault.sharesValueUsd8(s, true);
    }
    uint16 ltv = ltvBps > MAX_LTV_BPS ? MAX_LTV_BPS : ltvBps;
    return v == 0 ? 0 : oracle.usd8ToUsdg(v.mulDiv(ltv, BPS), Math.Rounding.Floor);
  }

  function ltvOf(address who) external view returns (uint16) {
    return uint16(_ltv(who));
  }

  // ================================================================ internal

  function _ltv(address who) internal view returns (uint256) {
    uint256 ltv = reputation.ltvOf(who);
    return ltv > MAX_LTV_BPS ? MAX_LTV_BPS : ltv;
  }

  function _requireVault(NorenDepositVault v) internal view {
    if (!isVault[address(v)]) revert NotVault(address(v));
  }

  function _accrue() internal {
    uint256 idx = currentIndex();
    borrowIndex = idx;
    lastAccrual = uint64(block.timestamp);
  }

  /// @dev Applies `paid` (<= debt): interest first, then principal. Returns the interest part.
  function _reduceDebt(address who, uint256 paid, uint256 debt) internal returns (uint256 interest) {
    Account storage a = _accounts[who];
    uint256 accrued = debt > a.principal ? debt - a.principal : 0;
    interest = Math.min(paid, accrued);
    uint256 principalPart = paid - interest;
    if (principalPart > a.principal) principalPart = a.principal;
    a.principal -= principalPart;
    totalPrincipal -= principalPart;
    interestPaidUsdg += interest;
    uint256 scaled = paid == debt ? a.scaledDebt : Math.min(a.scaledDebt, paid.mulDiv(RAY, borrowIndex));
    a.scaledDebt -= scaled;
    totalScaledDebt -= scaled;
    if (a.scaledDebt == 0 && a.principal != 0) {
      totalPrincipal -= a.principal;
      a.principal = 0;
    }
  }

  /// @dev Move the yield earned on `who`'s locked `v` shares since the last settlement into pending.
  function _settleYield(address who, NorenDepositVault v) internal {
    uint256 acc = v.feesPerShare();
    uint256 locked = lockedShares[who][address(v)];
    if (locked != 0) {
      _pendingYield[who][address(v)] += locked.mulDiv(acc - feeIndexOf[who][address(v)], ACC);
    } else if (_pendingYield[who][address(v)] == 0) {
      (, uint256 f,) = v.feeBook();
      fillMarkOf[who][address(v)] = f;
    }
    feeIndexOf[who][address(v)] = acc;
  }

  /// @dev Take `take` USDG of yield out of `who`'s locked `v` shares. Returns the USDG received and
  /// the shares redeemed (never more than the position's locked shares).
  function _harvest(address who, NorenDepositVault v, uint256 take) internal returns (uint256 got, uint256 shares) {
    shares = v.sharesForUsdg(take);
    uint256 locked = lockedShares[who][address(v)];
    if (shares > locked) revert InsufficientLocked(shares, locked);
    lockedShares[who][address(v)] = locked - shares;
    if (usdg.balanceOf(address(v)) >= take) {
      uint256 burned = v.harvestUsdg(take, address(this), address(this));
      if (burned != shares) revert BadConfig();
      return (take, shares);
    }
    (uint256 a, uint256 u) = v.redeemInKind(shares, address(this), address(this));
    got = u;
    if (a != 0) {
      INorenLiquidity l = liquidity;
      if (address(l) == address(0)) revert NoLiquidity();
      address asset = v.asset();
      uint256 minOut = oracle.usd8ToUsdg(oracle.valueUsd8(asset, a).mulDiv(BPS - HARVEST_MAX_SLIPPAGE_BPS, BPS), Math.Rounding.Ceil);
      IERC20(asset).forceApprove(address(l), a);
      (uint256 out,) = l.sellExactAsset(asset, a, minOut, address(this));
      IERC20(asset).forceApprove(address(l), 0);
      got += out;
    }
  }

  function _closeLoan(address who) internal {
    Account storage a = _accounts[who];
    bool counts = a.peakPrincipal >= minMilestonePrincipal && block.timestamp >= uint256(a.openedAt) + minMilestoneAge;
    if (counts) a.repaidLoans += 1;
    emit LoanRepaid(who, a.peakPrincipal, counts);
    a.peakPrincipal = 0;
    a.openedAt = 0;
  }

  function _writeOff(address who, uint256 amount) internal {
    Account storage a = _accounts[who];
    totalScaledDebt -= a.scaledDebt;
    totalPrincipal -= a.principal;
    a.scaledDebt = 0;
    a.principal = 0;
    a.peakPrincipal = 0;
    a.openedAt = 0;
    badDebtUsdg += amount;
  }

  function _hasCollateral(address who) internal view returns (bool) {
    for (uint256 i; i < _vaults.length; ++i) {
      if (lockedShares[who][address(_vaults[i])] != 0) return true;
    }
    return false;
  }

  /// @dev Push tokens; if the token refuses (blocklist, pause) credit them for claim() instead.
  function _sendOrCredit(address asset, address to, uint256 amount) internal {
    (bool ok, bytes memory ret) = asset.call(abi.encodeCall(IERC20.transfer, (to, amount)));
    if (ok && (ret.length == 0 || abi.decode(ret, (bool))) && asset.code.length != 0) return;
    claimable[to][asset] += amount;
    emit CollateralCredited(to, asset, amount);
  }
}
