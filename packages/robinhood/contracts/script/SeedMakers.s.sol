// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from 'forge-std/Script.sol';
import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {NorenLiquidity} from '../src/NorenLiquidity.sol';
import {IAqua, ISwapVMRouter} from '../src/interfaces/IAquaSwapVM.sol';
import {RobinhoodMainnet as RH} from './RobinhoodMainnet.sol';

/// @notice Fork demo: the broadcaster (a maker, e.g. a merchant with idle USDG) approves Aqua once and
/// ships one NorenOraclePeg strategy per asset, then registers each with NorenLiquidity.
/// USDG stays in the maker's wallet; Aqua only records virtual balances.
/// Env: NOREN_RH_LIQUIDITY, NOREN_AQUA_MAKER_USDG (per strategy, 6 decimals, default 10,000 USDG).
contract SeedMakers is Script {
  function run() external {
    NorenLiquidity liquidity = NorenLiquidity(vm.envAddress('NOREN_RH_LIQUIDITY'));
    uint256 perStrategy = vm.envOr('NOREN_AQUA_MAKER_USDG', uint256(10_000e6));
    address router = address(liquidity.router());
    // Every Stock Token with a Chainlink feed in NorenAssetOracle, plus WETH: each payable through its own maker.
    address[9] memory assets = [RH.NVDA, RH.TSLA, RH.AAPL, RH.SPY, RH.MSFT, RH.AMZN, RH.GOOGL, RH.META, RH.WETH];
    uint16[9] memory bids = [uint16(50), 50, 50, 50, 50, 50, 50, 50, 30];
    uint16[9] memory asks = [uint16(80), 80, 80, 80, 80, 80, 80, 80, 50];

    vm.startBroadcast();
    IERC20(RH.USDG).approve(RH.AQUA, type(uint256).max);
    for (uint256 i; i < assets.length; ++i) {
      IERC20(assets[i]).approve(RH.AQUA, type(uint256).max); // lets the strategy resell inventory
      NorenLiquidity.PegTerms memory t = NorenLiquidity.PegTerms({
        bidSpreadBps: bids[i],
        askSpreadBps: asks[i],
        closedExtraBps: assets[i] == RH.WETH ? 0 : 300,
        minPriceUsd8: 0,
        maxPriceUsd8: 0,
        salt: 0
      });
      (ISwapVMRouter.Order memory o, bytes32 h) = liquidity.buildOrder(msg.sender, assets[i], t);
      address[] memory tokens = new address[](2);
      tokens[0] = RH.USDG;
      tokens[1] = assets[i];
      uint256[] memory amounts = new uint256[](2);
      amounts[0] = perStrategy;
      IAqua(RH.AQUA).ship(router, abi.encode(o), tokens, amounts);
      liquidity.register(assets[i], t);
      console2.log('NOREN_AQUA_STRATEGY', assets[i], vm.toString(h));
    }
    vm.stopBroadcast();
  }
}
