// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {SafeERC20} from '@oz/token/ERC20/utils/SafeERC20.sol';
import {ReentrancyGuard} from '@oz/utils/ReentrancyGuard.sol';
import {IReceiver, IERC165} from './interfaces/IReceiver.sol';

/// @title NorenCreditLine
/// @notice Arc side of the Noren credit line. A Chainlink CRE workflow watches NorenCredit on
///         Robinhood Chain and, through the CRE forwarder, writes each opened line (borrower, limit,
///         expiry) here. The borrower then pays Noren merchants in USDC from this contract's pool,
///         up to the limit, and repays in USDC. Every Drawn/Repaid is carried back to NorenCredit by
///         the same workflow, so the collateral on Robinhood tracks the debt on Arc.
/// @dev Unaudited. Only `forwarder` may call onReport. The CRE simulation MockKeystoneForwarder
///      checks no DON signatures, so a deployment pointed at it is for simulation only. In
///      production `forwarder` is Arc's KeystoneForwarder, which verifies the DON's signatures, and
///      `expectedWorkflowOwner` pins the workflow.
///
///      Two report kinds arrive through onReport:
///        kind 1  collateral line from Robinhood: abi.encode(address borrower, bytes32 lineId,
///                uint256 limitUsdc6, uint64 expiry) (128 bytes, the original fixed interface), or the
///                same fields versioned as abi.encode(uint8(1), borrower, lineId, limitUsdc6, expiry).
///        kind 2  World ID human starter limit: abi.encode(uint8(2), address borrower,
///                bytes32 nullifierHash, uint256 starterLimitUsdc6, uint64 expiry). Unsecured credit
///                for a verified unique human, capped by maxStarterLimitUsdc6. Each nullifierHash is
///                accepted once, ever. It opens or tops up the borrower's own starter line, kept apart
///                from collateral lines so Robinhood's collateral accounting stays exact.
contract NorenCreditLine is IReceiver, ReentrancyGuard {
  using SafeERC20 for IERC20;

  struct Line {
    address borrower;
    uint64 expiry;
    /// @dev Strictly increasing per change: max(block.timestamp, previous + 1). The bridge sends it
    ///      to NorenCredit as `asOf`, which rejects any report not newer than the last one.
    uint64 updatedAt;
    bool closed;
    uint256 limitUsdc6;
    uint256 drawnUsdc6;
    uint256 repaidUsdc6;
    /// @dev True for a World ID starter line (kind 2): no collateral behind it, lives only on Arc.
    bool unsecured;
  }

  uint8 public constant KIND_COLLATERAL_LINE = 1;
  uint8 public constant KIND_HUMAN_STARTER = 2;
  /// @notice Longest expiry a starter-limit report may set, from the time it lands.
  uint64 public constant MAX_STARTER_DURATION = 90 days;

  IERC20 public immutable usdc;
  address public owner;
  address public pendingOwner;
  address public forwarder;
  /// @notice Optional CRE workflow owner pin (zero = off; the simulation mock forwarder sends no workflow metadata).
  address public expectedWorkflowOwner;
  bool public paused;
  /// @notice Sum of drawn minus repaid across all lines.
  uint256 public totalOutstandingUsdc6;
  /// @notice Most unsecured starter credit one borrower's starter line can hold (USDC, 6 decimals).
  uint256 public maxStarterLimitUsdc6;

  /// @notice Borrower a World ID nullifier hash was spent on (zero = unused). Never cleared.
  mapping(bytes32 nullifierHash => address) public nullifierUsedBy;

  mapping(bytes32 lineId => Line) private _lines;
  mapping(bytes32 lineId => mapping(bytes32 invoiceId => bool)) public invoicePaid;

  event Drawn(bytes32 indexed lineId, uint256 amount, bytes32 invoiceId, address merchant);
  event Repaid(bytes32 indexed lineId, uint256 amount);
  event CreditLineSynced(bytes32 indexed lineId, address indexed borrower, uint256 limitUsdc6, uint64 expiry);
  event CreditLineFrozen(bytes32 indexed lineId);
  event HumanStarterGranted(
    bytes32 indexed lineId, address indexed borrower, bytes32 indexed nullifierHash, uint256 addedUsdc6, uint256 limitUsdc6, uint64 expiry
  );
  event MaxStarterLimitSet(uint256 maxStarterLimitUsdc6);
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
  error UnknownReportKind(uint256 kind);
  error NullifierUsed(bytes32 nullifierHash, address usedBy);
  error StarterCapExceeded(uint256 cap, uint256 requested);
  error StarterExpiryTooFar(uint64 expiry, uint64 latest);
  error NotCollateralLine(bytes32 lineId);

  modifier onlyOwner() {
    if (msg.sender != owner) revert NotOwner();
    _;
  }

  constructor(IERC20 usdc_, address forwarder_, address owner_) {
    if (address(usdc_) == address(0) || forwarder_ == address(0) || owner_ == address(0)) revert ZeroAddress();
    usdc = usdc_;
    forwarder = forwarder_;
    owner = owner_;
    maxStarterLimitUsdc6 = 25e6;
    emit MaxStarterLimitSet(25e6);
    emit ForwarderSet(forwarder_);
    emit OwnershipTransferred(address(0), owner_);
  }

  // ---------------------------------------------------------------- CRE receiver

  /// @inheritdoc IReceiver
  /// @dev Kind 1 (collateral line): the first report for a lineId opens it; limitUsdc6 = 0 freezes
  ///      it for good (NorenCredit emitted CreditLineClosed), which also stops an old "opened"
  ///      report from being replayed. Kind 2 (human starter): see the contract notes.
  ///      Reports keep landing while paused, so Arc never misses a limit change.
  function onReport(bytes calldata metadata, bytes calldata report) external override {
    if (msg.sender != forwarder) revert NotForwarder(msg.sender);
    if (expectedWorkflowOwner != address(0)) {
      // metadata = abi.encodePacked(bytes32 workflowId, bytes10 workflowName, address workflowOwner) [+ bytes2 reportId]
      address workflowOwner = metadata.length >= 62 ? address(bytes20(metadata[42:62])) : address(0);
      if (workflowOwner != expectedWorkflowOwner) revert InvalidWorkflowOwner(workflowOwner, expectedWorkflowOwner);
    }
    if (report.length == 128) {
      (address borrower, bytes32 lineId, uint256 limitUsdc6, uint64 expiry) = abi.decode(report, (address, bytes32, uint256, uint64));
      _applyCollateralLine(borrower, lineId, limitUsdc6, expiry);
      return;
    }
    if (report.length != 160) revert InvalidReport();
    uint256 kind = uint256(bytes32(report[0:32]));
    if (kind == KIND_COLLATERAL_LINE) {
      (, address borrower, bytes32 lineId, uint256 limitUsdc6, uint64 expiry) =
        abi.decode(report, (uint8, address, bytes32, uint256, uint64));
      _applyCollateralLine(borrower, lineId, limitUsdc6, expiry);
    } else if (kind == KIND_HUMAN_STARTER) {
      (, address borrower, bytes32 nullifierHash, uint256 starterLimitUsdc6, uint64 expiry) =
        abi.decode(report, (uint8, address, bytes32, uint256, uint64));
      _applyHumanStarter(borrower, nullifierHash, starterLimitUsdc6, expiry);
    } else {
      revert UnknownReportKind(kind);
    }
  }

  /// @notice The lineId of a borrower's World ID starter line (whether or not it exists yet).
  function starterLineId(address borrower) public pure returns (bytes32) {
    return keccak256(abi.encode('noren.human-starter.v1', borrower));
  }

  function _applyCollateralLine(address borrower, bytes32 lineId, uint256 limitUsdc6, uint64 expiry) private {
    if (borrower == address(0) || lineId == bytes32(0)) revert InvalidReport();
    Line storage l = _lines[lineId];
    if (l.borrower == address(0)) {
      if (limitUsdc6 == 0) revert UnknownLine(lineId);
      if (expiry <= block.timestamp) revert ReportExpired(expiry);
      l.borrower = borrower;
    } else {
      if (l.unsecured) revert NotCollateralLine(lineId);
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

  function _applyHumanStarter(address borrower, bytes32 nullifierHash, uint256 starterLimitUsdc6, uint64 expiry) private {
    if (borrower == address(0) || nullifierHash == bytes32(0) || starterLimitUsdc6 == 0) revert InvalidReport();
    address usedBy = nullifierUsedBy[nullifierHash];
    if (usedBy != address(0)) revert NullifierUsed(nullifierHash, usedBy);
    if (expiry <= block.timestamp) revert ReportExpired(expiry);
    uint64 latest = uint64(block.timestamp) + MAX_STARTER_DURATION;
    if (expiry > latest) revert StarterExpiryTooFar(expiry, latest);

    bytes32 lineId = starterLineId(borrower);
    Line storage l = _lines[lineId];
    if (l.borrower == address(0)) {
      l.borrower = borrower;
      l.unsecured = true;
    } else if (l.closed) {
      revert LineClosed(lineId);
    }
    uint256 newLimit = l.limitUsdc6 + starterLimitUsdc6;
    if (newLimit > maxStarterLimitUsdc6) revert StarterCapExceeded(maxStarterLimitUsdc6, newLimit);

    nullifierUsedBy[nullifierHash] = borrower;
    l.limitUsdc6 = newLimit;
    if (expiry > l.expiry) l.expiry = expiry;
    _touch(l);
    emit HumanStarterGranted(lineId, borrower, nullifierHash, starterLimitUsdc6, newLimit, l.expiry);
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

  /// @notice The snapshot the bridge sends to NorenCredit.onReport: (lineId, drawn, repaid, asOf).
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

  /// @notice Lowering the cap stops new starter credit above it; existing limits are kept.
  function setMaxStarterLimit(uint256 maxStarterLimitUsdc6_) external onlyOwner {
    maxStarterLimitUsdc6 = maxStarterLimitUsdc6_;
    emit MaxStarterLimitSet(maxStarterLimitUsdc6_);
  }

  /// @notice Owner may freeze an unsecured starter line (risk control). Collateral lines are frozen
  ///         only by a CRE report, so they never diverge from Robinhood.
  function freezeStarterLine(address borrower) external onlyOwner {
    bytes32 lineId = starterLineId(borrower);
    Line storage l = _lines[lineId];
    if (l.borrower == address(0)) revert UnknownLine(lineId);
    l.closed = true;
    l.limitUsdc6 = 0;
    _touch(l);
    emit CreditLineFrozen(lineId);
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
