// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {NorenShieldSink, IPrivacyEntrypoint, IPrivacyPoolRagequit} from "../src/NorenShieldSink.sol";
import {INorenActionSink} from "../src/interfaces/INorenActionSink.sol";
import {NorenArcAction} from "../src/libraries/NorenArcAction.sol";

/// Fork-only stand-in for Arc's native USDC at 0x3600...: Arc implements it with chain precompiles that Foundry's
/// EVM does not have (the same approach as packages/cctp's NorenArcHookFork test). Same ERC-20 surface plus
/// FiatToken's isBlacklisted view. Never deployed anywhere.
contract ForkArcUsdc {
  mapping(address => uint256) public balanceOf;
  mapping(address => mapping(address => uint256)) public allowance;
  mapping(address => bool) public isBlacklisted;

  function decimals() external pure returns (uint8) {
    return 6;
  }

  function mint(address to, uint256 amount) external {
    balanceOf[to] += amount;
  }

  function blacklist(address a) external {
    isBlacklisted[a] = true;
  }

  function approve(address s, uint256 amount) external returns (bool) {
    allowance[msg.sender][s] = amount;
    return true;
  }

  function transfer(address to, uint256 amount) external returns (bool) {
    _move(msg.sender, to, amount);
    return true;
  }

  function transferFrom(address from, address to, uint256 amount) external returns (bool) {
    uint256 a = allowance[from][msg.sender];
    require(a >= amount, "allowance");
    if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
    _move(from, to, amount);
    return true;
  }

  function _move(address from, address to, uint256 amount) private {
    require(!isBlacklisted[from] && !isBlacklisted[to], "blacklisted");
    require(balanceOf[from] >= amount, "balance");
    balanceOf[from] -= amount;
    balanceOf[to] += amount;
  }
}

interface IRouterView {
  function owner() external view returns (address);
  function setRail(address rail, bytes32 railId) external;
  function invoicePaid(bytes32 invoiceId) external view returns (bool);
  function claimable(address account, address token) external view returns (uint256);
}

interface IEntrypointView {
  function usedPrecommitments(uint256 precommitment) external view returns (bool);
}

interface IPoolView {
  function depositors(uint256 label) external view returns (address);
}

