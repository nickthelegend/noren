// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from '@oz/access/Ownable2Step.sol';
import {ERC20} from '@oz/token/ERC20/ERC20.sol';
import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {IERC20Metadata} from '@oz/token/ERC20/extensions/IERC20Metadata.sol';
import {ERC4626} from '@oz/token/ERC20/extensions/ERC4626.sol';
import {SafeERC20} from '@oz/token/ERC20/utils/SafeERC20.sol';
import {Math} from '@oz/utils/math/Math.sol';
import {ReentrancyGuard} from '@oz/utils/ReentrancyGuard.sol';
import {NorenAssetOracle} from './NorenAssetOracle.sol';
import {NorenLiquidity} from './NorenLiquidity.sol';
import {IAqua, ISwapVMRouter} from './interfaces/IAquaSwapVM.sol';
import {IWETH} from './interfaces/IWETH.sol';

/// @title NorenDepositVault
/// @notice "Noren ETH deposit" (nETH), "Noren NVDA deposit" (nNVDA), ...: an ERC-4626 vault for one
/// asset (WETH or a Robinhood Stock Token) whose deposits back a 1inch Aqua maker strategy
/// (NorenOraclePeg through NorenLiquidity) with the vault as the maker.
///
/// - Deposits are pushed into the strategy's Aqua virtual balance. The tokens never leave the vault
///   until a fill: Aqua only records the allocation, and NorenOraclePeg refuses any fill the vault's
///   real balance cannot cover.
/// - Ask side: a buyer takes the asset at the Chainlink price plus the ask spread; the USDG it pays
///   lands in the vault and is pushed into the strategy's USDG virtual balance.
/// - Bid side: with that USDG the vault buys the asset back at the Chainlink price minus the bid
///   spread, for example when a Noren customer pays a merchant with ETH or a Stock Token.
/// - Each fill adds exactly its spread to the vault's value at that moment's Chainlink price; that
///   is the depositors' yield. NorenLiquidity books every fill it routes (`strategy(h).feesUsdg`).
///
/// NAV in the asset = asset balance + USDG balance converted at the validated Chainlink price. While
/// the vault holds USDG from a sale, that part also moves with the asset's price (inventory mark);
/// `stats()` reports it separately from realised fees.
///
/// Withdrawals in the asset are limited to the asset the vault holds now (`LiquidityInUse` names the
/// amount available). `redeemInKind` always works: it pays the shares' pro-rata asset and USDG and
/// needs no price.
contract NorenDepositVault is ERC4626, Ownable2Step, ReentrancyGuard {
  using SafeERC20 for IERC20;
  using Math for uint256;

  NorenAssetOracle public immutable oracle;
  NorenLiquidity public immutable liquidity;
  IERC20 public immutable usdg;
  /// @notice True for the WETH vault: depositETH / redeemETH wrap and unwrap native ETH.
  bool public immutable isWeth;

  /// @notice The active Aqua strategy (0 = none shipped).
  bytes32 public strategyHash;
  bytes32[] internal _strategyHistory;
  /// @notice Timestamp of the first deposit: the start of the observed yield window.
  uint64 public firstDepositAt;

  /// @dev Fee-per-share accumulator scale: USDG (6 dp) x 1e36 / share (24 dp).
  uint256 internal constant ACC = 1e36;
  /// @dev Realised maker fees per share up to the last mint or burn. Fills never change the share
  /// supply, so checkpointing at every mint and burn attributes each fee to exactly the shares that
  /// existed when it was booked.
  uint256 internal _feeAcc;
  uint256 internal _feesCheckpointed;
  /// @notice The only address allowed to call `harvestUsdg` (NorenBorrow, for loans repaid by yield).
  address public harvester;

  struct Stats {
    uint256 assetBalance; // raw asset units held
    uint256 usdgBalance; // USDG (6 decimals) held from ask-side sales
    uint256 totalAssets; // NAV in raw asset units (USDG at Chainlink)
    uint256 totalSupply; // shares
    uint256 assetsPerShare; // raw asset units per 10**decimals() shares
    uint256 navUsd8; // NAV in USD (8 decimals) at Chainlink
    uint256 feesUsdg; // realised spread fees booked by NorenLiquidity over every strategy this vault shipped
    uint256 fills;
    uint256 volumeUsdg;
    uint64 firstDepositAt;
    bytes32 strategyHash;
    bool priced; // false when a feed is stale: NAV fields are then 0 and only redeemInKind works
  }

  event StrategyShipped(bytes32 indexed strategyHash, uint256 assetVirtual, uint256 usdgVirtual);
  event StrategyDocked(bytes32 indexed strategyHash);
  event RedeemedInKind(address indexed caller, address indexed receiver, address indexed owner, uint256 shares, uint256 assets, uint256 usdgOut);
  event HarvesterSet(address indexed harvester);
  event YieldHarvested(address indexed owner, address indexed receiver, uint256 shares, uint256 usdgOut);

  error NotSupported(address asset);
  error StrategyActive(bytes32 strategyHash);
  error NoStrategy();
  error LiquidityInUse(uint256 requested, uint256 availableNow, uint256 usdgHeld);
  error NotWethVault();
  error EthTransferFailed();
  error ZeroShares();
  error NotHarvester();
  error NotEnoughUsdg(uint256 requested, uint256 held);

  constructor(
    address owner_,
    IERC20 asset_,
    NorenAssetOracle oracle_,
    NorenLiquidity liquidity_,
    bool isWeth_,
    string memory name_,
    string memory symbol_
  ) ERC20(name_, symbol_) ERC4626(asset_) Ownable(owner_) {
    if (address(asset_) == oracle_.usdg() || !oracle_.isSupported(address(asset_))) revert NotSupported(address(asset_));
    oracle = oracle_;
    liquidity = liquidity_;
    usdg = IERC20(oracle_.usdg());
    isWeth = isWeth_;
  }

  receive() external payable {
    if (!isWeth || msg.sender != asset()) revert NotWethVault();
  }

  // ---------------------------------------------------------------- Aqua strategy (owner)

  /// @notice Ship the vault's NorenOraclePeg strategy with everything the vault holds as virtual
  /// balances, and register it with NorenLiquidity. Later deposits are pushed into it.
  function shipStrategy(NorenLiquidity.PegTerms calldata t) external onlyOwner returns (bytes32 h) {
    if (strategyHash != bytes32(0)) revert StrategyActive(strategyHash);
    IAqua aqua = liquidity.aqua();
    ISwapVMRouter.Order memory o;
    (o, h) = liquidity.buildOrder(address(this), asset(), t);
    IERC20(asset()).forceApprove(address(aqua), type(uint256).max);
    usdg.forceApprove(address(aqua), type(uint256).max);
    uint256[] memory amounts = new uint256[](2);
    amounts[0] = usdg.balanceOf(address(this));
    amounts[1] = IERC20(asset()).balanceOf(address(this));
    aqua.ship(address(liquidity.router()), abi.encode(o), _pair(), amounts);
    liquidity.register(asset(), t);
    strategyHash = h;
    _strategyHistory.push(h);
    emit StrategyShipped(h, amounts[1], amounts[0]);
  }

  /// @notice Dock the strategy on Aqua and remove it from Noren routing (e.g. to change spreads).
  function dockStrategy() external onlyOwner {
    bytes32 h = strategyHash;
    if (h == bytes32(0)) revert NoStrategy();
    liquidity.aqua().dock(address(liquidity.router()), h, _pair());
    liquidity.remove(h);
    strategyHash = bytes32(0);
    emit StrategyDocked(h);
  }

  /// @notice Set the contract allowed to take realised fees out in USDG (NorenBorrow).
  function setHarvester(address h) external onlyOwner {
    harvester = h;
    emit HarvesterSet(h);
  }

  // ---------------------------------------------------------------- ERC-4626

  function deposit(uint256 assets, address receiver) public override nonReentrant returns (uint256) {
    return super.deposit(assets, receiver);
  }

  function mint(uint256 shares, address receiver) public override nonReentrant returns (uint256) {
    return super.mint(shares, receiver);
  }

  function withdraw(uint256 assets, address receiver, address owner_) public override nonReentrant returns (uint256) {
    _checkLiquidity(assets);
    return super.withdraw(assets, receiver, owner_);
  }

  function redeem(uint256 shares, address receiver, address owner_) public override nonReentrant returns (uint256) {
    _checkLiquidity(previewRedeem(shares));
    return super.redeem(shares, receiver, owner_);
  }

  /// @notice Deposit native ETH (WETH vault only).
  function depositETH(address receiver) external payable nonReentrant returns (uint256 shares) {
    if (!isWeth) revert NotWethVault();
    uint256 assets = msg.value;
    uint256 maxAssets = maxDeposit(receiver);
    if (assets > maxAssets) revert ERC4626ExceededMaxDeposit(receiver, assets, maxAssets);
    shares = previewDeposit(assets); // before wrapping: NAV must not include the new ETH yet
    IWETH(asset()).deposit{value: assets}();
    _afterIntake(receiver, assets, shares);
  }

  /// @notice Redeem shares for native ETH (WETH vault only).
  function redeemETH(uint256 shares, address payable receiver, address owner_) external nonReentrant returns (uint256 assets) {
    if (!isWeth) revert NotWethVault();
    uint256 maxShares = maxRedeem(owner_);
    if (shares > maxShares) revert ERC4626ExceededMaxRedeem(owner_, shares, maxShares);
    assets = previewRedeem(shares);
    _checkLiquidity(assets);
    if (msg.sender != owner_) _spendAllowance(owner_, msg.sender, shares);
    _burn(owner_, shares);
    IWETH(asset()).withdraw(assets);
    (bool ok,) = receiver.call{value: assets}('');
    if (!ok) revert EthTransferFailed();
    emit Withdraw(msg.sender, receiver, owner_, assets, shares);
  }

  /// @notice Redeem `shares` for their pro-rata asset and USDG. Needs no price, so it works while
  /// part of the deposits is held as USDG and while a feed is stale.
  function redeemInKind(uint256 shares, address receiver, address owner_)
    external
    nonReentrant
    returns (uint256 assets, uint256 usdgOut)
  {
    if (shares == 0) revert ZeroShares();
    uint256 supply = totalSupply();
    if (shares > balanceOf(owner_)) revert ERC4626ExceededMaxRedeem(owner_, shares, balanceOf(owner_));
    assets = IERC20(asset()).balanceOf(address(this)).mulDiv(shares, supply);
    usdgOut = usdg.balanceOf(address(this)).mulDiv(shares, supply);
    if (msg.sender != owner_) _spendAllowance(owner_, msg.sender, shares);
    _burn(owner_, shares);
    if (assets != 0) IERC20(asset()).safeTransfer(receiver, assets);
    if (usdgOut != 0) usdg.safeTransfer(receiver, usdgOut);
    emit RedeemedInKind(msg.sender, receiver, owner_, shares, assets, usdgOut);
  }

  /// @notice Harvester only: burn `owner_`'s shares worth exactly `usdgAmount` at the validated
  /// Chainlink price (shares rounded up, in the remaining holders' favour) and pay that USDG from the
  /// USDG the vault already holds. Used to take a loan's realised fee yield out without a sale.
  /// Reverts when the vault holds less USDG than requested.
  function harvestUsdg(uint256 usdgAmount, address receiver, address owner_) external nonReentrant returns (uint256 shares) {
    if (msg.sender != harvester || msg.sender == address(0)) revert NotHarvester();
    if (usdgAmount == 0) revert ZeroShares();
    uint256 held = usdg.balanceOf(address(this));
    if (usdgAmount > held) revert NotEnoughUsdg(usdgAmount, held);
    shares = sharesForUsdg(usdgAmount);
    if (owner_ != msg.sender) _spendAllowance(owner_, msg.sender, shares);
    _burn(owner_, shares);
    usdg.safeTransfer(receiver, usdgAmount);
    emit YieldHarvested(owner_, receiver, shares, usdgAmount);
  }

  /// @notice NAV in raw asset units: the asset held plus USDG converted at the validated Chainlink price.
  function totalAssets() public view override returns (uint256) {
    uint256 a = IERC20(asset()).balanceOf(address(this));
    uint256 u = usdg.balanceOf(address(this));
    return u == 0 ? a : a + _usdgToAsset(u);
  }

  /// @notice Asset withdrawable now: the pro-rata share, capped by the asset the vault holds.
  function maxWithdraw(address owner_) public view override returns (uint256) {
    return Math.min(super.maxWithdraw(owner_), IERC20(asset()).balanceOf(address(this)));
  }

  function maxRedeem(address owner_) public view override returns (uint256) {
    uint256 byBalance = _convertToShares(IERC20(asset()).balanceOf(address(this)), Math.Rounding.Floor);
    return Math.min(super.maxRedeem(owner_), byBalance);
  }

  // ---------------------------------------------------------------- views

  /// @notice Raw asset and USDG that `shares` redeem in kind.
  function inKind(uint256 shares) public view returns (uint256 assets, uint256 usdgAmount) {
    uint256 supply = totalSupply();
    if (supply == 0 || shares == 0) return (0, 0);
    assets = IERC20(asset()).balanceOf(address(this)).mulDiv(shares, supply);
    usdgAmount = usdg.balanceOf(address(this)).mulDiv(shares, supply);
  }

  /// @notice Chainlink value (USD, 8 decimals) of `shares`. `risk` applies the closed-market haircut
  /// to the asset part (used for new borrowing); health checks use risk = false.
  function sharesValueUsd8(uint256 shares, bool risk) external view returns (uint256 v) {
    (uint256 a, uint256 u) = inKind(shares);
    if (a != 0) v = risk ? oracle.riskValueUsd8(asset(), a) : oracle.valueUsd8(asset(), a);
    if (u != 0) v += oracle.usdgToUsd8(u, Math.Rounding.Floor);
  }

  /// @notice Shares worth `usdgAmount` USDG at the validated Chainlink price, rounded up.
  function sharesForUsdg(uint256 usdgAmount) public view returns (uint256) {
    if (usdgAmount == 0) return 0;
    uint256 usd8 = oracle.usdgToUsd8(usdgAmount, Math.Rounding.Ceil);
    NorenAssetOracle.Price memory p = oracle.price(asset());
    uint256 dec = IERC20Metadata(asset()).decimals();
    uint256 assetUnits = usd8.mulDiv(10 ** dec * 1e18, p.usd8 * oracle.multiplier(asset()), Math.Rounding.Ceil);
    return _convertToShares(assetUnits, Math.Rounding.Ceil);
  }

  /// @notice Realised maker fees earned per share since the vault opened (USDG x 1e36 per share).
  /// A holder's fee yield between two readings = shares x (later - earlier) / 1e36, in USDG.
  function feesPerShare() public view returns (uint256 acc) {
    acc = _feeAcc;
    uint256 supply = totalSupply();
    if (supply == 0) return acc;
    (uint256 fees,,) = feeBook();
    if (fees > _feesCheckpointed) acc += (fees - _feesCheckpointed).mulDiv(ACC, supply);
  }

  function strategyHistory() external view returns (bytes32[] memory) {
    return _strategyHistory;
  }

  /// @notice Realised fees, fills and volume over every strategy this vault shipped (NorenLiquidity's book).
  function feeBook() public view returns (uint256 feesUsdg, uint256 fills, uint256 volumeUsdg) {
    for (uint256 i; i < _strategyHistory.length; ++i) {
      NorenLiquidity.Strategy memory s = liquidity.strategy(_strategyHistory[i]);
      feesUsdg += s.feesUsdg;
      fills += s.fills;
      volumeUsdg += s.volumeUsdg;
    }
  }

  function stats() external view returns (Stats memory s) {
    s.assetBalance = IERC20(asset()).balanceOf(address(this));
    s.usdgBalance = usdg.balanceOf(address(this));
    s.totalSupply = totalSupply();
    (s.feesUsdg, s.fills, s.volumeUsdg) = feeBook();
    s.firstDepositAt = firstDepositAt;
    s.strategyHash = strategyHash;
    try this.navUsd8() returns (uint256 nav, uint256 ta) {
      s.navUsd8 = nav;
      s.totalAssets = ta;
      s.assetsPerShare = _convertToAssets(10 ** decimals(), Math.Rounding.Floor);
      s.priced = true;
    } catch {}
  }

  /// @notice NAV in USD (8 decimals) and in raw asset units. Reverts when a feed is stale.
  function navUsd8() external view returns (uint256 nav, uint256 assetsTotal) {
    uint256 a = IERC20(asset()).balanceOf(address(this));
    uint256 u = usdg.balanceOf(address(this));
    nav = (a == 0 ? 0 : oracle.valueUsd8(asset(), a)) + (u == 0 ? 0 : oracle.usdgToUsd8(u, Math.Rounding.Floor));
    assetsTotal = totalAssets();
  }

  // ---------------------------------------------------------------- internal

  function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
    oracle.checkTransferable(asset(), caller, address(this));
    super._deposit(caller, receiver, assets, shares);
    _afterIntakeAccounting(assets);
  }

  /// @dev Checkpoint the fee accumulator before the share supply changes (mint or burn).
  function _update(address from, address to, uint256 value) internal override {
    if (from == address(0) || to == address(0)) {
      (uint256 fees,,) = feeBook();
      uint256 supply = totalSupply();
      if (supply != 0 && fees > _feesCheckpointed) _feeAcc += (fees - _feesCheckpointed).mulDiv(ACC, supply);
      _feesCheckpointed = fees;
    }
    super._update(from, to, value);
  }

  function _afterIntake(address receiver, uint256 assets, uint256 shares) internal {
    _mint(receiver, shares);
    emit Deposit(msg.sender, receiver, assets, shares);
    _afterIntakeAccounting(assets);
  }

  /// @dev Push the new deposit into the strategy's Aqua virtual balance (a self-transfer through
  /// Aqua: the tokens stay in the vault, only the allocation grows).
  function _afterIntakeAccounting(uint256 assets) internal {
    if (firstDepositAt == 0) firstDepositAt = uint64(block.timestamp);
    bytes32 h = strategyHash;
    if (h != bytes32(0) && assets != 0) {
      liquidity.aqua().push(address(this), address(liquidity.router()), h, asset(), assets);
    }
  }

  function _checkLiquidity(uint256 assets) internal view {
    uint256 held = IERC20(asset()).balanceOf(address(this));
    if (assets > held) revert LiquidityInUse(assets, held, usdg.balanceOf(address(this)));
  }

  /// @dev USDG (6 decimals) to raw asset units at Chainlink (floor): usd8 * 10^dec * 1e18 / (price8 * mult).
  function _usdgToAsset(uint256 u) internal view returns (uint256) {
    uint256 usd8 = oracle.usdgToUsd8(u, Math.Rounding.Floor);
    NorenAssetOracle.Price memory p = oracle.price(asset());
    uint256 dec = IERC20Metadata(asset()).decimals();
    return usd8.mulDiv(10 ** dec * 1e18, p.usd8 * oracle.multiplier(asset()));
  }

  function _pair() internal view returns (address[] memory tokens) {
    tokens = new address[](2);
    tokens[0] = address(usdg);
    tokens[1] = asset();
  }

  /// @dev 6 extra share decimals blunt the ERC-4626 first-deposit inflation attack (as NorenVault).
  function _decimalsOffset() internal pure override returns (uint8) {
    return 6;
  }
}
