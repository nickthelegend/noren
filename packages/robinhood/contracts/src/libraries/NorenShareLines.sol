// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {SafeERC20} from '@oz/token/ERC20/utils/SafeERC20.sol';
import {Math} from '@oz/utils/math/Math.sol';
import {NorenAssetOracle} from '../NorenAssetOracle.sol';
import {INorenLiquidity} from '../interfaces/IAquaSwapVM.sol';

/// @notice The parts of a NorenDepositVault (nETH, nNVDA, ...) that a share-backed credit line uses.
interface INorenShareVault {
  function asset() external view returns (address);
  function sharesValueUsd8(uint256 shares, bool risk) external view returns (uint256);
  function sharesForUsdg(uint256 usdgAmount) external view returns (uint256);
  function feesPerShare() external view returns (uint256);
  function redeemInKind(uint256 shares, address receiver, address owner_) external returns (uint256 assets, uint256 usdgOut);
  function harvestUsdg(uint256 usdgAmount, address receiver, address owner_) external returns (uint256 shares);
}

/// @notice NorenCredit's own getters, read back by the library while it runs as NorenCredit.
interface INorenCreditCtx {
  function oracle() external view returns (NorenAssetOracle);
  function usdg() external view returns (IERC20);
  function vault() external view returns (address);
  function liquidity() external view returns (INorenLiquidity);
  function params() external view returns (uint32, uint32, uint16, uint16 liquidationBonusBps, uint16, uint32, uint32);
  function minCollateralRatioBps() external view returns (uint16);
}

interface INorenVaultDisburse {
  function disburse(address to, uint256 amountUsdg) external;
}

