// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

/// @custom:license-url https://github.com/1inch/swap-vm/blob/main/LICENSES/SwapVM-1.1.txt
/// @custom:copyright Tests for a SwapVM extension. © 2026 Nivesh Gajengi; SwapVM — © Degensoft Ltd 2025.

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { TakerTraitsLib } from "@1inch/swap-vm/src/libs/TakerTraits.sol";

import { PegBase } from "./PegBase.sol";
import { NorenOraclePeg, NorenOraclePegArgsBuilder } from "../src/instructions/NorenOraclePeg.sol";
import { NorenDutchDecay, NorenDutchDecayArgsBuilder, INorenDutchAuctionHouse } from "../src/instructions/NorenDutchDecay.sol";

/// @dev The auction-house role the instruction trusts: it records auction starts and is the taker.
/// (Noren's real house is NorenDutchAuction in packages/robinhood; this one only exercises the
/// instruction against the official Aqua registry on the fork.)
contract TestAuctionHouse is INorenDutchAuctionHouse {
    mapping(bytes32 => uint256) public starts;
    ISwapVM internal immutable router;

    constructor(ISwapVM router_) {
        router = router_;
    }

    function setStart(bytes32 id, uint256 startedAt) external {
        starts[id] = startedAt;
    }

    function dutchAuctionStart(bytes32 auctionId) external view returns (uint256) {
        return starts[auctionId];
    }

    function takerData(bool exactIn, uint256 threshold, bytes32 auctionId) public view returns (bytes memory) {
        return TakerTraitsLib.build(
            TakerTraitsLib.Args({
                taker: address(this),
                isExactIn: exactIn,
                shouldUnwrapWeth: false,
                isStrictThresholdAmount: false,
                isFirstTransferFromTaker: false,
                useTransferFromAndAquaPush: true,
                threshold: abi.encodePacked(threshold),
                to: address(0),
                deadline: 0,
                hasPreTransferInCallback: false,
                hasPreTransferOutCallback: false,
                preTransferInHookData: "",
                postTransferInHookData: "",
                preTransferOutHookData: "",
                postTransferOutHookData: "",
                preTransferInCallbackData: "",
                preTransferOutCallbackData: "",
                instructionsArgs: abi.encodePacked(auctionId),
                signature: ""
            })
        );
    }

    function quote(ISwapVM.Order calldata order, address tokenIn, address tokenOut, uint256 amount, bool exactIn, bytes32 id)
        external
        view
        returns (uint256 amountIn, uint256 amountOut)
    {
        (amountIn, amountOut,) = router.quote(order, tokenIn, tokenOut, amount, takerData(exactIn, exactIn ? 0 : type(uint256).max, id));
    }

    function swap(ISwapVM.Order calldata order, address tokenIn, address tokenOut, uint256 amount, bool exactIn, bytes32 id)
        external
        returns (uint256 amountIn, uint256 amountOut)
    {
        IERC20(tokenIn).approve(address(router), type(uint256).max);
        (amountIn, amountOut,) = router.swap(order, tokenIn, tokenOut, amount, takerData(exactIn, exactIn ? 0 : type(uint256).max, id));
    }
}

