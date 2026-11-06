// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Test.sol";
import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {CcipForkBase} from "./CcipForkBase.sol";
import {NorenCcipBase} from "../src/NorenCcipBase.sol";
import {NorenCcipGateway} from "../src/NorenCcipGateway.sol";
import {NorenCcipHub} from "../src/NorenCcipHub.sol";
import {NorenArcActionRouter, INorenCcipSender} from "../src/NorenArcActionRouter.sol";
import {NorenCcipInbox} from "../src/NorenCcipInbox.sol";
import {NorenArcAction} from "../src/libraries/NorenArcAction.sol";
import {INorenActionSink} from "../src/interfaces/INorenActionSink.sol";

/// @dev FORK-ONLY stand-in for Arc's native USDC at 0x3600…, whose native-balance bridge Foundry forks cannot run
///      (same reason as packages/contracts/src/ForkUSDC.sol). Never deployed anywhere.
contract ForkArcUSDC {
  mapping(address => uint256) public balanceOf;
  mapping(address => mapping(address => uint256)) public allowance;

  function decimals() external pure returns (uint8) {
    return 6;
  }

  function mint(address to, uint256 v) external {
    balanceOf[to] += v;
  }

  function approve(address s, uint256 v) external returns (bool) {
    allowance[msg.sender][s] = v;
    return true;
  }

  function transfer(address to, uint256 v) external returns (bool) {
    require(balanceOf[msg.sender] >= v, "balance");
    balanceOf[msg.sender] -= v;
    balanceOf[to] += v;
    return true;
  }

  function transferFrom(address f, address to, uint256 v) external returns (bool) {
    require(allowance[f][msg.sender] >= v && balanceOf[f] >= v, "allowance");
    allowance[f][msg.sender] -= v;
    balanceOf[f] -= v;
    balanceOf[to] += v;
    return true;
  }
}

