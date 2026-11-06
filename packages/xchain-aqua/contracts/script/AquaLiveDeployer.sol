// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from 'forge-std/Script.sol';
import {NorenCrossChainSettler} from '../src/NorenCrossChainSettler.sol';
import {NorenRateOracleFeed, INorenRateOracle} from '../src/NorenRateOracleFeed.sol';
import {IAqua, ISwapVMRouter} from '../src/interfaces/IExternal.sol';

/// @notice The Arc Testnet Aqua stack, built from packages/xchain-aqua/live/config.json, the same
/// file the live deployment (scripts/live/aqua-live.ts) reads. Used by the fork tests to deploy a
/// fresh copy, or to load the live addresses from live/arc-testnet.json.
///   - 1inch Aqua v1.0.0, unmodified (packages/aqua/aqua-official build artifact), CREATE2
///   - NorenAquaSwapVMRouter (SwapVM v1.0.2 + NorenOraclePeg, packages/aqua/swapvm-ext), CREATE2
///   - NorenRateOracleFeed x2: EUR/USD and USDC/USD legs of the live NorenRateOracle EUR rate
///   - NorenCrossChainSettler with one delivered route, USDC -> EURC, and the live Arc action router
///     as a transport
/// MIT: SwapVM and Aqua are deployed from their build artifacts and called through ABIs only.
abstract contract AquaLiveDeployer is Script {
  string internal constant CONFIG = '../live/config.json';
  string internal constant LIVE = '../live/arc-testnet.json';
  string internal constant AQUA_ARTIFACT = '../../aqua/aqua-official/build/out/AquaRouter.sol/AquaRouter.json';
  string internal constant ROUTER_ARTIFACT = '../../aqua/swapvm-ext/out/NorenAquaSwapVMRouter.sol/NorenAquaSwapVMRouter.json';

  struct LiveStack {
    address aqua;
    address router;
    NorenRateOracleFeed eurUsd;
    NorenRateOracleFeed usdcUsd;
    NorenCrossChainSettler settler;
    bytes32 routeKey;
  }

  struct LiveConfig {
    address owner;
    address usdc;
    address eurc;
    address rateOracle;
    address actionRouter;
    address arcHook;
    address creForwarder;
    address create2Deployer;
    bytes32 aquaSalt;
    bytes32 routerSalt;
  }

  function _config() internal view returns (LiveConfig memory c) {
    string memory j = vm.readFile(CONFIG);
    c.owner = vm.parseJsonAddress(j, '.owner');
    c.usdc = vm.parseJsonAddress(j, '.usdc');
    c.eurc = vm.parseJsonAddress(j, '.eurc');
    c.rateOracle = vm.parseJsonAddress(j, '.rateOracle');
    c.actionRouter = vm.parseJsonAddress(j, '.actionRouter');
    c.arcHook = vm.parseJsonAddress(j, '.arcHook');
    c.creForwarder = vm.parseJsonAddress(j, '.creForwarder');
    c.create2Deployer = vm.parseJsonAddress(j, '.create2Deployer');
    c.aquaSalt = keccak256(bytes(vm.parseJsonString(j, '.aquaSalt')));
    c.routerSalt = keccak256(bytes(vm.parseJsonString(j, '.routerSalt')));
  }

  function _route(LiveStack memory s) internal view returns (NorenCrossChainSettler.Route memory r) {
    string memory j = vm.readFile(CONFIG);
    LiveConfig memory c = _config();
    r = NorenCrossChainSettler.Route({
      inToken: c.usdc,
      outToken: c.eurc,
      delivered: true,
      takerSellsBase: false, // base = EURC: the maker sells EURC at EUR/USD x (1 + ask)
      baseFeed: address(s.eurUsd),
      relayed: false,
      quoteFeed: address(s.usdcUsd),
      baseMaxAgeOpen: uint32(vm.parseJsonUint(j, '.route.baseMaxAgeOpen')),
      baseMaxAgeClosed: uint32(vm.parseJsonUint(j, '.route.baseMaxAgeClosed')),
      quoteMaxAge: uint32(vm.parseJsonUint(j, '.route.quoteMaxAge')),
      quoteMaxDepegBps: uint16(vm.parseJsonUint(j, '.route.quoteMaxDepegBps')),
      flags: uint8(vm.parseJsonUint(j, '.route.flags')),
      enabled: true
    });
  }

  function _terms() internal view returns (NorenCrossChainSettler.PegTerms memory t) {
    string memory j = vm.readFile(CONFIG);
    t = NorenCrossChainSettler.PegTerms({
      bidSpreadBps: 0,
      askSpreadBps: uint16(vm.parseJsonUint(j, '.terms.askSpreadBps')),
      closedExtraBps: uint16(vm.parseJsonUint(j, '.terms.closedExtraBps')),
      minPriceUsd8: uint64(vm.parseJsonUint(j, '.terms.minPriceUsd8')),
      maxPriceUsd8: uint64(vm.parseJsonUint(j, '.terms.maxPriceUsd8')),
      salt: uint64(vm.parseJsonUint(j, '.terms.salt'))
    });
  }

  function _create2(address deployer, bytes32 salt, bytes memory initcode) internal returns (address a) {
    a = vm.computeCreate2Address(salt, keccak256(initcode), deployer);
    if (a.code.length == 0) {
      (bool ok,) = deployer.call(abi.encodePacked(salt, initcode));
      require(ok && a.code.length != 0, 'CREATE2 deploy failed');
    }
  }

  /// @dev A fresh stack owned by `owner` (the caller must be `owner` for the setup calls).
  function _deployLiveStack(address owner) internal returns (LiveStack memory s) {
    LiveConfig memory c = _config();
    // AquaRouter's only constructor argument is the Rescuable owner (it may only rescue tokens stuck in
    // the registry contract itself; it has no power over makers' balances or strategies).
    s.aqua = _create2(c.create2Deployer, c.aquaSalt, abi.encodePacked(vm.getCode(AQUA_ARTIFACT), abi.encode(owner)));
    string memory j = vm.readFile(CONFIG);
    bytes memory routerInit = abi.encodePacked(
      vm.getCode(ROUTER_ARTIFACT),
      abi.encode(s.aqua, address(0), owner, vm.parseJsonString(j, '.routerName'), vm.parseJsonString(j, '.routerVersion'))
    );
    s.router = _create2(c.create2Deployer, c.routerSalt, routerInit);
    s.eurUsd = new NorenRateOracleFeed(INorenRateOracle(c.rateOracle), 'EUR', NorenRateOracleFeed.Leg.FIAT_USD);
    s.usdcUsd = new NorenRateOracleFeed(INorenRateOracle(c.rateOracle), 'EUR', NorenRateOracleFeed.Leg.USDC_USD);
    s.settler = new NorenCrossChainSettler(owner, c.creForwarder, IAqua(s.aqua), ISwapVMRouter(s.router));
    s.settler.setRoute(0, c.usdc, _route(s));
    s.settler.setTransport(c.actionRouter, true);
    s.routeKey = s.settler.routeKey(0, c.usdc, c.eurc);
  }

  /// @dev The stack deployed on Arc Testnet by scripts/live/aqua-live.ts (live/arc-testnet.json).
  function _loadLiveStack() internal view returns (LiveStack memory s) {
    string memory j = vm.readFile(LIVE);
    s.aqua = vm.parseJsonAddress(j, '.contracts.aqua.address');
    s.router = vm.parseJsonAddress(j, '.contracts.swapVmRouter.address');
    s.eurUsd = NorenRateOracleFeed(vm.parseJsonAddress(j, '.contracts.eurUsdFeed.address'));
    s.usdcUsd = NorenRateOracleFeed(vm.parseJsonAddress(j, '.contracts.usdcUsdFeed.address'));
    s.settler = NorenCrossChainSettler(vm.parseJsonAddress(j, '.contracts.settler.address'));
    LiveConfig memory c = _config();
    s.routeKey = s.settler.routeKey(0, c.usdc, c.eurc);
  }
}
