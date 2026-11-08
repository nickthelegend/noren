// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from 'forge-std/Test.sol';
import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {NorenWifRouter} from '../src/NorenWifRouter.sol';

contract NorenWifRouterTest is Test {
  NorenWifRouter router;
  IERC20 wif = IERC20(0x5173b8eA6923c2d40267890D45C46a3480954773);
  IERC20 usdg = IERC20(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168);
  address constant PM = 0x8366a39CC670B4001A1121B8F6A443A643e40951;

  function setUp() public {
    vm.createSelectFork(vm.envOr('ROBINHOOD_RPC', string('https://rpc.mainnet.chain.robinhood.com')));
    router = new NorenWifRouter();
    vm.prank(PM); wif.transfer(address(this), 100_000e18);
    vm.prank(PM); usdg.transfer(address(this), 100e6);
  }

  function testTwoWayRealPools() public {
    uint256 quote = router.quoteWifForUsdg(10e6);
    wif.approve(address(router), quote);
    uint256 spent = router.wifForExactUsdg(10e6, quote, address(this));
    assertGt(spent, 0);
    usdg.approve(address(router), 1e6);
    uint256 out = router.usdgForWif(1e6, router.quoteWifFromUsdg(1e6), address(this));
    assertGt(out, 0);
  }
}