/// @notice Robinhood Chain testnet -> Base Sepolia hub -> Arc testnet (and back), plus direct Base Sepolia and
///         Ethereum Sepolia -> Arc, on forks of the four public testnets with the real Chainlink CCIP contracts.
contract NorenCcipForkTest is CcipForkBase {
  address internal constant ARC_USDC = 0x3600000000000000000000000000000000000000;
  address internal constant BASE_LINK = 0xE4aB69C077896252FAFBD49EFD26B5D171A32410;

  address internal operator = makeAddr("noren-credit-operator"); // stands in for NorenCredit's operator on Robinhood
  address internal borrower = makeAddr("borrower");
  address internal merchant = makeAddr("merchant");

  NorenCcipGateway internal rhGw;
  NorenCcipInbox internal rhInbox;
  NorenCcipHub internal hub;
  NorenCcipGateway internal baseGw;
  NorenCcipGateway internal arcGw;
  NorenArcActionRouter internal arcRouter;
  NorenCcipGateway internal sepGw;

  bytes32 internal constant LINE = keccak256("line-1");

  uint32 internal constant HUB_GAS = 400_000;
  uint32 internal constant ARC_GAS = 500_000;
  uint32 internal constant RH_GAS = 400_000;

  function setUp() public {
    _forks();

    vm.selectFork(arcFork);
    vm.etch(ARC_USDC, address(new ForkArcUSDC()).code);
    arcGw = new NorenCcipGateway(ARC_ROUTER, ARC, address(this));
    arcRouter = new NorenArcActionRouter(IERC20(ARC_USDC), address(this));
    arcGw.setApp(INorenActionSink(address(arcRouter)));
    arcRouter.setRail(address(arcGw), NorenArcAction.RAIL_CCIP);
    arcRouter.setCcipGateway(INorenCcipSender(address(arcGw)));
    arcRouter.setCreditAuthority(NorenArcAction.RAIL_CCIP, RH, operator, true);
    ForkArcUSDC(ARC_USDC).mint(address(this), 100e6);
    IERC20(ARC_USDC).approve(address(arcRouter), 100e6);
    arcRouter.addLiquidity(100e6);

    vm.selectFork(baseFork);
    hub = new NorenCcipHub(BASE_ROUTER, BASE, address(this));
    baseGw = new NorenCcipGateway(BASE_ROUTER, BASE, address(this));
    vm.deal(address(hub), 0.05 ether);

    vm.selectFork(rhFork);
    rhGw = new NorenCcipGateway(RH_ROUTER, RH, address(this));
    rhInbox = new NorenCcipInbox(address(rhGw), address(this));
    rhGw.setApp(INorenActionSink(address(rhInbox)));

    vm.selectFork(sepFork);
    sepGw = new NorenCcipGateway(SEP_ROUTER, SEP, address(this));

    // Robinhood: Arc via the Base hub; trust the hub for Arc-origin envelopes.
    vm.selectFork(rhFork);
    rhGw.setRoute(ARC, NorenCcipGateway.Route(BASE, address(hub), address(arcGw), HUB_GAS, 0));
    rhGw.setPeer(BASE, address(hub), NorenCcipBase.Peer.HUB);
    rhGw.setAllowedOrigin(ARC, true);
    rhInbox.setReporter(ARC, address(arcRouter), true);

    // Base hub: accepts the Robinhood and Arc gateways, forwards to the other one.
    vm.selectFork(baseFork);
    hub.setPeer(RH, address(rhGw), NorenCcipBase.Peer.GATEWAY);
    hub.setPeer(ARC, address(arcGw), NorenCcipBase.Peer.GATEWAY);
    hub.setHubRoute(ARC, NorenCcipHub.HubRoute(address(arcGw), ARC_GAS, 0));
    hub.setHubRoute(RH, NorenCcipHub.HubRoute(address(rhGw), RH_GAS, 0));
    baseGw.setRoute(ARC, NorenCcipGateway.Route(ARC, address(arcGw), address(arcGw), ARC_GAS, 0));

    // Ethereum Sepolia: direct lane into Arc.
    vm.selectFork(sepFork);
    sepGw.setRoute(ARC, NorenCcipGateway.Route(ARC, address(arcGw), address(arcGw), ARC_GAS, 0));

    // Arc: trust the hub (for Robinhood-origin envelopes) and the direct Base / Sepolia gateways.
    vm.selectFork(arcFork);
    arcGw.setPeer(BASE, address(hub), NorenCcipBase.Peer.HUB);
    arcGw.setAllowedOrigin(RH, true);
    arcGw.setPeer(BASE, address(baseGw), NorenCcipBase.Peer.GATEWAY);
    arcGw.setPeer(SEP, address(sepGw), NorenCcipBase.Peer.GATEWAY);
    arcGw.setRoute(RH, NorenCcipGateway.Route(BASE, address(hub), address(rhGw), HUB_GAS, 0));
  }

  // ---------------------------------------------------------------- helpers

  function _creditLine(uint256 limit, uint64 asOf) internal view returns (bytes memory) {
    return NorenArcAction.encode(
      NorenArcAction.CREDIT_LINE, borrower, LINE, abi.encode(LINE, limit, uint64(block.timestamp + 30 days), asOf)
    );
  }

  function _payOnCredit(bytes32 invoiceId, uint256 amount) internal view returns (bytes memory) {
    return NorenArcAction.encode(NorenArcAction.PAY_ON_CREDIT, borrower, invoiceId, abi.encode(LINE, merchant, invoiceId, amount));
  }

  /// @dev Sends from `gw` on `fork` paying native fees through the real Router + OnRamp; returns the OnRamp message.
  function _send(uint256 fork, NorenCcipGateway gw, address onRamp, address from, uint64 finalChain, bytes memory payload)
    internal
    returns (Sent memory s)
  {
    vm.selectFork(fork);
    uint256 fee = gw.quote(finalChain, payload, address(0), 0, address(0));
    assertGt(fee, 0, "real fee quote");
    vm.deal(from, fee + 1 ether);
    vm.recordLogs();
    vm.prank(from);
    bytes32 id = gw.send{value: fee + 0.001 ether}(finalChain, payload, address(0), 0, address(0));
    s = _sentFromLogs(vm.getRecordedLogs(), onRamp);
    assertEq(s.messageId, id, "gateway returned the OnRamp messageId");
    assertEq(from.balance, 1 ether, "excess native fee refunded");
  }

  /// @dev Routes `s` into the Base hub and returns the hub's outbound message (second hop).
  function _throughHub(Sent memory s) internal returns (Sent memory out) {
    vm.recordLogs();
    (bool ok, bytes memory ret, uint256 gasUsed) = _route(baseFork, BASE_ROUTER, BASE_OFFRAMP, s);
    assertTrue(ok, string(ret));
    assertLt(gasUsed, HUB_GAS, "hub hop fits its gas limit");
    out = _sentFromLogs(vm.getRecordedLogs(), BASE_ONRAMP);
    assertEq(hub.forwardedAs(s.messageId), out.messageId);
  }

  // ---------------------------------------------------------------- Robinhood -> Base hub -> Arc

  function test_RobinhoodToArcViaHub_opensLineAndPaysMerchantOnCredit() public {
    Sent memory s1 = _send(rhFork, rhGw, RH_ONRAMP, operator, ARC, _creditLine(50e6, 1));
    assertEq(s1.dest, BASE, "first hop goes to the Base hub");
    Sent memory h1 = _throughHub(s1);
    assertEq(h1.dest, ARC);
    (bool ok, bytes memory ret, uint256 gasUsed) = _route(arcFork, ARC_ROUTER, ARC_OFFRAMP, h1);
    assertTrue(ok, string(ret));
    assertLt(gasUsed, ARC_GAS, "arc hop fits its gas limit");
    (address b, uint64 expiry,, uint64 src, uint256 limit,,) = arcRouter.lines(LINE);
    assertEq(b, borrower);
    assertEq(limit, 50e6);
    assertEq(src, RH);
    assertGt(expiry, block.timestamp);
    assertEq(uint8(arcGw.statusOf(h1.messageId)), uint8(NorenCcipGateway.Status.DELIVERED));
    assertEq(arcGw.deliveredMessage(RH, 1), h1.messageId);
    (,,,,,,,, bytes32 prev,) = arcGw.deliveries(h1.messageId);
    assertEq(prev, s1.messageId, "Arc delivery links back to the Robinhood messageId");

    bytes32 inv = keccak256("invoice-42");
    Sent memory s2 = _send(rhFork, rhGw, RH_ONRAMP, borrower, ARC, _payOnCredit(inv, 12e6));
    Sent memory h2 = _throughHub(s2);
    (ok, ret,) = _route(arcFork, ARC_ROUTER, ARC_OFFRAMP, h2);
    assertTrue(ok, string(ret));
    assertEq(IERC20(ARC_USDC).balanceOf(merchant), 12e6, "merchant paid in USDC on Arc");
    assertEq(arcRouter.available(LINE), 38e6);
    assertTrue(arcRouter.invoicePaid(inv));
  }

  function test_ReversePath_ArcToRobinhoodViaHub_reportsLineUtilisation() public {
    test_RobinhoodToArcViaHub_opensLineAndPaysMerchantOnCredit();

    vm.selectFork(arcFork);
    address reporterEoa = makeAddr("anyone");
    vm.deal(reporterEoa, 10 ether);
    vm.recordLogs();
    vm.prank(reporterEoa);
    bytes32 id = arcRouter.reportLine{value: 1 ether}(LINE, RH);
    Sent memory s = _sentFromLogs(vm.getRecordedLogs(), ARC_ONRAMP);
    assertEq(s.messageId, id);
    assertGt(reporterEoa.balance, 9 ether, "unused native fee refunded through the router");

    Sent memory h = _throughHub(s);
    assertEq(h.dest, RH);
    (bool ok, bytes memory ret,) = _route(rhFork, RH_ROUTER, RH_OFFRAMP, h);
    assertTrue(ok, string(ret));
    (uint256 drawn, uint256 repaid, uint64 asOf, uint64 source, address b, bytes32 msgId) = rhInbox.lineReports(LINE);
    assertEq(drawn, 12e6);
    assertEq(repaid, 0);
    assertGt(asOf, 0);
    assertEq(source, ARC);
    assertEq(b, borrower);
    assertEq(msgId, h.messageId);
  }

  // ---------------------------------------------------------------- direct lanes into Arc

  function test_DirectBaseSepoliaToArc_opensAquaOrder() public {
    bytes32 ref = keccak256("aqua-order-1");
    bytes memory action = NorenArcAction.encode(NorenArcAction.AQUA_ORDER, borrower, ref, hex"c0ffee");
    Sent memory s = _send(baseFork, baseGw, BASE_ONRAMP, borrower, ARC, action);
    assertEq(s.dest, ARC, "direct lane, no hub");
    (bool ok, bytes memory ret,) = _route(arcFork, ARC_ROUTER, ARC_OFFRAMP, s);
    assertTrue(ok, string(ret));
    (address ben,,,, uint64 src, bool open,) = arcRouter.aquaOrders(ref);
    assertEq(ben, borrower);
    assertEq(src, BASE);
    assertTrue(open);
  }

  function test_DirectEthereumSepoliaToArc_opensAquaOrder() public {
    bytes32 ref = keccak256("aqua-order-sep");
    bytes memory action = NorenArcAction.encode(NorenArcAction.AQUA_ORDER, borrower, ref, hex"beef");
    Sent memory s = _send(sepFork, sepGw, SEP_ONRAMP, borrower, ARC, action);
    assertEq(s.dest, ARC);
    (bool ok, bytes memory ret,) = _route(arcFork, ARC_ROUTER, ARC_OFFRAMP, s);
    assertTrue(ok, string(ret));
    (, , , , uint64 src, bool open,) = arcRouter.aquaOrders(ref);
    assertEq(src, SEP);
    assertTrue(open);
  }

  // ---------------------------------------------------------------- safety

  function test_ReplayOfSameMessageIsRejected() public {
    Sent memory s = _send(baseFork, baseGw, BASE_ONRAMP, borrower, ARC, NorenArcAction.encode(3, borrower, bytes32("r"), ""));
    (bool ok,,) = _route(arcFork, ARC_ROUTER, ARC_OFFRAMP, s);
    assertTrue(ok);
    (bool ok2, bytes memory ret2,) = _route(arcFork, ARC_ROUTER, ARC_OFFRAMP, s);
    assertFalse(ok2);
    assertEq(bytes4(ret2), NorenCcipBase.MessageReplayed.selector);
  }

  function test_UnknownSourceSenderIsRejected() public {
    vm.selectFork(baseFork);
    NorenCcipGateway rogue = new NorenCcipGateway(BASE_ROUTER, BASE, address(this));
    rogue.setRoute(ARC, NorenCcipGateway.Route(ARC, address(arcGw), address(arcGw), ARC_GAS, 0));
    Sent memory s = _send(baseFork, rogue, BASE_ONRAMP, borrower, ARC, _creditLine(1_000_000e6, 1));
    (bool ok, bytes memory ret,) = _route(arcFork, ARC_ROUTER, ARC_OFFRAMP, s);
    assertFalse(ok);
    assertEq(bytes4(ret), NorenCcipBase.UntrustedSender.selector);
    (address b,,,,,,) = arcRouter.lines(LINE);
    assertEq(b, address(0), "no state change from an unknown sender");
  }

  function test_OutOfOrderDeliveryKeepsNewestCreditUpdate() public {
    Sent memory older = _send(rhFork, rhGw, RH_ONRAMP, operator, ARC, _creditLine(10e6, 1));
    Sent memory newer = _send(rhFork, rhGw, RH_ONRAMP, operator, ARC, _creditLine(20e6, 2));
    Sent memory hNewer = _throughHub(newer);
    Sent memory hOlder = _throughHub(older);
    (bool ok1,,) = _route(arcFork, ARC_ROUTER, ARC_OFFRAMP, hNewer);
    (bool ok2,,) = _route(arcFork, ARC_ROUTER, ARC_OFFRAMP, hOlder);
    assertTrue(ok1 && ok2);
    (,, uint64 asOf,, uint256 limit,,) = arcRouter.lines(LINE);
    assertEq(limit, 20e6, "older update arriving late does not overwrite");
    assertEq(asOf, 2);
  }

  function test_HubOutOfFees_ForwardPending_ThenAnyoneRetries() public {
    vm.selectFork(baseFork);
    hub.withdrawNative(payable(address(0xdead)), address(hub).balance);
    Sent memory s = _send(rhFork, rhGw, RH_ONRAMP, operator, ARC, _creditLine(5e6, 1));
    vm.recordLogs();
    (bool ok, bytes memory ret, uint256 gasUsed) = _route(baseFork, BASE_ROUTER, BASE_OFFRAMP, s);
    assertTrue(ok, string(ret));
    assertLt(gasUsed, HUB_GAS, "pending path fits the hub gas limit");
    assertEq(uint8(hub.forwardStatus(s.messageId)), uint8(NorenCcipHub.ForwardStatus.PENDING));
    bytes memory env;
    Vm.Log[] memory logs = vm.getRecordedLogs();
    for (uint256 i = 0; i < logs.length; i++) {
      if (logs[i].emitter == address(hub) && logs[i].topics[0] == NorenCcipHub.ForwardPending.selector) {
        (env,) = abi.decode(logs[i].data, (bytes, bytes));
      }
    }
    assertGt(env.length, 0, "envelope recoverable from the ForwardPending event");

    address keeper = makeAddr("keeper");
    vm.deal(keeper, 1 ether);
    vm.recordLogs();
    vm.prank(keeper);
    hub.retryForward{value: 0.01 ether}(s.messageId, env);
    Sent memory h = _sentFromLogs(vm.getRecordedLogs(), BASE_ONRAMP);
    assertEq(uint8(hub.forwardStatus(s.messageId)), uint8(NorenCcipHub.ForwardStatus.FORWARDED));
    (ok, ret,) = _route(arcFork, ARC_ROUTER, ARC_OFFRAMP, h);
    assertTrue(ok, string(ret));
    (, , , , uint256 limit,,) = arcRouter.lines(LINE);
    assertEq(limit, 5e6);
  }

  function test_PayOnCreditWithoutLiquidity_FailsSafely_ThenRetrySucceeds() public {
    test_RobinhoodToArcViaHub_opensLineAndPaysMerchantOnCredit();
    vm.selectFork(arcFork);
    arcRouter.withdrawLiquidity(address(this), arcRouter.liquidity());

    bytes32 inv = keccak256("invoice-43");
    Sent memory s = _send(rhFork, rhGw, RH_ONRAMP, borrower, ARC, _payOnCredit(inv, 5e6));
    Sent memory h = _throughHub(s);
    (bool ok, bytes memory ret,) = _route(arcFork, ARC_ROUTER, ARC_OFFRAMP, h);
    assertTrue(ok, string(ret)); // the CCIP execution itself succeeds
    assertEq(uint8(arcGw.statusOf(h.messageId)), uint8(NorenCcipGateway.Status.FAILED));

    IERC20(ARC_USDC).approve(address(arcRouter), 5e6);
    arcRouter.addLiquidity(5e6);
    vm.prank(makeAddr("anyone"));
    arcGw.retryFailed(h.messageId);
    assertEq(uint8(arcGw.statusOf(h.messageId)), uint8(NorenCcipGateway.Status.DELIVERED));
    assertEq(IERC20(ARC_USDC).balanceOf(merchant), 17e6);
  }

  function test_PayOnCreditFromNonBorrowerIsDeclined() public {
    test_RobinhoodToArcViaHub_opensLineAndPaysMerchantOnCredit();
    bytes32 inv = keccak256("invoice-evil");
    Sent memory s = _send(rhFork, rhGw, RH_ONRAMP, makeAddr("mallory"), ARC, _payOnCredit(inv, 1e6));
    Sent memory h = _throughHub(s);
    (bool ok,,) = _route(arcFork, ARC_ROUTER, ARC_OFFRAMP, h);
    assertTrue(ok);
    assertFalse(arcRouter.invoicePaid(inv));
    assertEq(IERC20(ARC_USDC).balanceOf(merchant), 12e6);
  }

  function test_LinkFeePath_BaseSepoliaToArc() public {
    vm.selectFork(baseFork);
    bytes memory p = NorenArcAction.encode(3, borrower, bytes32("link-fee"), "");
    uint256 fee = baseGw.quote(ARC, p, address(0), 0, BASE_LINK);
    assertGt(fee, 0);
    deal(BASE_LINK, borrower, fee); // fork-only balance cheat; the fee itself is the real FeeQuoter's
    vm.startPrank(borrower);
    IERC20(BASE_LINK).approve(address(baseGw), fee);
    vm.recordLogs();
    bytes32 id = baseGw.send(ARC, p, address(0), 0, BASE_LINK);
    vm.stopPrank();
    Sent memory s = _sentFromLogs(vm.getRecordedLogs(), BASE_ONRAMP);
    assertEq(s.messageId, id);
    assertEq(IERC20(BASE_LINK).balanceOf(borrower), 0, "exact LINK fee pulled");
    (bool ok, bytes memory ret,) = _route(arcFork, ARC_ROUTER, ARC_OFFRAMP, s);
    assertTrue(ok, string(ret));
  }

  function test_FinalityPolicy_TrustedSendersMayUseBlockDepth() public {
    vm.selectFork(arcFork);
    (,,, bytes4 before) = arcGw.getCCVsAndFinalityConfig(BASE, abi.encode(address(baseGw)));
    assertEq(before, bytes4(0), "finality-only by default");
    arcGw.setMinFinalityDepth(BASE, 10);
    (,,, bytes4 trusted) = arcGw.getCCVsAndFinalityConfig(BASE, abi.encode(address(baseGw)));
    (,,, bytes4 untrusted) = arcGw.getCCVsAndFinalityConfig(BASE, abi.encode(makeAddr("x")));
    assertEq(trusted, bytes4(uint32(10)));
    assertEq(untrusted, bytes4(0));
  }

}
