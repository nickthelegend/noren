// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {NorenArcHook} from "../src/NorenArcHook.sol";
import {IMessageTransmitterV2} from "../src/interfaces/IMessageTransmitterV2.sol";
import {INorenArcActionRouter} from "../src/interfaces/INorenArcActionRouter.sol";
import {IERC20Min} from "../src/interfaces/IERC20Min.sol";

/// Test USDC (6 dp) minted by the transmitter double.
contract TestUsdc is IERC20Min {
  mapping(address => uint256) public balanceOf;

  function mint(address to, uint256 amount) external {
    balanceOf[to] += amount;
  }

  function transfer(address to, uint256 amount) external returns (bool) {
    balanceOf[msg.sender] -= amount;
    balanceOf[to] += amount;
    return true;
  }
}

/// Unit-test double of Circle's MessageTransmitterV2 with the same rules the hook relies on: the attestation must
/// match, the caller must be the message's destinationCaller, a nonce is used once, and it mints
/// amount - feeExecuted to mintRecipient. The real contract is exercised in NorenArcHookFork.t.sol.
contract TransmitterDouble is IMessageTransmitterV2 {
  TestUsdc public immutable usdc;
  bytes32 public attestationHash;
  mapping(bytes32 => uint256) public usedNonces;

  constructor(TestUsdc usdc_) {
    usdc = usdc_;
  }

  function localDomain() external pure returns (uint32) {
    return 26;
  }

  function setAttestation(bytes calldata a) external {
    attestationHash = keccak256(a);
  }

  function receiveMessage(bytes calldata m, bytes calldata attestation) external returns (bool) {
    require(keccak256(attestation) == attestationHash, "invalid attestation");
    require(bytes32(m[108:140]) == bytes32(uint256(uint160(msg.sender))), "invalid caller");
    bytes32 nonce = bytes32(m[12:44]);
    require(usedNonces[nonce] == 0, "nonce already used");
    usedNonces[nonce] = 1;
    address to = address(uint160(uint256(bytes32(m[148 + 36:148 + 68]))));
    uint256 amount = uint256(bytes32(m[148 + 68:148 + 100]));
    uint256 fee = uint256(bytes32(m[148 + 164:148 + 196]));
    usdc.mint(to, amount - fee);
    return true;
  }
}

/// Records what the hook hands it, like the shared router: funds first, then execute once per (rail, msgId).
contract RouterDouble is INorenArcActionRouter {
  bytes32 public lastRail;
  bytes32 public lastMsgId;
  uint64 public lastSource;
  address public lastSender;
  uint256 public lastAmount;
  bytes public lastAction;
  bool public fail;
  mapping(bytes32 => bool) public seen;

  function setFail(bool f) external {
    fail = f;
  }

  function execute(bytes32 rail, bytes32 msgId, uint64 source, address sourceSender, address, uint256 amount, bytes calldata action)
    external
    returns (bool)
  {
    require(!fail, "router down");
    bytes32 k = keccak256(abi.encode(rail, msgId));
    require(!seen[k], "replay");
    seen[k] = true;
    (lastRail, lastMsgId, lastSource, lastSender, lastAmount, lastAction) = (rail, msgId, source, sourceSender, amount, action);
    return true;
  }
}

