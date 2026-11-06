// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

/// @custom:license-url https://github.com/1inch/swap-vm/blob/main/LICENSES/SwapVM-1.1.txt
/// @custom:copyright Extends SwapVM — © Degensoft Ltd 2025. This file © 2026 Nivesh Gajengi.
/// @custom:change 2026-11-06 (Noren): new instruction, not part of upstream SwapVM v1.0.2.
/// Distributed under LicenseRef-Degensoft-SwapVM-1.1 because it plugs into the SwapVM runtime.

import { Context, ContextLib } from "@1inch/swap-vm/src/libs/VM.sol";

/// @dev The liquidation engine whose auctions a NorenDutchDecay strategy buys. It is the only
/// taker the instruction accepts, and the source of each auction's start time.
interface INorenDutchAuctionHouse {
    /// @return startedAt Unix time the auction opened; 0 when no auction is open under this id.
    function dutchAuctionStart(bytes32 auctionId) external view returns (uint256 startedAt);
}

/// @title NorenDutchDecayArgsBuilder
/// @notice Packs and unpacks the 30-byte argument blob of the NorenDutchDecay instruction.
library NorenDutchDecayArgsBuilder {
    uint256 internal constant ARGS_LENGTH = 30;
    /// @dev Hard ceiling on any auction discount the instruction accepts (50%).
    uint16 internal constant MAX_CAP_BPS = 5_000;

    error NorenDutchDecayBadArgsLength(uint256 length);
    error NorenDutchDecayBadArgs();

    struct Args {
        address house; // the only accepted taker; dutchAuctionStart(auctionId) gives the start
        uint16 startBps; // total auction discount when the auction opens
        uint16 capBps; // total auction discount after `duration`, and never more
        uint32 duration; // seconds from startBps to capBps (linear)
        uint16 keeperShareBps; // part of the total discount that is the keeper's, not the maker's
    }

    function build(Args memory a) internal pure returns (bytes memory) {
        require(
            a.house != address(0) && a.startBps <= a.capBps && a.capBps <= MAX_CAP_BPS && a.duration != 0
                && a.keeperShareBps <= 10_000,
            NorenDutchDecayBadArgs()
        );
        return abi.encodePacked(a.house, a.startBps, a.capBps, a.duration, a.keeperShareBps);
    }

    function parse(bytes calldata args) internal pure returns (Args memory a) {
        require(args.length == ARGS_LENGTH, NorenDutchDecayBadArgsLength(args.length));
        a.house = address(bytes20(args[0:20]));
        a.startBps = uint16(bytes2(args[20:22]));
        a.capBps = uint16(bytes2(args[22:24]));
        a.duration = uint32(bytes4(args[24:28]));
        a.keeperShareBps = uint16(bytes2(args[28:30]));
        require(a.startBps <= a.capBps && a.capBps <= MAX_CAP_BPS && a.duration != 0 && a.keeperShareBps <= 10_000, NorenDutchDecayBadArgs());
    }

    /// @notice Total auction discount (1e18 = 100%) `elapsed` seconds after the auction opened:
    /// startBps rising linearly to capBps over `duration`, then flat at capBps. Rounded down.
    function totalDiscountWad(Args memory a, uint256 elapsed) internal pure returns (uint256) {
        uint256 t = elapsed < a.duration ? elapsed : a.duration;
        return uint256(a.startBps) * 1e14 + uint256(a.capBps - a.startBps) * 1e14 * t / a.duration;
    }

    /// @notice The maker's part of the total discount (the keeper's part is the rest). Rounded down.
    function makerDiscountWad(Args memory a, uint256 elapsed) internal pure returns (uint256) {
        return totalDiscountWad(a, elapsed) * (10_000 - a.keeperShareBps) / 10_000;
    }
}