/// @notice NorenDutchDecay composed with NorenOraclePeg on the Robinhood mainnet fork: real NVDA,
/// USDG and Chainlink feeds, settled through the official Aqua registry.
contract NorenDutchDecayTest is PegBase {
    using Math for uint256;

    uint8 internal constant OP_DUTCH = 35;
    uint16 internal constant START = 50; // 0.5%
    uint16 internal constant CAP = 800; // 8%
    uint32 internal constant DURATION = 2 hours;
    uint16 internal constant KEEPER_SHARE = 2_500; // 25% of the discount is the keeper's
    bytes32 internal constant ID = bytes32(uint256(7));

    TestAuctionHouse internal house;
    ISwapVM.Order internal order;
    bytes32 internal strategyHash;

    function setUp() public override {
        super.setUp();
        house = new TestAuctionHouse(q);
        order = _aquaOrder(maker, _dutchProgram(address(house), START, CAP, DURATION, KEEPER_SHARE));
        strategyHash = _ship(maker, address(router), order, NVDA, 20_000e6, 0);
        _fund(NVDA, address(house), 20e18);
    }

    // ------------------------------------------------------------ helpers

    function _dutchProgram(address h, uint16 start, uint16 cap, uint32 duration, uint16 share) internal pure returns (bytes memory) {
        bytes memory decay = NorenDutchDecayArgsBuilder.build(
            NorenDutchDecayArgsBuilder.Args({ house: h, startBps: start, capBps: cap, duration: duration, keeperShareBps: share })
        );
        // Zero-spread, buy-only peg: the auction discount is the only discount; no weekend extra.
        NorenOraclePegArgsBuilder.Args memory a = _stockArgs(NVDA, FEED_NVDA, 0, NorenOraclePegArgsBuilder.ONE_SIDED);
        a.closedExtraBps = 0;
        // A fork freezes every feed at the fork block, so the 24/7 USDG feed cannot reach its next
        // heartbeat during the hours these tests warp through: this maker allows a 2-day-old USDG
        // price. The NVDA feed keeps the production limits.
        a.quoteMaxAge = 2 days;
        bytes memory peg = NorenOraclePegArgsBuilder.build(a);
        return bytes.concat(
            abi.encodePacked(OP_SALT, uint8(8), uint64(0)),
            abi.encodePacked(OP_DUTCH, uint8(decay.length)),
            decay,
            abi.encodePacked(OP_PEG, uint8(peg.length)),
            peg
        );
    }

    function _args() internal view returns (NorenDutchDecayArgsBuilder.Args memory) {
        return NorenDutchDecayArgsBuilder.Args({ house: address(house), startBps: START, capBps: CAP, duration: DURATION, keeperShareBps: KEEPER_SHARE });
    }

    /// @dev Chainlink value of `nvdaIn` in raw USDG at zero spread (floor), the peg's own math.
    function _oracleUsdg(uint256 nvdaIn) internal view returns (uint256) {
        return nvdaIn.mulDiv(_px(FEED_NVDA) * _mult(NVDA) * 1e6, _px(FEED_USDG) * 1e18 * 1e18);
    }

    /// @dev Raw NVDA the zero-spread peg asks for `usdgOut` (ceil).
    function _oracleNvda(uint256 usdgOut) internal view returns (uint256) {
        return usdgOut.mulDiv(_px(FEED_USDG) * 1e18 * 1e18, _px(FEED_NVDA) * _mult(NVDA) * 1e6, Math.Rounding.Ceil);
    }

    function _startNow() internal {
        house.setStart(ID, block.timestamp);
    }

    // ------------------------------------------------------------ tests

    function test_routerExposesTheDecayOpcode() public view {
        assertEq(router.NOREN_DUTCH_DECAY_OPCODE(), OP_DUTCH);
        assertEq(router.NOREN_ORACLE_PEG_OPCODE(), OP_PEG);
    }

    function test_discountScheduleIsLinearAndCapped() public pure {
        NorenDutchDecayArgsBuilder.Args memory a =
            NorenDutchDecayArgsBuilder.Args({ house: address(1), startBps: START, capBps: CAP, duration: DURATION, keeperShareBps: KEEPER_SHARE });
        assertEq(NorenDutchDecayArgsBuilder.totalDiscountWad(a, 0), 0.005e18);
        assertEq(NorenDutchDecayArgsBuilder.totalDiscountWad(a, DURATION / 2), 0.0425e18);
        assertEq(NorenDutchDecayArgsBuilder.totalDiscountWad(a, DURATION), 0.08e18);
        assertEq(NorenDutchDecayArgsBuilder.totalDiscountWad(a, 30 days), 0.08e18, "never above the cap");
        assertEq(NorenDutchDecayArgsBuilder.makerDiscountWad(a, DURATION), 0.06e18, "keeper keeps 25% of the discount");
    }

    /// @notice The maker's exact-out price falls over time (vm.warp) and stops at the cap.
    function test_discountGrowsOverTimeOnTheFork() public {
        _startNow();
        uint256 usdgOut = 1_000e6;
        uint256 base = _oracleNvda(usdgOut);
        uint256 prevIn;
        uint256[5] memory at = [uint256(0), 30 minutes, 1 hours, 2 hours, 6 hours];
        uint256 t0 = vm.getBlockTimestamp(); // not block.timestamp: via-IR may re-read it after a warp
        for (uint256 i; i < at.length; ++i) {
            vm.warp(t0 + at[i]);
            (uint256 ain, uint256 aout) = house.quote(order, NVDA, USDG, usdgOut, false, ID);
            assertEq(aout, usdgOut);
            uint256 dm = NorenDutchDecayArgsBuilder.makerDiscountWad(_args(), at[i]);
            assertEq(ain, base.mulDiv(1e18, 1e18 - dm, Math.Rounding.Ceil), "exact-out = oracle amount / (1 - d)");
            if (i != 0) assertGe(ain, prevIn, "price only falls");
            if (i != 0 && at[i] <= DURATION) assertGt(ain, prevIn, "strictly before the cap");
            prevIn = ain;
        }
        (uint256 capIn,) = house.quote(order, NVDA, USDG, usdgOut, false, ID);
        assertEq(capIn, base.mulDiv(1e18, 1e18 - 0.06e18, Math.Rounding.Ceil), "flat at the cap after duration");
    }

    /// @notice Exact-in at any time pays at most the oracle value, and never less than oracle x (1 - cap).
    function test_neverAboveOracleNeverBelowCap() public {
        _startNow();
        uint256 t0 = vm.getBlockTimestamp(); // not block.timestamp: via-IR may re-read it after a warp
        for (uint256 dt; dt <= 3 hours; dt += 45 minutes) {
            vm.warp(t0 + dt);
            (, uint256 out) = house.quote(order, NVDA, USDG, 1e18, true, ID);
            uint256 oracleOut = _oracleUsdg(1e18);
            assertLt(out, oracleOut, "maker never pays the oracle price or more");
            assertGe(out, oracleOut * (10_000 - CAP) / 10_000, "never below oracle x (1 - cap)");
            uint256 dm = NorenDutchDecayArgsBuilder.makerDiscountWad(_args(), dt);
            assertEq(out, _oracleUsdg(1e18 - (1e18 * dm).ceilDiv(1e18)), "exact-in prices amountIn x (1 - d)");
        }
    }

    function test_swapSettlesThroughAquaAtTheDecayedPrice() public {
        _startNow();
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        (uint256 qin,) = house.quote(order, NVDA, USDG, 500e6, false, ID);
        uint256 makerUsdg = IERC20(USDG).balanceOf(maker);
        uint256 houseNvda = IERC20(NVDA).balanceOf(address(house));
        (uint256 ain, uint256 aout) = house.swap(order, NVDA, USDG, 500e6, false, ID);
        assertEq(ain, qin);
        assertEq(aout, 500e6);
        assertEq(IERC20(USDG).balanceOf(address(house)), 500e6, "house received exactly the USDG");
        assertEq(makerUsdg - IERC20(USDG).balanceOf(maker), 500e6, "from the maker wallet");
        assertEq(houseNvda - IERC20(NVDA).balanceOf(address(house)), ain);
        (uint248 nv,) = aqua.rawBalances(maker, address(router), strategyHash, NVDA);
        assertEq(nv, ain, "Aqua push credited the maker's strategy");
    }

    function test_roundingFavoursTheMaker() public {
        _startNow();
        vm.warp(vm.getBlockTimestamp() + 17 minutes);
        (, uint256 y) = house.quote(order, NVDA, USDG, 3.3e18 + 7, true, ID);
        (uint256 x2,) = house.quote(order, NVDA, USDG, y, false, ID);
        assertLe(x2, 3.3e18 + 7, "exact-out of the exact-in output never needs more than was put in");
        assertGe(x2 + 1e13, 3.3e18 + 7, "within one USDG price step");
        (uint256 x3,) = house.quote(order, NVDA, USDG, y + 1, false, ID);
        assertGt(x3, 3.3e18 + 7, "one more micro-USDG needs more NVDA than the exact-in amount");
        (, uint256 y1) = house.quote(order, NVDA, USDG, 1.65e18, true, ID);
        assertLe(2 * y1, y, "splitting never beats one fill");
    }

    function test_onlyTheHouseCanTake() public {
        _startNow();
        bytes memory td = house.takerData(true, 0, ID);
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(NorenDutchDecay.NorenDutchDecayTakerNotHouse.selector, taker));
        router.swap(order, NVDA, USDG, 1e18, td);
    }

    function test_noOpenAuctionOrFutureStartReverts() public {
        vm.expectRevert(abi.encodeWithSelector(NorenDutchDecay.NorenDutchDecayNoActiveAuction.selector, ID));
        house.quote(order, NVDA, USDG, 1e18, true, ID);
        house.setStart(ID, block.timestamp + 1);
        vm.expectRevert(abi.encodeWithSelector(NorenDutchDecay.NorenDutchDecayNoActiveAuction.selector, ID));
        house.quote(order, NVDA, USDG, 1e18, true, ID);
        // an auction id the house never opened
        _startNow();
        vm.expectRevert(abi.encodeWithSelector(NorenDutchDecay.NorenDutchDecayNoActiveAuction.selector, bytes32(uint256(8))));
        house.quote(order, NVDA, USDG, 1e18, true, bytes32(uint256(8)));
    }

    function test_stalePriceStillRefusesToQuote() public {
        _startNow();
        (,,, uint256 updatedAt,) = IFeedLike(FEED_NVDA).latestRoundData();
        vm.warp(updatedAt + MAX_AGE_CLOSED + 1);
        house.setStart(ID, block.timestamp);
        vm.expectRevert();
        house.quote(order, NVDA, USDG, 1e18, true, ID);
    }

    function test_badArgsAreRejected() public {
        NorenDutchDecayArgsBuilder.Args memory a = _args();
        a.capBps = 5_001;
        vm.expectRevert(NorenDutchDecayArgsBuilder.NorenDutchDecayBadArgs.selector);
        this.buildArgs(a);
        a = _args();
        a.startBps = CAP + 1;
        vm.expectRevert(NorenDutchDecayArgsBuilder.NorenDutchDecayBadArgs.selector);
        this.buildArgs(a);
        a = _args();
        a.duration = 0;
        vm.expectRevert(NorenDutchDecayArgsBuilder.NorenDutchDecayBadArgs.selector);
        this.buildArgs(a);

        // A program whose decay args are malformed fails at quote time.
        bytes memory bad = abi.encodePacked(address(house), uint16(900), uint16(800), DURATION, KEEPER_SHARE);
        NorenOraclePegArgsBuilder.Args memory pa = _stockArgs(NVDA, FEED_NVDA, 0, NorenOraclePegArgsBuilder.ONE_SIDED);
        bytes memory peg = NorenOraclePegArgsBuilder.build(pa);
        ISwapVM.Order memory o = _aquaOrder(
            maker,
            bytes.concat(abi.encodePacked(OP_DUTCH, uint8(bad.length)), bad, abi.encodePacked(OP_PEG, uint8(peg.length)), peg)
        );
        _ship(maker, address(router), o, NVDA, 1_000e6, 0);
        _startNow();
        vm.expectRevert(NorenDutchDecay.NorenDutchDecayBadArgs.selector);
        house.quote(o, NVDA, USDG, 1e18, true, ID);
    }

    function buildArgs(NorenDutchDecayArgsBuilder.Args memory a) external pure returns (bytes memory) {
        return NorenDutchDecayArgsBuilder.build(a);
    }
}

interface IFeedLike {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}
