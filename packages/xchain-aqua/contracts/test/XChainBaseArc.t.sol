// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {Math} from '@oz/utils/math/Math.sol';
import {XC} from '../script/XChainConstants.sol';
import {XChainForkBase, IForkUSDC, IWETH9} from './XChainForkBase.sol';
import {CrossChainOrder} from '../src/XChainOrder.sol';
import {XChainMessages, PriceRound} from '../src/XChainMessages.sol';
import {XChainInbox} from '../src/XChainTransport.sol';
import {NorenCrossChainSettler} from '../src/NorenCrossChainSettler.sol';
import {NorenCrossChainEscrow} from '../src/NorenCrossChainEscrow.sol';
import {IAggregatorV3} from '../src/interfaces/IExternal.sol';

/// @notice A second source chain against the same Arc maker: WETH locked on Base Sepolia (fork),
/// USDC paid on Arc from the same maker wallet that serves Robinhood orders.
contract XChainBaseArcTest is XChainForkBase {
  uint256 internal constant AMOUNT = 0.5 ether;

  function setUp() public {
    _setUpArc();
    uint256 base = vm.createSelectFork(vm.envString('NOREN_XCHAIN_BASE_RPC'));
    assertEq(block.chainid, XC.BASE_SEPOLIA, 'Base Sepolia fork');
    vm.deal(taker, 2 ether);
    vm.prank(taker);
    IWETH9(XC.BASE_WETH).deposit{value: 1 ether}();
    _setUpSource(base, XC.BASE_FORWARDER, XC.BASE_WETH, XC.BASE_ETH_USD, false, arc.wethRoute);
  }

  function test_wethOnBasePaysUsdcOnArcAndReleasesToMaker() public {
    CrossChainOrder memory o = _order(AMOUNT, 1e6, maker, wethStrategy, 1);
    vm.selectFork(srcFork);
    (uint80 roundId, int256 answer,,,) = IAggregatorV3(XC.BASE_ETH_USD).latestRoundData();
    bytes memory payload = _open(o);
    assertEq(IERC20(XC.BASE_WETH).balanceOf(address(escrow)), AMOUNT, 'escrow holds 0.5 WETH on Base');
    (,, PriceRound memory p) = abi.decode(payload, (uint8, CrossChainOrder, PriceRound));
    assertEq(p.roundId, roundId, 'real Chainlink ETH/USD round on Base Sepolia');
    assertEq(p.answer, answer);
    assertEq(p.uiMultiplier, 1e18);

    vm.selectFork(arcFork);
    uint256 makerUsdc = _usdc(maker);
    (bytes memory settlement, bytes memory rejection) = _toArc(payload);
    assertEq(rejection.length, 0, 'filled');
    uint256 expected = _expectedOut(arc.ethUsd, AMOUNT, 1e18, false);
    assertEq(_usdc(recipient), expected, 'taker paid on Arc at Chainlink ETH/USD - 50 bps');
    assertEq(makerUsdc - _usdc(maker), expected, 'from the same maker wallet');
    assertEq(arc.rWeth.totalSupply(), 0);

    _toSource(settlement);
    assertEq(IERC20(XC.BASE_WETH).balanceOf(makerPayout), AMOUNT, 'maker received WETH on Base');
    assertEq(uint8(escrow.orderStatus(keccak256(abi.encode(o)))), uint8(NorenCrossChainEscrow.Status.Released));
  }

  function test_oneMakerWalletBacksTwoRoutes() public {
    // The same maker's USDC wallet backs both the NVDA (Robinhood) and WETH (Base) strategies:
    // Aqua virtual balances are allocations of one wallet, not separate deposits.
    vm.selectFork(arcFork);
    assertEq(_aquaBalance(maker, nvdaStrategy, XC.ARC_USDC), 15_000e6);
    assertEq(_aquaBalance(maker, wethStrategy, XC.ARC_USDC), 15_000e6);
    assertEq(_usdc(maker), MAKER_USDC, '20,000 USDC in the wallet back 30,000 of allocations');
    (bytes memory settlement,) = _toArc(_open(_order(AMOUNT, 1e6, maker, wethStrategy, 2)));
    _toSource(settlement);
    vm.selectFork(arcFork);
    uint256 paid = _usdc(recipient);
    assertEq(MAKER_USDC - _usdc(maker), paid);
    assertEq(_aquaBalance(maker, nvdaStrategy, XC.ARC_USDC), 15_000e6, 'the other route is untouched');
    assertEq(_aquaBalance(maker, wethStrategy, XC.ARC_USDC), 15_000e6 - paid);
  }

  function test_nvdaOrderCannotUseTheWethStrategy() public {
    // A Base WETH order pointed at the maker's Robinhood NVDA strategy is the wrong route.
    CrossChainOrder memory o = _order(AMOUNT, 1e6, maker, nvdaStrategy, 3);
    bytes memory payload = _open(o);
    vm.selectFork(arcFork);
    vm.prank(XC.ARC_FORWARDER);
    vm.expectRevert(abi.encodeWithSelector(NorenCrossChainSettler.WrongStrategy.selector, nvdaStrategy, arc.wethRoute));
    arc.settler.onReport('', payload);
  }
}

