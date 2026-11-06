// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {SafeERC20} from '@oz/token/ERC20/utils/SafeERC20.sol';
import {ReentrancyGuard} from '@oz/utils/ReentrancyGuard.sol';
import {IReceiver, IERC165} from './interfaces/IReceiver.sol';

/// @title NorenCreditLine
/// @notice Arc side of the Tsuke credit line. A Chainlink CRE workflow watches TsukeCredit on
///         Robinhood Chain and, through the CRE forwarder, writes each opened line (borrower, limit,
///         expiry) here. The borrower then pays Noren merchants in USDC from this contract's pool,
///         up to the limit, and repays in USDC. Every Drawn/Repaid is carried back to TsukeCredit by
///         the same workflow, so the collateral on Robinhood tracks the debt on Arc.
/// @dev Unaudited. Only `forwarder` may call onReport. The CRE simulation MockKeystoneForwarder
///      checks no DON signatures, so a deployment pointed at it is for simulation only. In
///      production `forwarder` is Arc's KeystoneForwarder, which verifies the DON's signatures, and
///      `expectedWorkflowOwner` pins the workflow.
contract NorenCreditLine is IReceiver, ReentrancyGuard {
  using SafeERC20 for IERC20;

  struct Line {
    address borrower;
    uint64 expiry;
    /// @dev Strictly increasing per change: max(block.timestamp, previous + 1). The bridge sends it
    ///      to TsukeCredit as `asOf`, which rejects any report not newer than the last one.
    uint64 updatedAt;
    bool closed;
    uint256 limitUsdc6;
    uint256 drawnUsdc6;
    uint256 repaidUsdc6;
  }

  IERC20 public immutable usdc;
  address public owner;
  address public pendingOwner;
  address public forwarder;
  /// @notice Optional CRE workflow owner pin (zero = off; the simulation mock forwarder sends no workflow metadata).
  address public expectedWorkflowOwner;
  bool public paused;
  /// @notice Sum of drawn minus repaid across all lines.
  uint256 public totalOutstandingUsdc6;

  mapping(bytes32 lineId => Line) private _lines;
  mapping(bytes32 lineId => mapping(bytes32 invoiceId => bool)) public invoicePaid;

  event Drawn(bytes32 indexed lineId, uint256 amount, bytes32 invoiceId, address merchant);
  event Repaid(bytes32 indexed lineId, uint256 amount);
  event CreditLineSynced(bytes32 indexed lineId, address indexed borrower, uint256 limitUsdc6, uint64 expiry);
  event CreditLineFrozen(bytes32 indexed lineId);
  event PoolFunded(address indexed from, uint256 amount);
  event PoolWithdrawn(address indexed to, uint256 amount);
  event ForwarderSet(address indexed forwarder);
  event ExpectedWorkflowOwnerSet(address indexed workflowOwner);
  event Paused(bool paused);
  event OwnershipTransferStarted(address indexed from, address indexed to);
  event OwnershipTransferred(address indexed from, address indexed to);

  error NotOwner();
  error NotForwarder(address caller);
  error InvalidWorkflowOwner(address got, address expected);
  error InvalidReport();
  error ReportExpired(uint64 expiry);
  error UnknownLine(bytes32 lineId);
  error BorrowerMismatch(address stored, address reported);
  error LineClosed(bytes32 lineId);
  error LineExpired(bytes32 lineId, uint64 expiry);
  error NotBorrower();
  error IsPaused();
  error ZeroAmount();
  error ZeroAddress();
  error InvoiceAlreadyPaid(bytes32 invoiceId);
  error LimitExceeded(uint256 available, uint256 requested);
  error PoolInsufficient(uint256 available, uint256 requested);
  error RepayTooMuch(uint256 outstanding, uint256 requested);

  modifier onlyOwner() {
    if (msg.sender != owner) revert NotOwner();
    _;
  }

  constructor(IERC20 usdc_, address forwarder_, address owner_) {
    if (address(usdc_) == address(0) || forwarder_ == address(0) || owner_ == address(0)) revert ZeroAddress();
    usdc = usdc_;
    forwarder = forwarder_;
    owner = owner_;
    emit ForwarderSet(forwarder_);
    emit OwnershipTransferred(address(0), owner_);
  }

  // ---------------------------------------------------------------- CRE receiver

  /// @inheritdoc IReceiver
  /// @dev report = abi.encode(address borrower, bytes32 lineId, uint256 limitUsdc6, uint64 expiry).
  ///      First report for a lineId opens it. limitUsdc6 = 0 freezes it for good (TsukeCredit
  ///      emitted CreditLineClosed), which also stops an old "opened" report from being replayed.
  ///      Reports keep landing while paused, so Arc never misses a limit change.
  function onReport(bytes calldata metadata, bytes calldata report) external override {
    if (msg.sender != forwarder) revert NotForwarder(msg.sender);
    if (expectedWorkflowOwner != address(0)) {
      // metadata = abi.encodePacked(bytes32 workflowId, bytes10 workflowName, address workflowOwner) [+ bytes2 reportId]
      address workflowOwner = metadata.length >= 62 ? address(bytes20(metadata[42:62])) : address(0);
      if (workflowOwner != expectedWorkflowOwner) revert InvalidWorkflowOwner(workflowOwner, expectedWorkflowOwner);
    }
    if (report.length != 128) revert InvalidReport();
    (address borrower, bytes32 lineId, uint256 limitUsdc6, uint64 expiry) = abi.decode(report, (address, bytes32, uint256, uint64));
    if (borrower == address(0) || lineId == bytes32(0)) revert InvalidReport();

    Line storage l = _lines[lineId];
    if (l.borrower == address(0)) {
      if (limitUsdc6 == 0) revert UnknownLine(lineId);
      if (expiry <= block.timestamp) revert ReportExpired(expiry);
      l.borrower = borrower;
    } else {
      if (l.borrower != borrower) revert BorrowerMismatch(l.borrower, borrower);
      if (l.closed) revert LineClosed(lineId);
    }

    if (limitUsdc6 == 0) {
      l.closed = true;
      l.limitUsdc6 = 0;
      _touch(l);
      emit CreditLineFrozen(lineId);
      return;
    }
    l.limitUsdc6 = limitUsdc6;
    l.expiry = expiry;
    _touch(l);
    emit CreditLineSynced(lineId, borrower, limitUsdc6, expiry);
  }

  function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
    return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
  }

  // ---------------------------------------------------------------- borrower

  /// @notice Pay a Noren merchant in USDC from the credit pool. Revolving: drawn minus repaid
  ///         stays at or under the limit. Each (lineId, invoiceId) pays once.
  function payInvoice(bytes32 lineId, address merchant, uint256 amount, bytes32 invoiceId) external nonReentrant {
    if (paused) revert IsPaused();
    Line storage l = _lines[lineId];
    if (l.borrower == address(0)) revert UnknownLine(lineId);
    if (l.borrower != msg.sender) revert NotBorrower();
    if (l.closed) revert LineClosed(lineId);
    if (block.timestamp >= l.expiry) revert LineExpired(lineId, l.expiry);
    if (merchant == address(0)) revert ZeroAddress();
    if (amount == 0) revert ZeroAmount();
    if (invoicePaid[lineId][invoiceId]) revert InvoiceAlreadyPaid(invoiceId);
    uint256 room = _available(l);
    if (amount > room) revert LimitExceeded(room, amount);
    uint256 pool = usdc.balanceOf(address(this));
    if (amount > pool) revert PoolInsufficient(pool, amount);

    invoicePaid[lineId][invoiceId] = true;
    l.drawnUsdc6 += amount;
    totalOutstandingUsdc6 += amount;
    _touch(l);
    usdc.safeTransfer(merchant, amount);
    emit Drawn(lineId, amount, invoiceId, merchant);
  }

  /// @notice Repay a line in USDC. Anyone may repay on the borrower's behalf; works while paused
  ///         and after expiry or close.
  function repay(bytes32 lineId, uint256 amount) external nonReentrant {
    Line storage l = _lines[lineId];
    if (l.borrower == address(0)) revert UnknownLine(lineId);
    if (amount == 0) revert ZeroAmount();
    uint256 owed = l.drawnUsdc6 - l.repaidUsdc6;
    if (amount > owed) revert RepayTooMuch(owed, amount);

    l.repaidUsdc6 += amount;
    totalOutstandingUsdc6 -= amount;
    _touch(l);
    usdc.safeTransferFrom(msg.sender, address(this), amount);
    emit Repaid(lineId, amount);
  }

  // ---------------------------------------------------------------- views

  function lines(bytes32 lineId) external view returns (Line memory) {
    return _lines[lineId];
  }

  function outstanding(bytes32 lineId) external view returns (uint256) {
    Line storage l = _lines[lineId];
    return l.drawnUsdc6 - l.repaidUsdc6;
  }

  /// @notice What the borrower can still spend now (0 if closed, expired or paused), ignoring pool size.
  function available(bytes32 lineId) external view returns (uint256) {
    Line storage l = _lines[lineId];
    if (paused || l.closed || l.borrower == address(0) || block.timestamp >= l.expiry) return 0;
    return _available(l);
  }

  /// @notice The snapshot the bridge sends to TsukeCredit.onReport: (lineId, drawn, repaid, asOf).
  function utilisation(bytes32 lineId) external view returns (uint256 drawnUsdc6, uint256 repaidUsdc6, uint64 asOf) {
    Line storage l = _lines[lineId];
    return (l.drawnUsdc6, l.repaidUsdc6, l.updatedAt);
  }

  // ---------------------------------------------------------------- pool and admin

  function fund(uint256 amount) external nonReentrant {
    if (amount == 0) revert ZeroAmount();
    usdc.safeTransferFrom(msg.sender, address(this), amount);
    emit PoolFunded(msg.sender, amount);
  }

  /// @notice Owner takes idle liquidity out. Drawn USDC already left the pool, so any balance is idle.
  function withdraw(address to, uint256 amount) external onlyOwner nonReentrant {
    if (to == address(0)) revert ZeroAddress();
    usdc.safeTransfer(to, amount);
    emit PoolWithdrawn(to, amount);
  }

  function setForwarder(address forwarder_) external onlyOwner {
    if (forwarder_ == address(0)) revert ZeroAddress();
    forwarder = forwarder_;
    emit ForwarderSet(forwarder_);
  }

  function setExpectedWorkflowOwner(address workflowOwner) external onlyOwner {
    expectedWorkflowOwner = workflowOwner;
    emit ExpectedWorkflowOwnerSet(workflowOwner);
  }

  /// @notice Pause stops new draws only. Reports and repayments keep working.
  function setPaused(bool paused_) external onlyOwner {
    paused = paused_;
    emit Paused(paused_);
  }

  function transferOwnership(address to) external onlyOwner {
    pendingOwner = to;
    emit OwnershipTransferStarted(owner, to);
  }

  function acceptOwnership() external {
    if (msg.sender != pendingOwner) revert NotOwner();
    emit OwnershipTransferred(owner, msg.sender);
    owner = msg.sender;
    pendingOwner = address(0);
  }

  function _available(Line storage l) private view returns (uint256) {
    uint256 out = l.drawnUsdc6 - l.repaidUsdc6;
    return out >= l.limitUsdc6 ? 0 : l.limitUsdc6 - out;
  }

  function _touch(Line storage l) private {
    uint64 next = uint64(block.timestamp);
    if (next <= l.updatedAt) next = l.updatedAt + 1;
    l.updatedAt = next;
  }
}