/// @title NorenShareLines
/// @notice NorenCredit's Arc credit lines backed by Noren deposit-vault shares (nNVDA, nETH, ...):
/// liquidation through Aqua makers and the yield harvest. Linked as an external library, so it runs
/// with NorenCredit's storage, balance and msg.sender (delegatecall) and keeps NorenCredit under the
/// EIP-170 size limit. Every caller check and state transition stays in NorenCredit.
library NorenShareLines {
  using SafeERC20 for IERC20;
  using Math for uint256;

  uint256 internal constant BPS = 10_000;
  /// @dev Fee-per-share scale of NorenDepositVault.feesPerShare (USDG x 1e36 per share).
  uint256 internal constant ACC = 1e36;
  /// @dev Extra value redeemed for a liquidation above debt + bonus, so the maker's bid spread cannot
  /// leave the sale short. What is not sold goes back to the borrower in the vault's asset.
  uint256 internal constant SALE_BUFFER_BPS = 500;
  /// @dev Worst price a harvest accepts when it must sell the asset part (as NorenBorrow).
  uint256 internal constant HARVEST_MAX_SLIPPAGE_BPS = 300;

  struct Ctx {
    NorenAssetOracle oracle;
    IERC20 usdg;
    address lender; // NorenVault: receives liquidation proceeds and harvested yield
    INorenLiquidity liquidity;
    uint16 bonusBps;
  }

  /// @notice Per-line yield state. `paidUsdc6` is the Arc debt repaid on Robinhood from yield.
  struct Yield {
    uint256 feeIndex;
    uint256 pending;
    uint256 paidUsdc6;
    uint256 paidUsdg;
  }

  /// @dev Same signature as NorenCredit's event (emitted from NorenCredit's address via delegatecall).
  event CollateralCredited(address indexed account, address indexed asset, uint256 amount);

  /// @dev Same signatures as NorenCredit's events and errors (emitted from NorenCredit via delegatecall).
  event LineYieldRepaid(
    bytes32 indexed lineId, address indexed caller, uint256 paidUsdg, uint256 creditUsdc6, uint256 shares, uint256 outstandingUsdc6
  );
  event LineYieldClaimed(bytes32 indexed lineId, address indexed borrower, uint256 yieldUsdg, uint256 shares);
  event LineYieldRefunded(bytes32 indexed lineId, address indexed borrower, uint256 usdg);
  event CollateralSoldToMakers(
    bytes32 indexed positionId, address indexed collateral, uint256 sold, uint256 bonus, uint256 returned, uint256 proceedsUsdg
  );

  error NoLiquidity();
  error NoYield();
  error InsufficientCollateral(uint256 valueUsd8, uint256 requiredUsd8);

  /// @notice One entry point for NorenCredit (fewer call sites keep NorenCredit under EIP-170):
  /// `outUsdc6` != 0 repays that much Arc debt from the yield (`harvest`), 0 pays the yield to the
  /// borrower (`claim`, the shares left must back the line's limit at minCollateralRatioBps).
  function yieldAction(
    Yield storage y,
    INorenShareVault v,
    uint256 lineShares,
    uint256 outUsdc6,
    uint256 limitUsdc6,
    bytes32 lineId
  ) public returns (uint256 shares) {
    if (outUsdc6 != 0) return harvest(y, v, lineShares, outUsdc6, lineId);
    uint256 req = (limitUsdc6 * 100).mulDiv(INorenCreditCtx(address(this)).minCollateralRatioBps(), BPS, Math.Rounding.Ceil);
    (, shares) = claim(y, v, lineShares, req, lineId);
  }

  /// @notice NorenCredit.harvestLineToRepay after its checks: settle the yield, pay up to the line's
  /// outstanding `outUsdc6` from it to the lender, book the credit, and refuse a lower collateral
  /// ratio. Returns the shares that left the line.
  function harvest(Yield storage y, INorenShareVault v, uint256 lineShares, uint256 outUsdc6, bytes32 lineId)
    internal
    returns (uint256 shares)
  {
    Ctx memory c = _ctx();
    settle(y, v, lineShares);
    uint256 take = Math.min(y.pending, c.oracle.usd8ToUsdg(outUsdc6 * 100, Math.Rounding.Ceil));
    if (take == 0) revert NoYield();
    uint256 v0 = v.sharesValueUsd8(lineShares, false);
    uint256 got;
    (got, shares) = takeYield(c, v, lineShares, take, c.lender, true);
    y.pending -= take;
    uint256 credit = Math.min(c.oracle.usdgToUsd8(got, Math.Rounding.Floor) / 100, outUsdc6);
    if (credit == 0) revert NoYield();
    y.paidUsdc6 += credit;
    y.paidUsdg += got;
    uint256 left = outUsdc6 - credit;
    uint256 v1 = v.sharesValueUsd8(lineShares - shares, false);
    if (left != 0 && v1 * outUsdc6 < v0 * left) revert InsufficientCollateral(v1, v0.mulDiv(left, outUsdc6));
    emit LineYieldRepaid(lineId, msg.sender, got, credit, shares, left);
  }

  /// @notice NorenCredit.claimLineYield after its checks: pay the whole unharvested yield to the
  /// caller (the borrower); the shares left must be worth at least `requiredUsd8`.
  function claim(Yield storage y, INorenShareVault v, uint256 lineShares, uint256 requiredUsd8, bytes32 lineId)
    internal
    returns (uint256 yieldUsdg, uint256 shares)
  {
    Ctx memory c = _ctx();
    settle(y, v, lineShares);
    yieldUsdg = y.pending;
    if (yieldUsdg == 0) revert NoYield();
    (, shares) = takeYield(c, v, lineShares, yieldUsdg, msg.sender, false);
    y.pending = 0;
    uint256 val = v.sharesValueUsd8(lineShares - shares, false);
    if (val < requiredUsd8) revert InsufficientCollateral(val, requiredUsd8);
    emit LineYieldClaimed(lineId, msg.sender, yieldUsdg, shares);
  }

  /// @notice Move the yield the line's `shares` earned since the last settlement into `pending`.
  function settle(Yield storage y, INorenShareVault v, uint256 shares) internal {
    uint256 acc = v.feesPerShare();
    if (acc > y.feeIndex) y.pending += shares.mulDiv(acc - y.feeIndex, ACC);
    y.feeIndex = acc;
  }

  /// @notice Yield not yet harvested or claimed (USDG, 6 decimals).
  function pendingYield(Yield storage y, INorenShareVault v, uint256 shares) internal view returns (uint256) {
    uint256 acc = v.feesPerShare();
    return y.pending + (acc > y.feeIndex ? shares.mulDiv(acc - y.feeIndex, ACC) : 0);
  }

  /// @notice Liquidate a share-backed line: redeem only the shares worth the debt plus the bonus
  /// (plus SALE_BUFFER_BPS), repay from their USDG first, sell their asset part to the best Aqua maker
  /// for the rest, and return everything else (unredeemed shares, unsold asset, USDG above the debt)
  /// to the borrower. Returns the USDG paid to the lender, the shares redeemed and the shortfall.
  function liquidate(
    mapping(address => mapping(address => uint256)) storage claimable,
    INorenShareVault v,
    uint256 shares,
    uint256 debtUsdg,
    address borrower,
    bytes32 lineId
  ) public returns (uint256 proceeds, uint256 redeemed, uint256 bad) {
    Ctx memory c = _ctx();
    uint256 valueUsd8 = v.sharesValueUsd8(shares, false);
    uint256 needUsd8 = c.oracle.usdgToUsd8(debtUsdg, Math.Rounding.Ceil).mulDiv(BPS + c.bonusBps + SALE_BUFFER_BPS, BPS);
    redeemed = needUsd8 >= valueUsd8 ? shares : shares.mulDiv(needUsd8, valueUsd8, Math.Rounding.Ceil);
    (uint256 a, uint256 u) = v.redeemInKind(redeemed, address(this), address(this));
    address asset = v.asset();

    uint256 fromUsdg = Math.min(u, debtUsdg);
    if (fromUsdg != 0) c.usdg.safeTransfer(c.lender, fromUsdg);
    if (u > fromUsdg) _sendOrCredit(claimable, address(c.usdg), borrower, u - fromUsdg);
    uint256 left = debtUsdg - fromUsdg;
    uint256 sold;
    uint256 bonus;
    uint256 got;
    if (left != 0 && a != 0) {
      if (address(c.liquidity) == address(0)) revert NoLiquidity();
      IERC20(asset).forceApprove(address(c.liquidity), a);
      uint256 excess;
      (got, sold, bonus, excess) = c.liquidity.liquidate(asset, a, left, c.bonusBps, c.lender, msg.sender);
      IERC20(asset).forceApprove(address(c.liquidity), 0);
      if (excess != 0) _sendOrCredit(claimable, address(c.usdg), borrower, excess);
    }
    if (a > sold + bonus) _sendOrCredit(claimable, asset, borrower, a - sold - bonus);
    if (shares > redeemed) _sendOrCredit(claimable, address(v), borrower, shares - redeemed);
    proceeds = fromUsdg + got;
    bad = debtUsdg - proceeds;
    emit CollateralSoldToMakers(lineId, address(v), redeemed, bonus, shares - redeemed, proceeds);
  }

  /// @notice At settlement: return the yield payments that Arc repayments made unnecessary
  /// (`arcOutUsdc6` = Arc drawn - repaid) from the vault to the borrower.
  function refundOnSettle(Yield storage y, uint256 arcOutUsdc6, address borrower, bytes32 lineId) public {
    uint256 paid = y.paidUsdc6;
    if (paid <= arcOutUsdc6) return;
    uint256 refund = y.paidUsdg.mulDiv(paid - arcOutUsdc6, paid);
    if (refund == 0) return;
    INorenVaultDisburse(INorenCreditCtx(address(this)).vault()).disburse(borrower, refund);
    emit LineYieldRefunded(lineId, borrower, refund);
  }

  function _ctx() private view returns (Ctx memory c) {
    INorenCreditCtx self = INorenCreditCtx(address(this));
    (,,, uint16 bonus,,,) = self.params();
    c = Ctx(self.oracle(), self.usdg(), self.vault(), self.liquidity(), bonus);
  }

  /// @notice Take `take` USDG of yield out of the line's shares and send it to `to`. When the vault
  /// holds the USDG it is paid straight out (`harvestUsdg`, shares worth exactly `take` at Chainlink,
  /// rounded up); otherwise those shares are redeemed in kind and, if `sell`, their asset part is sold
  /// to the best Aqua maker within HARVEST_MAX_SLIPPAGE_BPS of Chainlink (else it goes to `to` as is).
  /// Returns the USDG delivered to `to` and the shares that left the line.
  function takeYield(
    Ctx memory c,
    INorenShareVault v,
    uint256 lineShares,
    uint256 take,
    address to,
    bool sell
  ) internal returns (uint256 got, uint256 shares) {
    shares = v.sharesForUsdg(take);
    if (shares > lineShares) shares = lineShares;
    if (c.usdg.balanceOf(address(v)) >= take && shares == v.sharesForUsdg(take)) {
      v.harvestUsdg(take, to, address(this));
      return (take, shares);
    }
    (uint256 a, uint256 u) = v.redeemInKind(shares, sell ? address(this) : to, address(this));
    if (!sell) return (u, shares);
    got = u;
    if (a != 0) {
      if (address(c.liquidity) == address(0)) revert NoLiquidity();
      address asset = v.asset();
      uint256 minOut =
        c.oracle.usd8ToUsdg(c.oracle.valueUsd8(asset, a).mulDiv(BPS - HARVEST_MAX_SLIPPAGE_BPS, BPS), Math.Rounding.Ceil);
      IERC20(asset).forceApprove(address(c.liquidity), a);
      (uint256 out,) = c.liquidity.sellExactAsset(asset, a, minOut, address(this));
      IERC20(asset).forceApprove(address(c.liquidity), 0);
      got += out;
    }
    if (got != 0) c.usdg.safeTransfer(to, got);
  }

  function _sendOrCredit(
    mapping(address => mapping(address => uint256)) storage claimable,
    address asset,
    address to,
    uint256 amount
  ) private {
    (bool ok, bytes memory ret) = asset.call(abi.encodeCall(IERC20.transfer, (to, amount)));
    if (ok && (ret.length == 0 || abi.decode(ret, (bool))) && asset.code.length != 0) return;
    claimable[to][asset] += amount;
    emit CollateralCredited(to, asset, amount);
  }
}
