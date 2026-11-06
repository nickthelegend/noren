// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

/// @custom:license-url https://github.com/1inch/swap-vm/blob/main/LICENSES/SwapVM-1.1.txt
/// @custom:copyright Tests for a SwapVM extension. © 2026 Nivesh Gajengi; SwapVM — © Degensoft Ltd 2025.

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { MakerTraitsLib } from "@1inch/swap-vm/src/libs/MakerTraits.sol";
import { TakerTraitsLib } from "@1inch/swap-vm/src/libs/TakerTraits.sol";

import { NorenAquaSwapVMRouter } from "../src/routers/NorenAquaSwapVMRouter.sol";
import { NorenOraclePegArgsBuilder } from "../src/instructions/NorenOraclePeg.sol";

/// @notice Shared fixture. Runs only on a fork of Robinhood Chain mainnet (chain 4663) with the
/// official Aqua registry, real USDG, WETH, Stock Tokens and Chainlink feeds. Balances come from
/// impersonating a real holder (the Uniswap v4 PoolManager), never from deal().
abstract contract PegBase is Test {
    // Official 1inch deployments on Robinhood Chain (1inch/aqua deployments.md)
    address internal constant AQUA = 0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a;
    address internal constant OFFICIAL_ROUTER = 0x111111338c5091E8440b67B168bAe16a668AC0De;

    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address internal constant TSLA = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d;
    address internal constant FEED_NVDA = 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15;
    address internal constant FEED_TSLA = 0x4A1166a659A55625345e9515b32adECea5547C38;
    address internal constant FEED_ETH = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9;
    address internal constant FEED_USDG = 0x61B7e5650328764B076A108EFF5fa7282a1B9aD2;
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant MULTIPLIER_ADMIN = 0x92905e8d0e2301BA143215B8D86D63fFD4188143;

    uint32 internal constant MAX_AGE_OPEN = 86_400 + 3_600;
    uint32 internal constant MAX_AGE_CLOSED = 3 days;

    uint8 internal constant OP_SALT = 20; // AquaOpcodes: Controls._salt
    uint8 internal constant OP_XYC = 17; // AquaOpcodes: XYCSwap._xycSwapXD
    uint8 internal constant OP_PEG = 34; // NorenAquaSwapVMRouter: NorenOraclePeg

    NorenAquaSwapVMRouter internal router;
    /// @dev View handle: ISwapVM declares quote() view, so calls through it are static calls.
    ISwapVM internal q;
    IAqua internal aqua = IAqua(AQUA);

    address internal maker = makeAddr("maker");
    address internal taker = makeAddr("taker");

    function setUp() public virtual {
        require(block.chainid == 4663, "Run on the Robinhood mainnet fork: sh scripts/test-swapvm.sh");
        require(AQUA.code.length > 0 && OFFICIAL_ROUTER.code.length > 0, "official Aqua/SwapVM missing on this fork");
        router = new NorenAquaSwapVMRouter(AQUA, WETH, address(this), "Noren SwapVM", "1.0.2-noren.1");
        q = ISwapVM(address(router));
        _fund(USDG, maker, 50_000e6);
        _fund(NVDA, taker, 50e18);
        _fund(TSLA, taker, 20e18);
        vm.prank(maker);
        IERC20(USDG).approve(AQUA, type(uint256).max);
        vm.startPrank(taker);
        IERC20(NVDA).approve(address(router), type(uint256).max);
        IERC20(TSLA).approve(address(router), type(uint256).max);
        IERC20(USDG).approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    function _fund(address token, address to, uint256 amount) internal {
        vm.prank(POOL_MANAGER);
        IERC20(token).transfer(to, amount);
    }

    function _pegArgs(address base, address feed, uint16 bid, uint16 ask, uint8 flags)
        internal
        pure
        returns (NorenOraclePegArgsBuilder.Args memory)
    {
        return NorenOraclePegArgsBuilder.Args({
            base: base,
            quote: USDG,
            baseFeed: feed,
            quoteFeed: FEED_USDG,
            baseMaxAgeOpen: MAX_AGE_OPEN,
            baseMaxAgeClosed: (flags & NorenOraclePegArgsBuilder.FLAG_MARKET_HOURS) != 0 ? MAX_AGE_CLOSED : MAX_AGE_OPEN,
            quoteMaxAge: MAX_AGE_OPEN,
            bidSpreadBps: bid,
            askSpreadBps: ask,
            closedExtraBps: (flags & NorenOraclePegArgsBuilder.FLAG_MARKET_HOURS) != 0 ? 500 : 0,
            quoteMaxDepegBps: 200,
            flags: flags,
            minPriceUsd8: 0,
            maxPriceUsd8: 0
        });
    }

    function _stockArgs(address base, address feed, uint16 bid, uint16 ask) internal pure returns (NorenOraclePegArgsBuilder.Args memory) {
        return _pegArgs(base, feed, bid, ask, NorenOraclePegArgsBuilder.FLAG_UI_MULTIPLIER | NorenOraclePegArgsBuilder.FLAG_MARKET_HOURS);
    }

    function _program(NorenOraclePegArgsBuilder.Args memory a, uint64 salt) internal pure returns (bytes memory) {
        bytes memory peg = NorenOraclePegArgsBuilder.build(a);
        return bytes.concat(abi.encodePacked(OP_SALT, uint8(8), salt), abi.encodePacked(OP_PEG, uint8(peg.length)), peg);
    }

    function _aquaOrder(address who, bytes memory program) internal pure returns (ISwapVM.Order memory) {
        return MakerTraitsLib.build(
            MakerTraitsLib.Args({
                maker: who,
                receiver: address(0),
                shouldUnwrapWeth: false,
                useAquaInsteadOfSignature: true,
                allowZeroAmountIn: false,
                hasPreTransferInHook: false,
                hasPostTransferInHook: false,
                hasPreTransferOutHook: false,
                hasPostTransferOutHook: false,
                preTransferInTarget: address(0),
                preTransferInData: "",
                postTransferInTarget: address(0),
                postTransferInData: "",
                preTransferOutTarget: address(0),
                preTransferOutData: "",
                postTransferOutTarget: address(0),
                postTransferOutData: "",
                program: program
            })
        );
    }

    /// @dev Maker ships the order to Aqua for `app` with virtual balances (USDG, base).
    function _ship(address who, address app, ISwapVM.Order memory order, address base, uint256 usdgAmount, uint256 baseAmount)
        internal
        returns (bytes32 strategyHash)
    {
        address[] memory tokens = new address[](2);
        tokens[0] = USDG;
        tokens[1] = base;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = usdgAmount;
        amounts[1] = baseAmount;
        vm.prank(who);
        strategyHash = aqua.ship(app, abi.encode(order), tokens, amounts);
    }

    function _takerData(bool exactIn, uint256 threshold) internal view returns (bytes memory) {
        return TakerTraitsLib.build(
            TakerTraitsLib.Args({
                taker: taker,
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
                instructionsArgs: "",
                signature: ""
            })
        );
    }

    /// @dev Chainlink answer normalised to 8 decimals, read the same way the instruction does.
    function _px(address feed) internal view returns (uint256) {
        (, int256 answer,,,) = IFeed(feed).latestRoundData();
        uint8 dec = IFeed(feed).decimals();
        return dec == 8 ? uint256(answer) : dec > 8 ? uint256(answer) / 10 ** (dec - 8) : uint256(answer) * 10 ** (8 - dec);
    }

    function _mult(address stock) internal view returns (uint256) {
        return IStock(stock).uiMultiplier();
    }

    function _closedNow() internal view returns (bool) {
        uint256 dow = (block.timestamp / 1 days + 4) % 7;
        return dow == 6 || dow == 0 || (dow == 1 && block.timestamp % 1 days < 6 hours);
    }

    /// @dev Next timestamp at `hourUtc` on weekday `dow` (0 = Sunday) strictly after now.
    function _nextAt(uint256 dow, uint256 hourUtc) internal view returns (uint256 ts) {
        uint256 day = block.timestamp / 1 days;
        for (uint256 i; i < 8; ++i) {
            uint256 d = day + i;
            ts = d * 1 days + hourUtc * 1 hours;
            if ((d + 4) % 7 == dow && ts > block.timestamp) return ts;
        }
        revert("no slot");
    }
}

interface IFeed {
    function decimals() external view returns (uint8);
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

interface IStock {
    function uiMultiplier() external view returns (uint256);
    function updateMultiplier(uint256) external;
}
