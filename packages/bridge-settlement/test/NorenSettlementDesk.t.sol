// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from 'forge-std/Test.sol';
import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {NorenSettlementDesk} from '../src/NorenSettlementDesk.sol';
import {IAggregatorV3, IPermit2, IUniversalRouter, PoolKey} from '../src/interfaces/IExternal.sol';

interface IStockMultiplier {
  function uiMultiplier() external view returns (uint256);
}

interface IV4Quoter {
  struct QuoteExactSingleParams {
    PoolKey poolKey;
    bool zeroForOne;
    uint128 exactAmount;
    bytes hookData;
  }

  function quoteExactInputSingle(QuoteExactSingleParams memory params) external returns (uint256 amountOut, uint256 gasEstimate);
}

/// @notice Runs against a fork of Robinhood Chain mainnet at the latest block: the real USDG, NVDA
///         Stock Token, Chainlink feeds, Uniswap v4 pool, Universal Router, Permit2, Relay
///         Depository and Across SpokePool. No mocks. Needs network access to the public RPC.
contract NorenSettlementDeskForkTest is Test {
  address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
  address constant USDG_USD = 0x61B7e5650328764B076A108EFF5fa7282a1B9aD2;
  address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
  address constant NVDA_USD = 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15;
  address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951; // also a real NVDA holder
  address constant USDG_HOLDER = POOL_MANAGER; // the v4 PoolManager holds USDG too
  address constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
  address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
  address constant V4_QUOTER = 0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94;
  address constant RELAY_DEPOSITORY = 0x4cD00E387622C35bDDB9b4c962C136462338BC31;
  address constant ACROSS_SPOKE = 0xD29C85F15DF544bA632C9E25829fd29d767d7978;
  address constant ARC_USDC = 0x3600000000000000000000000000000000000000;

  NorenSettlementDesk desk;
  address forwarder = makeAddr('forwarder');
  address keeper = makeAddr('keeper');
  address owner = makeAddr('owner');
  address merchant = makeAddr('merchant');
  address arcTreasury = makeAddr('arc-treasury');
  uint256 constant AMOUNT = 100e6;

  function setUp() public {
    vm.createSelectFork('robinhood');
    desk = new NorenSettlementDesk(
      IERC20(USDG),
      IAggregatorV3(USDG_USD),
      RELAY_DEPOSITORY,
      ACROSS_SPOKE,
      ARC_USDC,
      IUniversalRouter(UNIVERSAL_ROUTER),
      IPermit2(PERMIT2),
      forwarder,
      keeper,
      owner
    );
    vm.prank(owner);
    desk.setStockFeed(NVDA, NVDA_USD);
    vm.prank(USDG_HOLDER);
    require(IERC20(USDG).transfer(merchant, 1_000e6), "usdg");
    vm.prank(POOL_MANAGER);
    require(IERC20(NVDA).transfer(merchant, 10e18), "nvda");
    vm.startPrank(merchant);
    IERC20(USDG).approve(address(desk), type(uint256).max);
    IERC20(NVDA).approve(address(desk), type(uint256).max);
    vm.stopPrank();
  }

  function _nvdaKey() internal pure returns (PoolKey memory) {
    // USDG (0x5fc5) sorts before NVDA (0xd060); fee 0.3%, tick spacing 60, no hooks.
    return PoolKey({currency0: USDG, currency1: NVDA, fee: 3000, tickSpacing: 60, hooks: address(0)});
  }

  function _request() internal returns (bytes32 id) {
    vm.prank(merchant);
    id = desk.requestSettlement(AMOUNT, arcTreasury, 50);
  }

  function _report(uint8 kind, bytes32 id, uint8 route, uint256 minOut, uint256 quoted, uint64 validUntil) internal pure returns (bytes memory) {
    return abi.encode(kind, id, route, minOut, quoted, uint256(99_998_000), uint256(99_990_000), validUntil);
  }

  function _approve(bytes32 id, uint8 route, uint256 minOut) internal {
    vm.prank(forwarder);
    desk.onReport('', _report(1, id, route, minOut, minOut + 100, uint64(block.timestamp + 600)));
  }

  function _relayCalldata(address depositor, address token, uint256 amount) internal pure returns (bytes memory) {
    return abi.encodeWithSelector(bytes4(0xe8017952), depositor, token, amount, keccak256('relay-order'));
  }

  function _acrossCalldata(address depositor, address recipient, address outToken, uint256 inAmount, uint256 outAmount, uint256 dest)
    internal
    view
    returns (bytes memory)
  {
    return abi.encodeWithSelector(
      bytes4(0xad5425c6),
      bytes32(uint256(uint160(depositor))),
      bytes32(uint256(uint160(recipient))),
      bytes32(uint256(uint160(USDG))),
      bytes32(uint256(uint160(outToken))),
      inAmount,
      outAmount,
      dest,
      bytes32(0),
      uint32(block.timestamp),
      uint32(block.timestamp + 3600),
      uint32(0),
      bytes('')
    );
  }

  // ------------------------------------------------------------ Uniswap v4 stock sale

  function test_sellStock_onLiveV4Pool_matchesQuoterAndClearsChainlinkFloor() public {
    (uint256 quoted,) = IV4Quoter(V4_QUOTER).quoteExactInputSingle(
      IV4Quoter.QuoteExactSingleParams({poolKey: _nvdaKey(), zeroForOne: false, exactAmount: 1e18, hookData: ''})
    );
    uint256 floor = desk.stockFloorUsdg6(NVDA, 1e18, 200);
    vm.prank(merchant);
    (bytes32 id, uint256 out) = desk.sellStockAndRequest(_nvdaKey(), 1e18, uint128(quoted), 200, arcTreasury, 50);
    assertEq(out, quoted, 'fill equals the V4Quoter quote');
    assertGe(out, floor, 'fill clears Chainlink value minus 2%');
    NorenSettlementDesk.Settlement memory s = desk.settlement(id);
    assertEq(uint8(s.status), uint8(NorenSettlementDesk.Status.Requested));
    assertEq(s.amountUsdg6, out);
    assertEq(IERC20(USDG).balanceOf(address(desk)), out);
    assertEq(IERC20(NVDA).balanceOf(merchant), 9e18);
    emit log_named_uint('1 NVDA -> USDG (6 dp) on v4', out);
    emit log_named_uint('Chainlink floor at 2% (6 dp)', floor);
  }

  function test_sellStock_refusesFillBelowChainlinkFloor() public {
    // The pool costs ~0.5% (0.3% fee + impact) below Chainlink; a 0.1% bound must refuse it.
    vm.prank(merchant);
    vm.expectRevert();
    desk.sellStockAndRequest(_nvdaKey(), 1e18, 0, 10, arcTreasury, 50);
  }

  function test_sellStock_rejectsUnknownStockAndHookedOrForeignPools() public {
    vm.startPrank(merchant);
    vm.expectRevert(abi.encodeWithSelector(NorenSettlementDesk.UnknownStock.selector, address(0xBEEF)));
    desk.sellStockAndRequest(PoolKey(USDG, address(0xBEEF), 3000, 60, address(0)), 1e18, 0, 200, arcTreasury, 50);
    vm.expectRevert(NorenSettlementDesk.BadPoolKey.selector);
    desk.sellStockAndRequest(PoolKey(USDG, NVDA, 3000, 60, address(0x1234)), 1e18, 0, 200, arcTreasury, 50);
    vm.expectRevert(NorenSettlementDesk.BadPoolKey.selector);
    desk.sellStockAndRequest(PoolKey(address(1), NVDA, 3000, 60, address(0)), 1e18, 0, 200, arcTreasury, 50);
    vm.expectRevert(abi.encodeWithSelector(NorenSettlementDesk.BadSlippage.selector, 501));
    desk.sellStockAndRequest(_nvdaKey(), 1e18, 0, 501, arcTreasury, 50);
    vm.stopPrank();
  }

  function test_stockFloor_usesLiveChainlinkAndMultiplier() public view {
    (, int256 nvda,,,) = IAggregatorV3(NVDA_USD).latestRoundData();
    (, int256 usdgUsd,,,) = IAggregatorV3(USDG_USD).latestRoundData();
    uint256 mult = IStockMultiplier(NVDA).uiMultiplier(); // not exactly 1e18: NVDA's split/dividend multiplier
    // Same operation order as the desk (the lost precision is under 1e-8 USD).
    // forge-lint: disable-next-line(divide-before-multiply)
    uint256 expected = (1e18 * mult / 1e18) * uint256(nvda) / 1e18 * 1e6 / uint256(usdgUsd);
    assertEq(desk.stockFloorUsdg6(NVDA, 1e18, 0), expected);
    assertEq(desk.stockFloorUsdg6(NVDA, 1e18, 100), expected * 9_900 / 10_000);
  }

  // ------------------------------------------------------------ requests and reports

  function test_request_pullsUsdgAndEmits() public {
    bytes32 id = _request();
    NorenSettlementDesk.Settlement memory s = desk.settlement(id);
    assertEq(s.merchant, merchant);
    assertEq(s.arcRecipient, arcTreasury);
    assertEq(s.amountUsdg6, AMOUNT);
    assertEq(s.maxSlippageBps, 50);
    assertEq(IERC20(USDG).balanceOf(address(desk)), AMOUNT);
  }

  function test_request_rejectsBadSlippageAndRecipient() public {
    vm.startPrank(merchant);
    vm.expectRevert(abi.encodeWithSelector(NorenSettlementDesk.BadSlippage.selector, 0));
    desk.requestSettlement(AMOUNT, arcTreasury, 0);
    vm.expectRevert(abi.encodeWithSelector(NorenSettlementDesk.BadSlippage.selector, 501));
    desk.requestSettlement(AMOUNT, arcTreasury, 501);
    vm.expectRevert(NorenSettlementDesk.ZeroAddress.selector);
    desk.requestSettlement(AMOUNT, address(0), 50);
    vm.expectRevert(NorenSettlementDesk.ZeroAmount.selector);
    desk.requestSettlement(0, arcTreasury, 50);
    vm.stopPrank();
  }

  function test_report_onlyForwarder() public {
    bytes32 id = _request();
    vm.prank(keeper);
    vm.expectRevert(abi.encodeWithSelector(NorenSettlementDesk.NotForwarder.selector, keeper));
    desk.onReport('', _report(1, id, 1, 99e6, 99.9e6, uint64(block.timestamp + 600)));
  }

  function test_report_approveStoresTerms() public {
    bytes32 id = _request();
    _approve(id, 1, 99.5e6);
    NorenSettlementDesk.Settlement memory s = desk.settlement(id);
    assertEq(uint8(s.status), uint8(NorenSettlementDesk.Status.Approved));
    assertEq(uint8(s.route), 1);
    assertEq(s.minOutUsdc6, 99.5e6);
    assertEq(s.quotedOutUsdc6, 99.5e6 + 100);
  }

  function test_report_rejectsBadApprovals() public {
    bytes32 id = _request();
    vm.startPrank(forwarder);
    vm.expectRevert(NorenSettlementDesk.InvalidReport.selector);
    desk.onReport('', _report(1, id, 3, 99e6, 99e6, uint64(block.timestamp + 600)));
    vm.expectRevert(abi.encodeWithSelector(NorenSettlementDesk.ApprovalExpired.selector, uint64(block.timestamp)));
    desk.onReport('', _report(1, id, 1, 99e6, 99e6, uint64(block.timestamp)));
    // A compromised report can never set a minimum below amount x 95%.
    vm.expectRevert(abi.encodeWithSelector(NorenSettlementDesk.MinOutBelowFloor.selector, 94e6, 95e6));
    desk.onReport('', _report(1, id, 1, 94e6, 99e6, uint64(block.timestamp + 600)));
    vm.expectRevert(NorenSettlementDesk.InvalidReport.selector);
    desk.onReport('', abi.encode(uint8(1), id));
    vm.expectRevert(NorenSettlementDesk.InvalidReport.selector);
    desk.onReport('', _report(9, id, 1, 99e6, 99e6, uint64(block.timestamp + 600)));
    vm.stopPrank();
  }

  function test_report_rejectThenRetryThenCancel() public {
    bytes32 id = _request();
    vm.prank(forwarder);
    desk.onReport('', _report(2, id, 0, 0, 99e6, 0));
    assertEq(uint8(desk.settlement(id).status), uint8(NorenSettlementDesk.Status.Rejected));
    vm.prank(forwarder);
    vm.expectRevert(abi.encodeWithSelector(NorenSettlementDesk.BadStatus.selector, NorenSettlementDesk.Status.Rejected));
    desk.onReport('', _report(1, id, 1, 99e6, 99e6, uint64(block.timestamp + 600)));
    vm.prank(merchant);
    desk.retry(id);
    assertEq(uint8(desk.settlement(id).status), uint8(NorenSettlementDesk.Status.Requested));
    vm.prank(forwarder);
    desk.onReport('', _report(2, id, 0, 0, 99e6, 0));
    uint256 before = IERC20(USDG).balanceOf(merchant);
    vm.prank(merchant);
    desk.cancel(id);
    assertEq(IERC20(USDG).balanceOf(merchant), before + AMOUNT);
  }

  function test_cancel_unansweredOnlyAfterTimeout() public {
    bytes32 id = _request();
    vm.prank(merchant);
    vm.expectRevert(abi.encodeWithSelector(NorenSettlementDesk.TooEarly.selector, uint64(block.timestamp + 1 hours)));
    desk.cancel(id);
    vm.prank(keeper);
    vm.expectRevert(NorenSettlementDesk.NotMerchant.selector);
    desk.cancel(id);
    vm.warp(block.timestamp + 1 hours + 1);
    vm.prank(merchant);
    desk.cancel(id);
    assertEq(uint8(desk.settlement(id).status), uint8(NorenSettlementDesk.Status.Cancelled));
  }

  // ------------------------------------------------------------ Relay execution (real Depository)

  function test_execute_relay_depositsIntoRealDepository() public {
    bytes32 id = _request();
    _approve(id, 1, 99.5e6);
    uint256 before = IERC20(USDG).balanceOf(RELAY_DEPOSITORY);
    vm.prank(keeper);
    desk.executeSettlement(id, NorenSettlementDesk.Route.Relay, _relayCalldata(address(desk), USDG, AMOUNT));
    assertEq(IERC20(USDG).balanceOf(RELAY_DEPOSITORY), before + AMOUNT);
    assertEq(IERC20(USDG).balanceOf(address(desk)), 0);
    assertEq(IERC20(USDG).allowance(address(desk), RELAY_DEPOSITORY), 0);
    assertEq(uint8(desk.settlement(id).status), uint8(NorenSettlementDesk.Status.Executed));
  }

  function test_execute_relay_checksCalldata() public {
    bytes32 id = _request();
    _approve(id, 1, 99.5e6);
    vm.startPrank(keeper);
    vm.expectRevert(abi.encodeWithSelector(NorenSettlementDesk.BadCalldata.selector, 'relay depositor'));
    desk.executeSettlement(id, NorenSettlementDesk.Route.Relay, _relayCalldata(keeper, USDG, AMOUNT));
    vm.expectRevert(abi.encodeWithSelector(NorenSettlementDesk.BadCalldata.selector, 'relay token'));
    desk.executeSettlement(id, NorenSettlementDesk.Route.Relay, _relayCalldata(address(desk), NVDA, AMOUNT));
    vm.expectRevert(abi.encodeWithSelector(NorenSettlementDesk.BadCalldata.selector, 'relay amount'));
    desk.executeSettlement(id, NorenSettlementDesk.Route.Relay, _relayCalldata(address(desk), USDG, AMOUNT - 1));
    vm.expectRevert(abi.encodeWithSelector(NorenSettlementDesk.BadCalldata.selector, 'relay selector or length'));
    desk.executeSettlement(id, NorenSettlementDesk.Route.Relay, abi.encodeWithSelector(bytes4(0x12345678), address(desk)));
    vm.stopPrank();
  }

  function test_execute_onlyKeeper_onlyApproved_notExpired_once() public {
    bytes32 id = _request();
    bytes memory data = _relayCalldata(address(desk), USDG, AMOUNT);
    vm.prank(keeper);
    vm.expectRevert(abi.encodeWithSelector(NorenSettlementDesk.BadStatus.selector, NorenSettlementDesk.Status.Requested));
    desk.executeSettlement(id, NorenSettlementDesk.Route.Relay, data);
    _approve(id, 2, 99.5e6);
    vm.prank(merchant);
    vm.expectRevert(NorenSettlementDesk.NotKeeper.selector);
    desk.executeSettlement(id, NorenSettlementDesk.Route.Relay, data);
    vm.prank(keeper);
    vm.expectRevert(abi.encodeWithSelector(NorenSettlementDesk.RouteNotApproved.selector, NorenSettlementDesk.Route.Relay));
    desk.executeSettlement(id, NorenSettlementDesk.Route.Relay, data);
    vm.warp(block.timestamp + 601);
    vm.prank(keeper);
    vm.expectRevert(abi.encodeWithSelector(NorenSettlementDesk.ApprovalExpired.selector, uint64(block.timestamp - 1)));
    desk.executeSettlement(id, NorenSettlementDesk.Route.Across, data);
  }

  // ------------------------------------------------------------ Across execution (real SpokePool)

  function test_execute_across_depositsIntoRealSpokePool() public {
    bytes32 id = _request();
    _approve(id, 2, 99.5e6);
    uint256 before = IERC20(USDG).balanceOf(ACROSS_SPOKE);
    vm.prank(keeper);
    desk.executeSettlement(
      id, NorenSettlementDesk.Route.Across, _acrossCalldata(address(desk), arcTreasury, ARC_USDC, AMOUNT, 99.9e6, 5042)
    );
    assertEq(IERC20(USDG).balanceOf(ACROSS_SPOKE), before + AMOUNT);
    assertEq(uint8(desk.settlement(id).status), uint8(NorenSettlementDesk.Status.Executed));
  }

  function test_execute_across_isTheFallbackEvenWhenRelayWasApproved() public {
    bytes32 id = _request();
    _approve(id, 1, 99.5e6);
    vm.prank(keeper);
    desk.executeSettlement(
      id, NorenSettlementDesk.Route.Across, _acrossCalldata(address(desk), arcTreasury, ARC_USDC, AMOUNT, 99.5e6, 5042)
    );
    assertEq(uint8(desk.settlement(id).status), uint8(NorenSettlementDesk.Status.Executed));
  }

  function test_execute_across_enforcesTermsOnChain() public {
    bytes32 id = _request();
    _approve(id, 2, 99.5e6);
    vm.startPrank(keeper);
    vm.expectRevert(abi.encodeWithSelector(NorenSettlementDesk.BadCalldata.selector, 'across output below approved minimum'));
    desk.executeSettlement(id, NorenSettlementDesk.Route.Across, _acrossCalldata(address(desk), arcTreasury, ARC_USDC, AMOUNT, 99.5e6 - 1, 5042));
    vm.expectRevert(abi.encodeWithSelector(NorenSettlementDesk.BadCalldata.selector, 'across recipient'));
    desk.executeSettlement(id, NorenSettlementDesk.Route.Across, _acrossCalldata(address(desk), keeper, ARC_USDC, AMOUNT, 99.9e6, 5042));
    vm.expectRevert(abi.encodeWithSelector(NorenSettlementDesk.BadCalldata.selector, 'across destination'));
    desk.executeSettlement(id, NorenSettlementDesk.Route.Across, _acrossCalldata(address(desk), arcTreasury, ARC_USDC, AMOUNT, 99.9e6, 1));
    vm.expectRevert(abi.encodeWithSelector(NorenSettlementDesk.BadCalldata.selector, 'across output token'));
    desk.executeSettlement(id, NorenSettlementDesk.Route.Across, _acrossCalldata(address(desk), arcTreasury, USDG, AMOUNT, 99.9e6, 5042));
    vm.expectRevert(abi.encodeWithSelector(NorenSettlementDesk.BadCalldata.selector, 'across depositor'));
    desk.executeSettlement(id, NorenSettlementDesk.Route.Across, _acrossCalldata(keeper, arcTreasury, ARC_USDC, AMOUNT, 99.9e6, 5042));
    vm.expectRevert(abi.encodeWithSelector(NorenSettlementDesk.BadCalldata.selector, 'across amount'));
    desk.executeSettlement(id, NorenSettlementDesk.Route.Across, _acrossCalldata(address(desk), arcTreasury, ARC_USDC, AMOUNT + 1, 99.9e6, 5042));
    vm.stopPrank();
  }

  // ------------------------------------------------------------ admin

  function test_admin_onlyOwner() public {
    vm.startPrank(merchant);
    vm.expectRevert(NorenSettlementDesk.NotOwner.selector);
    desk.setStockFeed(NVDA, address(0));
    vm.expectRevert(NorenSettlementDesk.NotOwner.selector);
    desk.setRoles(merchant, merchant, address(0));
    vm.expectRevert(NorenSettlementDesk.NotOwner.selector);
    desk.setMaxFeedAge(1);
    vm.stopPrank();
  }

  function test_stalePriceRefusesSale() public {
    vm.prank(owner);
    desk.setMaxFeedAge(1);
    vm.warp(block.timestamp + 3);
    vm.prank(merchant);
    vm.expectRevert();
    desk.sellStockAndRequest(_nvdaKey(), 1e18, 0, 200, arcTreasury, 50);
  }
}
