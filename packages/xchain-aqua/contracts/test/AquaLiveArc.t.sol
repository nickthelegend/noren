// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from 'forge-std/Test.sol';
import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {Math} from '@oz/utils/math/Math.sol';
import {AquaLiveDeployer} from '../script/AquaLiveDeployer.sol';
import {NorenCrossChainSettler} from '../src/NorenCrossChainSettler.sol';
import {NorenRateOracleFeed, INorenRateOracle} from '../src/NorenRateOracleFeed.sol';
import {XChainMessages} from '../src/XChainMessages.sol';
import {ISwapVMRouter} from '../src/interfaces/IExternal.sol';

interface IAquaV1 {
  function ship(address app, bytes calldata strategy, address[] calldata tokens, uint256[] calldata amounts)
    external
    returns (bytes32 strategyHash);
  function dock(address app, bytes32 strategyHash, address[] calldata tokens) external;
}

interface IShimUSDC {
  function mint(address to, uint256 value) external;
}

interface IRateOracleQuote {
  function rateE18(string calldata currency) external view returns (uint256);
  function maxAge() external view returns (uint256);
}

interface ILiveActionRouter {
  function execute(bytes32 rail, bytes32 msgId, uint64 source, address sourceSender, address token, uint256 amount, bytes calldata action)
    external
    returns (bool ok);
  function setAquaOperator(address operator) external;
  function aquaOperator() external view returns (address);
  function aquaOrders(bytes32 ref)
    external
    view
    returns (address beneficiary, address token, uint256 amount, bytes32 rail, uint64 source, bool open, bytes memory params);
  function owner() external view returns (address);
}

