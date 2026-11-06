// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from 'forge-std/Script.sol';
import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {NorenAssetOracle} from '../src/NorenAssetOracle.sol';
import {NorenVault} from '../src/NorenVault.sol';
import {NorenGateway} from '../src/NorenGateway.sol';
import {NorenCredit} from '../src/NorenCredit.sol';
import {NorenLiquidity} from '../src/NorenLiquidity.sol';
import {IAqua, ISwapVMRouter} from '../src/interfaces/IAquaSwapVM.sol';
import {INorenVault} from '../src/interfaces/INorenVault.sol';
import {IWETH} from '../src/interfaces/IWETH.sol';
import {RobinhoodMainnet as RH} from './RobinhoodMainnet.sol';

/// @notice Deploys Noren with CREATE2 (salt "noren-robinhood-v1") so a fork deployment lands on the same
/// addresses every time for the same code and constructor arguments. Also deploys the modified SwapVM
/// router (packages/aqua/swapvm-ext build artifact, LicenseRef-Degensoft-SwapVM-1.1) against the
/// official Aqua registry, and NorenLiquidity, and points the gateway and credit at it.
/// Env: NOREN_RH_OWNER, NOREN_RH_UNDERWRITER, NOREN_RH_FORWARDER, NOREN_RH_INSTALLMENT_INTERVAL (s), NOREN_RH_GRACE (s).
contract Deploy is Script {
  bytes32 internal constant SALT = keccak256('noren-robinhood-v1');
  /// @dev Foundry's deterministic CREATE2 deployer (the one `new X{salt: ...}` uses in scripts).
  address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

  function run() external {
    // 46630 = a local mainnet fork re-tagged as Robinhood testnet for the CRE simulator.
    require(block.chainid == 4663 || block.chainid == 46630, 'Robinhood Chain (4663) or a local fork (4663/46630) only');
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
    require(RH.AQUA.code.length > 0, 'official Aqua registry missing on this chain');
    ISwapVMRouter router = _deployRouter(owner);
    NorenLiquidity liquidity = new NorenLiquidity{salt: SALT}(owner, IAqua(RH.AQUA), router, oracle);
    gateway.setLiquidity(liquidity, true);
    credit.setLiquidity(liquidity);
    address[8] memory stocks = [RH.TSLA, RH.AAPL, RH.NVDA, RH.SPY, RH.AMZN, RH.MSFT, RH.GOOGL, RH.META];
    for (uint256 i; i < stocks.length; ++i) gateway.setSpread(stocks[i], 50);
    vm.stopBroadcast();

    console2.log('NOREN_RH_ORACLE', address(oracle));
    console2.log('NOREN_RH_VAULT', address(vault));
    console2.log('NOREN_RH_GATEWAY', address(gateway));
    console2.log('NOREN_RH_CREDIT', address(credit));
    console2.log('NOREN_RH_SWAPVM_ROUTER', address(router));
    console2.log('NOREN_RH_LIQUIDITY', address(liquidity));
  }

  /// @dev CREATE2 from the build artifact, so this MIT script never compiles SwapVM source.
  function _deployRouter(address owner) internal returns (ISwapVMRouter router) {
    bytes memory initcode = abi.encodePacked(
      vm.getCode(RH.NOREN_ROUTER_ARTIFACT),
      abi.encode(RH.AQUA, RH.WETH, owner, RH.NOREN_ROUTER_NAME, RH.NOREN_ROUTER_VERSION)
    );
    address predicted = vm.computeCreate2Address(SALT, keccak256(initcode), CREATE2_DEPLOYER);
    if (predicted.code.length == 0) {
      (bool ok,) = CREATE2_DEPLOYER.call(abi.encodePacked(SALT, initcode));
      require(ok && predicted.code.length > 0, 'router deploy failed');
    }
    router = ISwapVMRouter(predicted);
  }
}
