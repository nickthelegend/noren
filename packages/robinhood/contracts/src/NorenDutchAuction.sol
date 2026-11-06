// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from '@oz/access/Ownable2Step.sol';
import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {SafeERC20} from '@oz/token/ERC20/utils/SafeERC20.sol';
import {Math} from '@oz/utils/math/Math.sol';
import {ReentrancyGuard} from '@oz/utils/ReentrancyGuard.sol';
import {NorenAssetOracle} from './NorenAssetOracle.sol';
import {NorenCredit} from './NorenCredit.sol';
import {IAqua, ISwapVMRouter} from './interfaces/IAquaSwapVM.sol';

/// @title NorenDutchAuction
/// @notice Partial Dutch-auction liquidations of Pay-in-3 plans through 1inch Aqua + SwapVM.
///
/// Makers ship a buy-only Aqua strategy whose program is Salt ‖ NorenDutchDecay ‖ NorenOraclePeg
/// (zero spread), built here. Its buy price for liquidated collateral is
///     Chainlink price x (1 - makerDiscount(t)),  makerDiscount = totalDiscount x (1 - keeperShare)
///     totalDiscount(t) = startBps + (capBps - startBps) x min(t - auctionStart, duration) / duration
/// The keeper's share of the discount is paid here in collateral, so a fill costs the borrower
/// totalDiscount(t) of the value sold, never more than capBps: the keeper bonus comes out of the
/// discount, not on top of it.
///
/// - `openAuction(planId)`: anyone, once the plan's health is below 1 (collateral below
///   liquidationThresholdBps of the debt) or two installments are missed (NorenCredit rules).
/// - `fill(planId, maxRepayUsdg)`: anyone (the keeper). Sells only enough collateral to the best
///   maker to bring the plan's health back to `targetHealthBps` (and to pay every missed
///   installment), never the whole position. The USDG goes straight to the lender pool. Repeated
///   fills are allowed while the plan is still liquidatable; the auction closes when it is not.
///   If the collateral cannot restore the target, it is all sold and any shortfall is bad debt.
/// - The remaining collateral stays locked in the borrower's plan.
///
/// Safety: the router only accepts this contract as taker on these strategies and reads the
/// auction start from `dutchAuctionStart` here; Chainlink staleness and the weekend window are
/// NorenAssetOracle's and NorenOraclePeg's rules; every fill checks that the maker paid no more
/// than the oracle value and no less than oracle x (1 - cap); a plan that is no longer
/// liquidatable cannot be filled; reentrancy is guarded; repayment rounds up and the keeper's
/// bonus rounds down.
///
/// MIT: this contract calls the SwapVM router and Aqua through their ABIs only (Pure Caller Use).
contract NorenDutchAuction is Ownable2Step, ReentrancyGuard {
  using SafeERC20 for IERC20;
  using Math for uint256;

  uint256 internal constant BPS = 10_000;
  uint256 internal constant WAD = 1e18;
  /// @dev SwapVM MakerTraits: useAquaInsteadOfSignature, receiver = maker, no hooks.
  uint256 public constant AQUA_TRAITS = 1 << 254;
  uint8 public constant OP_SALT = 20;
  uint16 internal constant ONE_SIDED = type(uint16).max;
  uint8 internal constant FLAG_UI_MULTIPLIER = 0x01;
  uint8 internal constant FLAG_MARKET_HOURS = 0x02;
  uint16 internal constant TAKER_EXACT_IN = 0x0001;
  uint16 internal constant TAKER_TRANSFER_FROM_AND_AQUA_PUSH = 0x0040;
  uint8 public constant MAX_STRATEGIES_PER_ASSET = 8;

  struct Auction {
    uint64 startedAt; // 0 = no open auction
    uint32 round; // auctions opened for this plan so far
    uint32 fills; // fills in the current round
    bool defaultRecorded; // NorenCredit history got this plan's default
  }

  struct Strategy {
    address maker;
    address asset;
    bool active;
    uint64 salt;
    uint32 fills;
    uint256 assetBought;
    uint256 usdgPaid;
    uint256 discountUsdg; // Chainlink value of the collateral bought minus the USDG paid
    bytes data;
  }

  struct Status {
    bool open;
    uint64 startedAt;
    uint256 elapsed;
    uint256 discountWad; // total discount now (borrower's cost per unit of value sold)
    uint256 makerDiscountWad;
    uint256 keeperDiscountWad;
    uint256 healthWad; // collateral value / (debt x threshold); < 1e18 = liquidatable
    uint256 targetHealthWad;
    bool overdue;
    bool liquidatable;
    uint32 round;
    uint32 fills;
    address collateral;
    uint256 collateralAmount;
    uint256 outstandingUsdg;
    uint256 priceUsd8;
    string error; // why health/price could not be read (e.g. stale feed); empty otherwise
  }

  struct Fill {
    bytes32 strategyHash;
    bool sellAll; // the health target is out of reach: all collateral is sold (exact-in)
    uint256 usdgOut; // USDG the maker pays
    uint256 repayUsdg; // part of usdgOut applied to the debt (to the lender pool)
    uint256 excessUsdg; // usdgOut above the debt (sell-all path only), back to the borrower
    uint256 collateralSold; // to the maker
    uint256 keeperBonus; // to the keeper, collateral: collateralSold x keeper's share of the discount
    uint256 discountWad;
    bool closesPlan; // nothing left outstanding, or no collateral left
    uint256 badDebtUsdg;
    uint256 healthAfterWad;
    uint256 collateralLeft;
    uint256 outstandingAfterUsdg;
  }

  NorenCredit public immutable credit;
  IAqua public immutable aqua;
  ISwapVMRouter public immutable router;
  NorenAssetOracle public immutable oracle;
  IERC20 public immutable usdg;
  address public immutable vault;
  uint8 public immutable decayOpcode;
  uint8 public immutable pegOpcode;

  uint16 public immutable startDiscountBps;
  uint16 public immutable capDiscountBps;
  uint32 public immutable duration;
  uint16 public immutable keeperShareBps;
  uint16 public immutable targetHealthBps;

  mapping(uint256 planId => Auction) internal _auctions;
  mapping(bytes32 strategyHash => Strategy) internal _strategies;
  mapping(address asset => bytes32[]) internal _byAsset;

  event AuctionOpened(uint256 indexed planId, address indexed borrower, address indexed opener, uint32 round, uint256 healthWad, bool overdue);
  event AuctionFilled(
    uint256 indexed planId,
    address indexed keeper,
    bytes32 indexed strategyHash,
    uint32 round,
    uint256 discountWad,
    uint256 collateralSold,
    uint256 keeperBonus,
    uint256 repaidUsdg,
    uint256 healthAfterWad
  );
  event AuctionClosed(uint256 indexed planId, uint32 round, bool planClosed);
  event StrategyRegistered(bytes32 indexed strategyHash, address indexed maker, address indexed asset, uint64 salt);
  event StrategyRemoved(bytes32 indexed strategyHash);

  error AuctionAlreadyOpen(uint256 planId);
  error AuctionNotOpen(uint256 planId);
  error NotLiquidatable(uint256 planId);
  error StillLiquidatable(uint256 planId);
  error PlanNotActive(uint256 planId);
  error NoMakerLiquidity(address asset, uint256 amount);
  error FillAboveOracle(uint256 paidUsd8, uint256 valueUsd8);
  error FillBelowCap(uint256 paidUsd8, uint256 floorUsd8);
  error FillMismatch(uint256 amountIn, uint256 amountOut);
  error NothingToFill(uint256 planId);
  error AssetNotSupported(address asset);
  error StrategyExists(bytes32 strategyHash);
  error StrategyNotShipped(bytes32 strategyHash);
  error TooManyStrategies(address asset);
  error UnknownStrategy(bytes32 strategyHash);
  error NotRemovable(bytes32 strategyHash);
  error BadConfig();

  constructor(
    address owner_,
    NorenCredit credit_,
    ISwapVMRouter router_,
    uint16 startBps,
    uint16 capBps,
    uint32 duration_,
    uint16 keeperShare,
    uint16 targetHealth
  ) Ownable(owner_) {
    (, , uint16 thresholdBps,,,,) = credit_.params();
    // The target must leave room for the sale's own cost: target x threshold > (1 + dk) / (1 - dm) at the cap.
    uint256 capW = uint256(capBps) * 1e14;
    uint256 dk = capW * keeperShare / BPS;
    uint256 c = (WAD + dk).mulDiv(WAD, WAD - (capW - dk), Math.Rounding.Ceil);
    if (
      startBps > capBps || capBps == 0 || capBps > 2_000 || duration_ == 0 || keeperShare > BPS || targetHealth < BPS
        || uint256(targetHealth) * thresholdBps * 1e10 <= c || router_.AQUA() == address(0)
    ) revert BadConfig();
    credit = credit_;
    router = router_;
    aqua = IAqua(router_.AQUA());
    oracle = credit_.oracle();
    usdg = credit_.usdg();
    vault = address(credit_.vault());
    decayOpcode = router_.NOREN_DUTCH_DECAY_OPCODE();
    pegOpcode = router_.NOREN_ORACLE_PEG_OPCODE();
    startDiscountBps = startBps;
    capDiscountBps = capBps;
    duration = duration_;
    keeperShareBps = keeperShare;
    targetHealthBps = targetHealth;
  }

  // ================================================================ makers

  /// @notice The canonical Dutch-auction Aqua order for `maker` buying `asset`, and its strategy
  /// hash. Ship it with aqua.ship(router, abi.encode(order), [USDG, asset], [usdgAmount, 0]).
  function buildOrder(address maker, address asset, uint64 salt) public view returns (ISwapVMRouter.Order memory o, bytes32 h) {
    address usdg_ = address(usdg);
    (address feed, uint32 ageOpen, uint32 ageClosed, bool marketHours, bool ui, bool enabled) = oracle.assetConfig(asset);
    if (!enabled || asset == usdg_) revert AssetNotSupported(asset);
    (address usdgFeed, uint32 usdgAge,,,,) = oracle.assetConfig(usdg_);
    bytes memory decay = abi.encodePacked(address(this), startDiscountBps, capDiscountBps, duration, keeperShareBps);
    // Zero spread, buy-only, no weekend extra: the auction discount is the maker's only discount.
    bytes memory peg = abi.encodePacked(
      abi.encodePacked(asset, usdg_, feed, usdgFeed),
      abi.encodePacked(ageOpen, ageClosed, usdgAge),
      abi.encodePacked(
        uint16(0), ONE_SIDED, uint16(0), oracle.usdgDepegBps(), uint8((ui ? FLAG_UI_MULTIPLIER : 0) | (marketHours ? FLAG_MARKET_HOURS : 0))
      ),
      abi.encodePacked(uint64(0), uint64(0))
    );
    bytes memory program = bytes.concat(
      abi.encodePacked(OP_SALT, uint8(8), salt),
      abi.encodePacked(decayOpcode, uint8(decay.length)),
      decay,
      abi.encodePacked(pegOpcode, uint8(peg.length)),
      peg
    );
    o = ISwapVMRouter.Order({maker: maker, traits: AQUA_TRAITS, data: program});
    h = keccak256(abi.encode(o));
  }

  /// @notice Register the caller's shipped Dutch strategy so auctions route fills to it.
  function register(address asset, uint64 salt) external returns (bytes32 h) {
    ISwapVMRouter.Order memory o;
    (o, h) = buildOrder(msg.sender, asset, salt);
    if (_strategies[h].active) revert StrategyExists(h);
    if (!_shipped(msg.sender, h, asset)) revert StrategyNotShipped(h);
    if (_byAsset[asset].length >= MAX_STRATEGIES_PER_ASSET) revert TooManyStrategies(asset);
    Strategy storage s = _strategies[h];
    s.maker = msg.sender;
    s.asset = asset;
    s.active = true;
    s.salt = salt;
    s.data = o.data;
    _byAsset[asset].push(h);
    emit StrategyRegistered(h, msg.sender, asset, salt);
  }

  /// @notice The maker may remove its strategy at any time; anyone may remove a docked one.
  function remove(bytes32 h) external {
    Strategy storage s = _strategies[h];
    if (!s.active) revert UnknownStrategy(h);
    if (msg.sender != s.maker && _shipped(s.maker, h, s.asset)) revert NotRemovable(h);
    s.active = false;
    bytes32[] storage list = _byAsset[s.asset];
    for (uint256 i; i < list.length; ++i) {
      if (list[i] == h) {
        list[i] = list[list.length - 1];
        list.pop();
        break;
      }
    }
    emit StrategyRemoved(h);
  }

  // ================================================================ auctions

  /// @notice Read by NorenDutchDecay inside the router: the open auction's start for
  /// auctionId = bytes32(planId), 0 when none is open.
  function dutchAuctionStart(bytes32 auctionId) external view returns (uint256) {
    return _auctions[uint256(auctionId)].startedAt;
  }

  /// @notice Open a Dutch auction for a liquidatable plan (anyone).
  function openAuction(uint256 planId) external nonReentrant {
    Auction storage a = _auctions[planId];
    if (a.startedAt != 0) revert AuctionAlreadyOpen(planId);
    NorenCredit.Plan memory p = credit.plan(planId);
    if (p.status != NorenCredit.PlanStatus.Active) revert PlanNotActive(planId);
    (bool overdue, bool under) = credit.planLiquidatable(planId);
    if (!overdue && !under) revert NotLiquidatable(planId);
    a.startedAt = uint64(block.timestamp);
    a.round += 1;
    a.fills = 0;
    emit AuctionOpened(planId, p.borrower, msg.sender, a.round, _health(p), overdue);
  }

  /// @notice Close an open auction whose plan is no longer liquidatable (anyone), e.g. after the
  /// borrower repaid or the price recovered.
  function closeAuction(uint256 planId) external nonReentrant {
    Auction storage a = _auctions[planId];
    if (a.startedAt == 0) revert AuctionNotOpen(planId);
    NorenCredit.Plan memory p = credit.plan(planId);
    if (p.status == NorenCredit.PlanStatus.Active) {
      (bool overdue, bool under) = credit.planLiquidatable(planId);
      if (overdue || under) revert StillLiquidatable(planId);
    }
    a.startedAt = 0;
    emit AuctionClosed(planId, a.round, p.status != NorenCredit.PlanStatus.Active);
  }

  /// @notice What `fill(planId, maxRepayUsdg)` would do now (reverts with the same errors).
  function previewFill(uint256 planId, uint256 maxRepayUsdg) public view returns (Fill memory f) {
    if (_auctions[planId].startedAt == 0) revert AuctionNotOpen(planId);
    NorenCredit.Plan memory p = credit.plan(planId);
    if (p.status != NorenCredit.PlanStatus.Active) revert PlanNotActive(planId);
    (bool overdue, bool under) = credit.planLiquidatable(planId);
    if (!overdue && !under) revert NotLiquidatable(planId);

    uint256 outstanding = p.principal - p.repaid;
    f.discountWad = discountWad(planId);
    uint256 dk = f.discountWad * keeperShareBps / BPS;
    uint256 dm = f.discountWad - dk;
    uint256 valueUsd8 = oracle.valueUsd8(p.collateral, p.collateralAmount);

    // Repayment R that restores health to the target after removing R x c of collateral value,
    // c = (1 + dk) / (1 - dm):  R = (target x threshold x debt - value) / (target x threshold - c).
    uint256 r = _healthRepayUsdg(outstanding, valueUsd8, dk, dm);
    if (overdue) {
      uint8 missed = credit.missedInstallments(planId);
      uint256 due = credit.cumulativeDue(planId, p.paid + missed);
      if (due > p.repaid && due - p.repaid > r) r = due - p.repaid;
    }
    if (r > outstanding) r = outstanding;
    if (r > maxRepayUsdg) r = maxRepayUsdg;
    if (r == 0) revert NothingToFill(planId);

    (f.strategyHash, f.collateralSold) = _bestQuoteForUsdg(planId, p.collateral, r);
    if (f.strategyHash != bytes32(0)) {
      // The keeper's bonus is its share of the discount on the collateral sold (rounded down), so the
      // borrower's whole cost is discount x value sold.
      f.keeperBonus = f.collateralSold.mulDiv(dk, WAD);
      if (f.collateralSold + f.keeperBonus <= p.collateralAmount) {
        f.usdgOut = r;
        f.repayUsdg = r;
      } else {
        f.strategyHash = bytes32(0);
      }
    }
    if (f.strategyHash == bytes32(0)) {
      // The target is out of reach (or no maker can pay R): sell all collateral, keeper share first.
      f.sellAll = true;
      f.keeperBonus = p.collateralAmount.mulDiv(dk, WAD + dk);
      f.collateralSold = p.collateralAmount - f.keeperBonus;
      (f.strategyHash, f.usdgOut) = _bestQuoteForAsset(planId, p.collateral, f.collateralSold);
      if (f.strategyHash == bytes32(0)) revert NoMakerLiquidity(p.collateral, f.collateralSold);
      f.repayUsdg = Math.min(f.usdgOut, outstanding);
      f.excessUsdg = f.usdgOut - f.repayUsdg;
      f.badDebtUsdg = outstanding - f.repayUsdg;
    }
    f.collateralLeft = p.collateralAmount - f.collateralSold - f.keeperBonus;
    f.outstandingAfterUsdg = outstanding - f.repayUsdg - f.badDebtUsdg;
    f.closesPlan = f.outstandingAfterUsdg == 0 || f.collateralLeft == 0;
    if (f.outstandingAfterUsdg != 0 && f.collateralLeft != 0) {
      uint256 debtUsd8 = oracle.usdgToUsd8(f.outstandingAfterUsdg, Math.Rounding.Ceil);
      f.healthAfterWad = oracle.valueUsd8(p.collateral, f.collateralLeft).mulDiv(BPS * WAD, debtUsd8 * _thresholdBps());
    } else {
      f.healthAfterWad = type(uint256).max;
    }
  }

  /// @notice Fill the open auction for `planId` (anyone; the caller is the keeper and receives the
  /// bonus in collateral). `maxRepayUsdg` caps this fill's repayment (type(uint256).max = as needed).
  function fill(uint256 planId, uint256 maxRepayUsdg) external nonReentrant returns (Fill memory f) {
    f = previewFill(planId, maxRepayUsdg);
    Auction storage a = _auctions[planId];
    NorenCredit.Plan memory p = credit.plan(planId);
    bool first = !a.defaultRecorded;
    a.defaultRecorded = true;
    a.fills += 1;

    // Collateral comes out of the plan and the repayment is booked in the same transaction as the sale.
    credit.auctionSeize(planId, f.collateralSold + f.keeperBonus, f.repayUsdg, first);
    _sell(f, p.collateral, f.sellAll ? address(this) : vault, bytes32(planId));
    if (f.sellAll) {
      usdg.safeTransfer(vault, f.repayUsdg);
      if (f.excessUsdg != 0) usdg.safeTransfer(p.borrower, f.excessUsdg);
    }
    if (f.keeperBonus != 0) IERC20(p.collateral).safeTransfer(msg.sender, f.keeperBonus);

    emit AuctionFilled(planId, msg.sender, f.strategyHash, a.round, f.discountWad, f.collateralSold, f.keeperBonus, f.repayUsdg, f.healthAfterWad);
    bool stillLiquidatable;
    if (!f.closesPlan) {
      (bool overdue, bool under) = credit.planLiquidatable(planId);
      stillLiquidatable = overdue || under;
    }
    if (!stillLiquidatable) {
      a.startedAt = 0;
      a.defaultRecorded = f.closesPlan; // a later auction on a reopened position records a new default
      emit AuctionClosed(planId, a.round, f.closesPlan);
    }
  }

  // ================================================================ views

  /// @notice Total auction discount now (1e18 = 100%), 0 when no auction is open.
  function discountWad(uint256 planId) public view returns (uint256) {
    uint256 s = _auctions[planId].startedAt;
    if (s == 0 || s > block.timestamp) return 0;
    uint256 t = Math.min(block.timestamp - s, duration);
    return uint256(startDiscountBps) * 1e14 + uint256(capDiscountBps - startDiscountBps) * 1e14 * t / duration;
  }

  /// @notice Plan health (1e18 = liquidation boundary): collateral value / (debt x threshold).
  function healthOf(uint256 planId) external view returns (uint256) {
    return _health(credit.plan(planId));
  }

  function auction(uint256 planId) external view returns (Auction memory) {
    return _auctions[planId];
  }

  /// @notice Everything the app shows for a plan's auction. Health is left at 0 with `error` set
  /// when the oracle refuses (stale feed, paused token).
  function auctionStatus(uint256 planId) external view returns (Status memory s) {
    Auction memory a = _auctions[planId];
    NorenCredit.Plan memory p = credit.plan(planId);
    s.open = a.startedAt != 0;
    s.startedAt = a.startedAt;
    s.elapsed = s.open && block.timestamp > a.startedAt ? block.timestamp - a.startedAt : 0;
    s.discountWad = discountWad(planId);
    s.keeperDiscountWad = s.discountWad * keeperShareBps / BPS;
    s.makerDiscountWad = s.discountWad - s.keeperDiscountWad;
    s.targetHealthWad = uint256(targetHealthBps) * 1e14;
    s.round = a.round;
    s.fills = a.fills;
    s.collateral = p.collateral;
    s.collateralAmount = p.collateralAmount;
    s.outstandingUsdg = p.status == NorenCredit.PlanStatus.Active ? p.principal - p.repaid : 0;
    if (p.status != NorenCredit.PlanStatus.Active) return s;
    try this.healthOf(planId) returns (uint256 h) {
      s.healthWad = h;
      s.priceUsd8 = oracle.price(p.collateral).usd8;
      (s.overdue,) = credit.planLiquidatable(planId);
      s.liquidatable = s.overdue || h < WAD;
    } catch Error(string memory reason) {
      s.error = reason;
    } catch (bytes memory reason) {
      s.error = reason.length >= 4 ? 'oracle refused (stale feed, closed market or paused token)' : 'oracle refused';
    }
  }

  function strategy(bytes32 h) external view returns (Strategy memory) {
    return _strategies[h];
  }

  function strategiesFor(address asset) external view returns (bytes32[] memory) {
    return _byAsset[asset];
  }

  function order(bytes32 h) public view returns (ISwapVMRouter.Order memory) {
    Strategy storage s = _strategies[h];
    if (s.maker == address(0)) revert UnknownStrategy(h);
    return ISwapVMRouter.Order({maker: s.maker, traits: AQUA_TRAITS, data: s.data});
  }

  // ================================================================ internal

  function _thresholdBps() internal view returns (uint256 t) {
    (, , uint16 th,,,,) = credit.params();
    t = th;
  }

  function _health(NorenCredit.Plan memory p) internal view returns (uint256) {
    uint256 outstanding = p.principal - p.repaid;
    if (p.status != NorenCredit.PlanStatus.Active || outstanding == 0) return type(uint256).max;
    uint256 debtUsd8 = oracle.usdgToUsd8(outstanding, Math.Rounding.Ceil);
    return oracle.valueUsd8(p.collateral, p.collateralAmount).mulDiv(BPS * WAD, debtUsd8 * _thresholdBps());
  }

  /// @dev USDG to repay so that health = target after the sale (0 if already at or above it), rounded up.
  function _healthRepayUsdg(uint256 outstanding, uint256 valueUsd8, uint256 dk, uint256 dm) internal view returns (uint256) {
    uint256 k = uint256(targetHealthBps) * _thresholdBps() * 1e10; // target x threshold, WAD
    uint256 c = (WAD + dk).mulDiv(WAD, WAD - dm, Math.Rounding.Ceil);
    // +2: valueUsd8 floors to 1e-8 USD, so the remaining collateral can read up to that much lower
    // than the analytic value; aiming 2e-8 USD higher keeps health at or just above the target.
    uint256 needUsd8 = oracle.usdgToUsd8(outstanding, Math.Rounding.Ceil).mulDiv(k, WAD, Math.Rounding.Ceil) + 2;
    if (needUsd8 <= valueUsd8) return 0;
    uint256 rUsd8 = (needUsd8 - valueUsd8).mulDiv(WAD, k - c, Math.Rounding.Ceil);
    return oracle.usd8ToUsdg(rUsd8, Math.Rounding.Ceil);
  }

  /// @dev Exact-out (exactly R USDG) on the normal path; exact-in (all collateral) on the sell-all path.
  function _sell(Fill memory f, address asset, address to, bytes32 auctionId) internal {
    Strategy storage s = _strategies[f.strategyHash];
    bool exactIn = f.sellAll;
    IERC20(asset).forceApprove(address(router), f.collateralSold);
    (uint256 ain, uint256 aout,) = router.swap(
      order(f.strategyHash),
      asset,
      address(usdg),
      exactIn ? f.collateralSold : f.usdgOut,
      _takerData(exactIn, exactIn ? f.usdgOut : f.collateralSold, to, auctionId)
    );
    if (ain != f.collateralSold || aout != f.usdgOut) revert FillMismatch(ain, aout);
    IERC20(asset).forceApprove(address(router), 0);
    // No fill above the oracle price, none below oracle x (1 - cap).
    uint256 valueUsd8 = oracle.valueUsd8(asset, ain);
    uint256 paidUsd8 = oracle.usdgToUsd8(aout, Math.Rounding.Floor);
    if (paidUsd8 > valueUsd8) revert FillAboveOracle(paidUsd8, valueUsd8);
    uint256 floorUsd8 = valueUsd8.mulDiv(BPS - capDiscountBps, BPS);
    if (paidUsd8 < floorUsd8) revert FillBelowCap(paidUsd8, floorUsd8);
    s.fills += 1;
    s.assetBought += ain;
    s.usdgPaid += aout;
    s.discountUsdg += oracle.usd8ToUsdg(valueUsd8 - paidUsd8, Math.Rounding.Floor);
  }

  /// @dev Lowest collateral-in among registered strategies for exactly `usdgOut`.
  function _bestQuoteForUsdg(uint256 planId, address asset, uint256 usdgOut) internal view returns (bytes32 best, uint256 assetIn) {
    bytes32[] storage list = _byAsset[asset];
    bytes memory td = _takerData(false, type(uint256).max, address(0), bytes32(planId));
    for (uint256 i; i < list.length; ++i) {
      try router.quote(order(list[i]), asset, address(usdg), usdgOut, td) returns (uint256 ain, uint256 aout, bytes32) {
        if (aout == usdgOut && ain != 0 && (best == bytes32(0) || ain < assetIn)) {
          best = list[i];
          assetIn = ain;
        }
      } catch {}
    }
  }

  /// @dev Highest USDG-out among registered strategies for exactly `assetIn`.
  function _bestQuoteForAsset(uint256 planId, address asset, uint256 assetIn) internal view returns (bytes32 best, uint256 usdgOut) {
    bytes32[] storage list = _byAsset[asset];
    bytes memory td = _takerData(true, 0, address(0), bytes32(planId));
    for (uint256 i; i < list.length; ++i) {
      try router.quote(order(list[i]), asset, address(usdg), assetIn, td) returns (uint256 ain, uint256 aout, bytes32) {
        if (ain == assetIn && aout > usdgOut) {
          best = list[i];
          usdgOut = aout;
        }
      } catch {}
    }
  }

  function _shipped(address maker, bytes32 h, address asset) internal view returns (bool) {
    try aqua.safeBalances(maker, address(router), h, address(usdg), asset) returns (uint256, uint256) {
      return true;
    } catch {
      return false;
    }
  }

  /// @dev SwapVM TakerTraits: slice index table, flags, threshold (32 bytes), optional recipient,
  /// then the instruction args (the auction id NorenDutchDecay reads). No hooks or signature.
  function _takerData(bool exactIn, uint256 threshold, address to, bytes32 auctionId) internal view returns (bytes memory) {
    bool hasTo = to != address(0) && to != address(this);
    uint160 end = hasTo ? 52 : 32;
    uint160 idx = 32 | (end << 16);
    for (uint256 k = 2; k < 9; ++k) idx |= end << uint160(16 * k);
    idx |= (end + 32) << 144; // InstructionsArgs slice: 32 bytes
    uint16 flags = TAKER_TRANSFER_FROM_AND_AQUA_PUSH | (exactIn ? TAKER_EXACT_IN : 0);
    return abi.encodePacked(idx, flags, threshold, hasTo ? abi.encodePacked(to) : bytes(''), auctionId);
  }
}
