// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from '@oz/access/Ownable2Step.sol';
import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {SafeERC20} from '@oz/token/ERC20/utils/SafeERC20.sol';
import {Math} from '@oz/utils/math/Math.sol';
import {ReentrancyGuard} from '@oz/utils/ReentrancyGuard.sol';
import {NorenAssetOracle} from './NorenAssetOracle.sol';
import {IAqua, ISwapVMRouter, INorenLiquidity} from './interfaces/IAquaSwapVM.sol';

/// @title NorenLiquidity
/// @notice Noren's liquidity and liquidation layer on 1inch Aqua + SwapVM (Robinhood Chain).
///
/// Makers (merchants or LPs with idle USDG) keep USDG in their own wallets, approve Aqua once and
/// ship an Aqua strategy whose SwapVM program is a single NorenOraclePeg instruction: buy a Stock
/// Token or WETH at the Chainlink price minus a bid spread, and resell it at the Chainlink price
/// plus an ask spread. This contract builds that canonical program (feeds and maximum ages come
/// from NorenAssetOracle), keeps the registry of active strategies per asset, routes Noren's
/// conversions (pay with stocks, liquidations) to the best maker quote, and books each maker's
/// spread income at the Chainlink price.
///
/// Orders are Aqua orders (no signature, no hooks, maker is the receiver) so a registered
/// strategy can never call back into Noren during settlement.
contract NorenLiquidity is Ownable2Step, ReentrancyGuard, INorenLiquidity {
  using SafeERC20 for IERC20;
  using Math for uint256;

  uint256 internal constant BPS = 10_000;
  /// @dev SwapVM MakerTraits: useAquaInsteadOfSignature, receiver = maker, no hooks.
  uint256 public constant AQUA_TRAITS = 1 << 254;
  /// @dev SwapVM AquaOpcodes Controls._salt (lets one maker ship several otherwise equal strategies).
  uint8 public constant OP_SALT = 20;
  uint16 public constant ONE_SIDED = type(uint16).max;
  uint8 internal constant FLAG_UI_MULTIPLIER = 0x01;
  uint8 internal constant FLAG_MARKET_HOURS = 0x02;
  /// @dev TakerTraits flags: exact-in, and pay the maker via transferFrom + Aqua.push.
  uint16 internal constant TAKER_EXACT_IN = 0x0001;
  uint16 internal constant TAKER_TRANSFER_FROM_AND_AQUA_PUSH = 0x0040;

  struct PegTerms {
    uint16 bidSpreadBps; // maker buys the asset at oracle * (1 - bid)
    uint16 askSpreadBps; // maker resells at oracle * (1 + ask); ONE_SIDED = buy only
    uint16 closedExtraBps; // added to both spreads while US markets are closed (stocks)
    uint64 minPriceUsd8; // maker circuit breaker (0 = off)
    uint64 maxPriceUsd8; // maker circuit breaker (0 = off)
    uint64 salt;
  }

  struct Strategy {
    address maker;
    address asset;
    bool active;
    uint16 bidSpreadBps;
    uint16 askSpreadBps;
    uint64 registeredAt;
    uint32 fills;
    uint256 volumeUsdg; // USDG paid out by the maker through Noren
    uint256 feesUsdg; // spread earned: Chainlink value of the asset bought minus USDG paid
    bytes data; // SwapVM order data (the program)
  }

  IAqua public immutable aqua;
  ISwapVMRouter public immutable router;
  NorenAssetOracle public immutable oracle;
  IERC20 public immutable usdg;
  uint8 public immutable pegOpcode;

  /// @notice Widest bid spread a strategy may register with (customers pay it).
  uint16 public maxSpreadBps = 300;
  /// @notice A liquidation may sell collateral at most this far below its Chainlink value.
  uint16 public maxLiquidationSlippageBps = 300;
  uint8 public maxStrategiesPerAsset = 8;

  mapping(bytes32 strategyHash => Strategy) internal _strategies;
  mapping(address asset => bytes32[]) internal _byAsset;
  mapping(address maker => bytes32[]) internal _byMaker;
  mapping(address maker => uint256) public makerFeesUsdg;
  /// @notice When on, only owner-approved makers may register (anti-squatting switch; off by default).
  bool public makerAllowlist;
  mapping(address maker => bool) public approvedMaker;

  event StrategyRegistered(
    bytes32 indexed strategyHash, address indexed maker, address indexed asset, uint16 bidSpreadBps, uint16 askSpreadBps
  );
  event StrategyRemoved(bytes32 indexed strategyHash, address indexed maker, address indexed asset);
  event MakerFill(
    bytes32 indexed strategyHash,
    address indexed maker,
    address indexed asset,
    address taker,
    uint256 assetIn,
    uint256 usdgOut,
    uint256 oracleValueUsdg,
    uint256 feeUsdg
  );
  /// @notice A maker sold `assetOut` of its inventory for `usdgIn` (ask side). fee = usdgIn - Chainlink value.
  event MakerSale(
    bytes32 indexed strategyHash,
    address indexed maker,
    address indexed asset,
    address taker,
    uint256 assetOut,
    uint256 usdgIn,
    uint256 oracleValueUsdg,
    uint256 feeUsdg
  );
  event CollateralLiquidated(
    address indexed asset, address indexed seller, uint256 amount, uint256 sold, uint256 bonus, uint256 proceedsUsdg, uint256 debtUsdg
  );
  event LimitsSet(uint16 maxSpreadBps, uint16 maxLiquidationSlippageBps, uint8 maxStrategiesPerAsset);
  event MakerAllowlistSet(bool on);
  event MakerApproved(address indexed maker, bool approved);

  error AssetNotSupported(address asset);
  error SpreadTooWide(uint16 bidSpreadBps, uint16 maxSpreadBps);
  error StrategyNotShipped(bytes32 strategyHash);
  error StrategyExists(bytes32 strategyHash);
  error TooManyStrategies(address asset);
  error UnknownStrategy(bytes32 strategyHash);
  error NotRemovable(bytes32 strategyHash);
  error NoMakerLiquidity(address asset, uint256 amount);
  error Slippage(uint256 required, uint256 limit);
  error LiquidationSlippage(uint256 valueUsd8, uint256 limitUsd8);
  error FillMismatch(uint256 amountIn, uint256 amountOut);
  error ReceivedShort(uint256 expected, uint256 received);
  error BadConfig();
  error MakerNotApproved(address maker);

  constructor(address owner_, IAqua aqua_, ISwapVMRouter router_, NorenAssetOracle oracle_) Ownable(owner_) {
    if (address(aqua_) == address(0) || router_.AQUA() != address(aqua_)) revert BadConfig();
    aqua = aqua_;
    router = router_;
    oracle = oracle_;
    usdg = IERC20(oracle_.usdg());
    pegOpcode = router_.NOREN_ORACLE_PEG_OPCODE();
  }

  function setLimits(uint16 maxSpread, uint16 maxLiqSlippage, uint8 maxPerAsset) external onlyOwner {
    if (maxSpread >= 2_000 || maxLiqSlippage >= 2_000 || maxPerAsset == 0 || maxPerAsset > 32) revert BadConfig();
    maxSpreadBps = maxSpread;
    maxLiquidationSlippageBps = maxLiqSlippage;
    maxStrategiesPerAsset = maxPerAsset;
    emit LimitsSet(maxSpread, maxLiqSlippage, maxPerAsset);
  }

  /// @notice Turn the maker allowlist on or off. Registration is permissionless while it is off, so
  /// anyone can fill an asset's `maxStrategiesPerAsset` slots; the owner can then remove squatters
  /// (`remove`) and switch this on.
  function setMakerAllowlist(bool on) external onlyOwner {
    makerAllowlist = on;
    emit MakerAllowlistSet(on);
  }

  function setMakerApproved(address maker, bool approved) external onlyOwner {
    approvedMaker[maker] = approved;
    emit MakerApproved(maker, approved);
  }

  // ================================================================ strategy building

  /// @notice The canonical Aqua order for `maker` pegging `asset` to its Chainlink feed, and its
  /// strategy hash (keccak256(abi.encode(order)), the hash SwapVM and Aqua use for Aqua orders).
  /// Ship it with aqua.ship(router, abi.encode(order), [USDG, asset], [usdgAmount, assetAmount]).
  function buildOrder(address maker, address asset, PegTerms memory t)
    public
    view
    returns (ISwapVMRouter.Order memory o, bytes32 strategyHash)
  {
    address usdg_ = address(usdg);
    (address feed, uint32 ageOpen, uint32 ageClosed, bool marketHours, bool ui, bool enabled) = oracle.assetConfig(asset);
    if (!enabled || asset == usdg_) revert AssetNotSupported(asset);
    (address usdgFeed, uint32 usdgAge,,,,) = oracle.assetConfig(usdg_);
    if (t.askSpreadBps != ONE_SIDED && t.askSpreadBps >= BPS) revert BadConfig();
    bytes memory args = abi.encodePacked(
      abi.encodePacked(asset, usdg_, feed, usdgFeed),
      abi.encodePacked(ageOpen, ageClosed, usdgAge),
      abi.encodePacked(
        t.bidSpreadBps,
        t.askSpreadBps,
        t.closedExtraBps,
        oracle.usdgDepegBps(),
        uint8((ui ? FLAG_UI_MULTIPLIER : 0) | (marketHours ? FLAG_MARKET_HOURS : 0))
      ),
      abi.encodePacked(t.minPriceUsd8, t.maxPriceUsd8)
    );
    bytes memory program =
      bytes.concat(abi.encodePacked(OP_SALT, uint8(8), t.salt), abi.encodePacked(pegOpcode, uint8(args.length)), args);
    o = ISwapVMRouter.Order({maker: maker, traits: AQUA_TRAITS, data: program});
    strategyHash = keccak256(abi.encode(o));
  }

  // ================================================================ registry

  /// @notice Register the caller's shipped Aqua strategy so Noren routes conversions to it.
  /// The strategy must already be shipped to the router with both USDG and `asset` as tokens.
  function register(address asset, PegTerms calldata t) external returns (bytes32 strategyHash) {
    if (makerAllowlist && !approvedMaker[msg.sender]) revert MakerNotApproved(msg.sender);
    if (t.bidSpreadBps > maxSpreadBps) revert SpreadTooWide(t.bidSpreadBps, maxSpreadBps);
    ISwapVMRouter.Order memory o;
    (o, strategyHash) = buildOrder(msg.sender, asset, t);
    if (_strategies[strategyHash].active) revert StrategyExists(strategyHash);
    if (!_shipped(msg.sender, strategyHash, asset)) revert StrategyNotShipped(strategyHash);
    if (_byAsset[asset].length >= maxStrategiesPerAsset) revert TooManyStrategies(asset);
    Strategy storage s = _strategies[strategyHash];
    s.maker = msg.sender;
    s.asset = asset;
    s.active = true;
    s.bidSpreadBps = t.bidSpreadBps;
    s.askSpreadBps = t.askSpreadBps;
    s.registeredAt = uint64(block.timestamp);
    s.data = o.data;
    _byAsset[asset].push(strategyHash);
    _byMaker[msg.sender].push(strategyHash);
    emit StrategyRegistered(strategyHash, msg.sender, asset, t.bidSpreadBps, t.askSpreadBps);
  }

  /// @notice The maker or the owner may remove a strategy at any time (the owner clears squatted
  /// routing slots); anyone may remove one that was docked on Aqua. Removal only stops Noren routing:
  /// the maker's Aqua strategy and funds are untouched.
  function remove(bytes32 strategyHash) external {
    Strategy storage s = _strategies[strategyHash];
    if (!s.active) revert UnknownStrategy(strategyHash);
    if (msg.sender != s.maker && msg.sender != owner() && _shipped(s.maker, strategyHash, s.asset)) revert NotRemovable(strategyHash);
    s.active = false;
    bytes32[] storage list = _byAsset[s.asset];
    for (uint256 i; i < list.length; ++i) {
      if (list[i] == strategyHash) {
        list[i] = list[list.length - 1];
        list.pop();
        break;
      }
    }
    emit StrategyRemoved(strategyHash, s.maker, s.asset);
  }

  // ================================================================ quotes

  /// @notice Best maker quote to receive exactly `usdgOut` USDG for `asset` (lowest asset in).
  /// Makers whose quote reverts (stale feed, under-funded, docked, blocklisted) are skipped.
  /// Returns strategyHash = 0 when no maker can fill.
  function bestQuoteForUsdg(address asset, uint256 usdgOut) public view returns (bytes32 strategyHash, uint256 assetIn) {
    bytes32[] storage list = _byAsset[asset];
    bytes memory td = _takerData(false, type(uint256).max, address(0));
    for (uint256 i; i < list.length; ++i) {
      Strategy storage s = _strategies[list[i]];
      if (!_transferable(asset, s.maker)) continue;
      try router.quote(_order(s), asset, address(usdg), usdgOut, td) returns (uint256 ain, uint256 aout, bytes32) {
        if (aout == usdgOut && ain != 0 && (strategyHash == bytes32(0) || ain < assetIn)) {
          strategyHash = list[i];
          assetIn = ain;
        }
      } catch {}
    }
  }

  /// @notice Best maker quote for selling exactly `assetIn` of `asset` (highest USDG out).
  function bestQuoteForAsset(address asset, uint256 assetIn) public view returns (bytes32 strategyHash, uint256 usdgOut) {
    bytes32[] storage list = _byAsset[asset];
    bytes memory td = _takerData(true, 0, address(0));
    for (uint256 i; i < list.length; ++i) {
      Strategy storage s = _strategies[list[i]];
      if (!_transferable(asset, s.maker)) continue;
      try router.quote(_order(s), asset, address(usdg), assetIn, td) returns (uint256 ain, uint256 aout, bytes32) {
        if (ain == assetIn && aout > usdgOut) {
          strategyHash = list[i];
          usdgOut = aout;
        }
      } catch {}
    }
  }

  /// @notice Best maker quote to buy exactly `assetOut` of `asset` with USDG (lowest USDG in, ask side).
  /// One-sided (buy-only) strategies and makers without enough inventory are skipped.
  function bestAskForAsset(address asset, uint256 assetOut) public view returns (bytes32 strategyHash, uint256 usdgIn) {
    bytes32[] storage list = _byAsset[asset];
    bytes memory td = _takerData(false, type(uint256).max, address(0));
    for (uint256 i; i < list.length; ++i) {
      Strategy storage s = _strategies[list[i]];
      if (s.askSpreadBps == ONE_SIDED || !_transferable(asset, s.maker)) continue;
      try router.quote(_order(s), address(usdg), asset, assetOut, td) returns (uint256 uin, uint256 aout, bytes32) {
        if (aout == assetOut && uin != 0 && (strategyHash == bytes32(0) || uin < usdgIn)) {
          strategyHash = list[i];
          usdgIn = uin;
        }
      } catch {}
    }
  }

  // ================================================================ swaps

  /// @notice Sell `asset` from the caller to the best maker so `to` receives exactly `usdgOut` USDG.
  function sellForUsdg(address asset, uint256 usdgOut, uint256 maxAssetIn, address to)
    external
    nonReentrant
    returns (uint256 assetIn, bytes32 strategyHash)
  {
    (strategyHash, assetIn) = bestQuoteForUsdg(asset, usdgOut);
    if (strategyHash == bytes32(0)) revert NoMakerLiquidity(asset, usdgOut);
    if (assetIn > maxAssetIn) revert Slippage(assetIn, maxAssetIn);
    _pull(asset, assetIn);
    _swap(strategyHash, asset, false, usdgOut, assetIn, _recipient(to), assetIn, usdgOut);
  }

  /// @notice Sell exactly `assetIn` of `asset` from the caller to the best maker; `to` receives the USDG.
  function sellExactAsset(address asset, uint256 assetIn, uint256 minUsdgOut, address to)
    external
    nonReentrant
    returns (uint256 usdgOut, bytes32 strategyHash)
  {
    (strategyHash, usdgOut) = bestQuoteForAsset(asset, assetIn);
    if (strategyHash == bytes32(0)) revert NoMakerLiquidity(asset, assetIn);
    if (usdgOut < minUsdgOut) revert Slippage(minUsdgOut, usdgOut);
    _pull(asset, assetIn);
    _swap(strategyHash, asset, true, assetIn, usdgOut, _recipient(to), assetIn, usdgOut);
  }

  /// @notice Buy exactly `assetOut` of `asset` from the best maker (Chainlink price plus its ask spread);
  /// the caller pays USDG and `to` receives the asset. The maker's spread is booked as its fee.
  function buyFromMakers(address asset, uint256 assetOut, uint256 maxUsdgIn, address to)
    external
    nonReentrant
    returns (uint256 usdgIn, bytes32 strategyHash)
  {
    (strategyHash, usdgIn) = bestAskForAsset(asset, assetOut);
    if (strategyHash == bytes32(0)) revert NoMakerLiquidity(asset, assetOut);
    if (usdgIn > maxUsdgIn) revert Slippage(usdgIn, maxUsdgIn);
    _pull(address(usdg), usdgIn);
    Strategy storage s = _strategies[strategyHash];
    usdg.forceApprove(address(router), usdgIn);
    address recipient = _recipient(to);
    (uint256 uin, uint256 aout,) = router.swap(_order(s), address(usdg), asset, assetOut, _takerData(false, usdgIn, recipient));
    if (uin != usdgIn || aout != assetOut) revert FillMismatch(uin, aout);
    uint256 valueUsdg;
    try oracle.valueUsd8(asset, aout) returns (uint256 v) {
      valueUsdg = oracle.usd8ToUsdg(v, Math.Rounding.Ceil);
    } catch {}
    // An unpriceable fill (feed stale or asset disabled in NorenAssetOracle) books no fee, as in _swap.
    uint256 fee = valueUsdg != 0 && uin > valueUsdg ? uin - valueUsdg : 0;
    s.fills += 1;
    s.volumeUsdg += uin;
    s.feesUsdg += fee;
    makerFeesUsdg[s.maker] += fee;
    emit MakerSale(strategyHash, s.maker, asset, msg.sender, aout, uin, valueUsdg, fee);
  }

  /// @notice Sell seized collateral to makers. Pulls up to `amount` of `asset` from the caller.
  /// - Covered (collateral worth at least debt + bonus): sell exactly enough for `debtUsdg` USDG to
  ///   `proceedsTo`, send collateral worth `bonusBps` of the debt to `bonusTo`, return the rest.
  /// - Underwater: `bonusTo` gets amount * bonus / (1 + bonus), the rest is sold, proceeds up to the
  ///   debt go to `proceedsTo` and any USDG above the debt goes back to the caller.
  /// Either way the sale must clear within maxLiquidationSlippageBps of the Chainlink value.
  function liquidate(address asset, uint256 amount, uint256 debtUsdg, uint16 bonusBps, address proceedsTo, address bonusTo)
    external
    nonReentrant
    returns (uint256 proceeds, uint256 sold, uint256 bonus, uint256 excessUsdg)
  {
    uint256 valueUsd8 = oracle.valueUsd8(asset, amount);
    uint256 debtUsd8 = oracle.usdgToUsd8(debtUsdg, Math.Rounding.Ceil);
    uint256 bonusUsd8 = debtUsd8 * bonusBps / BPS;
    bytes32 h;
    if (valueUsd8 >= debtUsd8 + bonusUsd8) {
      (h, sold) = bestQuoteForUsdg(asset, debtUsdg);
      bonus = amount.mulDiv(bonusUsd8, valueUsd8);
      if (h != bytes32(0) && sold + bonus <= amount) {
        uint256 soldUsd8 = oracle.valueUsd8(asset, sold);
        uint256 limit = debtUsd8.mulDiv(BPS + maxLiquidationSlippageBps, BPS);
        if (soldUsd8 > limit) revert LiquidationSlippage(soldUsd8, limit);
        _pull(asset, sold + bonus);
        _swap(h, asset, false, debtUsdg, sold, proceedsTo, sold, debtUsdg);
        IERC20(asset).safeTransfer(bonusTo, bonus);
        proceeds = debtUsdg;
        emit CollateralLiquidated(asset, msg.sender, amount, sold, bonus, proceeds, debtUsdg);
        return (proceeds, sold, bonus, 0);
      }
    }
    bonus = amount.mulDiv(bonusBps, BPS + bonusBps);
    sold = amount - bonus;
    uint256 out;
    (h, out) = bestQuoteForAsset(asset, sold);
    if (h == bytes32(0)) revert NoMakerLiquidity(asset, sold);
    uint256 floorUsd8 = oracle.valueUsd8(asset, sold).mulDiv(BPS - maxLiquidationSlippageBps, BPS);
    uint256 outUsd8 = oracle.usdgToUsd8(out, Math.Rounding.Floor);
    if (outUsd8 < floorUsd8) revert LiquidationSlippage(outUsd8, floorUsd8);
    _pull(asset, amount);
    _swap(h, asset, true, sold, out, address(this), sold, out);
    IERC20(asset).safeTransfer(bonusTo, bonus);
    proceeds = Math.min(out, debtUsdg);
    excessUsdg = out - proceeds;
    usdg.safeTransfer(proceedsTo, proceeds);
    if (excessUsdg != 0) usdg.safeTransfer(msg.sender, excessUsdg);
    emit CollateralLiquidated(asset, msg.sender, amount, sold, bonus, proceeds, debtUsdg);
  }

  // ================================================================ views

  function strategy(bytes32 strategyHash) external view returns (Strategy memory) {
    return _strategies[strategyHash];
  }

  function order(bytes32 strategyHash) external view returns (ISwapVMRouter.Order memory) {
    Strategy storage s = _strategies[strategyHash];
    if (s.maker == address(0)) revert UnknownStrategy(strategyHash);
    return _order(s);
  }

  function strategiesFor(address asset) external view returns (bytes32[] memory) {
    return _byAsset[asset];
  }

  function strategiesOf(address maker) external view returns (bytes32[] memory) {
    return _byMaker[maker];
  }

  /// @notice Aqua virtual balances (USDG, asset) of a registered strategy; (0, 0) once docked.
  function balances(bytes32 strategyHash) external view returns (uint256 usdgBalance, uint256 assetBalance) {
    Strategy storage s = _strategies[strategyHash];
    if (!_shipped(s.maker, strategyHash, s.asset)) return (0, 0);
    return aqua.safeBalances(s.maker, address(router), strategyHash, address(usdg), s.asset);
  }

  // ================================================================ internal

  function _order(Strategy storage s) internal view returns (ISwapVMRouter.Order memory) {
    return ISwapVMRouter.Order({maker: s.maker, traits: AQUA_TRAITS, data: s.data});
  }

  function _shipped(address maker, bytes32 strategyHash, address asset) internal view returns (bool) {
    try aqua.safeBalances(maker, address(router), strategyHash, address(usdg), asset) returns (uint256, uint256) {
      return true;
    } catch {
      return false;
    }
  }

  function _transferable(address asset, address maker) internal view returns (bool) {
    try oracle.checkTransferable(asset, address(this), maker) {
      return true;
    } catch {
      return false;
    }
  }

  /// @dev USDG or asset bought for an external caller never stays in this contract (no sweep exists).
  function _recipient(address to) internal view returns (address) {
    return to == address(0) || to == address(this) ? msg.sender : to;
  }

  function _pull(address asset, uint256 amount) internal {
    uint256 before = IERC20(asset).balanceOf(address(this));
    IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
    uint256 got = IERC20(asset).balanceOf(address(this)) - before;
    if (got < amount) revert ReceivedShort(amount, got);
  }

  /// @dev Execute on the router: taker = this contract, maker paid via transferFrom + Aqua.push.
  function _swap(
    bytes32 strategyHash,
    address asset,
    bool exactIn,
    uint256 amount,
    uint256 threshold,
    address to,
    uint256 wantIn,
    uint256 wantOut
  ) internal {
    Strategy storage s = _strategies[strategyHash];
    IERC20(asset).forceApprove(address(router), wantIn);
    (uint256 ain, uint256 aout,) = router.swap(_order(s), asset, address(usdg), amount, _takerData(exactIn, threshold, to));
    if (ain != wantIn || aout != wantOut) revert FillMismatch(ain, aout);
    uint256 valueUsdg;
    try oracle.valueUsd8(asset, ain) returns (uint256 v) {
      valueUsdg = oracle.usd8ToUsdg(v, Math.Rounding.Floor);
    } catch {}
    uint256 fee = valueUsdg > aout ? valueUsdg - aout : 0;
    s.fills += 1;
    s.volumeUsdg += aout;
    s.feesUsdg += fee;
    makerFeesUsdg[s.maker] += fee;
    emit MakerFill(strategyHash, s.maker, asset, msg.sender, ain, aout, valueUsdg, fee);
  }

  /// @dev SwapVM TakerTraits: 20-byte slice index table, 2-byte flags, then threshold (32 bytes)
  /// and an optional 20-byte recipient. No deadline, hooks, callbacks or signature.
  function _takerData(bool exactIn, uint256 threshold, address to) internal view returns (bytes memory) {
    bool hasTo = to != address(0) && to != address(this);
    uint160 end = hasTo ? 52 : 32;
    uint160 idx = 32 | (end << 16);
    for (uint256 k = 2; k < 10; ++k) idx |= end << uint160(16 * k);
    uint16 flags = TAKER_TRANSFER_FROM_AND_AQUA_PUSH | (exactIn ? TAKER_EXACT_IN : 0);
    return abi.encodePacked(idx, flags, threshold, hasTo ? abi.encodePacked(to) : bytes(''));
  }
}
