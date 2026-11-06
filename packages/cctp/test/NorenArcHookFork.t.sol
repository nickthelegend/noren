// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {NorenArcHook} from "../src/NorenArcHook.sol";
import {IMessageTransmitterV2} from "../src/interfaces/IMessageTransmitterV2.sol";
import {INorenActionSink} from "../src/interfaces/INorenActionSink.sol";
import {IERC20Min} from "../src/interfaces/IERC20Min.sol";

interface IRouterAdmin {
  function owner() external view returns (address);
  function setRail(address rail, bytes32 railId) external;
  function executed(bytes32 rail, bytes32 msgId) external view returns (bool);
}

interface IAttestable {
  function attesterManager() external view returns (address);
  function enableAttester(address attester) external;
  function setSignatureThreshold(uint256 threshold) external;
}

/// Fork-only stand-in for Arc's native USDC at 0x3600...: Arc implements it with chain precompiles
/// (0x1800...01 blocklist, native balance) that Foundry's EVM does not have. Same ERC-20 surface and the
/// mint(address,uint256) that Circle's TokenMinterV2 calls. Never deployed anywhere.
contract ForkArcUsdc {
  mapping(address => uint256) public balanceOf;

  function mint(address to, uint256 amount) external returns (bool) {
    balanceOf[to] += amount;
    return true;
  }

  function transfer(address to, uint256 amount) external returns (bool) {
    require(balanceOf[msg.sender] >= amount, "balance");
    balanceOf[msg.sender] -= amount;
    balanceOf[to] += amount;
    return true;
  }
}

/// Records what the hook hands it, like the shared router (the real one lives on branch `ccip`).
contract ForkRouter is INorenActionSink {
  uint256 public lastAmount;
  bytes public lastAction;

  function execute(bytes32, bytes32, uint64, address, address, uint256 amount, bytes calldata action) external returns (bool) {
    lastAmount = amount;
    lastAction = action;
    return true;
  }
}

/// A generic CCTP V2 message recipient anyone can deploy on Arc (what an attacker would point `sendMessage` at).
contract AttackerHandler {
  function handleReceiveFinalizedMessage(uint32, bytes32, uint32, bytes calldata) external pure returns (bool) {
    return true;
  }

  function handleReceiveUnfinalizedMessage(uint32, bytes32, uint32, bytes calldata) external pure returns (bool) {
    return true;
  }
}

