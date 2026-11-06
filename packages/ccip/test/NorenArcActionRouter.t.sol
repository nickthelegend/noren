// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {NorenArcActionRouter} from "../src/NorenArcActionRouter.sol";
import {NorenArcAction} from "../src/libraries/NorenArcAction.sol";

/// @dev Unit-test token (local only). The router has no CCIP dependency, so these tests call it as a rail would.
contract TestUSDC is ERC20("Test USDC", "tUSDC") {
  function decimals() public pure override returns (uint8) {
    return 6;
  }

  function mint(address to, uint256 v) external {
    _mint(to, v);
  }
}

contract TestVault is ERC4626 {
  constructor(IERC20 asset_) ERC20("Noren Earn", "nEARN") ERC4626(asset_) {}
}

/// @notice Unit tests (local, no fork) for the action router both rails share. The CCIP rail's real-router
///         behaviour is covered by fork-test/; here the test contract plays the rail.
contract NorenArcActionRouterTest is Test {
  TestUSDC internal usdc;
  NorenArcActionRouter internal router;
  TestVault internal vault;
  address internal cctpHook = makeAddr("cctp-hook");
  address internal alice = makeAddr("alice");
  address internal merchant = makeAddr("merchant");
  uint64 internal constant SRC = 6; // a CCTP domain or CCIP selector; the router treats it as opaque

  function setUp() public {
    usdc = new TestUSDC();
    router = new NorenArcActionRouter(IERC20(address(usdc)), address(this));
    vault = new TestVault(IERC20(address(usdc)));
    router.setRail(address(this), NorenArcAction.RAIL_CCIP);
    router.setRail(cctpHook, NorenArcAction.RAIL_CCTP);
    router.setEarnVault(address(vault), true);
  }

  function _deliver(address rail, bytes32 railId, bytes32 msgId, uint256 amount, bytes memory action) internal returns (bool) {
    usdc.mint(address(router), amount);
    vm.prank(rail);
    return router.execute(railId, msgId, SRC, alice, address(usdc), amount, action);
  }

  function test_PayInvoiceViaCctpRail() public {
    bytes32 inv = keccak256("inv");
    bytes memory a = NorenArcAction.encode(NorenArcAction.PAY_INVOICE, alice, inv, abi.encode(merchant, inv));
    assertTrue(_deliver(cctpHook, NorenArcAction.RAIL_CCTP, bytes32(uint256(7)), 3e6, a));
    assertEq(usdc.balanceOf(merchant), 3e6);
    assertTrue(router.invoicePaid(inv));
  }

  function test_EarnDepositMintsSharesToBeneficiary() public {
    bytes memory a = NorenArcAction.encode(NorenArcAction.EARN_DEPOSIT, alice, bytes32("e"), abi.encode(address(vault)));
    assertTrue(_deliver(cctpHook, NorenArcAction.RAIL_CCTP, bytes32(uint256(1)), 5e6, a));
    assertEq(vault.balanceOf(alice), 5e6);
  }

  function test_FailedActionWithValueBecomesClaimable() public {
    bytes memory a = NorenArcAction.encode(NorenArcAction.EARN_DEPOSIT, alice, bytes32("e"), abi.encode(makeAddr("not-a-vault")));
    assertFalse(_deliver(cctpHook, NorenArcAction.RAIL_CCTP, bytes32(uint256(2)), 4e6, a));
    assertEq(router.claimable(alice, address(usdc)), 4e6);
    assertEq(router.liquidity(), 0, "claimable funds are not lendable");
    vm.prank(alice);
    router.claim(address(usdc));
    assertEq(usdc.balanceOf(alice), 4e6);
  }

  function test_FailedInstructionWithoutValueStaysRetryable() public {
    bytes memory a = NorenArcAction.encode(99, alice, bytes32("x"), "");
    assertFalse(_deliver(address(this), NorenArcAction.RAIL_CCIP, bytes32(uint256(3)), 0, a));
    assertFalse(router.executed(NorenArcAction.RAIL_CCIP, bytes32(uint256(3))));
  }

  function test_DuplicateMsgIdIsIgnoredAndValueBooked() public {
    bytes32 inv = keccak256("inv2");
    bytes memory a = NorenArcAction.encode(NorenArcAction.PAY_INVOICE, alice, inv, abi.encode(merchant, inv));
    assertTrue(_deliver(cctpHook, NorenArcAction.RAIL_CCTP, bytes32(uint256(9)), 1e6, a));
    assertFalse(_deliver(cctpHook, NorenArcAction.RAIL_CCTP, bytes32(uint256(9)), 1e6, a));
    assertEq(usdc.balanceOf(merchant), 1e6, "paid once");
    assertEq(router.claimable(alice, address(usdc)), 1e6, "second copy refundable");
  }

  function test_OnlyRegisteredRailsMayExecute() public {
    vm.prank(makeAddr("rogue"));
    vm.expectRevert();
    router.execute(NorenArcAction.RAIL_CCIP, bytes32(0), SRC, alice, address(usdc), 0, "");
    // a registered rail cannot claim to be the other rail
    vm.prank(cctpHook);
    vm.expectRevert();
    router.execute(NorenArcAction.RAIL_CCIP, bytes32(0), SRC, alice, address(usdc), 0, "");
  }

  function test_AquaOrderHeldThenSettledOrCancelled() public {
    router.setAquaOperator(address(this));
    bytes memory a1 = NorenArcAction.encode(NorenArcAction.AQUA_ORDER, alice, bytes32("o1"), hex"01");
    bytes memory a2 = NorenArcAction.encode(NorenArcAction.AQUA_ORDER, alice, bytes32("o2"), hex"02");
    assertTrue(_deliver(cctpHook, NorenArcAction.RAIL_CCTP, bytes32(uint256(11)), 2e6, a1));
    assertTrue(_deliver(cctpHook, NorenArcAction.RAIL_CCTP, bytes32(uint256(12)), 1e6, a2));
    assertEq(router.reserved(address(usdc)), 3e6);
    address maker = makeAddr("maker");
    router.settleAquaOrder(bytes32("o1"), maker);
    assertEq(usdc.balanceOf(maker), 2e6);
    vm.prank(alice);
    router.cancelAquaOrder(bytes32("o2"));
    assertEq(usdc.balanceOf(alice), 1e6);
    assertEq(router.reserved(address(usdc)), 0);
    vm.expectRevert();
    router.settleAquaOrder(bytes32("o2"), maker);
  }

  function test_CreditLineAuthorityLimitExpiryAndRepay() public {
    bytes32 line = keccak256("line");
    bytes memory open = NorenArcAction.encode(
      NorenArcAction.CREDIT_LINE, alice, line, abi.encode(line, uint256(10e6), uint64(block.timestamp + 1 days), uint64(1))
    );
    // not an authority yet -> declined, retryable
    assertFalse(_deliver(address(this), NorenArcAction.RAIL_CCIP, bytes32(uint256(20)), 0, open));
    router.setCreditAuthority(NorenArcAction.RAIL_CCIP, SRC, alice, true);
    assertTrue(_deliver(address(this), NorenArcAction.RAIL_CCIP, bytes32(uint256(20)), 0, open));

    usdc.mint(address(this), 100e6);
    usdc.approve(address(router), 100e6);
    router.addLiquidity(100e6);

    bytes32 inv = keccak256("i1");
    bytes memory pay = NorenArcAction.encode(NorenArcAction.PAY_ON_CREDIT, alice, inv, abi.encode(line, merchant, inv, uint256(8e6)));
    assertTrue(_deliver(address(this), NorenArcAction.RAIL_CCIP, bytes32(uint256(21)), 0, pay));
    assertEq(usdc.balanceOf(merchant), 8e6);

    bytes32 inv2 = keccak256("i2");
    bytes memory over = NorenArcAction.encode(NorenArcAction.PAY_ON_CREDIT, alice, inv2, abi.encode(line, merchant, inv2, uint256(3e6)));
    assertFalse(_deliver(address(this), NorenArcAction.RAIL_CCIP, bytes32(uint256(22)), 0, over), "over limit");

    usdc.mint(address(this), 5e6);
    usdc.approve(address(router), 5e6);
    router.repay(line, 5e6);
    assertEq(router.available(line), 7e6);
    assertTrue(_deliver(address(this), NorenArcAction.RAIL_CCIP, bytes32(uint256(22)), 0, over), "retry after repay");

    vm.warp(block.timestamp + 2 days);
    bytes32 inv3 = keccak256("i3");
    bytes memory late = NorenArcAction.encode(NorenArcAction.PAY_ON_CREDIT, alice, inv3, abi.encode(line, merchant, inv3, uint256(1e6)));
    assertFalse(_deliver(address(this), NorenArcAction.RAIL_CCIP, bytes32(uint256(23)), 0, late), "expired");
  }

  function test_WithdrawLiquidityCannotTouchReservedFunds() public {
    bytes memory a = NorenArcAction.encode(NorenArcAction.AQUA_ORDER, alice, bytes32("o"), "");
    _deliver(cctpHook, NorenArcAction.RAIL_CCTP, bytes32(uint256(30)), 2e6, a);
    vm.expectRevert();
    router.withdrawLiquidity(address(this), 1);
  }
}
