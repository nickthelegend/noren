// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

/// @custom:license-url https://github.com/1inch/swap-vm/blob/main/LICENSES/SwapVM-1.1.txt
/// @custom:copyright Tests for a SwapVM extension. © 2026 Nivesh Gajengi; SwapVM — © Degensoft Ltd 2025.

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { IMakerHooks } from "@1inch/swap-vm/src/interfaces/IMakerHooks.sol";
import { MakerTraitsLib } from "@1inch/swap-vm/src/libs/MakerTraits.sol";
import { TakerTraitsLib } from "@1inch/swap-vm/src/libs/TakerTraits.sol";
import { TransientLockLib } from "@1inch/solidity-utils/contracts/libraries/TransientLock.sol";

import { PegBase, IStock } from "./PegBase.sol";
import { NorenOraclePeg, NorenOraclePegArgsBuilder } from "../src/instructions/NorenOraclePeg.sol";
import { NorenAquaSwapVMRouter } from "../src/routers/NorenAquaSwapVMRouter.sol";

interface IEip712Domain {
    function eip712Domain()
        external
        view
        returns (bytes1, string memory name, string memory version, uint256, address, bytes32, uint256[] memory);
    function AQUA() external view returns (address);
}

/// @notice NorenOraclePeg on the Robinhood mainnet fork, settled through the official Aqua registry.
contract NorenOraclePegTest is PegBase {
    using Math for uint256;

    uint256 internal constant BPS = 10_000;

    // ------------------------------------------------------------ helpers

    /// @dev USDG (6 dec) a taker receives for `nvdaIn` raw NVDA at oracle * (1 - bid), floor.
    function _expectedUsdgOut(uint256 nvdaIn, uint256 bid) internal view returns (uint256) {
        uint256 num = _px(FEED_NVDA) * _mult(NVDA) * 1e6 * (BPS - bid);
        uint256 den = _px(FEED_USDG) * 1e18 * 1e18 * BPS;
        return nvdaIn.mulDiv(num, den);
    }

    function _shipNvda(uint16 bid, uint16 ask, uint256 usdgAmount, uint256 nvdaAmount, uint64 salt)
        internal
        returns (ISwapVM.Order memory order, bytes32 h)
    {
        order = _aquaOrder(maker, _program(_stockArgs(NVDA, FEED_NVDA, bid, ask), salt));
        h = _ship(maker, address(router), order, NVDA, usdgAmount, nvdaAmount);
    }

    // ------------------------------------------------------------ deployment facts

    function test_officialContractsArePresentOnTheFork() public view {
        (, string memory name, string memory version,,,,) = IEip712Domain(OFFICIAL_ROUTER).eip712Domain();
        assertEq(name, "1inch SwapVM v1.0");
        assertEq(version, "1.0.2");
        assertEq(IEip712Domain(OFFICIAL_ROUTER).AQUA(), AQUA);
        assertEq(address(router.AQUA()), AQUA);
        assertEq(router.NOREN_ORACLE_PEG_OPCODE(), OP_PEG);
    }

    /// @notice The official router executes an upstream Aqua x*y=k strategy on the fork: opcodes
    /// 0-33 are the same table the Noren router keeps.
    function test_officialRouterSwapsAnAquaXycStrategy() public {
        _fund(TSLA, maker, 5e18);
        vm.prank(maker);
        IERC20(TSLA).approve(AQUA, type(uint256).max);
        ISwapVM.Order memory order = _aquaOrder(maker, abi.encodePacked(OP_XYC, uint8(0)));
        bytes32 h = _ship(maker, OFFICIAL_ROUTER, order, TSLA, 1_750e6, 5e18);
        vm.prank(taker);
        IERC20(TSLA).approve(OFFICIAL_ROUTER, 1e18);

        uint256 makerUsdg = IERC20(USDG).balanceOf(maker);
        vm.prank(taker);
        (uint256 amountIn, uint256 amountOut,) = ISwapVM(OFFICIAL_ROUTER).swap(order, TSLA, USDG, 1e18, _takerData(true, 0));
        assertEq(amountIn, 1e18);
        assertEq(amountOut, uint256(1e18) * 1_750e6 / (5e18 + 1e18)); // x*y=k, floor
        assertEq(makerUsdg - IERC20(USDG).balanceOf(maker), amountOut);
        (uint248 tslaBal,) = aqua.rawBalances(maker, OFFICIAL_ROUTER, h, TSLA);
        assertEq(tslaBal, 6e18);
    }

    // ------------------------------------------------------------ pricing

    function test_makerBuysStockAtOracleMinusSpreadExactOut() public {
        if (_closedNow()) vm.skip(true);
        (ISwapVM.Order memory order, bytes32 h) = _shipNvda(50, 50, 20_000e6, 0, 1);
        uint256 usdgOut = 1_000e6;
        uint256 expectedIn = usdgOut.mulDiv(_px(FEED_USDG) * 1e18 * 1e18 * BPS, _px(FEED_NVDA) * _mult(NVDA) * 1e6 * (BPS - 50), Math.Rounding.Ceil);

        uint256 makerUsdg = IERC20(USDG).balanceOf(maker);
        uint256 makerNvda = IERC20(NVDA).balanceOf(maker);
        uint256 takerNvda = IERC20(NVDA).balanceOf(taker);
        vm.prank(taker);
        (uint256 amountIn, uint256 amountOut,) = router.swap(order, NVDA, USDG, usdgOut, _takerData(false, type(uint256).max));

        assertEq(amountOut, usdgOut);
        assertEq(amountIn, expectedIn);
        // real transfers: USDG maker -> taker, NVDA taker -> maker (through router and Aqua.push)
        assertEq(makerUsdg - IERC20(USDG).balanceOf(maker), usdgOut);
        assertEq(IERC20(USDG).balanceOf(taker), usdgOut);
        assertEq(IERC20(NVDA).balanceOf(maker) - makerNvda, expectedIn);
        assertEq(takerNvda - IERC20(NVDA).balanceOf(taker), expectedIn);
        assertEq(IERC20(NVDA).balanceOf(address(router)), 0);
        // Aqua virtual balances moved by the same amounts
        (uint248 u,) = aqua.rawBalances(maker, address(router), h, USDG);
        (uint248 n,) = aqua.rawBalances(maker, address(router), h, NVDA);
        assertEq(u, 20_000e6 - usdgOut);
        assertEq(n, expectedIn);
    }

    function test_exactInMatchesIndependentMathAndQuote() public {
        if (_closedNow()) vm.skip(true);
        (ISwapVM.Order memory order,) = _shipNvda(80, 120, 20_000e6, 0, 2);
        (uint256 qIn, uint256 qOut,) = q.quote(order, NVDA, USDG, 3e18, _takerData(true, 0));
        assertEq(qIn, 3e18);
        assertEq(qOut, _expectedUsdgOut(3e18, 80));
        vm.prank(taker);
        (, uint256 out,) = router.swap(order, NVDA, USDG, 3e18, _takerData(true, qOut));
        assertEq(out, qOut);
    }

    /// @notice exactIn(X) -> Y then exactOut(Y) needs <= X (rounding favours the maker, no free value).
    function test_exactInExactOutSymmetryFavoursMaker() public {
        if (_closedNow()) vm.skip(true);
        (ISwapVM.Order memory order,) = _shipNvda(50, 50, 20_000e6, 0, 3);
        (, uint256 y,) = q.quote(order, NVDA, USDG, 2.5e18, _takerData(true, 0));
        (uint256 x2,,) = q.quote(order, NVDA, USDG, y, _takerData(false, type(uint256).max));
        assertLe(x2, 2.5e18);
        assertGe(x2 + 1e12, 2.5e18); // within rounding of one price step
        // splitting a trade never beats one trade
        (, uint256 y1,) = q.quote(order, NVDA, USDG, 1.25e18, _takerData(true, 0));
        assertLe(2 * y1, y);
    }

    /// @notice Two-sided position: the maker resells inventory above the oracle.
    function test_makerSellsInventoryAtOraclePlusSpread() public {
        if (_closedNow()) vm.skip(true);
        _fund(NVDA, maker, 4e18);
        vm.prank(maker);
        IERC20(NVDA).approve(AQUA, type(uint256).max);
        (ISwapVM.Order memory order,) = _shipNvda(50, 70, 10_000e6, 4e18, 4);
        _fund(USDG, taker, 2_000e6);
        uint256 nvdaOut = 1e18;
        uint256 expectedUsdgIn = nvdaOut.mulDiv(_px(FEED_NVDA) * _mult(NVDA) * 1e6 * (BPS + 70), _px(FEED_USDG) * 1e18 * 1e18 * BPS, Math.Rounding.Ceil);
        uint256 takerUsdg = IERC20(USDG).balanceOf(taker);
        vm.prank(taker);
        (uint256 inUsdg, uint256 outNvda,) = router.swap(order, USDG, NVDA, nvdaOut, _takerData(false, type(uint256).max));
        assertEq(outNvda, nvdaOut);
        assertEq(inUsdg, expectedUsdgIn);
        assertEq(takerUsdg - IERC20(USDG).balanceOf(taker), expectedUsdgIn);
        // buy at oracle-50bps, sell at oracle+70bps: the round trip earns the maker 120 bps
        uint256 bidUsdg = _expectedUsdgOut(nvdaOut, 50);
        assertGt(inUsdg, bidUsdg);
        assertApproxEqRel(inUsdg - bidUsdg, inUsdg * 120 / 10_070, 0.01e18);
    }

    function test_oneSidedStrategyRefusesToSell() public {
        (ISwapVM.Order memory order,) = _shipNvda(50, NorenOraclePegArgsBuilder.ONE_SIDED, 1_000e6, 0, 5);
        _fund(USDG, taker, 100e6);
        vm.expectRevert(NorenOraclePeg.NorenOraclePegOneSided.selector);
        vm.prank(taker);
        router.swap(order, USDG, NVDA, 100e6, _takerData(true, 0));
    }

    /// @notice Even when the maker's Aqua strategy also holds TSLA, an NVDA peg never prices TSLA.
    function test_wrongPairRejected() public {
        ISwapVM.Order memory order = _aquaOrder(maker, _program(_stockArgs(NVDA, FEED_NVDA, 50, 50), 6));
        address[] memory tokens = new address[](3);
        tokens[0] = USDG;
        tokens[1] = NVDA;
        tokens[2] = TSLA;
        uint256[] memory amounts = new uint256[](3);
        amounts[0] = 1_000e6;
        vm.prank(maker);
        aqua.ship(address(router), abi.encode(order), tokens, amounts);
        vm.expectRevert(abi.encodeWithSelector(NorenOraclePeg.NorenOraclePegWrongPair.selector, TSLA, USDG));
        q.quote(order, TSLA, USDG, 1e18, _takerData(true, 0));
    }

    /// @notice A Robinhood corporate action (real updateMultiplier role) re-prices the strategy live.
    function test_uiMultiplierIsReadLive() public {
        if (_closedNow()) vm.skip(true);
        (ISwapVM.Order memory order,) = _shipNvda(50, 50, 20_000e6, 0, 7);
        (, uint256 before,) = q.quote(order, NVDA, USDG, 1e18, _takerData(true, 0));
        uint256 m = _mult(NVDA);
        vm.prank(MULTIPLIER_ADMIN);
        IStock(NVDA).updateMultiplier(m * 2);
        (, uint256 afterSplit,) = q.quote(order, NVDA, USDG, 1e18, _takerData(true, 0));
        assertApproxEqAbs(afterSplit, before * 2, 1);
    }

    // ------------------------------------------------------------ Data Feeds safety (attacks)

    function test_stalePriceRefusesToQuote() public {
        (ISwapVM.Order memory order,) = _shipNvda(50, 50, 20_000e6, 0, 8);
        // Next Wednesday 15:00 UTC is inside open hours; the frozen fork feed is days old by then.
        vm.warp(_nextAt(3, 15) + 7 days);
        (,,, uint256 updatedAt,) = IFeedFull(FEED_NVDA).latestRoundData();
        vm.expectRevert(abi.encodeWithSelector(NorenOraclePeg.NorenOraclePegStalePrice.selector, FEED_NVDA, updatedAt, MAX_AGE_OPEN));
        q.quote(order, NVDA, USDG, 1e18, _takerData(true, 0));
    }

    /// @notice Saturday: the stock feed may be up to 3 days old and the spread widens by closedExtraBps.
    function test_weekendWindowAllowsOlderStockPriceWithWiderSpread() public {
        NorenOraclePegArgsBuilder.Args memory a = _stockArgs(NVDA, FEED_NVDA, 50, 50);
        a.quoteMaxAge = 30 days; // the fork freezes the 24/7 USDG feed too; isolate the stock rule
        ISwapVM.Order memory order = _aquaOrder(maker, _program(a, 9));
        _ship(maker, address(router), order, NVDA, 20_000e6, 0);
        (,,, uint256 updatedAt,) = IFeedFull(FEED_NVDA).latestRoundData();
        uint256 sat = _nextAt(6, 12);
        if (sat - updatedAt <= MAX_AGE_OPEN || sat - updatedAt > MAX_AGE_CLOSED) vm.skip(true);
        vm.warp(sat);
        (, uint256 out,) = q.quote(order, NVDA, USDG, 1e18, _takerData(true, 0));
        assertEq(out, _expectedUsdgOut(1e18, 550));
        // the same age on a weekday is stale
        vm.warp(_nextAt(3, 12) + 7 days);
        vm.expectRevert();
        q.quote(order, NVDA, USDG, 1e18, _takerData(true, 0));
    }

    function test_quoteTokenDepegRefusesToQuote() public {
        NorenOraclePegArgsBuilder.Args memory a = _stockArgs(NVDA, FEED_NVDA, 50, 50);
        a.quoteMaxDepegBps = 0; // the real USDG/USD answer is not exactly $1.00000000
        ISwapVM.Order memory order = _aquaOrder(maker, _program(a, 10));
        _ship(maker, address(router), order, NVDA, 1_000e6, 0);
        uint256 usdgPx = _px(FEED_USDG);
        if (usdgPx == 1e8) vm.skip(true);
        vm.expectRevert(abi.encodeWithSelector(NorenOraclePeg.NorenOraclePegQuoteDepeg.selector, usdgPx));
        q.quote(order, NVDA, USDG, 1e18, _takerData(true, 0));
    }

    /// @notice Maker circuit breaker: an oracle print outside the maker's band never fills.
    function test_priceOutsideMakerBandRefusesToQuote() public {
        uint256 px = _px(FEED_NVDA);
        NorenOraclePegArgsBuilder.Args memory a = _stockArgs(NVDA, FEED_NVDA, 50, 50);
        a.minPriceUsd8 = uint64(px + 1); // a band the current price sits below
        a.maxPriceUsd8 = uint64(px * 2);
        ISwapVM.Order memory order = _aquaOrder(maker, _program(a, 11));
        _ship(maker, address(router), order, NVDA, 1_000e6, 0);
        vm.expectRevert(abi.encodeWithSelector(NorenOraclePeg.NorenOraclePegPriceOutOfBand.selector, px, px + 1, px * 2));
        q.quote(order, NVDA, USDG, 1e18, _takerData(true, 0));
    }

    /// @notice A taker cannot get more than oracle - spread: asking for one more unit of output reverts.
    function test_takerCannotBeatThePeg() public {
        if (_closedNow()) vm.skip(true);
        (ISwapVM.Order memory order,) = _shipNvda(50, 50, 20_000e6, 0, 12);
        uint256 fair = _expectedUsdgOut(1e18, 50);
        vm.expectRevert(abi.encodeWithSelector(TakerTraitsLib.TakerTraitsInsufficientMinOutputAmount.selector, fair, fair + 1));
        vm.prank(taker);
        router.swap(order, NVDA, USDG, 1e18, _takerData(true, fair + 1));
    }

    // ------------------------------------------------------------ funding (attacks)

    function test_virtualBalanceCapsTheFill() public {
        if (_closedNow()) vm.skip(true);
        (ISwapVM.Order memory order,) = _shipNvda(50, 50, 100e6, 0, 13);
        vm.expectRevert(abi.encodeWithSelector(NorenOraclePeg.NorenOraclePegInsufficientBalance.selector, 100e6, 101e6));
        q.quote(order, NVDA, USDG, 101e6, _takerData(false, type(uint256).max));
    }

    /// @notice Aqua virtual balances can exceed what the maker really holds. The instruction checks
    /// the maker's wallet balance and allowance so the fill fails at quote time with a readable error.
    function test_underfundedMakerFailsAtQuote() public {
        if (_closedNow()) vm.skip(true);
        address poor = makeAddr("poorMaker");
        _fund(USDG, poor, 100e6);
        vm.prank(poor);
        IERC20(USDG).approve(AQUA, type(uint256).max);
        ISwapVM.Order memory order = _aquaOrder(poor, _program(_stockArgs(NVDA, FEED_NVDA, 50, 50), 14));
        _ship(poor, address(router), order, NVDA, 10_000e6, 0); // promises 10,000 USDG, holds 100
        vm.expectRevert(abi.encodeWithSelector(NorenOraclePeg.NorenOraclePegMakerUnderfunded.selector, poor, USDG, 100e6, 500e6));
        q.quote(order, NVDA, USDG, 500e6, _takerData(false, type(uint256).max));
        // revoking the Aqua allowance has the same effect
        vm.prank(poor);
        IERC20(USDG).approve(AQUA, 10e6);
        vm.expectRevert(abi.encodeWithSelector(NorenOraclePeg.NorenOraclePegMakerUnderfunded.selector, poor, USDG, 10e6, 50e6));
        q.quote(order, NVDA, USDG, 50e6, _takerData(false, type(uint256).max));
    }

    function test_dockedStrategyCannotTrade() public {
        (ISwapVM.Order memory order, bytes32 h) = _shipNvda(50, 50, 1_000e6, 0, 15);
        address[] memory tokens = new address[](2);
        tokens[0] = USDG;
        tokens[1] = NVDA;
        vm.prank(maker);
        aqua.dock(address(router), h, tokens);
        vm.expectRevert();
        q.quote(order, NVDA, USDG, 1e18, _takerData(true, 0));
    }

    // ------------------------------------------------------------ reentrancy (attack)

    /// @notice A maker hook that re-enters swap() on the same Aqua strategy mid-settlement is stopped
    /// by SwapVM's per-order transient lock, so a strategy can never be filled twice in one swap.
    function test_reentrantHookCannotDoubleFill() public {
        if (_closedNow()) vm.skip(true);
        ReenteringHook hook = new ReenteringHook(router, taker);
        bytes memory program = _program(_stockArgs(NVDA, FEED_NVDA, 50, 50), 16);
        ISwapVM.Order memory order = MakerTraitsLib.build(
            MakerTraitsLib.Args({
                maker: maker,
                receiver: address(0),
                shouldUnwrapWeth: false,
                useAquaInsteadOfSignature: true,
                allowZeroAmountIn: false,
                hasPreTransferInHook: false,
                hasPostTransferInHook: false,
                hasPreTransferOutHook: true,
                hasPostTransferOutHook: false,
                preTransferInTarget: address(0),
                preTransferInData: "",
                postTransferInTarget: address(0),
                postTransferInData: "",
                preTransferOutTarget: address(hook),
                preTransferOutData: "",
                postTransferOutTarget: address(0),
                postTransferOutData: "",
                program: program
            })
        );
        _ship(maker, address(router), order, NVDA, 20_000e6, 0);
        hook.arm(order, _takerData(true, 0));
        vm.expectRevert(TransientLockLib.UnexpectedLock.selector);
        vm.prank(taker);
        router.swap(order, NVDA, USDG, 1e18, _takerData(true, 0));
    }
}

interface IFeedFull {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// @dev Attacker-controlled maker hook that tries to fill the same strategy again mid-swap.
contract ReenteringHook is IMakerHooks {
    NorenAquaSwapVMRouter internal immutable router;
    address internal immutable attackerTaker;
    ISwapVM.Order internal order;
    bytes internal takerData;

    constructor(NorenAquaSwapVMRouter r, address t) {
        router = r;
        attackerTaker = t;
    }

    function arm(ISwapVM.Order memory o, bytes memory td) external {
        order = o;
        takerData = td;
    }

    function preTransferOut(address, address, address tokenIn, address tokenOut, uint256 amountIn, uint256, bytes32, bytes calldata, bytes calldata) external {
        router.swap(order, tokenIn, tokenOut, amountIn, takerData);
    }

    function preTransferIn(address, address, address, address, uint256, uint256, bytes32, bytes calldata, bytes calldata) external {}
    function postTransferIn(address, address, address, address, uint256, uint256, bytes32, bytes calldata, bytes calldata) external {}
    function postTransferOut(address, address, address, address, uint256, uint256, bytes32, bytes calldata, bytes calldata) external {}
}
