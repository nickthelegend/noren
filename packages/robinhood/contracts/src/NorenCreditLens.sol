// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from '@oz/utils/math/Math.sol';
import {NorenCredit, INorenReputationLtv} from './NorenCredit.sol';
import {NorenAssetOracle} from './NorenAssetOracle.sol';
import {INorenShareVault} from './libraries/NorenShareLines.sol';

/// @title NorenCreditLens
/// @notice Read-only views over NorenCredit for the Noren app (kept out of NorenCredit, which sits at
/// the EIP-170 size limit): the largest credit line a collateral amount allows at the borrower's tier,
/// and the live yield of a share-backed line.
contract NorenCreditLens {
  using Math for uint256;

  uint256 internal constant BPS = 10_000;
  uint256 internal constant ACC = 1e36;
  uint256 internal constant USDC6_TO_USD8 = 100;

  NorenCredit public immutable credit;

  error CollateralNotAccepted(address asset);

  constructor(NorenCredit credit_) {
    credit = credit_;
  }

  /// @notice The largest line `borrower` can open with `amount` of `collateral` (a Stock Token, WETH
  /// via address(0), or accepted deposit-vault shares such as nNVDA): the collateral's risk value
  /// (closed-market haircut included) times the tier's LTV = 1 / collateral ratio, capped by the
  /// borrower's available credit. When NorenCredit has a NorenReputation set, the LTV is also capped by
  /// the borrower's reputation tier, so the limit rises with collateral and with recorded attestations.
  /// Same arithmetic as NorenCredit.openCreditLine's check, so a line
  /// opened at exactly `limitUsdc6` passes. E.g. $100 of nNVDA at the 125% floor: up to $80.
  function maxCreditLimit(address borrower, address collateral, uint256 amount)
    external
    view
    returns (uint256 limitUsdc6, uint256 valueUsd8, uint16 ltvBps)
  {
    address c = collateral == address(0) ? address(credit.weth()) : collateral;
    uint8 status = credit.shareVaultStatus(c);
    if (status != 0) {
      if (status != 1) revert CollateralNotAccepted(collateral);
      valueUsd8 = INorenShareVault(c).sharesValueUsd8(amount, true);
    } else {
      NorenAssetOracle o = credit.oracle();
      if (c == address(credit.usdg()) || !o.isSupported(c)) revert CollateralNotAccepted(collateral);
      valueUsd8 = o.riskValueUsd8(c, amount);
    }
    (,, uint16 ratioBps, uint256 available) = credit.creditTerms(borrower);
    if (ratioBps == 0) return (0, valueUsd8, 0);
    // NorenCredit.openCreditLine caps the LTV at the on-chain reputation tier's (66 -> 70 -> 75 -> 80%).
    INorenReputationLtv rep = credit.reputation();
    if (address(rep) != address(0)) ratioBps = uint16(Math.max(ratioBps, (BPS * BPS).ceilDiv(rep.ltvOf(borrower))));
    ltvBps = uint16(BPS * BPS / ratioBps);
    limitUsdc6 = Math.min(valueUsd8.mulDiv(BPS, uint256(ratioBps) * USDC6_TO_USD8), available);
  }

  /// @notice A share-backed line's yield now: unharvested (USDG, 6 decimals), and what yield already
  /// repaid on Robinhood (Arc USDC credited, USDG paid to the vault).
  function lineYield(bytes32 lineId) external view returns (uint256 pendingUsdg, uint256 paidUsdc6, uint256 paidUsdg) {
    NorenCredit.Line memory l = credit.line(lineId);
    (uint256 feeIndex, uint256 pending, uint256 paid6, uint256 paidG) = credit.lineYieldState(lineId);
    pendingUsdg = pending;
    if (credit.shareVaultStatus(l.collateral) != 0 && l.collateralAmount != 0) {
      uint256 acc = INorenShareVault(l.collateral).feesPerShare();
      if (acc > feeIndex) pendingUsdg += l.collateralAmount.mulDiv(acc - feeIndex, ACC);
    }
    return (pendingUsdg, paid6, paidG);
  }
}
