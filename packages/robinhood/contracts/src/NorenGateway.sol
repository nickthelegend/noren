// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from '@oz/access/Ownable2Step.sol';
import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {IERC20Permit} from '@oz/token/ERC20/extensions/IERC20Permit.sol';
import {SafeERC20} from '@oz/token/ERC20/utils/SafeERC20.sol';
import {Math} from '@oz/utils/math/Math.sol';
import {ReentrancyGuard} from '@oz/utils/ReentrancyGuard.sol';
import {NorenAssetOracle} from './NorenAssetOracle.sol';
import {INorenVault} from './interfaces/INorenVault.sol';
import {INorenLiquidity} from './interfaces/IAquaSwapVM.sol';
import {IWETH} from './interfaces/IWETH.sol';
import {NorenWifRouter} from './NorenWifRouter.sol';

interface IBurnableWif { function burn(uint256 amount) external; }

/// @title NorenGateway
/// @notice Merchants post USDG invoices; customers pay them with USDG, ETH or a Stock Token.
/// Non-USDG payments are converted through 1inch Aqua + SwapVM: NorenLiquidity sells the asset to
/// the best maker strategy pegged to the Chainlink price and the maker pays the merchant the full
/// invoice in USDG straight from its wallet. If no maker can fill, the payment falls back to the
/// vault (asset kept as inventory at the Chainlink price plus a spread) when `vaultFallback` is on,
/// and otherwise reverts with NoMakerLiquidity. NorenCredit settles invoices for Pay in 3.
contract NorenGateway is Ownable2Step, ReentrancyGuard {
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
  NorenAssetOracle public immutable oracle;
  INorenVault public immutable vault;
  address public credit;
  /// @notice Aqua + SwapVM maker router; address(0) = vault only.
  INorenLiquidity public liquidity;
  NorenWifRouter public wifRouter;
  uint16 public protocolFeeBps = 30;
  uint16 public burnShareBps = 10_000;
  uint16 public keeperTipBps = 100;
  uint256 public burnThresholdUsdg = 1e6;
  uint256 public accruedUsdg;
  uint256 public totalWifBurned;
  /// @notice Use the vault when no maker strategy can fill (true by default).
  bool public vaultFallback = true;
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
  event LiquiditySet(address indexed liquidity, bool vaultFallback);
  event InvoiceRoutedToMaker(address indexed merchant, bytes32 indexed invoiceId, bytes32 indexed strategyHash, uint256 assetIn);
  event InvoiceRoutedToVault(address indexed merchant, bytes32 indexed invoiceId, uint256 assetIn);
  event WifBurned(bytes32 indexed invoiceId, uint256 usdgIn, uint256 wifBurned);
  event WifRouterSet(address indexed router);
  event WifFeeConfigSet(uint16 feeBps, uint16 burnShareBps, uint16 keeperTipBps, uint256 thresholdUsdg);
  event WifFeeAccrued(bytes32 indexed invoiceId, uint256 usdgAmount);

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
  error NoMakerLiquidity(address asset, uint256 amountUsdg);
  error BurnBelowThreshold(uint256 accrued, uint256 threshold);

  constructor(address owner_, IERC20 usdg_, IWETH weth_, NorenAssetOracle oracle_, INorenVault vault_) Ownable(owner_) {
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

  function setLiquidity(INorenLiquidity liquidity_, bool vaultFallback_) external onlyOwner {
    liquidity = liquidity_;
    vaultFallback = vaultFallback_;
    emit LiquiditySet(address(liquidity_), vaultFallback_);
  }

  function setWifRouter(NorenWifRouter router_) external onlyOwner {
    if (address(router_) == address(0) || address(router_.manager()).code.length == 0) revert BadConfig();
    wifRouter = router_;
    emit WifRouterSet(address(router_));
  }

  function setWifFeeConfig(uint16 feeBps, uint16 burnBps, uint16 tipBps, uint256 thresholdUsdg) external onlyOwner {
    if (feeBps > 100 || burnBps > BPS || tipBps > 500 || thresholdUsdg == 0) revert BadConfig();
    protocolFeeBps = feeBps;
    burnShareBps = burnBps;
    keeperTipBps = tipBps;
    burnThresholdUsdg = thresholdUsdg;
    emit WifFeeConfigSet(feeBps, burnBps, tipBps, thresholdUsdg);
  }

  /// @notice Anyone can buy and burn accrued fees once the threshold is met. A minimum output
  /// protects the keeper against price movement; the tip is paid in bought WIF.
  function burnAccrued(uint256 minWifOut) external nonReentrant returns (uint256 burned) {
    uint256 amount = accruedUsdg;
    if (amount < burnThresholdUsdg) revert BurnBelowThreshold(amount, burnThresholdUsdg);
    accruedUsdg = 0;
    usdg.forceApprove(address(wifRouter), amount);
    uint256 bought = wifRouter.usdgForWif(amount, minWifOut, address(this));
    uint256 tip = bought * keeperTipBps / BPS;
    burned = bought - tip;
    if (tip != 0) IERC20(wifRouter.WIF()).safeTransfer(msg.sender, tip);
    IBurnableWif(wifRouter.WIF()).burn(burned);
    totalWifBurned += burned;
    emit WifBurned(bytes32(0), amount, burned);
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

  /// @notice How much of `asset` pays the invoice right now (rounded up), and the Chainlink price.
  function quote(address merchant, bytes32 invoiceId, address asset)
    public
    view
    returns (uint256 assetIn, uint256 priceUsd8, bool marketClosed)
  {
    Invoice memory inv = _openInvoice(merchant, invoiceId);
    uint256 fee = address(wifRouter) != address(0) && asset != wifRouter.WIF() ? uint256(inv.amountUsdg) * protocolFeeBps / BPS : 0;
    (assetIn, priceUsd8, marketClosed,) = _quote(asset, uint256(inv.amountUsdg) + fee);
  }

  /// @notice quote() plus the route: the Aqua strategy that fills it, or 0 for the vault (or USDG).
  function quoteRoute(address merchant, bytes32 invoiceId, address asset)
    external
    view
    returns (uint256 assetIn, uint256 priceUsd8, bool marketClosed, bytes32 strategyHash)
  {
    Invoice memory inv = _openInvoice(merchant, invoiceId);
    uint256 fee = address(wifRouter) != address(0) && asset != wifRouter.WIF() ? uint256(inv.amountUsdg) * protocolFeeBps / BPS : 0;
    return _quote(asset, uint256(inv.amountUsdg) + fee);
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

  /// @notice Called by NorenCredit when a Pay-in-3 plan funds the invoice.
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

  /// @dev Credit pays this fee out of its existing merchant fee after the vault disbursement.
  function accrueCreditFee(bytes32 invoiceId, uint256 fee) external {
    if (msg.sender != credit) revert NotCredit();
    if (address(wifRouter) == address(0) || fee == 0) return;
    uint256 burnPart = fee * burnShareBps / BPS;
    accruedUsdg += burnPart;
    if (fee > burnPart) usdg.safeTransfer(owner(), fee - burnPart);
    emit WifFeeAccrued(invoiceId, burnPart);
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
    bool wifMode = address(wifRouter) != address(0);
    uint256 fee = wifMode && asset != wifRouter.WIF() ? amount * protocolFeeBps / BPS : 0;
    uint256 total = amount + fee;
    uint256 priceUsd8;
    bytes32 strategyHash;
    (assetIn, priceUsd8,, strategyHash) = _quote(asset, total);
    if (assetIn > maxAssetIn) revert Slippage(assetIn, maxAssetIn);
    if (asset != NATIVE_ETH && msg.value != 0) revert BadValue();

    // effects
    inv.status = Status.Paid;
    inv.payer = msg.sender;
    inv.asset = asset == NATIVE_ETH ? address(weth) : asset;
    inv.assetIn = assetIn;

    // interactions
    if (wifMode && asset == wifRouter.WIF()) {
      IERC20(asset).forceApprove(address(wifRouter), maxAssetIn);
      IERC20(asset).safeTransferFrom(msg.sender, address(this), maxAssetIn);
      uint256 spent = wifRouter.wifForExactUsdg(amount, maxAssetIn, address(this));
      if (spent < maxAssetIn) IERC20(asset).safeTransfer(msg.sender, maxAssetIn - spent);
      assetIn = spent;
      inv.assetIn = spent;
      usdg.safeTransfer(merchant, amount);
    } else if (asset == address(usdg)) {
      usdg.safeTransferFrom(msg.sender, wifMode ? address(this) : merchant, total);
      if (wifMode) usdg.safeTransfer(merchant, amount);
    } else if (asset == NATIVE_ETH) {
      if (msg.value < assetIn) revert Slippage(assetIn, msg.value);
      weth.deposit{value: assetIn}();
      _convert(address(weth), strategyHash, merchant, wifMode ? address(this) : merchant, invoiceId, total, assetIn);
      uint256 refund = msg.value - assetIn;
      if (refund != 0) {
        (bool ok,) = msg.sender.call{value: refund}('');
        if (!ok) revert BadValue();
      }
    } else {
      address dest = strategyHash == bytes32(0) ? address(vault) : address(this);
      oracle.checkTransferable(asset, msg.sender, dest);
      uint256 before = IERC20(asset).balanceOf(dest);
      IERC20(asset).safeTransferFrom(msg.sender, dest, assetIn);
      uint256 got = IERC20(asset).balanceOf(dest) - before;
      if (got < assetIn) revert ReceivedShort(assetIn, got);
      _convert(asset, strategyHash, merchant, wifMode ? address(this) : merchant, invoiceId, total, assetIn);
    }
    if (wifMode && asset != address(usdg) && asset != wifRouter.WIF()) usdg.safeTransfer(merchant, amount);
    if (fee != 0) {
      uint256 burnPart = fee * burnShareBps / BPS;
      accruedUsdg += burnPart;
      if (fee > burnPart) usdg.safeTransfer(owner(), fee - burnPart);
      emit WifFeeAccrued(invoiceId, burnPart);
    }
    emit InvoicePaid(merchant, invoiceId, msg.sender, inv.asset, assetIn, amount, priceUsd8);
  }

  /// @dev Maker route: the asset (held here) is sold to the strategy and the maker pays the merchant.
  /// Vault route: the asset was sent to the vault, which pays the merchant from LP liquidity.
  function _convert(address priced, bytes32 strategyHash, address merchant, address recipient, bytes32 invoiceId, uint256 amount, uint256 assetIn)
    internal
  {
    if (strategyHash == bytes32(0)) {
      if (priced == address(weth)) IERC20(priced).safeTransfer(address(vault), assetIn);
      vault.disburse(recipient, amount);
      emit InvoiceRoutedToVault(merchant, invoiceId, assetIn);
      return;
    }
    IERC20(priced).forceApprove(address(liquidity), assetIn);
    (uint256 used, bytes32 filled) = liquidity.sellForUsdg(priced, amount, assetIn, recipient);
    if (used != assetIn || filled != strategyHash) revert ReceivedShort(assetIn, used);
    emit InvoiceRoutedToMaker(merchant, invoiceId, strategyHash, assetIn);
  }

  function _quote(address asset, uint256 amountUsdg)
    internal
    view
    returns (uint256 assetIn, uint256 priceUsd8, bool closed, bytes32 strategyHash)
  {
    if (address(wifRouter) != address(0) && asset == wifRouter.WIF()) {
      return (wifRouter.quoteWifForUsdg(amountUsdg), 0, false, bytes32(0));
    }
    // USDG settles 1:1 with no conversion, so it does not depend on a feed (priceUsd8 = 0).
    if (asset == address(usdg)) return (amountUsdg, 0, false, bytes32(0));
    address priced = asset == NATIVE_ETH ? address(weth) : asset;
    if (!oracle.isSupported(priced)) revert AssetNotAccepted(asset);
    if (address(liquidity) != address(0)) {
      (strategyHash, assetIn) = liquidity.bestQuoteForUsdg(priced, amountUsdg);
      if (strategyHash != bytes32(0)) {
        NorenAssetOracle.Price memory mp = oracle.price(priced);
        return (assetIn, mp.usd8, mp.marketClosed, strategyHash);
      }
      if (!vaultFallback) revert NoMakerLiquidity(asset, amountUsdg);
    }
    uint256 usd8 = oracle.usdgToUsd8(amountUsdg, Math.Rounding.Ceil);
    NorenAssetOracle.Price memory p;
    (assetIn, p) = oracle.assetForUsd8(priced, usd8, spreadBps[priced]);
    return (assetIn, p.usd8, p.marketClosed, bytes32(0));
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
