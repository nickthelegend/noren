// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from 'forge-std/Script.sol';
import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {TsukeOracle} from '../src/TsukeOracle.sol';
import {TsukeVault} from '../src/TsukeVault.sol';
import {TsukeGateway} from '../src/TsukeGateway.sol';
import {TsukeCredit} from '../src/TsukeCredit.sol';
import {ITsukeVault} from '../src/interfaces/ITsukeVault.sol';
import {IWETH} from '../src/interfaces/IWETH.sol';
import {RobinhoodMainnet as RH} from './RobinhoodMainnet.sol';

/// @notice Deploys Tsuke with CREATE2 (salt "tsuke-v1") so a fork deployment lands on the same
/// addresses every time for the same code and constructor arguments.
/// Env: TSUKE_OWNER, TSUKE_UNDERWRITER, TSUKE_FORWARDER, TSUKE_INSTALLMENT_INTERVAL (s), TSUKE_GRACE (s).
contract Deploy is Script {
  bytes32 internal constant SALT = keccak256('tsuke-v1');

  function run() external {
    require(block.chainid == 4663, 'Robinhood Chain (4663) or its fork only');
    address owner = vm.envAddress('TSUKE_OWNER');
    address underwriter = vm.envAddress('TSUKE_UNDERWRITER');
    address forwarder = vm.envAddress('TSUKE_FORWARDER');
    uint32 interval = uint32(vm.envOr('TSUKE_INSTALLMENT_INTERVAL', uint256(14 days)));
    uint32 grace = uint32(vm.envOr('TSUKE_GRACE', uint256(3 days)));

    vm.startBroadcast();
    TsukeOracle oracle = new TsukeOracle{salt: SALT}(owner, RH.USDG);
    TsukeVault vault = new TsukeVault{salt: SALT}(owner, IERC20(RH.USDG), oracle);
    TsukeGateway gateway =
      new TsukeGateway{salt: SALT}(owner, IERC20(RH.USDG), IWETH(RH.WETH), oracle, ITsukeVault(address(vault)));
    TsukeCredit credit = new TsukeCredit{salt: SALT}(
      owner,
      IERC20(RH.USDG),
      IWETH(RH.WETH),
      oracle,
      ITsukeVault(address(vault)),
      gateway,
      underwriter,
      forwarder,
      TsukeCredit.Params({
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

    console2.log('TSUKE_ORACLE', address(oracle));
    console2.log('TSUKE_VAULT', address(vault));
    console2.log('TSUKE_GATEWAY', address(gateway));
    console2.log('TSUKE_CREDIT', address(credit));
  }
}
