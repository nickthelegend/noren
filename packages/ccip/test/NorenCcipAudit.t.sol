// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";

import {NorenCcipBase} from "../src/NorenCcipBase.sol";
import {NorenCcipGateway} from "../src/NorenCcipGateway.sol";
import {NorenCcipHub} from "../src/NorenCcipHub.sol";
import {NorenCcipEnvelope} from "../src/libraries/NorenCcipEnvelope.sol";
import {INorenActionSink} from "../src/interfaces/INorenActionSink.sol";

/// @dev Unit-test token (local only).
contract AuditToken is ERC20("Audit Token", "AUD") {
  function mint(address to, uint256 v) external {
    _mint(to, v);
  }
}

/// @dev An app that always reverts, so deliveries land in the FAILED store.
contract RevertingApp is INorenActionSink {
  function execute(bytes32, bytes32, uint64, address, address, uint256, bytes calldata) external pure returns (bool) {
    revert("app down");
  }
}

/// @notice Audit regressions for NorenCcipGateway / NorenCcipHub (local, no fork). The test plays the CCIP Router:
///         `ccipReceive` only checks msg.sender == router, so pranking that address delivers a message the way the
///         real OffRamp -> Router path does (that path is covered against the real CCIP contracts in fork-test/).
///         The send-path checks below revert before the router is ever called.
contract NorenCcipAuditTest is Test {
  uint64 internal constant LOCAL = 3034092155422581607; // Arc
  uint64 internal constant SRC = 10344971235874465080; // Base Sepolia
  address internal ccipRouter = makeAddr("ccip-router");
  address internal peer = makeAddr("source-gateway");
  address internal alice = makeAddr("alice");
  AuditToken internal token;
  NorenCcipGateway internal gw;

  function setUp() public {
    token = new AuditToken();
    gw = new NorenCcipGateway(ccipRouter, LOCAL, address(this));
    gw.setPeer(SRC, peer, NorenCcipBase.Peer.GATEWAY);
  }

  function _msg(bytes32 id, uint64 originNonce, uint256 amount, address finalReceiver)
    internal
    returns (Client.Any2EVMMessage memory m)
  {
    NorenCcipEnvelope.Envelope memory e = NorenCcipEnvelope.Envelope({
      version: NorenCcipEnvelope.VERSION,
      originChain: SRC,
      originSender: alice,
      nonce: originNonce,
      finalChain: LOCAL,
      finalReceiver: finalReceiver,
      prevMessageId: bytes32(0),
      payload: hex"01"
    });
    Client.EVMTokenAmount[] memory t = new Client.EVMTokenAmount[](amount == 0 ? 0 : 1);
    if (amount != 0) {
      t[0] = Client.EVMTokenAmount({token: address(token), amount: amount});
      token.mint(finalReceiver, amount); // the OffRamp's pool releases tokens before calling the receiver
    }
    m = Client.Any2EVMMessage({
      messageId: id,
      sourceChainSelector: SRC,
      sender: abi.encode(peer),
      data: abi.encode(e),
      destTokenAmounts: t
    });
  }

  function _receive(address receiver, Client.Any2EVMMessage memory m) internal {
    vm.prank(ccipRouter);
    NorenCcipGateway(payable(receiver)).ccipReceive(m);
  }

  // CCIP-1: the owner's withdrawToken could sweep tokens the gateway owes users (claimables, FAILED deliveries).
  function test_Audit_CCIP1_ownerCannotSweepClaimable() public {
    _receive(address(gw), _msg(bytes32("m1"), 1, 5e18, address(gw))); // no app: claimable by the origin sender
    assertEq(gw.claimable(alice, address(token)), 5e18);
    assertEq(gw.reserved(address(token)), 5e18);
    token.mint(address(gw), 1e18); // surplus (e.g. sent by mistake)
    vm.expectRevert(abi.encodeWithSelector(NorenCcipGateway.ExceedsFree.selector, 2e18, 1e18));
    gw.withdrawToken(IERC20(address(token)), address(this), 2e18);
    gw.withdrawToken(IERC20(address(token)), address(this), 1e18); // the surplus is still withdrawable
    vm.prank(alice);
    gw.claim(address(token));
    assertEq(token.balanceOf(alice), 5e18);
    assertEq(gw.reserved(address(token)), 0);
  }

  function test_Audit_CCIP1_failedDeliveryIsReservedUntilRetriedOrRecovered() public {
    RevertingApp bad = new RevertingApp();
    gw.setApp(INorenActionSink(address(bad)));
    _receive(address(gw), _msg(bytes32("m2"), 2, 3e18, address(gw)));
    assertEq(uint8(gw.statusOf(bytes32("m2"))), uint8(NorenCcipGateway.Status.FAILED));
    assertEq(gw.reserved(address(token)), 3e18);
    vm.expectRevert(abi.encodeWithSelector(NorenCcipGateway.ExceedsFree.selector, 1, 0));
    gw.withdrawToken(IERC20(address(token)), address(this), 1);
    // Duplicate copy of the same Noren message: also FAILED, also reserved.
    _receive(address(gw), _msg(bytes32("m2-dup"), 2, 1e18, address(gw)));
    assertEq(gw.reserved(address(token)), 4e18);
    // Retry with no app: the tokens move from the FAILED reserve to a claimable reserve.
    gw.setApp(INorenActionSink(address(0)));
    gw.retryFailed(bytes32("m2"));
    assertEq(gw.claimable(alice, address(token)), 3e18);
    assertEq(gw.reserved(address(token)), 4e18);
    gw.recoverFailed(bytes32("m2-dup"), alice);
    assertEq(gw.reserved(address(token)), 3e18);
  }

  // CCIP-2: an ERC-20 fee with msg.value attached used to leave the native value stuck in the gateway.
  function test_Audit_CCIP2_sendRejectsNativeWithErc20Fee() public {
    vm.deal(alice, 1 ether);
    vm.prank(alice);
    vm.expectRevert(abi.encodeWithSelector(NorenCcipGateway.UnexpectedNative.selector, 1 wei));
    gw.send{value: 1 wei}(SRC, hex"01", address(0), 0, address(token));
  }

  // CCIP-3: a replacement gateway restarts at nonce 1, colliding with its predecessor's (originChain, nonce) keys.
  function test_Audit_CCIP3_bumpNonceAvoidsCollisionWithAReplacedGateway() public {
    _receive(address(gw), _msg(bytes32("old-1"), 1, 0, address(gw)));
    // A message from a fresh gateway that restarted at nonce 1 is taken for a duplicate.
    _receive(address(gw), _msg(bytes32("new-1"), 1, 0, address(gw)));
    assertEq(uint8(gw.statusOf(bytes32("new-1"))), uint8(NorenCcipGateway.Status.FAILED));
    // The fix: the replacement's owner moves its nonce past the old one before use. Never backwards.
    NorenCcipGateway fresh = new NorenCcipGateway(ccipRouter, SRC, address(this));
    fresh.bumpNonce(1_000);
    assertEq(fresh.nonce(), 1_000);
    vm.expectRevert(abi.encodeWithSelector(NorenCcipGateway.NonceNotHigher.selector, 1_000, 1_000));
    fresh.bumpNonce(1_000);
    vm.prank(alice);
    vm.expectRevert();
    fresh.bumpNonce(2_000);
  }

  // CCIP-1 (hub): custody tokens are not owner-withdrawable either.
  function test_Audit_CCIP1_hubCustodyIsNotOwnerWithdrawable() public {
    NorenCcipHub hub = new NorenCcipHub(ccipRouter, LOCAL, address(this));
    hub.setPeer(SRC, peer, NorenCcipBase.Peer.GATEWAY);
    // No hub route: forwarding fails (PENDING) and the tokens stay in custody for the origin sender.
    Client.Any2EVMMessage memory m = _msg(bytes32("h1"), 7, 2e18, address(hub));
    vm.prank(ccipRouter);
    hub.ccipReceive(m);
    assertEq(hub.reserved(address(token)), 2e18);
    vm.expectRevert(abi.encodeWithSelector(NorenCcipHub.ExceedsFree.selector, 1, 0));
    hub.withdrawToken(IERC20(address(token)), address(this), 1);
    vm.prank(alice);
    hub.releaseCustody(bytes32("h1"), alice);
    assertEq(token.balanceOf(alice), 2e18);
    assertEq(hub.reserved(address(token)), 0);
  }
}
