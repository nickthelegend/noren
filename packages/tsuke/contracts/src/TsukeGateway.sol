// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from '@oz/access/Ownable2Step.sol';
import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {IERC20Permit} from '@oz/token/ERC20/extensions/IERC20Permit.sol';
import {SafeERC20} from '@oz/token/ERC20/utils/SafeERC20.sol';
import {Math} from '@oz/utils/math/Math.sol';
import {ReentrancyGuard} from '@oz/utils/ReentrancyGuard.sol';
import {TsukeOracle} from './TsukeOracle.sol';
import {ITsukeVault} from './interfaces/ITsukeVault.sol';
import {IWETH} from './interfaces/IWETH.sol';

/// @title TsukeGateway
/// @notice Merchants post USDG invoices; customers pay them with USDG, ETH or a Stock Token.
/// Non-USDG payments go to the vault as inventory at the Chainlink price plus a spread and the
/// vault pays the merchant the full invoice in USDG. TsukeCredit settles invoices for Pay in 4.
contract TsukeGateway is Ownable2Step, ReentrancyGuard {
  using SafeERC20 for IERC20;
  using Math for uint256;

  uint256 internal constant BPS = 10_000;
  /// @notice Pass as `asset` to pay with native ETH (wrapped to WETH for the vault).
  address public constant NATIVE_ETH = address(0);

  enum Status {
    None,
    Open,
    Paid,
    Cancelled
  }

  struct Invoice {
    uint128 amountUsdg; // 6 decimals
    uint64 expiry;
    Status status;
    address payer;
    address asset;
    uint256 assetIn;
  }

  IERC20 public immutable usdg;
  IWETH public immutable weth;
  TsukeOracle public immutable oracle;
  ITsukeVault public immutable vault;
  address public credit;
  mapping(address asset => uint16) public spreadBps;
  mapping(bytes32 key => Invoice) internal _invoices;

  event InvoiceCreated(address indexed merchant, bytes32 indexed invoiceId, uint256 amountUsdg, uint64 expiry);
  event InvoiceCancelled(address indexed merchant, bytes32 indexed invoiceId);
  event InvoicePaid(
    address indexed merchant,
    bytes32 indexed invoiceId,
    address indexed payer,
    address asset,
    uint256 assetIn,
    uint256 usdgOut,
    uint256 priceUsd8
  );
  event InvoiceSettledByCredit(address indexed merchant, bytes32 indexed invoiceId, address indexed borrower, uint256 amountUsdg);
  event SpreadSet(address indexed asset, uint16 bps);
  event CreditSet(address indexed credit);

  error InvoiceExists();
  error InvoiceNotOpen(Status status);
  error InvoiceExpired(uint64 expiry);
  error NotCredit();
  error ZeroAmount();
  error AssetNotAccepted(address asset);
  error Slippage(uint256 required, uint256 max);
  error BadValue();
  error ReceivedShort(uint256 expected, uint256 received);
  error BadConfig();

  constructor(address owner_, IERC20 usdg_, IWETH weth_, TsukeOracle oracle_, ITsukeVault vault_) Ownable(owner_) {
    usdg = usdg_;
    weth = weth_;
    oracle = oracle_;
    vault = vault_;
  }

  receive() external payable {
    if (msg.sender != address(weth)) revert BadValue();
  }

  // ---------------------------------------------------------------- admin

  function setSpread(address asset, uint16 bps) external onlyOwner {
    if (bps > 1_000) revert BadConfig();
    spreadBps[asset] = bps;
    emit SpreadSet(asset, bps);
  }

  function setCredit(address credit_) external onlyOwner {
    credit = credit_;
    emit CreditSet(credit_);
  }

  // ---------------------------------------------------------------- merchants

  function createInvoice(bytes32 invoiceId, uint128 amountUsdg, uint64 expiry) external {
    if (amountUsdg == 0) revert ZeroAmount();
    if (expiry <= block.timestamp) revert InvoiceExpired(expiry);
    Invoice storage inv = _invoices[_key(msg.sender, invoiceId)];
    if (inv.status != Status.None) revert InvoiceExists();
    inv.amountUsdg = amountUsdg;
    inv.expiry = expiry;
    inv.status = Status.Open;
    emit InvoiceCreated(msg.sender, invoiceId, amountUsdg, expiry);
  }

  function cancelInvoice(bytes32 invoiceId) external {
    Invoice storage inv = _invoices[_key(msg.sender, invoiceId)];
    if (inv.status != Status.Open) revert InvoiceNotOpen(inv.status);
    inv.status = Status.Cancelled;
    emit InvoiceCancelled(msg.sender, invoiceId);
  }

  function invoice(address merchant, bytes32 invoiceId) external view returns (Invoice memory) {
    return _invoices[_key(merchant, invoiceId)];
  }

  // ---------------------------------------------------------------- customers

  /// @notice How much of `asset` pays the invoice right now (rounded up), and the price used.
  function quote(address merchant, bytes32 invoiceId, address asset)
    public
    view
    returns (uint256 assetIn, uint256 priceUsd8, bool marketClosed)
  {
    Invoice memory inv = _openInvoice(merchant, invoiceId);
    return _quote(asset, inv.amountUsdg);
  }

  /// @notice Pay an open invoice with USDG, native ETH (asset = address(0)) or an accepted Stock Token.
  /// For ETH, send msg.value >= the quote; the excess is refunded. `maxAssetIn` bounds slippage.
  function pay(bytes32 invoiceId, address merchant, address asset, uint256 maxAssetIn)
    external
    payable
    nonReentrant
    returns (uint256 assetIn)
  {
    return _pay(invoiceId, merchant, asset, maxAssetIn);
  }

  /// @notice pay() after an EIP-2612 permit (USDG and Robinhood Stock Tokens both implement permit).
  /// A failed permit is ignored so a front-run permit cannot block the payment; the allowance decides.
  function payWithPermit(
    bytes32 invoiceId,
    address merchant,
    address asset,
    uint256 maxAssetIn,
    uint256 deadline,
    uint8 v,
    bytes32 r,
    bytes32 s
  ) external nonReentrant returns (uint256 assetIn) {
    if (asset == NATIVE_ETH) revert BadValue();
    try IERC20Permit(asset).permit(msg.sender, address(this), maxAssetIn, deadline, v, r, s) {} catch {}
    return _pay(invoiceId, merchant, asset, maxAssetIn);
  }

  /// @notice Called by TsukeCredit when a Pay-in-4 plan funds the invoice.
  function settleByCredit(address merchant, bytes32 invoiceId, address borrower) external returns (uint256 amountUsdg) {
    if (msg.sender != credit) revert NotCredit();
    Invoice storage inv = _invoices[_key(merchant, invoiceId)];
    _requireOpen(inv);
    inv.status = Status.Paid;
    inv.payer = borrower;
    inv.asset = address(usdg);
    inv.assetIn = inv.amountUsdg;
    amountUsdg = inv.amountUsdg;
    emit InvoiceSettledByCredit(merchant, invoiceId, borrower, amountUsdg);
  }

  /// @notice Invoice amount for an open, unexpired invoice (reverts otherwise).
  function openAmount(address merchant, bytes32 invoiceId) external view returns (uint256) {
    return _openInvoice(merchant, invoiceId).amountUsdg;
  }

  // ---------------------------------------------------------------- internal

  function _pay(bytes32 invoiceId, address merchant, address asset, uint256 maxAssetIn) internal returns (uint256 assetIn) {
    Invoice storage inv = _invoices[_key(merchant, invoiceId)];
    _requireOpen(inv);
    uint256 amount = inv.amountUsdg;
    uint256 priceUsd8;
    (assetIn, priceUsd8,) = _quote(asset, amount);
    if (assetIn > maxAssetIn) revert Slippage(assetIn, maxAssetIn);
    if (asset != NATIVE_ETH && msg.value != 0) revert BadValue();

    // effects
    inv.status = Status.Paid;
    inv.payer = msg.sender;
    inv.asset = asset == NATIVE_ETH ? address(weth) : asset;
    inv.assetIn = assetIn;

    // interactions
    if (asset == address(usdg)) {
      usdg.safeTransferFrom(msg.sender, merchant, amount);
    } else if (asset == NATIVE_ETH) {
      if (msg.value < assetIn) revert Slippage(assetIn, msg.value);
      weth.deposit{value: assetIn}();
      IERC20(address(weth)).safeTransfer(address(vault), assetIn);
      vault.disburse(merchant, amount);
      uint256 refund = msg.value - assetIn;
      if (refund != 0) {
        (bool ok,) = msg.sender.call{value: refund}('');
        if (!ok) revert BadValue();
      }
    } else {
      oracle.checkTransferable(asset, msg.sender, address(vault));
      uint256 before = IERC20(asset).balanceOf(address(vault));
      IERC20(asset).safeTransferFrom(msg.sender, address(vault), assetIn);
      uint256 got = IERC20(asset).balanceOf(address(vault)) - before;
      if (got < assetIn) revert ReceivedShort(assetIn, got);
      vault.disburse(merchant, amount);
    }
    emit InvoicePaid(merchant, invoiceId, msg.sender, inv.asset, assetIn, amount, priceUsd8);
  }

  function _quote(address asset, uint256 amountUsdg) internal view returns (uint256 assetIn, uint256 priceUsd8, bool closed) {
    if (asset == address(usdg)) return (amountUsdg, oracle.usdgPrice(), false);
    address priced = asset == NATIVE_ETH ? address(weth) : asset;
    if (!oracle.isSupported(priced)) revert AssetNotAccepted(asset);
    uint256 usd8 = oracle.usdgToUsd8(amountUsdg, Math.Rounding.Ceil);
    TsukeOracle.Price memory p;
    (assetIn, p) = oracle.assetForUsd8(priced, usd8, spreadBps[priced]);
    return (assetIn, p.usd8, p.marketClosed);
  }

  function _openInvoice(address merchant, bytes32 invoiceId) internal view returns (Invoice memory inv) {
    inv = _invoices[_key(merchant, invoiceId)];
    if (inv.status != Status.Open) revert InvoiceNotOpen(inv.status);
    if (inv.expiry <= block.timestamp) revert InvoiceExpired(inv.expiry);
  }

  function _requireOpen(Invoice storage inv) internal view {
    if (inv.status != Status.Open) revert InvoiceNotOpen(inv.status);
    if (inv.expiry <= block.timestamp) revert InvoiceExpired(inv.expiry);
  }

  function _key(address merchant, bytes32 invoiceId) internal pure returns (bytes32) {
    return keccak256(abi.encode(merchant, invoiceId));
  }
}