/// @notice The Arc Testnet Aqua stack on an Anvil fork of Arc Testnet (scripts/test-aqua-live.sh):
/// official 1inch Aqua v1.0.0 (unmodified build), the Noren SwapVM router, the NorenRateOracle feed
/// adapters reading the LIVE oracle's CRE-written Chainlink EUR/USD and USDC/USD rounds, the settler,
/// and the LIVE NorenArcActionRouter. With NOREN_AQUA_LIVE=true (fork taken after the live deployment)
/// the tests run against the deployed addresses in live/arc-testnet.json; otherwise they deploy a
/// fresh copy from live/config.json. Arc's native USDC is replaced by the fork-only ForkUSDC shim
/// (stock Anvil can't execute it); EURC is the real Arc Testnet EURC contract.
contract AquaLiveArcTest is Test, AquaLiveDeployer {
  using Math for uint256;

  bytes32 internal constant RAIL_CCTP = keccak256('CCTP');
  uint256 internal constant BPS = 10_000;
  string internal constant ARC_MAINNET_RPC = 'https://arc-rpc.publicnode.com';
  address internal constant OFFICIAL_AQUA = 0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a;

  LiveConfig internal c;
  LiveStack internal s;
  bool internal live;
  address internal maker = makeAddr('test-eurc-maker');
  address internal taker = makeAddr('test-taker');
  address internal recipient = makeAddr('test-eurc-recipient');
  bytes32 internal strategy;
  NorenCrossChainSettler.PegTerms internal terms;
  uint256 internal arcFork;

  function setUp() public {
    arcFork = vm.createSelectFork(vm.envString('NOREN_AQUA_ARC_RPC'));
    assertEq(block.chainid, 5042002, 'Arc Testnet fork');
    c = _config();
    live = vm.envOr('NOREN_AQUA_LIVE', false);
    if (live) {
      s = _loadLiveStack();
    } else {
      s = _deployLiveStack(address(this));
      ILiveActionRouter ar = ILiveActionRouter(c.actionRouter);
      vm.prank(ar.owner());
      ar.setAquaOperator(address(s.settler));
    }
    terms = _terms();
    terms.salt = 4242; // a test maker's own strategy, next to the live one
    deal(c.eurc, maker, 50e6);
    strategy = _ship(maker, terms, 40e6);
  }

  function _ship(address who, NorenCrossChainSettler.PegTerms memory t, uint256 alloc) internal returns (bytes32 h) {
    (ISwapVMRouter.Order memory o, bytes32 expected) = s.settler.buildOrder(who, s.routeKey, t);
    address[] memory tokens = new address[](2);
    tokens[0] = c.usdc;
    tokens[1] = c.eurc;
    uint256[] memory amounts = new uint256[](2);
    amounts[1] = alloc;
    vm.startPrank(who);
    IERC20(c.eurc).approve(s.aqua, type(uint256).max);
    h = IAquaV1(s.aqua).ship(s.router, abi.encode(o), tokens, amounts);
    assertEq(h, expected, 'Aqua strategy hash');
    s.settler.register(s.routeKey, t, address(0));
    vm.stopPrank();
  }

  /// EURC out for `usdcIn` at the oracle's USDC-per-EUR rate plus the maker's ask (floor).
  function _expectedEurc(uint256 usdcIn, uint16 askBps) internal view returns (uint256) {
    uint256 rate = IRateOracleQuote(c.rateOracle).rateE18('EUR'); // USDC per 1 EUR, 18 decimals
    return usdcIn.mulDiv(1e18 * BPS, rate * (BPS + askBps));
  }

  function _ask() internal view returns (uint16) {
    bool closed = (c.usdc != address(0)) && _closed(block.timestamp);
    return terms.askSpreadBps + (closed ? terms.closedExtraBps : 0);
  }

  function _closed(uint256 ts) internal pure returns (bool) {
    uint256 day = (ts / 1 days + 4) % 7; // 0 = Sunday
    return day == 6 || day == 0 || (day == 1 && (ts % 1 days) < 6 hours);
  }

  function _swap(address who, uint256 usdcIn, uint256 minOut) internal returns (uint256 out) {
    IShimUSDC(c.usdc).mint(who, usdcIn);
    vm.startPrank(who);
    IERC20(c.usdc).approve(s.router, usdcIn);
    (, out,) = ISwapVMRouter(s.router).swap(s.settler.strategyOrder(strategy), c.usdc, c.eurc, usdcIn, s.settler.takerData(minOut, who));
    vm.stopPrank();
  }

  // ---------------------------------------------------------------- the stack

  function test_aquaIsOfficialCodeIdenticalToArcMainnetExceptMetadata() public {
    bytes memory ours = s.aqua.code;
    uint256 mainnet = vm.createSelectFork(ARC_MAINNET_RPC);
    bytes memory official = OFFICIAL_AQUA.code;
    vm.selectFork(arcFork);
    assertTrue(mainnet != arcFork);
    assertEq(ours.length, official.length, 'same runtime length (5,619 bytes)');
    assertEq(ours.length, 5619);
    // Everything before the trailing 53-byte CBOR metadata is identical; only its 32-byte IPFS hash differs.
    uint256 n = ours.length - 53;
    for (uint256 i; i < n; ++i) {
      if (ours[i] != official[i]) revert('executable code differs from Arc mainnet');
    }
    // CBOR: a2 64 'ipfs' 58 22 12 20 (10 bytes) | 32-byte hash | 64 'solc' 43 00 08 1e 00 33 (11 bytes).
    assertEq(_slice(ours, n, 10), _slice(official, n, 10), 'CBOR prefix');
    assertEq(_slice(ours, ours.length - 11, 11), _slice(official, official.length - 11, 11), 'solc 0.8.30 tag');
  }

  function _slice(bytes memory b, uint256 from, uint256 len) internal pure returns (bytes memory out) {
    out = new bytes(len);
    for (uint256 i; i < len; ++i) out[i] = b[from + i];
  }

  function test_routerIsNorenSwapVMOnThisAqua() public view {
    assertEq(ISwapVMRouter(s.router).AQUA(), s.aqua, 'router bound to the Arc Testnet Aqua');
    assertEq(ISwapVMRouter(s.router).NOREN_ORACLE_PEG_OPCODE(), 34, 'NorenOraclePeg opcode');
    assertEq(s.settler.pegOpcode(), 34);
    assertEq(address(s.settler.router()), s.router);
    assertTrue(s.settler.transports(c.actionRouter), 'live action router is a transport');
    assertEq(ILiveActionRouter(c.actionRouter).aquaOperator(), address(s.settler), 'settler is the aquaOperator');
  }

  function test_feedsMirrorTheLiveCreWrittenChainlinkRounds() public view {
    INorenRateOracle.Rate memory r = INorenRateOracle(c.rateOracle).latestRate('EUR');
    assertGt(r.recordedAt, 0, 'the live oracle has a CRE-written EUR rate');
    (uint80 id, int256 a,, uint256 upd, uint80 air) = s.eurUsd.latestRoundData();
    assertEq(id, r.fiatUsdRoundId);
    assertEq(uint256(a), r.fiatUsdAnswer);
    assertEq(upd, r.fiatUsdUpdatedAt, 'Chainlink updatedAt, not the CRE write time');
    assertEq(air, id);
    assertEq(s.eurUsd.decimals(), r.fiatUsdDecimals);
    (id, a,, upd,) = s.usdcUsd.latestRoundData();
    assertEq(id, r.usdcUsdRoundId);
    assertEq(uint256(a), r.usdcUsdAnswer);
    assertEq(upd, r.usdcUsdUpdatedAt);
    assertEq(s.usdcUsd.decimals(), r.usdcUsdDecimals);
    assertEq(s.eurUsd.currency(), 'EUR');
  }

  // ---------------------------------------------------------------- fills

  function test_directSwapIsPricedByTheLiveOracleRate() public {
    uint256 makerUsdc = IERC20(c.usdc).balanceOf(maker);
    uint256 out = _swap(taker, 2e6, 1);
    uint256 expected = _expectedEurc(2e6, _ask());
    // rateE18 is floored, the instruction works on the raw rounds: allow 1 base unit.
    assertApproxEqAbs(out, expected, 1, 'EURC out = USDC in / (EUR/USD / USDC/USD x (1 + ask))');
    assertEq(IERC20(c.eurc).balanceOf(taker), out, 'taker got EURC');
    assertEq(IERC20(c.usdc).balanceOf(maker) - makerUsdc, 2e6, 'maker wallet got the USDC');
    assertEq(IERC20(c.eurc).balanceOf(maker), 50e6 - out, 'from the maker wallet');
  }

  function test_cctpAquaOrderInTheLiveActionRouterIsFilledThroughACreReport() public {
    bytes32 ref = keccak256('fork: cctp aqua order');
    uint256 amount = 1_999_740; // what a 2 USDC fast transfer mints after Circle's fee
    uint256 expected = _expectedEurc(amount, _ask());
    bytes memory params = abi.encode(
      NorenCrossChainSettler.AquaOrderParams({
        srcChainId: 421614,
        tokenOut: c.eurc,
        minAmountOut: expected * 99 / 100,
        recipient: recipient,
        maker: maker,
        strategyHash: strategy,
        fillDeadline: uint64(block.timestamp + 1 hours),
        nonce: 1
      })
    );
    ILiveActionRouter ar = ILiveActionRouter(c.actionRouter);
    IShimUSDC(c.usdc).mint(address(ar), amount); // what Circle's MessageTransmitter mints to the hook (fork shim)
    vm.prank(c.arcHook); // the live NorenArcHook is the router's CCTP rail
    assertTrue(ar.execute(RAIL_CCTP, keccak256('fork-nonce'), 3, recipient, c.usdc, amount, abi.encode(uint8(3), recipient, ref, params)));
    (,,,,, bool open,) = ar.aquaOrders(ref);
    assertTrue(open, 'router holds the AQUA_ORDER');

    vm.prank(c.creForwarder); // CRE ROUTER_ORDER report (packages/xchain-aqua/cre)
    s.settler.onReport('', abi.encode(XChainMessages.ROUTER_ORDER, address(ar), ref));
    (,,,,, open,) = ar.aquaOrders(ref);
    assertFalse(open, 'filled');
    assertApproxEqAbs(IERC20(c.eurc).balanceOf(recipient), expected, 1, 'EURC to the beneficiary');
    assertEq(IERC20(c.usdc).balanceOf(maker), amount, 'USDC to the maker');
  }

  // ---------------------------------------------------------------- refusals

  function test_staleOracleRateRefusesToQuote() public {
    INorenRateOracle.Rate memory r = INorenRateOracle(c.rateOracle).latestRate('EUR');
    vm.warp(uint256(r.usdcUsdUpdatedAt) + 90_001); // USDC/USD leg older than quoteMaxAge
    IShimUSDC(c.usdc).mint(taker, 1e6);
    vm.startPrank(taker);
    IERC20(c.usdc).approve(s.router, 1e6);
    ISwapVMRouter.Order memory o = s.settler.strategyOrder(strategy);
    bytes memory td = s.settler.takerData(1, taker);
    vm.expectRevert(
      abi.encodeWithSignature('NorenOraclePegStalePrice(address,uint256,uint256)', address(s.usdcUsd), uint256(r.usdcUsdUpdatedAt), uint256(90_000))
    );
    ISwapVMRouter(s.router).swap(o, c.usdc, c.eurc, 1e6, td);
    vm.stopPrank();
  }

  function test_underfundedMakerRefusesAndTheRouterOrderStaysOpen() public {
    vm.prank(maker);
    IERC20(c.eurc).transfer(address(1), 50e6); // wallet empty, Aqua allocation still 40 EURC
    bytes32 ref = keccak256('fork: underfunded');
    bytes memory params = abi.encode(
      NorenCrossChainSettler.AquaOrderParams({
        srcChainId: 84532,
        tokenOut: c.eurc,
        minAmountOut: 1,
        recipient: recipient,
        maker: maker,
        strategyHash: strategy,
        fillDeadline: uint64(block.timestamp + 1 hours),
        nonce: 2
      })
    );
    ILiveActionRouter ar = ILiveActionRouter(c.actionRouter);
    IShimUSDC(c.usdc).mint(address(ar), 1e6);
    vm.prank(c.arcHook);
    ar.execute(RAIL_CCTP, keccak256('fork-nonce-2'), 6, recipient, c.usdc, 1e6, abi.encode(uint8(3), recipient, ref, params));
    (bool filled,,) = s.settler.fillFromActionRouter(address(ar), ref);
    assertFalse(filled, 'NorenOraclePegMakerUnderfunded: nothing moves');
    (,,,,, bool open,) = ar.aquaOrders(ref);
    assertTrue(open, 'the beneficiary can still cancel and take the USDC back');
  }

  function test_minOutAboveThePegIsRefused() public {
    IShimUSDC(c.usdc).mint(taker, 1e6);
    vm.startPrank(taker);
    IERC20(c.usdc).approve(s.router, 1e6);
    ISwapVMRouter.Order memory o = s.settler.strategyOrder(strategy);
    bytes memory td = s.settler.takerData(1e6, taker); // 1 EURC for 1 USDC: better than EUR/USD allows
    vm.expectRevert();
    ISwapVMRouter(s.router).swap(o, c.usdc, c.eurc, 1e6, td);
    vm.stopPrank();
  }
}