/// FORK TESTS on Arc Testnet against the LIVE Noren and Privacy Pools contracts: the real Kohaku Entrypoint
/// (ERC1967 proxy), the real PrivacyPoolComplex with its Poseidon libraries, and the real NorenArcActionRouter.
/// Only Arc's precompile-backed USDC is swapped for ForkArcUsdc. The test contract plays the rail (NorenArcHook),
/// which the sink allowlists exactly as it allowlists the live hook.
contract NorenShieldSinkForkTest is Test {
  address constant ARC_USDC = 0x3600000000000000000000000000000000000000;
  address constant ENTRYPOINT = 0xa22F3200Ecb4319B48DCA49677c2F73Cd7260Ad5;
  address constant POOL = 0x393D8D46e1DFF8a719820E36d70BA509896Ea57d;
  address constant ROUTER = 0x3D2ddF0C08ed3574c25f07E5113CaaB5Db6FA7A4;
  bytes32 constant CCTP = keccak256("CCTP");

  // Pool.Deposited(address indexed depositor, uint256 commitment, uint256 label, uint256 value, uint256 precommitmentHash)
  bytes32 constant POOL_DEPOSITED = keccak256("Deposited(address,uint256,uint256,uint256,uint256)");

  NorenShieldSink sink;
  ForkArcUsdc usdc;
  address alice = makeAddr("alice"); // source-chain sender and Arc beneficiary
  address merchant = makeAddr("merchant");
  uint256 precommitment = uint256(keccak256("alice precommitment 0")) % 21888242871839275222246405745257275088548364400416034343698204186575808495617;

  function setUp() public {
    vm.createSelectFork(vm.envOr("ARC_TESTNET_RPC", string("https://rpc.testnet.arc.io")));
    vm.etch(ARC_USDC, address(new ForkArcUsdc()).code);
    usdc = ForkArcUsdc(ARC_USDC);
    // registerPool gave the pool an unlimited allowance in the real USDC storage, which the shim does not share.
    vm.prank(ENTRYPOINT);
    usdc.approve(POOL, type(uint256).max);

    sink = new NorenShieldSink(
      IERC20(ARC_USDC), IPrivacyEntrypoint(ENTRYPOINT), IPrivacyPoolRagequit(POOL), INorenActionSink(ROUTER), CCTP, address(this)
    );
    sink.setRail(address(this), true);
    vm.prank(IRouterView(ROUTER).owner());
    IRouterView(ROUTER).setRail(address(sink), CCTP);
  }

  function _shieldAction(address beneficiary, uint256 pre) internal pure returns (bytes memory) {
    return NorenArcAction.encode(NorenArcAction.SHIELD, beneficiary, bytes32("noren-private"), abi.encode(pre));
  }

  /// The rail transfers the minted USDC to the sink first, then calls execute (INorenActionSink contract).
  function _deliver(bytes32 msgId, address sender, uint256 amount, bytes memory action) internal returns (bool) {
    usdc.mint(address(sink), amount);
    return sink.execute(CCTP, msgId, 3, sender, ARC_USDC, amount, action);
  }

  function test_ShieldDepositsIntoTheLivePoolUnderTheUsersPrecommitment() public {
    uint256 poolBefore = usdc.balanceOf(POOL);
    vm.recordLogs();
    bool ok = _deliver(bytes32(uint256(1)), alice, 2_000_000, _shieldAction(alice, precommitment));
    assertTrue(ok);
    assertEq(usdc.balanceOf(POOL) - poolBefore, 2_000_000, "pool holds the arrival");
    assertEq(usdc.balanceOf(address(sink)), 0, "nothing left public in the sink");
    assertEq(usdc.balanceOf(alice), 0, "no public balance for the user on Arc");
    assertTrue(IEntrypointView(ENTRYPOINT).usedPrecommitments(precommitment));

    Vm.Log[] memory logs = vm.getRecordedLogs();
    bool found;
    for (uint256 i; i < logs.length; i++) {
      if (logs[i].emitter == POOL && logs[i].topics[0] == POOL_DEPOSITED) {
        (uint256 commitment, uint256 label, uint256 value, uint256 preHash) = abi.decode(logs[i].data, (uint256, uint256, uint256, uint256));
        assertEq(address(uint160(uint256(logs[i].topics[1]))), address(sink), "the pool's depositor is the sink");
        assertEq(value, 2_000_000);
        assertEq(preHash, precommitment);
        assertEq(IPoolView(POOL).depositors(label), address(sink));
        assertEq(sink.beneficiaryOf(commitment), alice, "ragequit goes to the beneficiary");
        found = true;
      }
    }
    assertTrue(found, "pool Deposited event");
  }

  function test_OtherKindsAreForwardedToTheLiveRouter() public {
    bytes32 invoiceId = keccak256("inv-forwarded");
    bytes memory action =
      NorenArcAction.encode(NorenArcAction.PAY_INVOICE, alice, bytes32("noren"), abi.encode(merchant, invoiceId));
    assertTrue(_deliver(bytes32(uint256(2)), alice, 1_500_000, action));
    assertEq(usdc.balanceOf(merchant), 1_500_000, "router paid the merchant");
    assertTrue(IRouterView(ROUTER).invoicePaid(invoiceId));
  }

  function test_BlocklistedSourceSenderIsHeldNotShielded() public {
    address mallory = makeAddr("mallory");
    usdc.blacklist(mallory);
    uint256 poolBefore = usdc.balanceOf(POOL);
    bool ok = _deliver(bytes32(uint256(3)), mallory, 1_000_000, _shieldAction(alice, precommitment));
    assertFalse(ok);
    assertEq(usdc.balanceOf(POOL), poolBefore, "nothing entered the pool");
    (address b, address s, uint256 amt) = sink.holds(bytes32(uint256(3)));
    assertEq(b, alice);
    assertEq(s, mallory);
    assertEq(amt, 1_000_000);
    assertEq(sink.claimable(alice, ARC_USDC), 0, "a hold is not claimable");
    assertFalse(IEntrypointView(ENTRYPOINT).usedPrecommitments(precommitment));

    vm.prank(alice);
    vm.expectRevert();
    sink.releaseHold(bytes32(uint256(3)), alice);
    address reviewed = makeAddr("reviewed");
    sink.releaseHold(bytes32(uint256(3)), reviewed);
    assertEq(usdc.balanceOf(reviewed), 1_000_000);
  }

  function test_BlocklistedBeneficiaryIsHeld() public {
    address bad = makeAddr("bad");
    usdc.blacklist(bad);
    assertFalse(_deliver(bytes32(uint256(4)), alice, 1_000_000, _shieldAction(bad, precommitment)));
    (,, uint256 amt) = sink.holds(bytes32(uint256(4)));
    assertEq(amt, 1_000_000);
  }

  function test_ReusedPrecommitmentBecomesClaimableForTheBeneficiary() public {
    assertTrue(_deliver(bytes32(uint256(5)), alice, 1_000_000, _shieldAction(alice, precommitment)));
    assertFalse(_deliver(bytes32(uint256(6)), alice, 1_200_000, _shieldAction(alice, precommitment)));
    assertEq(sink.claimable(alice, ARC_USDC), 1_200_000);
    vm.prank(alice);
    sink.claim(ARC_USDC);
    assertEq(usdc.balanceOf(alice), 1_200_000);
  }

  function test_BelowPoolMinimumBecomesClaimable() public {
    assertFalse(_deliver(bytes32(uint256(7)), alice, 999_999, _shieldAction(alice, precommitment)));
    assertEq(sink.claimable(alice, ARC_USDC), 999_999);
    assertFalse(IEntrypointView(ENTRYPOINT).usedPrecommitments(precommitment), "a failed deposit rolls back");
  }

  function test_PrecommitmentOutsideTheFieldIsRejected() public {
    assertFalse(_deliver(bytes32(uint256(8)), alice, 1_000_000, _shieldAction(alice, type(uint256).max)));
    assertFalse(_deliver(bytes32(uint256(9)), alice, 1_000_000, _shieldAction(alice, 0)));
    assertEq(sink.claimable(alice, ARC_USDC), 2_000_000);
  }

  function test_DuplicateMessageIsNotShieldedTwice() public {
    assertTrue(_deliver(bytes32(uint256(10)), alice, 1_000_000, _shieldAction(alice, precommitment)));
    uint256 other = precommitment + 1;
    assertFalse(_deliver(bytes32(uint256(10)), alice, 1_000_000, _shieldAction(alice, other)));
    assertEq(sink.claimable(alice, ARC_USDC), 1_000_000, "credited to the source sender");
    assertFalse(IEntrypointView(ENTRYPOINT).usedPrecommitments(other));
  }

  function test_OnlyAnAllowlistedRailMayDeliver() public {
    vm.prank(alice);
    vm.expectRevert(abi.encodeWithSelector(NorenShieldSink.NotRail.selector, alice, CCTP));
    sink.execute(CCTP, bytes32(uint256(11)), 3, alice, ARC_USDC, 0, _shieldAction(alice, precommitment));
    vm.expectRevert(abi.encodeWithSelector(NorenShieldSink.NotRail.selector, address(this), keccak256("CCIP")));
    sink.execute(keccak256("CCIP"), bytes32(uint256(11)), 3, alice, ARC_USDC, 0, _shieldAction(alice, precommitment));
  }

  function test_ShieldEntryPointIsSelfOnly() public {
    vm.expectRevert(NorenShieldSink.OnlySelf.selector);
    sink.shield(bytes32(0), 3, alice, ARC_USDC, 1, _shieldAction(alice, precommitment));
  }

  function test_RagequitOnlyForCommitmentsTheSinkMade() public {
    IPrivacyPoolRagequit.RagequitProof memory p;
    p.pubSignals[0] = 12345;
    vm.expectRevert(abi.encodeWithSelector(NorenShieldSink.UnknownCommitment.selector, uint256(12345)));
    sink.ragequit(p);
  }
}
