// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

/// @custom:license-url https://github.com/1inch/swap-vm/blob/main/LICENSES/SwapVM-1.1.txt
/// @custom:copyright Extends SwapVM — © Degensoft Ltd 2025. This file © 2026 Nivesh Gajengi.
/// @custom:change 2026-11-06 (Noren): new instruction, not part of upstream SwapVM v1.0.2.
/// Distributed under LicenseRef-Degensoft-SwapVM-1.1 because it plugs into the SwapVM runtime.

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import { Calldata } from "@1inch/solidity-utils/contracts/libraries/Calldata.sol";
import { Context } from "@1inch/swap-vm/src/libs/VM.sol";

/// @dev Chainlink AggregatorV3Interface (the parts the instruction reads).
interface INorenPegFeed {
    function decimals() external view returns (uint8);
    function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @dev Robinhood Chain Stock Tokens: 1e18-scaled shares per raw token (moves on dividends and splits).
interface INorenPegStockToken {
    function uiMultiplier() external view returns (uint256);
}

/// @title NorenOraclePegArgsBuilder
/// @notice Packs and unpacks the 117-byte argument blob of the NorenOraclePeg instruction.
library NorenOraclePegArgsBuilder {
    using Calldata for bytes;

    /// @dev Apply the base token's live uiMultiplier() (Robinhood Stock Tokens).
    uint8 internal constant FLAG_UI_MULTIPLIER = 0x01;
    /// @dev The base feed follows US equity hours (24/5): use baseMaxAgeClosed and closedExtraBps
    /// inside the closed window (Saturday, Sunday and Monday before 06:00 UTC).
    uint8 internal constant FLAG_MARKET_HOURS = 0x02;
    /// @dev askSpreadBps value that disables selling the base token (buy-only strategy).
    uint16 internal constant ONE_SIDED = type(uint16).max;
    uint256 internal constant ARGS_LENGTH = 117;

    error NorenOraclePegBadArgsLength(uint256 length);
    error NorenOraclePegBadArgs();

    struct Args {
        address base; // asset the maker trades against the quote token (Stock Token or WETH)
        address quote; // USDG
        address baseFeed; // Chainlink <BASE>/USD
        address quoteFeed; // Chainlink USDG/USD; address(0) values the quote token at exactly $1
        uint32 baseMaxAgeOpen; // max feed age, seconds
        uint32 baseMaxAgeClosed; // max feed age inside the closed window (FLAG_MARKET_HOURS)
        uint32 quoteMaxAge;
        uint16 bidSpreadBps; // maker buys base at oracle * (1 - bid)
        uint16 askSpreadBps; // maker sells base at oracle * (1 + ask); ONE_SIDED disables
        uint16 closedExtraBps; // added to both spreads inside the closed window
        uint16 quoteMaxDepegBps; // quote feed must be within this band of $1
        uint8 flags;
        uint64 minPriceUsd8; // circuit breaker: refuse to quote below this base price (0 = off)
        uint64 maxPriceUsd8; // circuit breaker: refuse to quote above this base price (0 = off)
    }

    function build(Args memory a) internal pure returns (bytes memory) {
        require(
            a.base != address(0) && a.quote != address(0) && a.base != a.quote && a.baseFeed != address(0)
                && a.baseMaxAgeOpen != 0 && a.baseMaxAgeClosed >= a.baseMaxAgeOpen && a.bidSpreadBps < 10_000
                && (a.askSpreadBps == ONE_SIDED || a.askSpreadBps < 10_000) && (a.maxPriceUsd8 == 0 || a.maxPriceUsd8 > a.minPriceUsd8),
            NorenOraclePegBadArgs()
        );
        return abi.encodePacked(
            abi.encodePacked(a.base, a.quote, a.baseFeed, a.quoteFeed),
            abi.encodePacked(a.baseMaxAgeOpen, a.baseMaxAgeClosed, a.quoteMaxAge),
            abi.encodePacked(a.bidSpreadBps, a.askSpreadBps, a.closedExtraBps, a.quoteMaxDepegBps, a.flags),
            abi.encodePacked(a.minPriceUsd8, a.maxPriceUsd8)
        );
    }

    function parse(bytes calldata args) internal pure returns (Args memory a) {
        require(args.length == ARGS_LENGTH, NorenOraclePegBadArgsLength(args.length));
        a.base = address(bytes20(args.slice(0, 20)));
        a.quote = address(bytes20(args.slice(20, 40)));
        a.baseFeed = address(bytes20(args.slice(40, 60)));
        a.quoteFeed = address(bytes20(args.slice(60, 80)));
        a.baseMaxAgeOpen = uint32(bytes4(args.slice(80, 84)));
        a.baseMaxAgeClosed = uint32(bytes4(args.slice(84, 88)));
        a.quoteMaxAge = uint32(bytes4(args.slice(88, 92)));
        a.bidSpreadBps = uint16(bytes2(args.slice(92, 94)));
        a.askSpreadBps = uint16(bytes2(args.slice(94, 96)));
        a.closedExtraBps = uint16(bytes2(args.slice(96, 98)));
        a.quoteMaxDepegBps = uint16(bytes2(args.slice(98, 100)));
        a.flags = uint8(bytes1(args.slice(100, 101)));
        a.minPriceUsd8 = uint64(bytes8(args.slice(101, 109)));
        a.maxPriceUsd8 = uint64(bytes8(args.slice(109, 117)));
    }
}

/// @title NorenOraclePeg
/// @notice SwapVM instruction that prices a swap at a Chainlink-pegged rate plus a maker spread.
/// The maker buys `base` (a Robinhood Stock Token or WETH) for `quote` (USDG) at
/// oracle * (1 - bid) and, unless the strategy is one-sided, sells it at oracle * (1 + ask).
/// The spread is the maker's trading fee.
///
/// Chainlink Data Feeds safety, on every call:
/// - feed decimals() read live and normalised to 8 decimals,
/// - answer > 0, updatedAt != 0, updatedAt <= block.timestamp, answeredInRound >= roundId,
/// - per-asset maximum age; a 24/5 stock feed gets a longer maximum age inside the closed window
///   (Saturday, Sunday, Monday before 06:00 UTC) and the strategy's closedExtraBps on top of its
///   spread. Holidays are not in the calendar, so on a weekday holiday the open-market age applies
///   and the strategy stops quoting once the feed is older (fail-closed),
/// - the quote feed (USDG/USD) must be fresh and within quoteMaxDepegBps of $1,
/// - optional maker circuit breaker: no quote outside [minPriceUsd8, maxPriceUsd8].
///
/// Stock Token amounts are converted with the token's live uiMultiplier(). Amounts round in the
/// maker's favour (amountOut down, amountIn up). The instruction fails loudly if the strategy's
/// Aqua virtual balance, or the maker's real wallet balance or allowance to Aqua, cannot cover the
/// output, so a taker can skip an under-funded maker at quote time instead of at settlement.
///
/// Program shape: the instruction computes the whole swap, so it is the only pricing instruction.
/// It may be preceded by guards such as Deadline or Salt.
contract NorenOraclePeg {
    using Math for uint256;

    uint256 private constant _BPS = 10_000;
    uint256 private constant _USD8 = 1e8;
    uint256 private constant _MONDAY_REOPEN_BUFFER = 6 hours;

    /// @dev Aqua registry used to read the maker's allowance (immutable, set by the router).
    address private immutable _PEG_AQUA;

    error NorenOraclePegWrongPair(address tokenIn, address tokenOut);
    error NorenOraclePegRecomputeDetected();
    error NorenOraclePegOneSided();
    error NorenOraclePegInvalidPrice(address feed, int256 answer);
    error NorenOraclePegIncompleteRound(address feed, uint80 roundId, uint80 answeredInRound);
    error NorenOraclePegFuturePrice(address feed, uint256 updatedAt);
    error NorenOraclePegStalePrice(address feed, uint256 updatedAt, uint256 maxAge);
    error NorenOraclePegQuoteDepeg(uint256 priceUsd8);
    error NorenOraclePegPriceOutOfBand(uint256 priceUsd8, uint256 minPriceUsd8, uint256 maxPriceUsd8);
    error NorenOraclePegSpreadTooWide(uint256 spreadBps);
    error NorenOraclePegInsufficientBalance(uint256 balanceOut, uint256 amountOut);
    error NorenOraclePegMakerUnderfunded(address maker, address token, uint256 available, uint256 needed);

    constructor(address aqua) {
        _PEG_AQUA = aqua;
    }

    /// @notice True inside the window when US-equity Chainlink feeds do not update.
    function _pegMarketClosed(uint256 ts) internal pure returns (bool) {
        uint256 dow = (ts / 1 days + 4) % 7; // 1970-01-01 was a Thursday; 0 = Sunday
        if (dow == 6 || dow == 0) return true;
        return dow == 1 && ts % 1 days < _MONDAY_REOPEN_BUFFER;
    }

    /// @notice Validated feed answer normalised to 8 decimals.
    function _pegFeedUsd8(address feed, uint256 maxAge) internal view returns (uint256 usd8) {
        (uint80 roundId, int256 answer,, uint256 updatedAt, uint80 answeredInRound) = INorenPegFeed(feed).latestRoundData();
        require(answer > 0, NorenOraclePegInvalidPrice(feed, answer));
        require(updatedAt != 0 && answeredInRound >= roundId, NorenOraclePegIncompleteRound(feed, roundId, answeredInRound));
        require(updatedAt <= block.timestamp, NorenOraclePegFuturePrice(feed, updatedAt));
        require(block.timestamp - updatedAt <= maxAge, NorenOraclePegStalePrice(feed, updatedAt, maxAge));
        uint8 dec = INorenPegFeed(feed).decimals(); // read live: never assume 8
        uint256 raw = uint256(answer);
        usd8 = dec == 8 ? raw : dec > 8 ? raw / 10 ** (dec - 8) : raw * 10 ** (8 - dec);
        require(usd8 != 0, NorenOraclePegInvalidPrice(feed, answer));
    }

    /// @dev args: NorenOraclePegArgsBuilder.Args, 117 bytes packed.
    function _norenOraclePeg1D(Context memory ctx, bytes calldata args) internal view {
        NorenOraclePegArgsBuilder.Args memory a = NorenOraclePegArgsBuilder.parse(args);
        bool makerBuysBase = ctx.query.tokenIn == a.base && ctx.query.tokenOut == a.quote;
        require(makerBuysBase || (ctx.query.tokenIn == a.quote && ctx.query.tokenOut == a.base), NorenOraclePegWrongPair(ctx.query.tokenIn, ctx.query.tokenOut));
        if (!makerBuysBase) require(a.askSpreadBps != NorenOraclePegArgsBuilder.ONE_SIDED, NorenOraclePegOneSided());

        bool closed = (a.flags & NorenOraclePegArgsBuilder.FLAG_MARKET_HOURS) != 0 && _pegMarketClosed(block.timestamp);
        uint256 basePx = _pegFeedUsd8(a.baseFeed, closed ? a.baseMaxAgeClosed : a.baseMaxAgeOpen);
        require(
            (a.minPriceUsd8 == 0 || basePx >= a.minPriceUsd8) && (a.maxPriceUsd8 == 0 || basePx <= a.maxPriceUsd8),
            NorenOraclePegPriceOutOfBand(basePx, a.minPriceUsd8, a.maxPriceUsd8)
        );
        uint256 quotePx = _USD8;
        if (a.quoteFeed != address(0)) {
            quotePx = _pegFeedUsd8(a.quoteFeed, a.quoteMaxAge);
            uint256 band = _USD8 * a.quoteMaxDepegBps / _BPS;
            require(quotePx >= _USD8 - band && quotePx <= _USD8 + band, NorenOraclePegQuoteDepeg(quotePx));
        }

        uint256 spread = (makerBuysBase ? a.bidSpreadBps : a.askSpreadBps) + (closed ? a.closedExtraBps : 0);
        require(spread < _BPS, NorenOraclePegSpreadTooWide(spread));
        uint256 mult = (a.flags & NorenOraclePegArgsBuilder.FLAG_UI_MULTIPLIER) != 0 ? INorenPegStockToken(a.base).uiMultiplier() : 1e18;

        // One raw base unit is worth num / den raw quote units at the oracle price:
        //   num = basePx * mult * 10^quoteDecimals,  den = quotePx * 1e18 * 10^baseDecimals
        uint256 num = basePx * mult * 10 ** IERC20Metadata(a.quote).decimals();
        uint256 den = quotePx * 1e18 * 10 ** IERC20Metadata(a.base).decimals();
        // Maker buys base below the oracle and sells it above.
        uint256 rateNum = num * (makerBuysBase ? _BPS - spread : _BPS + spread);
        uint256 rateDen = den * _BPS;
        bool baseIn = makerBuysBase;

        if (ctx.query.isExactIn) {
            require(ctx.swap.amountOut == 0, NorenOraclePegRecomputeDetected());
            ctx.swap.amountOut = baseIn
                ? ctx.swap.amountIn.mulDiv(rateNum, rateDen) // base in, quote out (floor)
                : ctx.swap.amountIn.mulDiv(rateDen, rateNum); // quote in, base out (floor)
        } else {
            require(ctx.swap.amountIn == 0, NorenOraclePegRecomputeDetected());
            ctx.swap.amountIn = baseIn
                ? ctx.swap.amountOut.mulDiv(rateDen, rateNum, Math.Rounding.Ceil) // quote out, base in (ceil)
                : ctx.swap.amountOut.mulDiv(rateNum, rateDen, Math.Rounding.Ceil); // base out, quote in (ceil)
        }

        uint256 out = ctx.swap.amountOut;
        require(out <= ctx.swap.balanceOut, NorenOraclePegInsufficientBalance(ctx.swap.balanceOut, out));
        address maker = ctx.query.maker;
        uint256 available = Math.min(IERC20(ctx.query.tokenOut).balanceOf(maker), IERC20(ctx.query.tokenOut).allowance(maker, _PEG_AQUA));
        require(out <= available, NorenOraclePegMakerUnderfunded(maker, ctx.query.tokenOut, available, out));
    }
}
