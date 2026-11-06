// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from '@oz/access/Ownable2Step.sol';
import {IERC20Metadata} from '@oz/token/ERC20/extensions/IERC20Metadata.sol';
import {Math} from '@oz/utils/math/Math.sol';
import {IAggregatorV3} from './interfaces/IAggregatorV3.sol';
import {IRobinhoodStockToken, IRobinhoodRegistry} from './interfaces/IRobinhoodStockToken.sol';

/// @title NorenAssetOracle
/// @notice Prices Noren assets from Chainlink Data Feeds on Robinhood Chain with the Data Feeds
/// safety rules: feed decimals() read live on every call, answer > 0, a complete round,
/// no future timestamps, and a per-asset maximum age. Stock feeds stop while US markets are
/// closed, so stock assets get a longer maximum age inside the weekend/holiday window and a
/// haircut on new risk taken during that window. Stock Token amounts are converted to shares
/// with the token's live uiMultiplier().
contract NorenAssetOracle is Ownable2Step {
  using Math for uint256;

  uint256 internal constant BPS = 10_000;
  uint256 internal constant USD8 = 1e8;
  /// @dev Monday 06:00 UTC: the closed window ends 6 h after Robinhood 24/5 trading resumes.
  uint256 internal constant MONDAY_REOPEN_BUFFER = 6 hours;

  struct AssetConfig {
    address feed;
    uint32 maxAgeOpen;
    uint32 maxAgeClosed;
    bool marketHours; // true for Stock Tokens (24/5); false for 24/7 assets (ETH, USDG)
    bool applyUiMultiplier; // true for Stock Tokens
    bool enabled;
  }

  struct Price {
    uint256 usd8; // price normalised to 8 decimals
    uint256 updatedAt;
    uint80 roundId;
    bool marketClosed;
  }

  address public immutable usdg;
  mapping(address asset => AssetConfig) public assetConfig;
  address[] internal _assets;
  mapping(uint256 utcDay => bool) public holiday;
  /// @notice USDG must trade within this band of $1 for any conversion to succeed.
  uint16 public usdgDepegBps = 200;
  /// @notice Extra haircut applied to Stock Token value for new risk taken while markets are closed.
  uint16 public closedHaircutBps = 500;

  event AssetConfigured(address indexed asset, address indexed feed, uint32 maxAgeOpen, uint32 maxAgeClosed, bool marketHours, bool applyUiMultiplier);
  event AssetDisabled(address indexed asset);
  event HolidaySet(uint256 indexed utcDay, bool closed);
  event RiskParamsSet(uint16 usdgDepegBps, uint16 closedHaircutBps);

  error AssetNotSupported(address asset);
  error InvalidPrice(address asset, int256 answer);
  error IncompleteRound(address asset, uint80 roundId, uint80 answeredInRound);
  error FuturePrice(address asset, uint256 updatedAt);
  error StalePrice(address asset, uint256 updatedAt, uint256 maxAge);
  error UsdgDepeg(uint256 priceUsd8);
  error BadConfig();
  error AssetPaused(address asset);
  error AccountBlocked(address asset, address account);

  constructor(address owner_, address usdg_) Ownable(owner_) {
    if (usdg_ == address(0)) revert BadConfig();
    usdg = usdg_;
  }

  // ---------------------------------------------------------------- admin

  function setAsset(address asset, address feed, uint32 maxAgeOpen, uint32 maxAgeClosed, bool marketHours, bool applyUiMultiplier)
    external
    onlyOwner
  {
    if (asset == address(0) || feed == address(0) || maxAgeOpen == 0 || maxAgeClosed < maxAgeOpen) revert BadConfig();
    // Probe the feed so a wrong address fails at configuration time, not at checkout.
    IAggregatorV3(feed).decimals();
    IAggregatorV3(feed).latestRoundData();
    if (applyUiMultiplier) IRobinhoodStockToken(asset).uiMultiplier();
    if (assetConfig[asset].feed == address(0)) _assets.push(asset);
    assetConfig[asset] = AssetConfig(feed, maxAgeOpen, maxAgeClosed, marketHours, applyUiMultiplier, true);
    emit AssetConfigured(asset, feed, maxAgeOpen, maxAgeClosed, marketHours, applyUiMultiplier);
  }

  function disableAsset(address asset) external onlyOwner {
    assetConfig[asset].enabled = false;
    emit AssetDisabled(asset);
  }

  /// @notice Mark a NYSE holiday (UTC day index = timestamp / 1 days) as closed.
  function setHoliday(uint256 utcDay, bool closed) external onlyOwner {
    holiday[utcDay] = closed;
    emit HolidaySet(utcDay, closed);
  }

  function setRiskParams(uint16 depegBps, uint16 haircutBps) external onlyOwner {
    if (depegBps > 1_000 || haircutBps > 5_000) revert BadConfig();
    usdgDepegBps = depegBps;
    closedHaircutBps = haircutBps;
    emit RiskParamsSet(depegBps, haircutBps);
  }

  // ---------------------------------------------------------------- views

  function assets() external view returns (address[] memory) {
    return _assets;
  }

  function isSupported(address asset) public view returns (bool) {
    return assetConfig[asset].enabled;
  }

  /// @notice True inside the window when US-equity Stock Token feeds do not update:
  /// Saturday and Sunday (UTC), Monday until 06:00 UTC, and owner-marked holidays (plus 6 h after).
  function marketClosed(uint256 ts) public view returns (bool) {
    uint256 day = ts / 1 days;
    uint256 secondOfDay = ts % 1 days;
    uint256 dow = (day + 4) % 7; // 1970-01-01 was a Thursday; 0 = Sunday
    if (dow == 6 || dow == 0) return true;
    if (dow == 1 && secondOfDay < MONDAY_REOPEN_BUFFER) return true;
    if (holiday[day]) return true;
    if (day > 0 && holiday[day - 1] && secondOfDay < MONDAY_REOPEN_BUFFER) return true;
    return false;
  }

  /// @notice Validated Chainlink price for `asset`, normalised to 8 decimals.
  function price(address asset) public view returns (Price memory p) {
    AssetConfig memory c = assetConfig[asset];
    if (!c.enabled) revert AssetNotSupported(asset);
    IAggregatorV3 feed = IAggregatorV3(c.feed);
    (uint80 roundId, int256 answer,, uint256 updatedAt, uint80 answeredInRound) = feed.latestRoundData();
    if (answer <= 0) revert InvalidPrice(asset, answer);
    if (updatedAt == 0 || answeredInRound < roundId) revert IncompleteRound(asset, roundId, answeredInRound);
    if (updatedAt > block.timestamp) revert FuturePrice(asset, updatedAt);
    bool closed = c.marketHours && marketClosed(block.timestamp);
    uint256 maxAge = closed ? c.maxAgeClosed : c.maxAgeOpen;
    if (block.timestamp - updatedAt > maxAge) revert StalePrice(asset, updatedAt, maxAge);
    uint8 dec = feed.decimals(); // read live: never assume 8
    uint256 raw = uint256(answer);
    p.usd8 = dec == 8 ? raw : dec > 8 ? raw / 10 ** (dec - 8) : raw * 10 ** (8 - dec);
    if (p.usd8 == 0) revert InvalidPrice(asset, answer);
    p.updatedAt = updatedAt;
    p.roundId = roundId;
    p.marketClosed = closed;
  }

  /// @notice Validated USDG/USD price; reverts outside the depeg band.
  function usdgPrice() public view returns (uint256 usd8) {
    usd8 = price(usdg).usd8;
    uint256 band = USD8 * usdgDepegBps / BPS;
    if (usd8 < USD8 - band || usd8 > USD8 + band) revert UsdgDepeg(usd8);
  }

  /// @notice 1e18-scaled shares per raw token unit (1e18 for non-stock assets).
  function multiplier(address asset) public view returns (uint256) {
    return assetConfig[asset].applyUiMultiplier ? IRobinhoodStockToken(asset).uiMultiplier() : 1e18;
  }

  /// @notice USD value (8 decimals) of `amount` raw units of `asset`, rounded down.
  function valueUsd8(address asset, uint256 amount) public view returns (uint256) {
    Price memory p = price(asset);
    return _value(asset, amount, p.usd8, Math.Rounding.Floor);
  }

  /// @notice Value used for new risk: valueUsd8 minus closedHaircutBps while a stock market is closed.
  function riskValueUsd8(address asset, uint256 amount) public view returns (uint256 v) {
    Price memory p = price(asset);
    v = _value(asset, amount, p.usd8, Math.Rounding.Floor);
    if (p.marketClosed) v = v * (BPS - closedHaircutBps) / BPS;
  }

  /// @notice Raw units of `asset` worth `usd8`, rounded up, grossed up by `spreadBps`
  /// (plus closedHaircutBps while the asset's market is closed).
  function assetForUsd8(address asset, uint256 usd8, uint256 spreadBps) public view returns (uint256 amount, Price memory p) {
    p = price(asset);
    uint256 dec = IERC20Metadata(asset).decimals();
    uint256 mult = multiplier(asset);
    // amount = usd8 * 10^dec * 1e18 / (price8 * mult)
    amount = usd8.mulDiv(10 ** dec * 1e18, p.usd8 * mult, Math.Rounding.Ceil);
    uint256 gross = BPS + spreadBps + (p.marketClosed ? closedHaircutBps : 0);
    amount = amount.mulDiv(gross, BPS, Math.Rounding.Ceil);
  }

  /// @notice USDG (6 decimals) to USD (8 decimals) at the validated USDG/USD price.
  function usdgToUsd8(uint256 amountUsdg, Math.Rounding r) public view returns (uint256) {
    return amountUsdg.mulDiv(usdgPrice(), 1e6, r);
  }

  /// @notice USD (8 decimals) to USDG (6 decimals) at the validated USDG/USD price.
  function usd8ToUsdg(uint256 usd8, Math.Rounding r) public view returns (uint256) {
    return usd8.mulDiv(1e6, usdgPrice(), r);
  }

  /// @notice Reverts with a readable error if a Stock Token is paused or either party is
  /// on Robinhood's blocklist, instead of letting the token revert with no reason.
  function checkTransferable(address asset, address from, address to) external view {
    if (!assetConfig[asset].applyUiMultiplier) return;
    IRobinhoodStockToken t = IRobinhoodStockToken(asset);
    if (t.paused() || t.tokenPaused()) revert AssetPaused(asset);
    IRobinhoodRegistry reg = IRobinhoodRegistry(t.ACCESS_CONTROLLED_REGISTRY());
    if (reg.paused()) revert AssetPaused(asset);
    if (from != address(0) && reg.isBlocked(from)) revert AccountBlocked(asset, from);
    if (to != address(0) && reg.isBlocked(to)) revert AccountBlocked(asset, to);
  }

  function _value(address asset, uint256 amount, uint256 price8, Math.Rounding r) internal view returns (uint256) {
    uint256 dec = IERC20Metadata(asset).decimals();
    // usd8 = amount * mult / 1e18 * price8 / 10^dec
    return amount.mulDiv(multiplier(asset) * price8, 1e18 * 10 ** dec, r);
  }
}
