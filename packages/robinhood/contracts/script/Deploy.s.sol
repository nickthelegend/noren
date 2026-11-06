// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from 'forge-std/Script.sol';
import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {NorenAssetOracle} from '../src/NorenAssetOracle.sol';
import {NorenVault} from '../src/NorenVault.sol';
import {NorenGateway} from '../src/NorenGateway.sol';
import {NorenCredit} from '../src/NorenCredit.sol';
import {INorenVault} from '../src/interfaces/INorenVault.sol';
import {IWETH} from '../src/interfaces/IWETH.sol';
import {RobinhoodMainnet as RH} from './RobinhoodMainnet.sol';

/// @notice Deploys Noren with CREATE2 (salt "noren-robinhood-v1") so a fork deployment lands on the same
/// addresses every time for the same code and constructor arguments.
/// Env: NOREN_RH_OWNER, NOREN_RH_UNDERWRITER, NOREN_RH_FORWARDER, NOREN_RH_INSTALLMENT_INTERVAL (s), NOREN_RH_GRACE (s).
contract Deploy is Script {
  bytes32 internal constant SALT = keccak256('noren-robinhood-v1');

  function run() external {
    require(block.chainid == 4663, 'Robinhood Chain (4663) or its fork only');
    address owner = vm.envAddress('NOREN_RH_OWNER');
    address underwriter = vm.envAddress('NOREN_RH_UNDERWRITER');
    address forwarder = vm.envAddress('NOREN_RH_FORWARDER');
    uint32 interval = uint32(vm.envOr('NOREN_RH_INSTALLMENT_INTERVAL', uint256(14 days)));
    uint32 grace = uint32(vm.envOr('NOREN_RH_GRACE', uint256(3 days)));

    vm.startBroadcast();
    NorenAssetOracle oracle = new NorenAssetOracle{salt: SALT}(owner, RH.USDG);
    NorenVault vault = new NorenVault{salt: SALT}(owner, IERC20(RH.USDG), oracle);
    NorenGateway gateway =
      new NorenGateway{salt: SALT}(owner, IERC20(RH.USDG), IWETH(RH.WETH), oracle, INorenVault(address(vault)));
    NorenCredit credit = new NorenCredit{salt: SALT}(
      owner,
      IERC20(RH.USDG),
      IWETH(RH.WETH),
      oracle,
      INorenVault(address(vault)),
      gateway,
      underwriter,
      forwarder,
      NorenCredit.Params({
        installmentInterval: interval,
        gracePeriod: grace,
        liquidationThresholdBps: 11_000,
        liquidationBonusBps: 500,
        merchantFeeBps: 300,
        maxLineDuration: 90 days,
        reportSkew: 300
      })
    );
    RH.configureOracle(oracle);
    vault.setModule(address(gateway), true);
    vault.setModule(address(credit), true);
    vault.setCredit(credit);
    gateway.setCredit(address(credit));
    gateway.setSpread(RH.WETH, 30);
    address[8] memory stocks = [RH.TSLA, RH.AAPL, RH.NVDA, RH.SPY, RH.AMZN, RH.MSFT, RH.GOOGL, RH.META];
    for (uint256 i; i < stocks.length; ++i) gateway.setSpread(stocks[i], 50);
    vm.stopBroadcast();

    console2.log('NOREN_RH_ORACLE', address(oracle));
    console2.log('NOREN_RH_VAULT', address(vault));
    console2.log('NOREN_RH_GATEWAY', address(gateway));
    console2.log('NOREN_RH_CREDIT', address(credit));
  }
}