contract NorenArcHookTest is Test {
  TestUsdc usdc;
  TransmitterDouble mt;
  NorenArcHook hook;
  RouterDouble router;
  address forwarder = makeAddr("forwarder");
  address owner = makeAddr("owner");
  address alice = makeAddr("alice");
  address depositor = makeAddr("depositor");
  address merchant = makeAddr("merchant");
  bytes attestation = hex"aa11";

  event Bridged(
    bytes32 indexed nonce,
    uint32 indexed sourceDomain,
    address indexed recipient,
    uint256 minted,
    uint256 feeExecuted,
    address depositor,
    uint32 finalityThresholdExecuted,
    bool viaCre
  );
  event HookRejected(bytes32 indexed nonce, address indexed refundTo, uint256 amount, string reason);

  function setUp() public {
    usdc = new TestUsdc();
    mt = new TransmitterDouble(usdc);
    mt.setAttestation(attestation);
    hook = new NorenArcHook(mt, usdc, forwarder, owner);
    router = new RouterDouble();
  }

  function _b32(address a) internal pure returns (bytes32) {
    return bytes32(uint256(uint160(a)));
  }

  /// A CCTP V2 burn message, byte layout as in MessageV2.sol / BurnMessageV2.sol.
  function _msg(uint32 src, uint32 dst, bytes32 nonce, address caller, address mintRecipient, uint256 amount, uint256 fee, bytes memory hookData)
    internal
    pure
    returns (bytes memory)
  {
    bytes memory body = abi.encodePacked(
      uint32(1), bytes32(uint256(0x1c7d)), _b32(mintRecipient), amount, _b32(address(0xD0D0)), uint256(fee * 2), fee, uint256(0), hookData
    );
    // the depositor word sits at body offset 100; rebuild with the real depositor below
    return abi.encodePacked(uint32(1), src, dst, nonce, _b32(address(0x8FE6)), _b32(address(0x8FE6)), _b32(caller), uint32(1000), uint32(1000), body);
  }

  function _msgFrom(address dep, bytes32 nonce, address mintRecipient, uint256 amount, uint256 fee, bytes memory hookData)
    internal
    view
    returns (bytes memory m)
  {
    m = _msg(6, 26, nonce, address(hook), mintRecipient, amount, fee, hookData);
    bytes32 d = _b32(dep);
    assembly {
      mstore(add(add(m, 32), 248), d) // 148 + 100
    }
  }

  function _action(uint8 kind, address beneficiary, bytes memory params) internal pure returns (bytes memory) {
    return abi.encode(kind, beneficiary, bytes32("ref"), params);
  }

  function _report(bytes memory m) internal view returns (bytes memory) {
    return abi.encode(m, attestation);
  }

  function test_plainTransferMintsToRecipientViaCre() public {
    bytes memory m = _msgFrom(depositor, bytes32(uint256(1)), alice, 5_000_000, 650, "");
    vm.expectEmit(address(hook));
    emit Bridged(bytes32(uint256(1)), 6, alice, 4_999_350, 650, depositor, 1000, true);
    vm.prank(forwarder);
    hook.onReport("", _report(m));
    assertEq(usdc.balanceOf(alice), 4_999_350);
    assertTrue(hook.processed(bytes32(uint256(1))));
  }

  function test_onlyForwarderCallsOnReport() public {
    bytes memory m = _msgFrom(depositor, bytes32(uint256(1)), alice, 1e6, 0, "");
    vm.expectRevert(abi.encodeWithSelector(NorenArcHook.NotForwarder.selector, alice));
    vm.prank(alice);
    hook.onReport("", _report(m));
  }

  function test_anyRelayerCanRelayWithAttestation() public {
    bytes memory m = _msgFrom(depositor, bytes32(uint256(2)), alice, 1e6, 0, "");
    vm.prank(makeAddr("anyone"));
    hook.relay(m, attestation);
    assertEq(usdc.balanceOf(alice), 1e6);
  }

  function test_badAttestationReverts() public {
    bytes memory m = _msgFrom(depositor, bytes32(uint256(3)), alice, 1e6, 0, "");
    vm.expectRevert("invalid attestation");
    hook.relay(m, hex"bb");
    assertFalse(hook.processed(bytes32(uint256(3))));
  }

  function test_replayRejected() public {
    bytes memory m = _msgFrom(depositor, bytes32(uint256(4)), alice, 1e6, 0, "");
    hook.relay(m, attestation);
    vm.expectRevert(abi.encodeWithSelector(NorenArcHook.AlreadyProcessed.selector, bytes32(uint256(4))));
    vm.prank(forwarder);
    hook.onReport("", _report(m));
  }

  function test_wrongDestinationDomainReverts() public {
    bytes memory m = _msg(6, 35, bytes32(uint256(5)), address(hook), alice, 1e6, 0, "");
    vm.expectRevert(abi.encodeWithSelector(NorenArcHook.WrongDestinationDomain.selector, uint32(35)));
    hook.relay(m, attestation);
  }

  function test_wrongDestinationCallerReverts() public {
    bytes memory m = _msg(6, 26, bytes32(uint256(6)), address(0), alice, 1e6, 0, "");
    vm.expectRevert(abi.encodeWithSelector(NorenArcHook.WrongDestinationCaller.selector, bytes32(0)));
    hook.relay(m, attestation);
  }

  function test_shortMessageReverts() public {
    vm.expectRevert(abi.encodeWithSelector(NorenArcHook.MessageTooShort.selector, uint256(10)));
    hook.relay(hex"00112233445566778899", attestation);
  }

  function test_hookRoutesMintedUsdcAndActionToRouter() public {
    vm.prank(owner);
    hook.setRouter(router);
    bytes memory action = _action(1, alice, abi.encode(merchant, bytes32("inv-42")));
    bytes memory m = _msgFrom(depositor, bytes32(uint256(7)), address(hook), 2_000_000, 260, action);
    vm.prank(forwarder);
    hook.onReport("", _report(m));
    assertEq(usdc.balanceOf(address(router)), 1_999_740);
    assertEq(usdc.balanceOf(address(hook)), 0);
    assertEq(router.lastRail(), keccak256("CCTP"));
    assertEq(router.lastMsgId(), bytes32(uint256(7)));
    assertEq(router.lastSource(), 6);
    assertEq(router.lastSender(), depositor);
    assertEq(router.lastAmount(), 1_999_740);
    assertEq(keccak256(router.lastAction()), keccak256(action));
  }

  function test_hookWithoutRouterDeliversToBeneficiary() public {
    bytes memory action = _action(2, alice, abi.encode(address(0xBEEF)));
    bytes memory m = _msgFrom(depositor, bytes32(uint256(8)), address(hook), 1e6, 0, action);
    hook.relay(m, attestation);
    assertEq(usdc.balanceOf(alice), 1e6);
  }

  function test_garbageHookDataRefundsDepositorOnArc() public {
    bytes memory m = _msgFrom(depositor, bytes32(uint256(9)), address(hook), 1e6, 0, hex"deadbeef");
    vm.expectEmit(address(hook));
    emit HookRejected(bytes32(uint256(9)), depositor, 1e6, "action shorter than 160 bytes");
    hook.relay(m, attestation);
    assertEq(usdc.balanceOf(depositor), 1e6);
  }

  function test_badParamsForKnownKindGoToBeneficiaryNotRouter() public {
    vm.prank(owner);
    hook.setRouter(router);
    bytes memory action = _action(1, alice, abi.encode(merchant)); // PAY_INVOICE needs (address,bytes32)
    bytes memory m = _msgFrom(depositor, bytes32(uint256(10)), address(hook), 1e6, 0, action);
    vm.expectEmit(address(hook));
    emit HookRejected(bytes32(uint256(10)), alice, 1e6, "PAY_INVOICE params must be (address,bytes32)");
    hook.relay(m, attestation);
    assertEq(usdc.balanceOf(alice), 1e6);
    assertEq(router.lastAmount(), 0);
  }

  function test_routerRevertLeavesMessageUnconsumedThenOwnerClearsRouter() public {
    vm.prank(owner);
    hook.setRouter(router);
    router.setFail(true);
    bytes memory action = _action(3, alice, hex"0102");
    bytes memory m = _msgFrom(depositor, bytes32(uint256(11)), address(hook), 1e6, 0, action);
    vm.expectRevert("router down");
    hook.relay(m, attestation);
    assertFalse(hook.processed(bytes32(uint256(11))));
    assertEq(mt.usedNonces(bytes32(uint256(11))), 0);
    vm.prank(owner);
    hook.setRouter(INorenArcActionRouter(address(0)));
    hook.relay(m, attestation);
    assertEq(usdc.balanceOf(alice), 1e6);
  }

  function test_validateActionStrict() public view {
    (bool ok, uint8 kind, address who,) = hook.validateAction(_action(4, alice, abi.encode(bytes32("line"), uint256(5e6), uint64(1e9))));
    assertTrue(ok);
    assertEq(kind, 4);
    assertEq(who, alice);
    // unknown kind is valid here; the router books it as claimable
    (ok,,,) = hook.validateAction(_action(9, alice, hex"01"));
    assertTrue(ok);
    // non-canonical: trailing bytes
    (ok,, who,) = hook.validateAction(abi.encodePacked(_action(2, alice, abi.encode(address(1))), bytes32(0)));
    assertFalse(ok);
    assertEq(who, alice);
    // dirty beneficiary word
    bytes memory dirty = _action(2, alice, abi.encode(address(1)));
    assembly {
      mstore(add(dirty, 64), not(0))
    }
    (ok,, who,) = hook.validateAction(dirty);
    assertFalse(ok);
    assertEq(who, address(0));
    // kind out of uint8 range
    bytes memory bigKind = _action(2, alice, abi.encode(address(1)));
    assembly {
      mstore(add(bigKind, 32), 256)
    }
    (ok,,,) = hook.validateAction(bigKind);
    assertFalse(ok);
    // empty params
    (ok,,,) = hook.validateAction(_action(3, alice, ""));
    assertFalse(ok);
    // CREDIT_LINE expiry beyond uint64
    (ok,,,) = hook.validateAction(_action(4, alice, abi.encode(bytes32("l"), uint256(1), uint256(type(uint64).max) + 1)));
    assertFalse(ok);
  }

  function testFuzz_validateActionNeverReverts(bytes calldata a) public view {
    hook.validateAction(a);
  }

  function test_ownerOnlyAdmin() public {
    vm.expectRevert(abi.encodeWithSelector(NorenArcHook.NotOwner.selector, alice));
    vm.prank(alice);
    hook.setRouter(router);
    vm.expectRevert(abi.encodeWithSelector(NorenArcHook.NotOwner.selector, alice));
    vm.prank(alice);
    hook.setForwarder(alice);
    vm.prank(owner);
    hook.setForwarder(alice);
    assertEq(hook.forwarder(), alice);
  }

  function test_supportsReceiverInterface() public view {
    assertTrue(hook.supportsInterface(0x805f2132)); // IReceiver.onReport
    assertTrue(hook.supportsInterface(0x01ffc9a7));
    assertEq(hook.localDomain(), 26);
  }
}
