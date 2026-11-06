// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from 'forge-std/Script.sol';
import {XC} from './XChainConstants.sol';
import {NorenCrossChainSettler} from '../src/NorenCrossChainSettler.sol';
import {NorenCrossChainEscrow} from '../src/NorenCrossChainEscrow.sol';
import {NorenEscrowReceipt} from '../src/NorenEscrowReceipt.sol';
import {NorenRelayedFeed} from '../src/NorenRelayedFeed.sol';
import {IAqua, ISwapVMRouter} from '../src/interfaces/IExternal.sol';

/// @notice Shared deployment steps for the fork tests and scripts/xchain-demo.sh.
abstract contract XChainDeployer is Script {
  struct ArcStack {
    address router;
    NorenCrossChainSettler settler;
    NorenEscrowReceipt rNvda;
    NorenEscrowReceipt rWeth;
    NorenRelayedFeed nvdaUsd;
    NorenRelayedFeed ethUsd;
    NorenRelayedFeed eurUsd;
    bytes32 nvdaRoute;
    bytes32 wethRoute;
    bytes32 eurcRoute;
  }

  /// @dev NorenAquaSwapVMRouter (packages/aqua/swapvm-ext build artifact, LicenseRef-Degensoft-SwapVM-1.1)
  /// via the deterministic CREATE2 deployer, so it lands at the same address on every chain.
  /// This MIT script never compiles SwapVM source. weth = 0: no WETH unwrapping is used.
  function _deployRouter(address owner) internal returns (address router) {
    bytes memory initcode = abi.encodePacked(
      vm.getCode(XC.NOREN_ROUTER_ARTIFACT), abi.encode(XC.AQUA, address(0), owner, 'Noren SwapVM', '1.0.2-noren.1')
    );
    router = vm.computeCreate2Address(XC.ROUTER_SALT, keccak256(initcode), XC.CREATE2_DEPLOYER);
    if (router.code.length == 0) {
      (bool ok,) = XC.CREATE2_DEPLOYER.call(abi.encodePacked(XC.ROUTER_SALT, initcode));
      require(ok && router.code.length != 0, 'router deploy failed');
    }
  }

  /// @dev Arc side: settler, receipts for NVDA (Robinhood) and WETH (Base Sepolia), relayed feeds,
  /// and three routes: NVDA->USDC and WETH->USDC (escrowed), USDC->EURC (delivered via CCTP/CCIP).
  function _deployArc(address owner, address forwarder) internal returns (ArcStack memory a) {
    a.router = _deployRouter(owner);
    a.settler = new NorenCrossChainSettler(owner, forwarder, IAqua(XC.AQUA), ISwapVMRouter(a.router));
    address s = address(a.settler);
    a.rNvda = new NorenEscrowReceipt('Noren escrow receipt: NVDA on Robinhood Chain', 'rNVDA', 18, XC.ROBINHOOD, XC.NVDA, s);
    a.rWeth = new NorenEscrowReceipt('Noren escrow receipt: WETH on Base Sepolia', 'rWETH', 18, XC.BASE_SEPOLIA, XC.BASE_WETH, s);
    a.nvdaUsd = new NorenRelayedFeed(s, 8, XC.ROBINHOOD, XC.NVDA_USD, 'NVDA / USD (Chainlink on Robinhood Chain 4663, relayed by CRE)');
    a.ethUsd = new NorenRelayedFeed(s, 8, XC.BASE_SEPOLIA, XC.BASE_ETH_USD, 'ETH / USD (Chainlink on Base Sepolia 84532, relayed by CRE)');
    a.eurUsd = new NorenRelayedFeed(s, 8, XC.ARC_MAINNET, XC.ARC_MAINNET_EUR_USD, 'EUR / USD (Chainlink on Arc mainnet 5042, relayed by CRE)');

    // Stock Token: 24/5 feed, uiMultiplier, 25 h open age, 3 days in the closed window (as NorenAssetOracle).
    a.settler.setRoute(XC.ROBINHOOD, XC.NVDA, _route(address(a.rNvda), XC.ARC_USDC, false, true, address(a.nvdaUsd), 90_000, 259_200, 0x03));
    a.settler.setRoute(XC.BASE_SEPOLIA, XC.BASE_WETH, _route(address(a.rWeth), XC.ARC_USDC, false, true, address(a.ethUsd), 86_400, 86_400, 0));
    // Delivered USDC buys EURC from the maker at the EUR/USD peg plus the maker's ask spread.
    a.settler.setRoute(0, XC.ARC_USDC, _route(XC.ARC_USDC, XC.ARC_EURC, true, false, address(a.eurUsd), 90_000, 259_200, 0));
    a.nvdaRoute = a.settler.routeKey(XC.ROBINHOOD, XC.NVDA, XC.ARC_USDC);
    a.wethRoute = a.settler.routeKey(XC.BASE_SEPOLIA, XC.BASE_WETH, XC.ARC_USDC);
    a.eurcRoute = a.settler.routeKey(0, XC.ARC_USDC, XC.ARC_EURC);
  }

  function _route(
    address inToken,
    address outToken,
    bool delivered,
    bool takerSellsBase,
    address feed,
    uint32 ageOpen,
    uint32 ageClosed,
    uint8 flags
  ) internal pure returns (NorenCrossChainSettler.Route memory r) {
    r = NorenCrossChainSettler.Route({
      inToken: inToken,
      outToken: outToken,
      delivered: delivered,
      takerSellsBase: takerSellsBase,
      baseFeed: feed,
      relayed: true,
      quoteFeed: address(0),
      baseMaxAgeOpen: ageOpen,
      baseMaxAgeClosed: ageClosed,
      quoteMaxAge: 0,
      quoteMaxDepegBps: 0,
      flags: flags,
      enabled: true
    });
  }

  /// @dev Source side: escrow with one enabled token and its Chainlink feed, pointing at the Arc settler.
  function _deployEscrow(address owner, address forwarder, address arcSettler, address token, address feed, bool uiMultiplier)
    internal
    returns (NorenCrossChainEscrow e)
  {
    e = new NorenCrossChainEscrow(owner, forwarder);
    e.setSettler(XC.ARC, arcSettler);
    e.setToken(token, feed, uiMultiplier, true);
  }
}