/// FORK TESTS against Circle's real CCTP V2 contracts.
/// 1. Arc Testnet fork: NorenArcHook drives the real MessageTransmitterV2, TokenMessengerV2 and TokenMinterV2, which mint Arc
///    USDC (0x3600..., whose precompile-backed code is swapped for ForkArcUsdc on the fork). Iris cannot attest a message that was never burned, so on the fork only, the test enables
///    one extra attester key through Circle's attesterManager and sets the threshold to 1. Everything else
///    (message format, nonce rules, destinationCaller check, minting) is Circle's deployed code.
/// 2. Robinhood Testnet fork: the live Arc -> Robinhood burn (fixtures/live-arc-to-robinhood.json) carries Circle's
///    real attestation; the real MessageTransmitterV2 accepts it and mints 1 USDC. No attester changes.
contract NorenArcHookForkTest is Test {
  address constant MT = 0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275;
  address constant TM = 0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA;
  address constant ARC_USDC = 0x3600000000000000000000000000000000000000;
  address constant BASE_SEPOLIA_USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
  address constant ARC_FORWARDER = 0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1;
  address constant RH_USDC = 0x2FD79307e37Ff0d60AE26A108FBA5B22bfC34b12;

  uint256 attesterKey = 0xA11CE;
  address alice = makeAddr("alice");
  address depositor = makeAddr("depositor");
  NorenArcHook hook;

  function _b32(address a) internal pure returns (bytes32) {
    return bytes32(uint256(uint160(a)));
  }

  function _arcFork() internal {
    vm.createSelectFork(vm.envOr("ARC_TESTNET_RPC", string("https://rpc.testnet.arc.io")));
    vm.etch(ARC_USDC, address(new ForkArcUsdc()).code);
    hook = new NorenArcHook(IMessageTransmitterV2(MT), IERC20Min(ARC_USDC), TM, ARC_FORWARDER, address(this));
    address manager = IAttestable(MT).attesterManager();
    vm.startPrank(manager);
    IAttestable(MT).enableAttester(vm.addr(attesterKey));
    IAttestable(MT).setSignatureThreshold(1);
    vm.stopPrank();
  }

  /// A Base Sepolia (domain 6) -> Arc burn message in CCTP V2 layout, as Circle's TokenMessengerV2 builds it.
  function _baseToArc(bytes32 nonce, address mintRecipient, uint256 amount, uint256 fee, bytes memory hookData)
    internal
    view
    returns (bytes memory)
  {
    bytes memory body = abi.encodePacked(
      uint32(1), _b32(BASE_SEPOLIA_USDC), _b32(mintRecipient), amount, _b32(depositor), uint256(fee * 2), fee, uint256(0), hookData
    );
    return abi.encodePacked(uint32(1), uint32(6), uint32(26), nonce, _b32(TM), _b32(TM), _b32(address(hook)), uint32(1000), uint32(1000), body);
  }

  function _attest(bytes memory message) internal view returns (bytes memory) {
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(attesterKey, keccak256(message));
    return abi.encodePacked(r, s, v);
  }

  function test_fork_arc_plainTransferMintsRealArcUsdcViaCreForwarder() public {
    _arcFork();
    bytes memory m = _baseToArc(keccak256("noren-fork-1"), alice, 2_000_000, 260, "");
    uint256 before = IERC20Min(ARC_USDC).balanceOf(alice);
    vm.prank(ARC_FORWARDER);
    hook.onReport("", abi.encode(m, _attest(m)));
    assertEq(IERC20Min(ARC_USDC).balanceOf(alice) - before, 1_999_740);
    assertEq(IMessageTransmitterV2(MT).usedNonces(keccak256("noren-fork-1")), 1);
    // Circle's transmitter and the hook both refuse a replay
    vm.expectRevert(abi.encodeWithSelector(NorenArcHook.AlreadyProcessed.selector, keccak256("noren-fork-1")));
    hook.relay(m, _attest(m));
  }

  function test_fork_arc_hookRoutesMintedUsdcToRouter() public {
    _arcFork();
    ForkRouter router = new ForkRouter();
    hook.setRouter(router);
    bytes memory action = abi.encode(uint8(1), alice, bytes32("ref"), abi.encode(makeAddr("merchant"), bytes32("inv-7")));
    bytes memory m = _baseToArc(keccak256("noren-fork-2"), address(hook), 3_000_000, 390, action);
    hook.relay(m, _attest(m));
    assertEq(IERC20Min(ARC_USDC).balanceOf(address(router)), 2_999_610);
    assertEq(router.lastAmount(), 2_999_610);
    assertEq(keccak256(router.lastAction()), keccak256(action));
    assertEq(IERC20Min(ARC_USDC).balanceOf(address(hook)), 0);
  }

  /// The ccip agent's live NorenArcActionRouter on Arc Testnet pays the invoice from the bridged USDC.
  function test_fork_arc_realRouterPaysInvoiceFromBridgedUsdc() public {
    _arcFork();
    address router = 0x3D2ddF0C08ed3574c25f07E5113CaaB5Db6FA7A4;
    vm.prank(IRouterAdmin(router).owner());
    IRouterAdmin(router).setRail(address(hook), keccak256("CCTP"));
    hook.setRouter(INorenActionSink(router));
    address merchant = makeAddr("merchant");
    bytes memory action = abi.encode(uint8(1), alice, bytes32("ref"), abi.encode(merchant, bytes32("inv-fork-9")));
    bytes32 nonce = keccak256("noren-fork-9");
    bytes memory m = _baseToArc(nonce, address(hook), 4_000_000, 520, action);
    hook.relay(m, _attest(m));
    assertEq(IERC20Min(ARC_USDC).balanceOf(merchant), 3_999_480);
    assertTrue(IRouterAdmin(router).executed(keccak256("CCTP"), nonce));
  }

  function test_fork_arc_garbageHookDataRefundsDepositorOnArc() public {
    _arcFork();
    bytes memory m = _baseToArc(keccak256("noren-fork-3"), address(hook), 1_000_000, 0, hex"0bad");
    hook.relay(m, _attest(m));
    assertEq(IERC20Min(ARC_USDC).balanceOf(depositor), 1_000_000);
  }

  function test_fork_arc_circleRejectsAMessageNotAddressedToTheHook() public {
    _arcFork();
    bytes memory m = _baseToArc(keccak256("noren-fork-4"), alice, 1_000_000, 0, "");
    // someone other than NorenArcHook tries to complete it directly at Circle's transmitter
    vm.expectRevert();
    IMessageTransmitterV2(MT).receiveMessage(m, _attest(m));
  }

  /// ARC-1 on Circle's real MessageTransmitterV2: a generic `sendMessage` message from any source address, addressed to
  /// an attacker's handler, with the hook as destinationCaller and a body shaped like a burn whose `messageSender` is a
  /// victim borrower. Circle's transmitter accepts it (checked below by calling it as the hook), so before the fix the
  /// hook would have routed a forged `sourceSender` to the router. The hook now rejects it before Circle is called.
  function test_Audit_ARC1_fork_forgedGenericMessageRejected() public {
    _arcFork();
    address handler = address(new AttackerHandler());
    address victim = makeAddr("victimBorrower");
    bytes memory action = abi.encode(uint8(5), victim, bytes32("ref"), abi.encode(bytes32("line"), alice, bytes32("inv"), uint256(1e6)));
    bytes memory body = abi.encodePacked(
      uint32(1), _b32(BASE_SEPOLIA_USDC), _b32(address(hook)), uint256(0), _b32(victim), uint256(0), uint256(0), uint256(0), action
    );
    bytes32 nonce = keccak256("noren-fork-forged");
    bytes memory m = abi.encodePacked(
      uint32(1), uint32(6), uint32(26), nonce, _b32(makeAddr("attackerOnBase")), _b32(handler), _b32(address(hook)), uint32(1000), uint32(2000), body
    );
    bytes memory att = _attest(m);
    vm.expectRevert(abi.encodeWithSelector(NorenArcHook.NotBurnMessage.selector, _b32(handler)));
    hook.relay(m, att);
    // The vector was real: Circle's transmitter accepts this message from the hook's address.
    uint256 snap = vm.snapshotState();
    vm.prank(address(hook));
    assertTrue(IMessageTransmitterV2(MT).receiveMessage(m, att));
    vm.revertToState(snap);
  }

  function test_fork_arc_unknownAttesterRejectedByCircle() public {
    _arcFork();
    bytes memory m = _baseToArc(keccak256("noren-fork-5"), alice, 1_000_000, 0, "");
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBADBAD, keccak256(m));
    vm.expectRevert();
    hook.relay(m, abi.encodePacked(r, s, v));
  }

  function test_fork_robinhood_liveArcBurnMintsWithCirclesRealAttestation() public {
    string memory rec = vm.readFile("fixtures/live-arc-to-robinhood.json");
    bytes memory message = vm.parseJsonBytes(rec, ".message");
    bytes memory attestation = vm.parseJsonBytes(rec, ".attestation");
    address recipient = vm.parseJsonAddress(rec, ".recipient");
    // Fork one block before the public mint (fixtures .mintBlock), so the real attestation is replayed on-chain state
    // where the nonce is still unused.
    uint256 mintBlock = vm.parseJsonUint(rec, ".mintBlock");
    vm.createSelectFork(vm.envOr("ROBINHOOD_TESTNET_RPC", string("https://rpc.testnet.chain.robinhood.com")), mintBlock - 1);
    bytes32 nonce = vm.parseJsonBytes32(rec, ".nonce");
    assertEq(IMessageTransmitterV2(MT).usedNonces(nonce), 0);
    uint256 before = IERC20Min(RH_USDC).balanceOf(recipient);
    assertTrue(IMessageTransmitterV2(MT).receiveMessage(message, attestation));
    assertEq(IERC20Min(RH_USDC).balanceOf(recipient) - before, 1_000_000);
    // a second delivery of the same attested message is refused by Circle
    vm.expectRevert();
    IMessageTransmitterV2(MT).receiveMessage(message, attestation);
  }
}