/// @notice USDC that arrived on Arc through the Arc action router (CCTP V2 hook or CCIP, action kind
/// 3 = AQUA_ORDER) buys EURC from the same maker at the Chainlink EUR/USD peg. The EUR/USD round is
/// read from Arc mainnet (read-only) and relayed by a PRICE report.
contract XChainDeliveredTest is XChainForkBase {
  using Math for uint256;

  address internal actionRouter = makeAddr('arc-action-router');
  PriceRound internal eur;

  function setUp() public {
    vm.createSelectFork(vm.envOr('ARC_MAINNET_RPC', string('https://arc-rpc.publicnode.com')));
    assertEq(block.chainid, XC.ARC_MAINNET);
    (eur.roundId, eur.answer, eur.startedAt, eur.updatedAt, eur.answeredInRound) = IAggregatorV3(XC.ARC_MAINNET_EUR_USD).latestRoundData();
    eur.decimals = IAggregatorV3(XC.ARC_MAINNET_EUR_USD).decimals();
    eur.uiMultiplier = 1e18;
    eur.sourceFeed = XC.ARC_MAINNET_EUR_USD;
    uint256 mainnetNow = block.timestamp;

    _setUpArc();
    if (block.timestamp < mainnetNow) vm.warp(mainnetNow); // the fork's clock must not be behind the round
    vm.prank(XC.ARC_FORWARDER);
    arc.settler.onReport('', abi.encode(XChainMessages.PRICE, address(arc.eurUsd), eur));
    arc.settler.setTransport(actionRouter, true);
    IForkUSDC(XC.ARC_USDC).mint(actionRouter, 1_000e6);
    vm.prank(actionRouter);
    IERC20(XC.ARC_USDC).approve(address(arc.settler), type(uint256).max);
  }

  function _params(uint256 minOut, address makerArg, bytes32 strategy, uint256 nonce) internal view returns (bytes memory) {
    return abi.encode(
      NorenCrossChainSettler.AquaOrderParams({
        srcChainId: XC.BASE_SEPOLIA,
        tokenOut: XC.ARC_EURC,
        minAmountOut: minOut,
        recipient: recipient,
        maker: makerArg,
        strategyHash: strategy,
        fillDeadline: uint64(block.timestamp + 10 minutes),
        nonce: nonce
      })
    );
  }

  function test_deliveredUsdcBuysEurcFromTheMaker() public {
    uint256 amountIn = 100e6;
    uint256 makerEurc = IERC20(XC.ARC_EURC).balanceOf(maker);
    vm.prank(actionRouter);
    (bool filled, uint256 out,) = arc.settler.fillDelivered(XC.ARC_USDC, amountIn, recipient, bytes32('cctp-1'), _params(1, maker, eurcStrategy, 1));
    assertTrue(filled);
    // Maker sells EURC at EUR/USD * (1 + 40 bps): EURC out = USDC in * 1e8 * 10000 / (price * 10040), floor.
    uint256 expected = amountIn.mulDiv(1e8 * 10_000, uint256(eur.answer) * 10_040);
    assertEq(out, expected);
    assertEq(IERC20(XC.ARC_EURC).balanceOf(recipient), expected, 'EURC to the beneficiary');
    assertEq(makerEurc - IERC20(XC.ARC_EURC).balanceOf(maker), expected, 'from the maker wallet');
    assertEq(IERC20(XC.ARC_USDC).balanceOf(actionRouter), 900e6, 'router paid exactly the USDC it delivered');
    assertEq(_usdc(maker), MAKER_USDC + amountIn, 'maker received the USDC');
  }

  function test_failedDeliveredFillPullsNothing() public {
    vm.prank(actionRouter);
    (bool filled, uint256 out, bytes32 id) =
      arc.settler.fillDelivered(XC.ARC_USDC, 100e6, recipient, bytes32('cctp-2'), _params(1_000e6, maker, eurcStrategy, 2));
    assertFalse(filled);
    assertEq(out, 0);
    assertEq(IERC20(XC.ARC_USDC).balanceOf(actionRouter), 1_000e6, 'funds stay with the router (claimable)');
    assertEq(uint8(arc.settler.orderStatus(id)), 0);
  }

  function test_deliveredWrongMakerIsRejectedWithoutPulling() public {
    vm.prank(actionRouter);
    (bool filled,,) = arc.settler.fillDelivered(XC.ARC_USDC, 100e6, recipient, bytes32('cctp-3'), _params(1, otherMaker, eurcStrategy, 3));
    assertFalse(filled);
    assertEq(IERC20(XC.ARC_USDC).balanceOf(actionRouter), 1_000e6);
  }

  function test_deliveredOrderRunsOnce() public {
    bytes memory p = _params(1, maker, eurcStrategy, 4);
    vm.prank(actionRouter);
    (,, bytes32 id) = arc.settler.fillDelivered(XC.ARC_USDC, 10e6, recipient, bytes32('cctp-4'), p);
    vm.prank(actionRouter);
    vm.expectRevert(abi.encodeWithSelector(NorenCrossChainSettler.AlreadySettled.selector, id, NorenCrossChainSettler.Status.Filled));
    arc.settler.fillDelivered(XC.ARC_USDC, 10e6, recipient, bytes32('cctp-4'), p);
  }

  function test_onlyTheActionRouterCanDeliver() public {
    vm.expectRevert(abi.encodeWithSelector(XChainInbox.NotTransport.selector, address(this)));
    arc.settler.fillDelivered(XC.ARC_USDC, 10e6, recipient, bytes32('x'), _params(1, maker, eurcStrategy, 5));
  }

  function test_stockReceiptsCannotBeDelivered() public {
    // Escrowed routes are not delivered routes: a transport can't push receipts in.
    vm.prank(actionRouter);
    (bool filled,,) = arc.settler.fillDelivered(address(arc.rNvda), 1e18, recipient, bytes32('x'), _params(1, maker, nvdaStrategy, 6));
    assertFalse(filled);
  }
}
