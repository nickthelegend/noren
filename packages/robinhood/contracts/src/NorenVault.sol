// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from '@oz/access/Ownable2Step.sol';
import {ERC20} from '@oz/token/ERC20/ERC20.sol';
import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {IERC20Permit} from '@oz/token/ERC20/extensions/IERC20Permit.sol';
import {ERC4626} from '@oz/token/ERC20/extensions/ERC4626.sol';
import {SafeERC20} from '@oz/token/ERC20/utils/SafeERC20.sol';
import {Math} from '@oz/utils/math/Math.sol';
import {ReentrancyGuard} from '@oz/utils/ReentrancyGuard.sol';
import {NorenAssetOracle} from './NorenAssetOracle.sol';
import {INorenVault, INorenReceivables} from './interfaces/INorenVault.sol';
import {IAqua, ISwapVMRouter, INorenLiquidityMaker} from './interfaces/IAquaSwapVM.sol';

/// @title NorenVault
/// @notice USDG liquidity for Noren. LPs deposit USDG for shares (ERC-4626). Approved modules
/// (the gateway and the credit contract) draw USDG to pay merchants. The vault keeps the
/// assets customers pay with (ETH as WETH, Stock Tokens) as inventory and sells it back to
/// anyone at the Chainlink price plus a spread. NAV = idle USDG + receivables + inventory
/// valued by NorenAssetOracle. Withdrawals are limited to idle USDG.
///
/// The owner can also make idle USDG back 1inch Aqua maker strategies (NorenOraclePeg via
/// NorenLiquidity): Aqua only records a virtual balance, the USDG stays here until a fill pulls it,
/// and the asset bought lands here as inventory, so NAV accounting is unchanged. Virtual balances
/// may exceed idle USDG (LP withdrawals and disbursements come first); the instruction then
/// refuses fills the vault cannot cover and Noren routes to another maker or the vault fallback.
contract NorenVault is ERC4626, Ownable2Step, ReentrancyGuard, INorenVault {
  using SafeERC20 for IERC20;
  using Math for uint256;

  uint256 internal constant BPS = 10_000;

  NorenAssetOracle public immutable oracle;
  INorenReceivables public credit;
  mapping(address module => bool) public isModule;
  /// @notice Spread charged when the vault sells inventory back (bps over the oracle price).
  uint16 public inventorySpreadBps = 50;

  event ModuleSet(address indexed module, bool allowed);
  event CreditSet(address indexed credit);
  event Disbursed(address indexed module, address indexed to, uint256 amountUsdg);
  event InventorySold(address indexed buyer, address indexed asset, uint256 amount, uint256 usdgIn, uint256 priceUsd8);
  event InventorySpreadSet(uint16 bps);
  event AquaStrategyShipped(bytes32 indexed strategyHash, address indexed asset, uint256 usdgVirtual);
  event AquaStrategyDocked(bytes32 indexed strategyHash, address indexed asset);

  error NotModule(address caller);
  error InsufficientLiquidity(uint256 requested, uint256 idle);
  error NotInventory(address asset);
  error Slippage(uint256 required, uint256 max);
  error BadConfig();

  constructor(address owner_, IERC20 usdg_, NorenAssetOracle oracle_)
    ERC20('Noren Vault USDG', 'nvUSDG')
    ERC4626(usdg_)
    Ownable(owner_)
  {
    if (address(oracle_) == address(0) || oracle_.usdg() != address(usdg_)) revert BadConfig();
    oracle = oracle_;
  }

  // ---------------------------------------------------------------- admin

  function setModule(address module, bool allowed) external onlyOwner {
    isModule[module] = allowed;
    emit ModuleSet(module, allowed);
  }

  function setCredit(INorenReceivables credit_) external onlyOwner {
    credit = credit_;
    emit CreditSet(address(credit_));
  }

  function setInventorySpread(uint16 bps) external onlyOwner {
    if (bps > 1_000) revert BadConfig();
    inventorySpreadBps = bps;
    emit InventorySpreadSet(bps);
  }

  // ---------------------------------------------------------------- Aqua maker (owner)

  /// @notice Ship a vault-backed Aqua strategy for `token` with `usdgVirtual` of virtual USDG and
  /// register it with NorenLiquidity. No USDG leaves the vault until a fill.
  function shipAquaStrategy(
    INorenLiquidityMaker liquidity,
    address token,
    INorenLiquidityMaker.PegTerms calldata t,
    uint256 usdgVirtual
  ) external onlyOwner returns (bytes32 strategyHash) {
    if (token == asset() || !oracle.isSupported(token)) revert NotInventory(token);
    IAqua aqua = liquidity.aqua();
    ISwapVMRouter.Order memory o;
    (o, strategyHash) = liquidity.buildOrder(address(this), token, t);
    IERC20(asset()).forceApprove(address(aqua), type(uint256).max);
    IERC20(token).forceApprove(address(aqua), type(uint256).max); // lets the strategy resell inventory
    aqua.ship(address(liquidity.router()), abi.encode(o), _pair(token), _amounts(usdgVirtual));
    liquidity.register(token, t);
    emit AquaStrategyShipped(strategyHash, token, usdgVirtual);
  }

  /// @notice Dock a vault-backed strategy on Aqua (virtual balances to zero) and remove it from routing.
  function dockAquaStrategy(INorenLiquidityMaker liquidity, bytes32 strategyHash, address token) external onlyOwner {
    liquidity.aqua().dock(address(liquidity.router()), strategyHash, _pair(token));
    liquidity.remove(strategyHash);
    emit AquaStrategyDocked(strategyHash, token);
  }

  function _pair(address token) internal view returns (address[] memory tokens) {
    tokens = new address[](2);
    tokens[0] = asset();
    tokens[1] = token;
  }

  function _amounts(uint256 usdgVirtual) internal pure returns (uint256[] memory amounts) {
    amounts = new uint256[](2);
    amounts[0] = usdgVirtual;
  }

  // ---------------------------------------------------------------- modules

  /// @inheritdoc INorenVault
  function disburse(address to, uint256 amountUsdg) external nonReentrant {
    if (!isModule[msg.sender]) revert NotModule(msg.sender);
    uint256 idle = idleUsdg();
    if (amountUsdg > idle) revert InsufficientLiquidity(amountUsdg, idle);
    IERC20(asset()).safeTransfer(to, amountUsdg);
    emit Disbursed(msg.sender, to, amountUsdg);
  }

  // ---------------------------------------------------------------- inventory

  /// @notice Buy `amount` of vault inventory (`invAsset`) for USDG at the oracle price plus spread
  /// (plus the closed-market haircut while US markets are closed).
  function buyInventory(address invAsset, uint256 amount, uint256 maxUsdgIn) external nonReentrant returns (uint256 usdgIn) {
    if (invAsset == asset() || !oracle.isSupported(invAsset)) revert NotInventory(invAsset);
    oracle.checkTransferable(invAsset, address(this), msg.sender);
    NorenAssetOracle.Price memory p = oracle.price(invAsset);
    uint256 usd8 = oracle.valueUsd8(invAsset, amount);
    uint256 gross = BPS + inventorySpreadBps + (p.marketClosed ? oracle.closedHaircutBps() : 0);
    usdgIn = oracle.usd8ToUsdg(usd8.mulDiv(gross, BPS, Math.Rounding.Ceil), Math.Rounding.Ceil);
    if (usdgIn > maxUsdgIn) revert Slippage(usdgIn, maxUsdgIn);
    IERC20(asset()).safeTransferFrom(msg.sender, address(this), usdgIn);
    IERC20(invAsset).safeTransfer(msg.sender, amount);
    emit InventorySold(msg.sender, invAsset, amount, usdgIn, p.usd8);
  }

  // ---------------------------------------------------------------- accounting

  function idleUsdg() public view returns (uint256) {
    return IERC20(asset()).balanceOf(address(this));
  }

  /// @notice USDG value of inventory held by the vault, at validated oracle prices.
  function inventoryUsdg() public view returns (uint256 total) {
    address[] memory list = oracle.assets();
    address usdg = asset();
    for (uint256 i; i < list.length; ++i) {
      address a = list[i];
      if (a == usdg || !oracle.isSupported(a)) continue;
      uint256 bal = IERC20(a).balanceOf(address(this));
      if (bal == 0) continue;
      total += oracle.usd8ToUsdg(oracle.valueUsd8(a, bal), Math.Rounding.Floor);
    }
  }

  function receivablesUsdg() public view returns (uint256) {
    return address(credit) == address(0) ? 0 : credit.receivablesUsdg();
  }

  function totalAssets() public view override returns (uint256) {
    return idleUsdg() + receivablesUsdg() + inventoryUsdg();
  }

  function maxWithdraw(address owner_) public view override returns (uint256) {
    return Math.min(super.maxWithdraw(owner_), idleUsdg());
  }

  function maxRedeem(address owner_) public view override returns (uint256) {
    uint256 byIdle = _convertToShares(idleUsdg(), Math.Rounding.Floor);
    return Math.min(super.maxRedeem(owner_), byIdle);
  }

  /// @notice EIP-2612 deposit: USDG on Robinhood Chain implements permit (probed on the fork).
  function depositWithPermit(uint256 assets, address receiver, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
    external
    returns (uint256 shares)
  {
    try IERC20Permit(asset()).permit(msg.sender, address(this), assets, deadline, v, r, s) {} catch {}
    return deposit(assets, receiver);
  }

  function _decimalsOffset() internal pure override returns (uint8) {
    return 6;
  }
}
