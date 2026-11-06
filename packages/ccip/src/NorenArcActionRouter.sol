// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {INorenActionSink} from "./interfaces/INorenActionSink.sol";
import {NorenArcAction} from "./libraries/NorenArcAction.sol";

interface INorenCcipSender {
  function send(uint64 finalChain, bytes calldata payload, address token, uint256 amount, address feeToken)
    external
    payable
    returns (bytes32 messageId);
}

/// @title NorenArcActionRouter
/// @notice The single place on Arc where cross-chain value and instructions land, whichever rail carried them:
///         NorenCcipGateway (Chainlink CCIP) or NorenArcHook (Circle CCTP). It runs the shared Noren actions:
///         pay an invoice, deposit to an Earn vault, hold funds for a cross-chain Aqua order, open/update a credit
///         line, and pay a merchant from Arc liquidity against that line. `reportLine` sends the line's utilisation
///         back over CCIP.
/// @dev `execute` never reverts for a well-formed call from an allowlisted rail: a failing action books the
///      delivered tokens as a claimable balance for the beneficiary (or the source sender); a failing instruction
///      that carried no tokens returns false and stays retryable. Idempotent per `(rail, msgId)`.
///      Unaudited hackathon code.
contract NorenArcActionRouter is INorenActionSink, Ownable2Step, ReentrancyGuard {
  using SafeERC20 for IERC20;

  struct Line {
    address borrower;
    uint64 expiry;
    uint64 asOf;
    uint64 source; // chain selector / domain the line was opened from
    uint256 limit; // USDC, 6 decimals
    uint256 drawn;
    uint256 repaid;
  }

  struct AquaOrder {
    address beneficiary;
    address token;
    uint256 amount;
    bytes32 rail;
    uint64 source;
    bool open;
    bytes params;
  }

  IERC20 public immutable usdc;

  /// @notice Rail contract -> rail id (keccak256("CCIP") / keccak256("CCTP")); zero = not a rail.
  mapping(address rail => bytes32) public railOf;
  mapping(bytes32 rail => mapping(bytes32 msgId => bool)) public executed;
  /// @notice Who may open/update credit lines, per rail and source chain (e.g. NorenCredit's operator on Robinhood).
  mapping(bytes32 rail => mapping(uint64 source => mapping(address sender => bool))) public creditAuthority;
  mapping(address vault => bool) public earnVault;
  /// @notice Operator that settles cross-chain Aqua orders (the xchain-aqua maker).
  address public aquaOperator;
  /// @notice CCIP gateway used by `reportLine`.
  INorenCcipSender public ccipGateway;

  mapping(bytes32 lineId => Line) public lines;
  mapping(bytes32 ref => AquaOrder) public aquaOrders;
  mapping(bytes32 invoiceId => bool) public invoicePaid;
  mapping(address account => mapping(address token => uint256)) public claimable;
  /// @notice Tokens held for claimables and open Aqua orders (not lendable liquidity).
  mapping(address token => uint256) public reserved;

  event RailSet(address indexed rail, bytes32 railId);
  event CreditAuthoritySet(bytes32 indexed rail, uint64 indexed source, address indexed sender, bool allowed);
  event EarnVaultSet(address indexed vault, bool allowed);
  event AquaOperatorSet(address indexed operator);
  event CcipGatewaySet(address indexed gateway);
  event ActionExecuted(
    bytes32 indexed rail,
    bytes32 indexed msgId,
    uint8 indexed kind,
    address beneficiary,
    bytes32 ref,
    address token,
    uint256 amount,
    bool ok
  );
  event ActionFailed(bytes32 indexed rail, bytes32 indexed msgId, address creditedTo, address token, uint256 amount, bytes reason);
  event DuplicateIgnored(bytes32 indexed rail, bytes32 indexed msgId);
  event InvoicePaid(bytes32 indexed invoiceId, address indexed merchant, address indexed payer, uint256 amount, bytes32 rail, uint64 source, bool onCredit);
  event EarnDeposited(address indexed vault, address indexed beneficiary, uint256 assets, uint256 shares);
  event AquaOrderOpened(bytes32 indexed ref, address indexed beneficiary, address token, uint256 amount, bytes32 rail, uint64 source, bytes params);
  event AquaOrderClosed(bytes32 indexed ref, address indexed to, uint256 amount, bool filled);
  event CreditLineUpdated(bytes32 indexed lineId, address indexed borrower, uint256 limit, uint64 expiry, uint64 asOf, uint64 source);
  event CreditLineStale(bytes32 indexed lineId, uint64 asOf, uint64 storedAsOf);
  event Drawn(bytes32 indexed lineId, uint256 amount, bytes32 invoiceId, address merchant);
  event Repaid(bytes32 indexed lineId, uint256 amount);
  event LineReported(bytes32 indexed lineId, uint64 indexed finalChain, bytes32 messageId, uint256 drawn, uint256 repaid, uint64 asOf);
  event Claimed(address indexed account, address indexed token, uint256 amount);
  event LiquidityAdded(address indexed from, uint256 amount);
  event LiquidityWithdrawn(address indexed to, uint256 amount);

  error NotRail(address caller, bytes32 rail);
  error OnlySelf();
  error UnknownKind(uint8 kind);
  error WrongToken(address token);
  error ZeroAmount();
  error InvoiceAlreadyPaid(bytes32 invoiceId);
  error VaultNotAllowed(address vault);
  error NotCreditAuthority(uint64 source, address sender);
  error NotBorrower(address sender);
  error LineExpired(bytes32 lineId);
  error OverLimit(uint256 requested, uint256 available);
  error InsufficientLiquidity(uint256 requested, uint256 available);
  error OrderExists(bytes32 ref);
  error OrderNotOpen(bytes32 ref);
  error NotAquaOperator(address caller);
  error NotOrderBeneficiary(address caller);
  error NothingToClaim();
  error NoLine(bytes32 lineId);
  error NoGateway();

  constructor(IERC20 usdc_, address owner_) Ownable(owner_) {
    usdc = usdc_;
  }

  // ---------------------------------------------------------------- admin

  function setRail(address rail, bytes32 railId) external onlyOwner {
    railOf[rail] = railId;
    emit RailSet(rail, railId);
  }

  function setCreditAuthority(bytes32 rail, uint64 source, address sender, bool allowed) external onlyOwner {
    creditAuthority[rail][source][sender] = allowed;
    emit CreditAuthoritySet(rail, source, sender, allowed);
  }

  function setEarnVault(address vault, bool allowed) external onlyOwner {
    earnVault[vault] = allowed;
    emit EarnVaultSet(vault, allowed);
  }

  function setAquaOperator(address operator) external onlyOwner {
    aquaOperator = operator;
    emit AquaOperatorSet(operator);
  }

  function setCcipGateway(INorenCcipSender gateway) external onlyOwner {
    ccipGateway = gateway;
    emit CcipGatewaySet(address(gateway));
  }

  // ---------------------------------------------------------------- liquidity (backs PAY_ON_CREDIT)

  function addLiquidity(uint256 amount) external nonReentrant {
    usdc.safeTransferFrom(msg.sender, address(this), amount);
    emit LiquidityAdded(msg.sender, amount);
  }

  function withdrawLiquidity(address to, uint256 amount) external onlyOwner nonReentrant {
    uint256 free = liquidity();
    if (amount > free) revert InsufficientLiquidity(amount, free);
    usdc.safeTransfer(to, amount);
    emit LiquidityWithdrawn(to, amount);
  }

  /// @notice USDC the router can lend: balance minus claimables and open-order holdings.
  function liquidity() public view returns (uint256) {
    uint256 bal = usdc.balanceOf(address(this));
    uint256 res = reserved[address(usdc)];
    return bal > res ? bal - res : 0;
  }

  // ---------------------------------------------------------------- entry point (both rails)

  /// @inheritdoc INorenActionSink
  function execute(
    bytes32 rail,
    bytes32 msgId,
    uint64 source,
    address sourceSender,
    address token,
    uint256 amount,
    bytes calldata action
  ) external nonReentrant returns (bool ok) {
    if (rail == bytes32(0) || railOf[msg.sender] != rail) revert NotRail(msg.sender, rail);
    if (executed[rail][msgId]) {
      if (amount != 0) _credit(sourceSender, token, amount);
      emit DuplicateIgnored(rail, msgId);
      return false;
    }
    executed[rail][msgId] = true;

    try this.run(rail, source, sourceSender, token, amount, action) returns (uint8 kind, address beneficiary, bytes32 ref) {
      emit ActionExecuted(rail, msgId, kind, beneficiary, ref, token, amount, true);
      return true;
    } catch (bytes memory reason) {
      address to = _fallbackBeneficiary(action, sourceSender);
      if (amount != 0) {
        // Value arrived: book it for the beneficiary so it can never be stuck.
        _credit(to, token, amount);
      } else {
        // Instruction only: leave it unexecuted so the rail can retry it (NorenCcipGateway.retryFailed).
        executed[rail][msgId] = false;
        to = address(0);
      }
      emit ActionFailed(rail, msgId, to, token, amount, reason);
      return false;
    }
  }

  /// @dev Self-call so a failing action rolls back cleanly and `execute` can book the funds instead.
  function run(bytes32 rail, uint64 source, address sourceSender, address token, uint256 amount, bytes calldata action)
    external
    returns (uint8 kind, address beneficiary, bytes32 ref)
  {
    if (msg.sender != address(this)) revert OnlySelf();
    NorenArcAction.Action memory a = NorenArcAction.decode(action);
    (kind, beneficiary, ref) = (a.kind, a.beneficiary, a.ref);

    if (a.kind == NorenArcAction.PAY_INVOICE) {
      (address merchant, bytes32 invoiceId) = abi.decode(a.params, (address, bytes32));
      if (token != address(usdc)) revert WrongToken(token);
      if (amount == 0) revert ZeroAmount();
      _markInvoice(invoiceId);
      usdc.safeTransfer(merchant, amount);
      emit InvoicePaid(invoiceId, merchant, a.beneficiary, amount, rail, source, false);
    } else if (a.kind == NorenArcAction.EARN_DEPOSIT) {
      address vault = abi.decode(a.params, (address));
      if (!earnVault[vault]) revert VaultNotAllowed(vault);
      if (amount == 0) revert ZeroAmount();
      if (IERC4626(vault).asset() != token) revert WrongToken(token);
      IERC20(token).forceApprove(vault, amount);
      uint256 shares = IERC4626(vault).deposit(amount, a.beneficiary);
      emit EarnDeposited(vault, a.beneficiary, amount, shares);
    } else if (a.kind == NorenArcAction.AQUA_ORDER) {
      if (aquaOrders[a.ref].beneficiary != address(0)) revert OrderExists(a.ref);
      aquaOrders[a.ref] = AquaOrder({
        beneficiary: a.beneficiary,
        token: token,
        amount: amount,
        rail: rail,
        source: source,
        open: true,
        params: a.params
      });
      if (amount != 0) reserved[token] += amount;
      emit AquaOrderOpened(a.ref, a.beneficiary, token, amount, rail, source, a.params);
    } else if (a.kind == NorenArcAction.CREDIT_LINE) {
      if (!creditAuthority[rail][source][sourceSender]) revert NotCreditAuthority(source, sourceSender);
      (bytes32 lineId, uint256 limit, uint64 expiry, uint64 asOf) = abi.decode(a.params, (bytes32, uint256, uint64, uint64));
      Line storage l = lines[lineId];
      if (asOf <= l.asOf) {
        // Out-of-order delivery: an older update must not overwrite a newer one.
        emit CreditLineStale(lineId, asOf, l.asOf);
      } else {
        l.borrower = a.beneficiary;
        l.limit = limit;
        l.expiry = expiry;
        l.asOf = asOf;
        l.source = source;
        emit CreditLineUpdated(lineId, a.beneficiary, limit, expiry, asOf, source);
      }
      if (amount != 0) _credit(a.beneficiary, token, amount);
    } else if (a.kind == NorenArcAction.PAY_ON_CREDIT) {
      (bytes32 lineId, address merchant, bytes32 invoiceId, uint256 amt) =
        abi.decode(a.params, (bytes32, address, bytes32, uint256));
      Line storage l = lines[lineId];
      if (l.borrower == address(0)) revert NoLine(lineId);
      if (sourceSender != l.borrower || a.beneficiary != l.borrower) revert NotBorrower(sourceSender);
      if (block.timestamp > l.expiry) revert LineExpired(lineId);
      if (amt == 0) revert ZeroAmount();
      uint256 outstanding = l.drawn > l.repaid ? l.drawn - l.repaid : 0;
      uint256 avail = l.limit > outstanding ? l.limit - outstanding : 0;
      if (amt > avail) revert OverLimit(amt, avail);
      uint256 free = liquidity();
      if (amt > free) revert InsufficientLiquidity(amt, free);
      _markInvoice(invoiceId);
      l.drawn += amt;
      usdc.safeTransfer(merchant, amt);
      emit Drawn(lineId, amt, invoiceId, merchant);
      emit InvoicePaid(invoiceId, merchant, l.borrower, amt, rail, source, true);
      if (amount != 0) _credit(a.beneficiary, token, amount);
    } else {
      revert UnknownKind(a.kind);
    }
  }

  // ---------------------------------------------------------------- Arc-side calls

  /// @notice Repays a line on Arc in USDC (anyone may repay on the borrower's behalf).
  function repay(bytes32 lineId, uint256 amount) external nonReentrant {
    Line storage l = lines[lineId];
    if (l.borrower == address(0)) revert NoLine(lineId);
    if (amount == 0) revert ZeroAmount();
    usdc.safeTransferFrom(msg.sender, address(this), amount);
    l.repaid += amount;
    emit Repaid(lineId, amount);
  }

  /// @notice Sends the line's utilisation to `finalChain` over CCIP (the reverse path). Caller pays the CCIP fee in
  ///         native gas; the excess is refunded by the gateway to this router and forwarded back.
  function reportLine(bytes32 lineId, uint64 finalChain) external payable nonReentrant returns (bytes32 messageId) {
    INorenCcipSender g = ccipGateway;
    if (address(g) == address(0)) revert NoGateway();
    Line memory l = lines[lineId];
    if (l.borrower == address(0)) revert NoLine(lineId);
    uint64 asOf = uint64(block.timestamp);
    bytes memory payload = NorenArcAction.encode(
      NorenArcAction.LINE_REPORT, l.borrower, lineId, abi.encode(lineId, l.drawn, l.repaid, asOf)
    );
    uint256 before = address(this).balance - msg.value;
    messageId = g.send{value: msg.value}(finalChain, payload, address(0), 0, address(0));
    uint256 refund = address(this).balance - before;
    if (refund != 0) {
      (bool ok,) = payable(msg.sender).call{value: refund}("");
      require(ok, "refund failed");
    }
    emit LineReported(lineId, finalChain, messageId, l.drawn, l.repaid, asOf);
  }

  /// @notice The Aqua operator settles an open order: sends the held funds to `to` (maker fill or bridge out).
  function settleAquaOrder(bytes32 ref, address to) external nonReentrant {
    if (msg.sender != aquaOperator) revert NotAquaOperator(msg.sender);
    _closeOrder(ref, to, true);
  }

  /// @notice The beneficiary cancels an open order and takes the funds back.
  function cancelAquaOrder(bytes32 ref) external nonReentrant {
    if (msg.sender != aquaOrders[ref].beneficiary) revert NotOrderBeneficiary(msg.sender);
    _closeOrder(ref, msg.sender, false);
  }

  function claim(address token) external nonReentrant {
    uint256 amt = claimable[msg.sender][token];
    if (amt == 0) revert NothingToClaim();
    claimable[msg.sender][token] = 0;
    reserved[token] -= amt;
    IERC20(token).safeTransfer(msg.sender, amt);
    emit Claimed(msg.sender, token, amt);
  }

  /// @notice Accepts the gateway's native fee refund in `reportLine`.
  receive() external payable {}

  // ---------------------------------------------------------------- views

  function available(bytes32 lineId) external view returns (uint256) {
    Line memory l = lines[lineId];
    uint256 outstanding = l.drawn > l.repaid ? l.drawn - l.repaid : 0;
    return l.limit > outstanding ? l.limit - outstanding : 0;
  }

  // ---------------------------------------------------------------- internals

  function _markInvoice(bytes32 invoiceId) private {
    if (invoicePaid[invoiceId]) revert InvoiceAlreadyPaid(invoiceId);
    invoicePaid[invoiceId] = true;
  }

  function _credit(address to, address token, uint256 amount) private {
    claimable[to][token] += amount;
    reserved[token] += amount;
  }

  function _closeOrder(bytes32 ref, address to, bool filled) private {
    AquaOrder storage o = aquaOrders[ref];
    if (!o.open) revert OrderNotOpen(ref);
    o.open = false;
    uint256 amt = o.amount;
    if (amt != 0) {
      reserved[o.token] -= amt;
      IERC20(o.token).safeTransfer(to, amt);
    }
    emit AquaOrderClosed(ref, to, amt, filled);
  }

  /// @dev Beneficiary from a well-formed action, else the source sender (same EOA across EVM chains).
  function _fallbackBeneficiary(bytes calldata action, address sourceSender) private view returns (address) {
    try this.beneficiaryOf(action) returns (address b) {
      return b == address(0) ? sourceSender : b;
    } catch {
      return sourceSender;
    }
  }

  function beneficiaryOf(bytes calldata action) external pure returns (address) {
    return NorenArcAction.decode(action).beneficiary;
  }
}
