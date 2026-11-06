// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IReceiver, IERC165} from '../interfaces/IReceiver.sol';

/// DEV_ONLY: fork-only test harness; scripts/deploy-public.sh refuses any step that deploys it.
/// @title NorenCreditHarness (TEST HARNESS, not the product contract)
/// @notice Stand-in for packages/robinhood NorenCredit on Robinhood Chain, used by
///         packages/cre-bridge/scripts/fork-simulate.sh with NOREN_BRIDGE_RECEIVER=harness when the
///         real contract is not available. It emits the identical CreditLineOpened and
///         CreditLineClosed events from the fixed interface and accepts the identical onReport
///         payload with the same forwarder-only, stale and future checks. It holds no collateral,
///         prices nothing and must never be deployed outside a local fork.
contract NorenCreditHarness is IReceiver {
  struct Utilisation {
    uint256 drawn;
    uint256 repaid;
    uint64 asOf;
  }

  address public immutable forwarder;
  uint64 public constant REPORT_SKEW = 300;
  mapping(bytes32 => address) public borrowerOf;
  mapping(bytes32 => Utilisation) public utilisation;

  event CreditLineOpened(address indexed borrower, bytes32 indexed lineId, uint256 limitUsdc6, uint64 expiry, uint256 collateralValueUsd8);
  event CreditLineClosed(bytes32 indexed lineId);
  event ArcUtilisationUpdated(bytes32 indexed lineId, uint256 drawnUsdc6, uint256 repaidUsdc6, uint64 asOf);

  error NotForwarder(address caller);
  error UnknownLine(bytes32 lineId);
  error StaleReport(uint64 asOf, uint64 last);
  error FutureReport(uint64 asOf);

  constructor(address forwarder_) {
    forwarder = forwarder_;
  }

  /// @notice Harness only: emit CreditLineOpened exactly as NorenCredit.openCreditLine does.
  function emitOpened(bytes32 lineId, uint256 limitUsdc6, uint64 expiry, uint256 collateralValueUsd8) external {
    borrowerOf[lineId] = msg.sender;
    emit CreditLineOpened(msg.sender, lineId, limitUsdc6, expiry, collateralValueUsd8);
  }

  /// @notice Harness only: emit CreditLineClosed exactly as NorenCredit.closeCreditLine does.
  function emitClosed(bytes32 lineId) external {
    if (borrowerOf[lineId] != msg.sender) revert UnknownLine(lineId);
    emit CreditLineClosed(lineId);
  }

  function onReport(bytes calldata, bytes calldata report) external override {
    if (msg.sender != forwarder) revert NotForwarder(msg.sender);
    (bytes32 lineId, uint256 drawn, uint256 repaid, uint64 asOf) = abi.decode(report, (bytes32, uint256, uint256, uint64));
    if (borrowerOf[lineId] == address(0)) revert UnknownLine(lineId);
    Utilisation storage u = utilisation[lineId];
    if (asOf <= u.asOf) revert StaleReport(asOf, u.asOf);
    if (asOf > block.timestamp + REPORT_SKEW) revert FutureReport(asOf);
    (u.drawn, u.repaid, u.asOf) = (drawn, repaid, asOf);
    emit ArcUtilisationUpdated(lineId, drawn, repaid, asOf);
  }

  function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
    return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
  }
}
