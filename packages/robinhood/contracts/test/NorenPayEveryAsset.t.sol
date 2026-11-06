// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {RobinhoodBase} from './RobinhoodBase.sol';
import {NorenGateway} from '../src/NorenGateway.sol';
import {NorenLiquidity} from '../src/NorenLiquidity.sol';
import {ISwapVMRouter} from '../src/interfaces/IAquaSwapVM.sol';
import {RobinhoodMainnet as RH} from '../script/RobinhoodMainnet.sol';

/// @notice "Pay with stocks or crypto" for every asset the checkout lists, on a fresh Robinhood mainnet fork:
/// the 8 Stock Tokens with Chainlink feeds, native ETH and USDG. Spreads match script/Deploy.s.sol and the
/// makers match script/SeedMakers.s.sol, so each stock and ETH payment is filled by its own 1inch Aqua maker
/// and the merchant receives the invoice in real USDG.
contract NorenPayEveryAssetTest is RobinhoodBase {
  uint128 internal constant AMOUNT = 25e6; // 25 USDG
  address internal makerWallet = makeAddr('seedMaker');

  function setUp() public override {
    super.setUp();
    address[9] memory assets = [RH.NVDA, RH.TSLA, RH.AAPL, RH.SPY, RH.MSFT, RH.AMZN, RH.GOOGL, RH.META, RH.WETH];
    vm.startPrank(owner);
    for (uint256 i; i < 8; ++i) gateway.setSpread(assets[i], 50);
    vm.stopPrank();
    _fund(RH.USDG, makerWallet, 9 * 10_000e6);
    vm.startPrank(makerWallet);
    usdg.approve(RH.AQUA, type(uint256).max);
    for (uint256 i; i < assets.length; ++i) {
      IERC20(assets[i]).approve(RH.AQUA, type(uint256).max);
      bool isWeth = assets[i] == RH.WETH;
      NorenLiquidity.PegTerms memory t = NorenLiquidity.PegTerms({
        bidSpreadBps: isWeth ? 30 : 50,
        askSpreadBps: isWeth ? 50 : 80,
        closedExtraBps: isWeth ? 0 : 300,
        minPriceUsd8: 0,
        maxPriceUsd8: 0,
        salt: 0
      });
      (ISwapVMRouter.Order memory o,) = liquidity.buildOrder(makerWallet, assets[i], t);
      address[] memory tokens = new address[](2);
      tokens[0] = RH.USDG;
      tokens[1] = assets[i];
      uint256[] memory amounts = new uint256[](2);
      amounts[0] = 10_000e6;
      aqua.ship(address(swapRouter), abi.encode(o), tokens, amounts);
      liquidity.register(assets[i], t);
    }
    vm.stopPrank();
  }

  function _payToken(address asset, bytes32 inv) internal {
    _invoice(inv, AMOUNT);
    (uint256 q,,, bytes32 strategy) = gateway.quoteRoute(merchant, inv, asset);
    if (asset != RH.USDG) assertTrue(strategy != bytes32(0), 'filled by an Aqua maker');
    _fund(asset, customer, q);
    uint256 before = usdg.balanceOf(merchant);
    vm.startPrank(customer);
    IERC20(asset).approve(address(gateway), q);
    uint256 paid = gateway.pay(inv, merchant, asset, q);
    vm.stopPrank();
    assertEq(paid, q);
    assertEq(usdg.balanceOf(merchant) - before, AMOUNT, 'merchant receives the invoice in USDG');
    NorenGateway.Invoice memory i = gateway.invoice(merchant, inv);
    assertEq(uint8(i.status), uint8(NorenGateway.Status.Paid));
    assertEq(i.asset, asset);
  }

  function test_payWithEveryStockToken() public {
    address[8] memory stocks = [RH.SPY, RH.MSFT, RH.AMZN, RH.GOOGL, RH.META, RH.TSLA, RH.AAPL, RH.NVDA];
    for (uint256 i; i < stocks.length; ++i) _payToken(stocks[i], keccak256(abi.encode('stock', i)));
  }

  function test_payWithUsdg() public {
    _payToken(RH.USDG, keccak256('usdg'));
  }

  function test_payWithNativeEth() public {
    bytes32 inv = keccak256('eth');
    _invoice(inv, AMOUNT);
    (uint256 q,,, bytes32 strategy) = gateway.quoteRoute(merchant, inv, address(0));
    assertTrue(strategy != bytes32(0), 'filled by the WETH Aqua maker');
    vm.deal(customer, 1 ether);
    uint256 before = usdg.balanceOf(merchant);
    vm.prank(customer);
    gateway.pay{value: q}(inv, merchant, address(0), q);
    assertEq(usdg.balanceOf(merchant) - before, AMOUNT);
    assertEq(gateway.invoice(merchant, inv).asset, RH.WETH);
  }
}
