// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from 'forge-std/Test.sol';
import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {Math} from '@oz/utils/math/Math.sol';
import {XC} from '../script/XChainConstants.sol';
import {XChainDeployer} from '../script/XChainDeployer.sol';
import {CrossChainOrder} from '../src/XChainOrder.sol';
import {NorenCrossChainSettler} from '../src/NorenCrossChainSettler.sol';
import {NorenCrossChainEscrow} from '../src/NorenCrossChainEscrow.sol';
import {NorenRelayedFeed} from '../src/NorenRelayedFeed.sol';
import {ISwapVMRouter} from '../src/interfaces/IExternal.sol';

interface IAquaShip {
  function ship(address app, bytes calldata strategy, address[] calldata tokens, uint256[] calldata amounts)
    external
    returns (bytes32 strategyHash);
  function rawBalances(address maker, address app, bytes32 strategyHash, address token)
    external
    view
    returns (uint248 balance, uint8 tokensCount);
}

interface IForkUSDC {
  function mint(address to, uint256 value) external;
}

interface IWETH9 {
  function deposit() external payable;
}

/// @notice Two local Anvil forks in one test: the Arc Testnet fork (official 1inch Aqua installed at
/// its official address from Arc mainnet bytecode, Arc's native USDC replaced by the fork-only
/// ForkUSDC shim, both by scripts/test-forks.sh) and a source-chain fork (the warmed Robinhood
/// mainnet snapshot, or Base Sepolia). The test plays the CRE DON: it reads the XChainMessage the
/// contract emitted on one fork and delivers the payload on the other fork as that chain's CRE
/// simulation forwarder. scripts/xchain-demo.sh runs the same flow through `cre workflow simulate`.
abstract contract XChainForkBase is Test, XChainDeployer {
  using Math for uint256;

  bytes32 internal constant XCHAIN_MESSAGE = keccak256('XChainMessage(bytes32,uint64,address,bytes)');
  bytes32 internal constant FILL_REJECTED = keccak256('FillRejected(bytes32,bytes)');
  uint64 internal constant SALT = 7;

  uint256 internal arcFork;
  uint256 internal srcFork;
  ArcStack internal arc;
  NorenCrossChainEscrow internal escrow;
  address internal srcForwarder;
  uint64 internal srcChainId;
  address internal srcToken;
  bytes32 internal srcRoute;

  address internal maker = makeAddr('arc-maker');
  address internal makerPayout = makeAddr('maker-payout-on-source');
  address internal otherMaker = makeAddr('other-arc-maker');
  address internal taker = makeAddr('taker-on-source');
  address internal recipient = makeAddr('taker-on-arc');

  bytes32 internal nvdaStrategy;
  bytes32 internal wethStrategy;
  bytes32 internal eurcStrategy;
  bytes32 internal otherNvdaStrategy;

  uint256 internal constant MAKER_USDC = 20_000e6; // one wallet backs every route
  uint16 internal constant BID = 50; // 0.50%
  uint16 internal constant CLOSED_EXTRA = 300;

  // ---------------------------------------------------------------- setup

  function _setUpArc() internal {
    arcFork = vm.createSelectFork(vm.envString('NOREN_XCHAIN_ARC_RPC'));
    assertEq(block.chainid, XC.ARC, 'Arc Testnet fork');
    assertEq(XC.AQUA.codehash, XC.AQUA_CODEHASH, 'official Aqua bytecode (from Arc mainnet) at its official address');
    assertEq(XC.OFFICIAL_SWAPVM_ROUTER.codehash, XC.ARC_ROUTER_CODEHASH, 'official SwapVM router bytecode (from Arc mainnet)');
    arc = _deployArc(address(this), XC.ARC_FORWARDER);
    IForkUSDC(XC.ARC_USDC).mint(maker, MAKER_USDC);
    IForkUSDC(XC.ARC_USDC).mint(otherMaker, 1_000e6);
    deal(XC.ARC_EURC, maker, 5_000e6);

    NorenCrossChainSettler.PegTerms memory t = _terms(BID, SALT);
    nvdaStrategy = _ship(maker, arc.nvdaRoute, t, address(arc.rNvda), XC.ARC_USDC, 15_000e6, makerPayout);
    wethStrategy = _ship(maker, arc.wethRoute, t, address(arc.rWeth), XC.ARC_USDC, 15_000e6, makerPayout);
    NorenCrossChainSettler.PegTerms memory ask = _terms(0, SALT);
    ask.askSpreadBps = 40;
    eurcStrategy = _ship(maker, arc.eurcRoute, ask, XC.ARC_USDC, XC.ARC_EURC, 5_000e6, address(0));
    otherNvdaStrategy = _ship(otherMaker, arc.nvdaRoute, t, address(arc.rNvda), XC.ARC_USDC, 1_000e6, makeAddr('other-payout'));
  }

  function _setUpSource(uint256 fork, address forwarder, address token, address feed, bool ui, bytes32 route_) internal {
    srcFork = fork;
    vm.selectFork(srcFork);
    srcChainId = uint64(block.chainid);
    srcForwarder = forwarder;
    srcToken = token;
    srcRoute = route_;
    escrow = _deployEscrow(address(this), forwarder, address(arc.settler), token, feed, ui);
    vm.selectFork(arcFork);
    arc.settler.setEscrow(srcChainId, address(escrow));
  }

  function _terms(uint16 bid, uint64 salt) internal pure returns (NorenCrossChainSettler.PegTerms memory t) {
    t = NorenCrossChainSettler.PegTerms({bidSpreadBps: bid, askSpreadBps: 0, closedExtraBps: CLOSED_EXTRA, minPriceUsd8: 0, maxPriceUsd8: 0, salt: salt});
  }

  /// @dev The maker's own transactions: approve Aqua, ship the canonical order, register it.
  function _ship(address who, bytes32 route_, NorenCrossChainSettler.PegTerms memory t, address inToken, address outToken, uint256 alloc, address payout)
    internal
    returns (bytes32 h)
  {
    (ISwapVMRouter.Order memory o, bytes32 expected) = arc.settler.buildOrder(who, route_, t);
    address[] memory tokens = new address[](2);
    tokens[0] = inToken;
    tokens[1] = outToken;
    uint256[] memory amounts = new uint256[](2);
    amounts[1] = alloc;
    vm.startPrank(who);
    IERC20(outToken).approve(XC.AQUA, type(uint256).max);
    h = IAquaShip(XC.AQUA).ship(arc.router, abi.encode(o), tokens, amounts);
    assertEq(h, expected, 'Aqua strategy hash');
    arc.settler.register(route_, t, payout);
    vm.stopPrank();
  }

  // ---------------------------------------------------------------- orders and relaying

  function _order(uint256 amountIn, uint256 minOut, address makerArg, bytes32 strategy, uint256 nonce)
    internal
    returns (CrossChainOrder memory o)
  {
    vm.selectFork(arcFork);
    uint64 arcNow = uint64(block.timestamp);
    vm.selectFork(srcFork);
    // Valid on both clocks: the deadline is read on Arc, the refund time on the source chain.
    uint64 later = arcNow > uint64(block.timestamp) ? arcNow : uint64(block.timestamp);
    o = CrossChainOrder({
      srcChainId: srcChainId,
      srcEscrow: address(escrow),
      dstChainId: XC.ARC,
      dstSettler: address(arc.settler),
      taker: taker,
      tokenIn: srcToken,
      amountIn: amountIn,
      tokenOut: XC.ARC_USDC,
      minAmountOut: minOut,
      recipient: recipient,
      maker: makerArg,
      strategyHash: strategy,
      fillDeadline: later + 30 minutes,
      refundAfter: later + 30 minutes + 2 hours,
      nonce: nonce
    });
  }

  /// @dev Taker locks tokenIn on the source fork; returns the payload the escrow emitted for Arc.
  function _open(CrossChainOrder memory o) internal returns (bytes memory payload) {
    vm.selectFork(srcFork);
    vm.startPrank(taker);
    IERC20(o.tokenIn).approve(address(escrow), o.amountIn);
    vm.recordLogs();
    escrow.open(o);
    vm.stopPrank();
    payload = _message(vm.getRecordedLogs(), address(escrow));
  }

  /// @dev CRE handler 0: deliver the source payload to the Arc settler. Returns the settlement payload (or empty).
  function _toArc(bytes memory payload) internal returns (bytes memory settlement, bytes memory rejection) {
    vm.selectFork(arcFork);
    vm.recordLogs();
    vm.prank(XC.ARC_FORWARDER);
    arc.settler.onReport('', payload);
    Vm.Log[] memory logs = vm.getRecordedLogs();
    settlement = _message(logs, address(arc.settler));
    for (uint256 i; i < logs.length; i++) {
      if (logs[i].emitter == address(arc.settler) && logs[i].topics[0] == FILL_REJECTED) rejection = abi.decode(logs[i].data, (bytes));
    }
  }

  /// @dev CRE handler 1: deliver the Arc settlement payload to the source escrow.
  function _toSource(bytes memory payload) internal {
    vm.selectFork(srcFork);
    vm.prank(srcForwarder);
    escrow.onReport('', payload);
  }

  function _message(Vm.Log[] memory logs, address emitter) internal pure returns (bytes memory payload) {
    for (uint256 i; i < logs.length; i++) {
      if (logs[i].emitter == emitter && logs[i].topics[0] == XCHAIN_MESSAGE) return abi.decode(logs[i].data, (bytes));
    }
  }

  // ---------------------------------------------------------------- expected prices (NorenOraclePeg arithmetic)

  function _closed(uint256 ts) internal pure returns (bool) {
    uint256 dow = (ts / 1 days + 4) % 7;
    if (dow == 6 || dow == 0) return true;
    return dow == 1 && ts % 1 days < 6 hours;
  }

  /// @dev USDC (6 dp) a maker pays for `amountIn` of an 18-dp base at the relayed round, minus the bid.
  function _expectedOut(NorenRelayedFeed feed, uint256 amountIn, uint256 mult, bool marketHours) internal view returns (uint256) {
    (, int256 answer,,,) = feed.latestRoundData();
    uint256 spread = BID + (marketHours && _closed(block.timestamp) ? CLOSED_EXTRA : 0);
    uint256 num = uint256(answer) * mult * 1e6;
    uint256 den = 1e8 * 1e18 * 1e18;
    return amountIn.mulDiv(num * (10_000 - spread), den * 10_000);
  }

  function _usdc(address who) internal view returns (uint256) {
    return IERC20(XC.ARC_USDC).balanceOf(who);
  }

  function _aquaBalance(address who, bytes32 h, address token) internal view returns (uint256 b) {
    (uint248 bal,) = IAquaShip(XC.AQUA).rawBalances(who, arc.router, h, token);
    b = bal;
  }
}
