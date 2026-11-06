// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from 'forge-std/Test.sol';
import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {Math} from '@oz/utils/math/Math.sol';
import {XC} from '../script/XChainConstants.sol';
import {XChainForkBase, IForkUSDC, IAquaShip} from './XChainForkBase.sol';
import {CrossChainOrder} from '../src/XChainOrder.sol';
import {XChainMessages} from '../src/XChainMessages.sol';
import {NorenCrossChainSettler} from '../src/NorenCrossChainSettler.sol';
import {NorenCrossChainEscrow} from '../src/NorenCrossChainEscrow.sol';
import {NorenEscrowReceipt} from '../src/NorenEscrowReceipt.sol';
import {IAqua, ISwapVMRouter, IAggregatorV3} from '../src/interfaces/IExternal.sol';

interface IStockToken {
  function uiMultiplier() external view returns (uint256);
}

/// @notice The reverse direction with the same contracts: USDC locked on Arc buys NVDA Stock Tokens
/// on Robinhood Chain from a Robinhood maker's Aqua strategy (official Aqua on Robinhood, Noren
/// SwapVM router, NorenOraclePeg reading the real Chainlink NVDA/USD feed directly, no relay).
/// The maker sells NVDA at Chainlink + ask and receives the taker's USDC on Arc when CRE reports the fill.
contract XChainReverseTest is XChainForkBase {
  using Math for uint256;

  address internal constant SNAPSHOT_CUSTOMER = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
  uint16 internal constant ASK = 60;
  uint256 internal constant USDC_IN = 500e6;

  uint256 internal rhFork;
  NorenCrossChainSettler internal rhSettler;
  NorenCrossChainEscrow internal arcEscrow;
  NorenEscrowReceipt internal rUsdc;
  bytes32 internal reverseRoute;
  bytes32 internal sellStrategy;
  address internal rhMaker = makeAddr('robinhood-maker');
  address internal rhMakerOnArc = makeAddr('robinhood-maker-on-arc');
  address internal arcTaker = makeAddr('taker-on-arc-with-usdc');
  address internal takerOnRobinhood = makeAddr('taker-on-robinhood');

  function setUp() public {
    arcFork = vm.createSelectFork(vm.envString('NOREN_XCHAIN_ARC_RPC'));
    assertEq(block.chainid, XC.ARC);
    rhFork = vm.createSelectFork(vm.envString('NOREN_XCHAIN_RH_RPC'));
    assertEq(block.chainid, XC.ROBINHOOD);
    assertEq(XC.AQUA.codehash, XC.AQUA_CODEHASH, 'official Aqua on Robinhood Chain');

    // Robinhood: Noren SwapVM router against the official Aqua, settler, rUSDC receipt, route.
    address router = _deployRouter(address(this));
    rhSettler = new NorenCrossChainSettler(address(this), XC.RH_FORWARDER, IAqua(XC.AQUA), ISwapVMRouter(router));
    rUsdc = new NorenEscrowReceipt('Noren escrow receipt: USDC on Arc', 'rUSDC', 6, XC.ARC, XC.ARC_USDC, address(rhSettler));
    rhSettler.setRoute(
      XC.ARC,
      XC.ARC_USDC,
      NorenCrossChainSettler.Route({
        inToken: address(rUsdc),
        outToken: XC.NVDA,
        delivered: false,
        takerSellsBase: false, // base = NVDA (the maker sells it), quote = rUSDC
        baseFeed: XC.NVDA_USD, // the real Chainlink feed on this chain: nothing to relay
        relayed: false,
        quoteFeed: address(0),
        baseMaxAgeOpen: 90_000,
        baseMaxAgeClosed: 259_200,
        quoteMaxAge: 0,
        quoteMaxDepegBps: 0,
        flags: 0x03,
        enabled: true
      })
    );
    reverseRoute = rhSettler.routeKey(XC.ARC, XC.ARC_USDC, XC.NVDA);

    // The Robinhood maker holds NVDA in its own wallet and ships a sell-side strategy.
    vm.prank(SNAPSHOT_CUSTOMER);
    IERC20(XC.NVDA).transfer(rhMaker, 10e18);
    NorenCrossChainSettler.PegTerms memory t =
      NorenCrossChainSettler.PegTerms({bidSpreadBps: 0, askSpreadBps: ASK, closedExtraBps: 300, minPriceUsd8: 0, maxPriceUsd8: 0, salt: 1});
    (ISwapVMRouter.Order memory o,) = rhSettler.buildOrder(rhMaker, reverseRoute, t);
    address[] memory tokens = new address[](2);
    tokens[0] = address(rUsdc);
    tokens[1] = XC.NVDA;
    uint256[] memory amounts = new uint256[](2);
    amounts[1] = 10e18;
    vm.startPrank(rhMaker);
    IERC20(XC.NVDA).approve(XC.AQUA, type(uint256).max);
    sellStrategy = IAquaShip(XC.AQUA).ship(router, abi.encode(o), tokens, amounts);
    rhSettler.register(reverseRoute, t, rhMakerOnArc);
    vm.stopPrank();

    // Arc: the escrow for USDC (no feed needed: the price is read on Robinhood).
    vm.selectFork(arcFork);
    arcEscrow = new NorenCrossChainEscrow(address(this), XC.ARC_FORWARDER);
    arcEscrow.setSettler(XC.ROBINHOOD, address(rhSettler));
    arcEscrow.setToken(XC.ARC_USDC, address(0), false, true);
    IForkUSDC(XC.ARC_USDC).mint(arcTaker, 1_000e6);
    vm.selectFork(rhFork);
    rhSettler.setEscrow(XC.ARC, address(arcEscrow));
  }

  function test_usdcOnArcBuysNvdaOnRobinhood() public {
    vm.selectFork(rhFork);
    uint64 rhNow = uint64(block.timestamp);
    vm.selectFork(arcFork);
    uint64 later = rhNow > uint64(block.timestamp) ? rhNow : uint64(block.timestamp);
    CrossChainOrder memory o = CrossChainOrder({
      srcChainId: XC.ARC,
      srcEscrow: address(arcEscrow),
      dstChainId: XC.ROBINHOOD,
      dstSettler: address(rhSettler),
      taker: arcTaker,
      tokenIn: XC.ARC_USDC,
      amountIn: USDC_IN,
      tokenOut: XC.NVDA,
      minAmountOut: 1,
      recipient: takerOnRobinhood,
      maker: rhMaker,
      strategyHash: sellStrategy,
      fillDeadline: later + 30 minutes,
      refundAfter: later + 3 hours,
      nonce: 1
    });
    vm.startPrank(arcTaker);
    IERC20(XC.ARC_USDC).approve(address(arcEscrow), USDC_IN);
    vm.recordLogs();
    arcEscrow.open(o);
    vm.stopPrank();
    bytes memory payload = _message(vm.getRecordedLogs(), address(arcEscrow));
    assertEq(IERC20(XC.ARC_USDC).balanceOf(address(arcEscrow)), USDC_IN, 'escrow holds 500 USDC on Arc');

    // CRE: Arc escrow -> Robinhood settler.
    vm.selectFork(rhFork);
    (, int256 px,,,) = IAggregatorV3(XC.NVDA_USD).latestRoundData();
    uint256 mult = IStockToken(XC.NVDA).uiMultiplier();
    uint256 makerNvda = IERC20(XC.NVDA).balanceOf(rhMaker);
    vm.recordLogs();
    vm.prank(XC.RH_FORWARDER);
    rhSettler.onReport('', payload);
    bytes memory settlement = _message(vm.getRecordedLogs(), address(rhSettler));
    uint256 spread = ASK + (_closed(block.timestamp) ? 300 : 0);
    // Maker sells base at oracle * (1 + ask): NVDA out = USDC in * den * BPS / (num * (BPS + ask)), floor.
    uint256 expected = USDC_IN.mulDiv(1e8 * 1e18 * 1e18 * 10_000, uint256(px) * mult * 1e6 * (10_000 + spread));
    assertEq(IERC20(XC.NVDA).balanceOf(takerOnRobinhood), expected, 'taker got NVDA on Robinhood at Chainlink + ask');
    assertEq(makerNvda - IERC20(XC.NVDA).balanceOf(rhMaker), expected, 'from the Robinhood maker wallet');
    assertEq(rUsdc.totalSupply(), 0);

    // CRE: Robinhood settler -> Arc escrow: the maker is paid the USDC on Arc.
    vm.selectFork(arcFork);
    vm.prank(XC.ARC_FORWARDER);
    arcEscrow.onReport('', settlement);
    assertEq(IERC20(XC.ARC_USDC).balanceOf(rhMakerOnArc), USDC_IN, 'maker received 500 USDC on Arc');
    assertEq(uint8(arcEscrow.orderStatus(keccak256(abi.encode(o)))), uint8(NorenCrossChainEscrow.Status.Released));
  }
}
