// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from 'forge-std/Script.sol';
import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {NorenAssetOracle} from '../src/NorenAssetOracle.sol';
import {NorenVault} from '../src/NorenVault.sol';
import {NorenGateway} from '../src/NorenGateway.sol';
import {NorenWifRouter} from '../src/NorenWifRouter.sol';
import {INorenVault} from '../src/interfaces/INorenVault.sol';
import {IWETH} from '../src/interfaces/IWETH.sol';
import {RobinhoodMainnet as RH} from './RobinhoodMainnet.sol';

/// @notice Minimal one-chain deployment. Requires the deployer to seed the USDG vault.
contract DeployWif is Script {
  uint256 constant SEED_USDG = 50e6;
  address constant WIF = 0x5173b8eA6923c2d40267890D45C46a3480954773;

  function run() external {
    require(block.chainid == 4663, 'Robinhood Chain only');
    uint256 key = vm.envUint('NOREN_RH_DEPLOYER_KEY');
    address deployer = vm.addr(key);
    // No transaction is broadcast until all funding checks pass. Funding output is address only.
    if (deployer.balance < 0.02 ether || IERC20(RH.USDG).balanceOf(deployer) < 60e6 || IERC20(WIF).balanceOf(deployer) < 10_000e18) {
      console2.logAddress(deployer);
      return;
    }
    vm.startBroadcast(key);
    NorenAssetOracle oracle = new NorenAssetOracle(deployer, RH.USDG);
    NorenVault vault = new NorenVault(deployer, IERC20(RH.USDG), oracle);
    NorenGateway gateway = new NorenGateway(deployer, IERC20(RH.USDG), IWETH(RH.WETH), oracle, INorenVault(address(vault)));
    NorenWifRouter router = new NorenWifRouter();
    RH.configureOracle(oracle);
    vault.setModule(address(gateway), true);
    gateway.setSpread(RH.WETH, 30);
    gateway.setSpread(RH.NVDA, 50);
    gateway.setSpread(RH.TSLA, 50);
    gateway.setSpread(RH.AAPL, 50);
    gateway.setWifRouter(router);
    // A 25 USDG demo invoice accrues 0.075 USDG, enough for one keeper burn.
    gateway.setWifFeeConfig(30, 10_000, 100, 50_000);
    IERC20(RH.USDG).approve(address(vault), SEED_USDG);
    vault.deposit(SEED_USDG, deployer);
    vm.stopBroadcast();
    console2.log('Gateway', address(gateway));
    console2.log('WIF router', address(router));
    console2.log('Vault', address(vault));
    console2.log('Oracle', address(oracle));
  }
}