/// @title NorenDutchDecay
/// @notice SwapVM instruction for Dutch-auction liquidations. It wraps the pricing instruction that
/// follows it (NorenOraclePeg) and lowers the maker's buy price for liquidated collateral over time:
///
///     maker buy price = Chainlink price x (1 - makerDiscount(t))
///     totalDiscount(t) = startBps + (capBps - startBps) x min(t - start, duration) / duration
///     makerDiscount(t) = totalDiscount(t) x (1 - keeperShareBps)
///
/// The keeper's share of the total discount is paid by the auction house in collateral, so the
/// borrower's cost of a fill is totalDiscount(t) of the value sold and never more than capBps.
///
/// Safety:
/// - only the auction house named in the order may take (`ctx.query.taker == house`), so nobody can
///   sell their own collateral to the maker at the auction discount;
/// - the auction start is read on-chain from the house (`dutchAuctionStart(auctionId)`, the
///   auctionId is the 32-byte instruction argument in the taker data); no open auction, or a start
///   in the future, reverts;
/// - the discount is bounded by capBps (itself at most 50%) and never negative, so combined with a
///   zero-spread NorenOraclePeg the maker never pays above the oracle price;
/// - exact-in shrinks the priced amount by ceil(amountIn x d) and exact-out grows amountIn with a
///   ceiling division, so rounding is always in the maker's favour;
/// - every Chainlink check (staleness, weekend window, USDG depeg, price band, funding) is the
///   following NorenOraclePeg's, unchanged.
///
/// Program shape: Salt ‖ NorenDutchDecay ‖ NorenOraclePeg (bid 0, one-sided). The instruction runs
/// the rest of the program itself (like upstream Fee), so it must come before the pricing one.
contract NorenDutchDecay {
    using ContextLib for Context;

    error NorenDutchDecayBadArgs();
    error NorenDutchDecayTakerNotHouse(address taker);
    error NorenDutchDecayNoActiveAuction(bytes32 auctionId);

    /// @dev args: NorenDutchDecayArgsBuilder.Args, 30 bytes packed (one calldata word, decoded with
    /// shifts to keep the router under EIP-170). Taker instruction args: bytes32 auctionId.
    function _norenDutchDecayXD(Context memory ctx, bytes calldata args) internal {
        uint256 takerAmountIn = ctx.swap.amountIn;
        bytes calldata idArg = ctx.takerArgs();
        uint256 w;
        bytes32 auctionId;
        assembly ("memory-safe") {
            w := calldataload(args.offset)
            auctionId := calldataload(idArg.offset)
        }
        address house = address(uint160(w >> 96));
        uint256 startBps = (w >> 80) & 0xffff;
        uint256 capBps = (w >> 64) & 0xffff;
        uint256 duration = (w >> 32) & 0xffffffff;
        uint256 keeperShareBps = (w >> 16) & 0xffff;
        require(
            args.length == NorenDutchDecayArgsBuilder.ARGS_LENGTH && idArg.length >= 32 && startBps <= capBps
                && capBps <= NorenDutchDecayArgsBuilder.MAX_CAP_BPS && duration != 0 && keeperShareBps <= 10_000
                && (takerAmountIn == 0 || ctx.swap.amountOut == 0),
            NorenDutchDecayBadArgs()
        );
        require(ctx.query.taker == house, NorenDutchDecayTakerNotHouse(ctx.query.taker));

        // startedAt = house.dutchAuctionStart(auctionId) (static call; 0 when no open auction).
        uint256 startedAt;
        bytes4 sel = INorenDutchAuctionHouse.dutchAuctionStart.selector;
        assembly ("memory-safe") {
            let m := mload(0x40)
            mstore(m, sel)
            mstore(add(m, 4), auctionId)
            let ok := staticcall(gas(), house, m, 36, m, 32)
            if iszero(and(ok, eq(returndatasize(), 32))) { mstore(m, 0) }
            startedAt := mload(m)
        }
        require(startedAt != 0 && startedAt <= block.timestamp, NorenDutchDecayNoActiveAuction(auctionId));

        uint256 t = block.timestamp - startedAt;
        if (t > duration) t = duration;
        // Same formula as NorenDutchDecayArgsBuilder.makerDiscountWad (1e18 = 100%, rounded down).
        uint256 dm = (startBps * 1e14 + (capBps - startBps) * 1e14 * t / duration) * (10_000 - keeperShareBps) / 10_000;
        bool exactIn = ctx.query.isExactIn;
        // Exact-in: price only amountIn x (1 - d), rounded down; the taker still delivers the full amountIn.
        if (exactIn) ctx.swap.amountIn = takerAmountIn - (takerAmountIn * dm + 1e18 - 1) / 1e18;
        ctx.runLoop();
        // Exact-out: the amountIn the pricing instruction asks for, grossed up to amountIn / (1 - d), rounded up.
        uint256 keep = 1e18 - dm;
        ctx.swap.amountIn = exactIn ? takerAmountIn : (ctx.swap.amountIn * 1e18 + keep - 1) / keep;
    }
}
