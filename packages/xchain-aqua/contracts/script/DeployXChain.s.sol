// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {XC} from './XChainConstants.sol';
import {XChainDeployer} from './XChainDeployer.sol';
import {NorenCrossChainSettler} from '../src/NorenCrossChainSettler.sol';
import {NorenCrossChainEscrow} from '../src/NorenCrossChainEscrow.sol';
import {ISwapVMRouter} from '../src/interfaces/IExternal.sol';

interface IAquaShip {
  function ship(address app, bytes calldata strategy, address[] calldata tokens, uint256[] calldata amounts)
    external
    returns (bytes32 strategyHash);
}

/// @notice Arc side (local fork only): router, settler, receipts, relayed feeds, routes.
/// Writes ../.fork/arc-deployment.json. Run with the deployer key (Anvil dev account 0).
contract DeployArc is XChainDeployer {
  function run() external {
    require(block.chainid == XC.ARC, 'Arc Testnet (fork) only');
    require(XC.AQUA.codehash == XC.AQUA_CODEHASH, 'official Aqua bytecode missing (scripts/forks.sh installs it)');
    vm.startBroadcast();
    (, address deployer,) = vm.readCallers();
    ArcStack memory a = _deployArc(deployer, XC.ARC_FORWARDER, uint64(vm.envOr('XCHAIN_RH_CHAIN_ID', uint256(XC.ROBINHOOD))));
    vm.stopBroadcast();
    string memory k = 'arc';
    vm.serializeAddress(k, 'router', a.router);
    vm.serializeAddress(k, 'settler', address(a.settler));
    vm.serializeAddress(k, 'rNVDA', address(a.rNvda));
    vm.serializeAddress(k, 'rWETH', address(a.rWeth));
    vm.serializeAddress(k, 'nvdaUsdRelayed', address(a.nvdaUsd));
    vm.serializeAddress(k, 'ethUsdRelayed', address(a.ethUsd));
    vm.serializeAddress(k, 'eurUsdRelayed', address(a.eurUsd));
    vm.serializeBytes32(k, 'nvdaRoute', a.nvdaRoute);
    vm.serializeBytes32(k, 'wethRoute', a.wethRoute);
    string memory out = vm.serializeBytes32(k, 'eurcRoute', a.eurcRoute);
    vm.writeJson(out, vm.envOr('XCHAIN_OUT', string('../.fork/arc-deployment.json')));
  }
}

/// @notice Source side (local fork only): escrow for one token, pointing at the Arc settler.
/// env: XCHAIN_ARC_SETTLER, XCHAIN_TOKEN, XCHAIN_FEED, XCHAIN_UI (bool), XCHAIN_FORWARDER, XCHAIN_OUT
contract DeploySource is XChainDeployer {
  function run() external {
    vm.startBroadcast();
    (, address deployer,) = vm.readCallers();
    NorenCrossChainEscrow e = _deployEscrow(
      deployer,
      vm.envAddress('XCHAIN_FORWARDER'),
      vm.envAddress('XCHAIN_ARC_SETTLER'),
      vm.envAddress('XCHAIN_TOKEN'),
      vm.envAddress('XCHAIN_FEED'),
      vm.envBool('XCHAIN_UI')
    );
    vm.stopBroadcast();
    vm.writeJson(vm.serializeAddress('src', 'escrow', address(e)), vm.envString('XCHAIN_OUT'));
  }
}

/// @notice The maker's own transactions on Arc: approve Aqua once, ship the canonical NorenOraclePeg
/// order for each route, register it with the settler. One USDC wallet backs every strategy.
/// env: XCHAIN_SETTLER, XCHAIN_ROUTES (bytes32[]), XCHAIN_IN_TOKENS (address[]), XCHAIN_ALLOC (uint256),
///      XCHAIN_BID_BPS, XCHAIN_PAYOUT, XCHAIN_OUT; optional XCHAIN_OUT_TOKEN (default Arc USDC), XCHAIN_ASK_BPS
contract MakerShip is XChainDeployer {
  function run() external {
    NorenCrossChainSettler s = NorenCrossChainSettler(vm.envAddress('XCHAIN_SETTLER'));
    bytes32[] memory routes = vm.envBytes32('XCHAIN_ROUTES', ',');
    address[] memory inTokens = vm.envAddress('XCHAIN_IN_TOKENS', ',');
    uint256 alloc = vm.envUint('XCHAIN_ALLOC');
    NorenCrossChainSettler.PegTerms memory t = NorenCrossChainSettler.PegTerms({
      bidSpreadBps: uint16(vm.envUint('XCHAIN_BID_BPS')),
      askSpreadBps: uint16(vm.envOr('XCHAIN_ASK_BPS', uint256(0))),
      closedExtraBps: 300,
      minPriceUsd8: 0,
      maxPriceUsd8: 0,
      salt: 1
    });
    address payout = vm.envAddress('XCHAIN_PAYOUT');
    address outToken = vm.envOr('XCHAIN_OUT_TOKEN', XC.ARC_USDC);
    vm.startBroadcast();
    (, address maker,) = vm.readCallers();
    IERC20(outToken).approve(XC.AQUA, type(uint256).max);
    string memory k = 'maker';
    string memory out;
    for (uint256 i; i < routes.length; i++) {
      (ISwapVMRouter.Order memory o, bytes32 h) = s.buildOrder(maker, routes[i], t);
      address[] memory tokens = new address[](2);
      tokens[0] = inTokens[i];
      tokens[1] = outToken;
      uint256[] memory amounts = new uint256[](2);
      amounts[1] = alloc;
      require(IAquaShip(XC.AQUA).ship(address(s.router()), abi.encode(o), tokens, amounts) == h, 'strategy hash');
      s.register(routes[i], t, payout);
      out = vm.serializeBytes32(k, vm.toString(i), h);
    }
    vm.stopBroadcast();
    vm.writeJson(out, vm.envString('XCHAIN_OUT'));
  }
}
