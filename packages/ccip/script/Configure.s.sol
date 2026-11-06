// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";

import {NorenCcipBase} from "../src/NorenCcipBase.sol";
import {NorenCcipGateway} from "../src/NorenCcipGateway.sol";
import {NorenCcipHub} from "../src/NorenCcipHub.sol";
import {NorenCcipInbox} from "../src/NorenCcipInbox.sol";

/// @notice Wires peers, routes and gas limits on one chain after every chain is deployed.
///         ROLE = arc | hub | base-gateway | sepolia-gateway | robinhood | robinhood-to-sepolia | sepolia-from-robinhood. Addresses come from env (see docs/CCIP.md).
///         Key from NOREN_DEPLOYER_KEY.
contract Configure is Script {
  uint64 internal constant RH = 2032988798112970440;
  uint64 internal constant BASE = 10344971235874465080;
  uint64 internal constant ARC = 3034092155422581607;
  uint64 internal constant SEP = 16015286601757825753;

  uint32 internal constant HUB_GAS = 400_000; // hub ccipReceive incl. its own ccipSend (fork-measured < 400k)
  uint32 internal constant ARC_GAS = 500_000; // Arc gateway + action router (fork-measured < 500k)
  uint32 internal constant GATEWAY_GAS = 400_000; // Robinhood / Base gateway + inbox
  // Ethereum Sepolia reprices new storage slots: a 1-token delivery used ~1.31M gas there (manual execution, Nov 6).
  uint32 internal constant SEPOLIA_GAS = 1_500_000;

  function run() external {
    uint256 pk = vm.envUint("NOREN_DEPLOYER_KEY");
    bytes32 role = keccak256(bytes(vm.envString("ROLE")));
    address arcGw = vm.envAddress("ARC_GATEWAY");
    address hub = vm.envAddress("BASE_HUB");
    address baseGw = vm.envOr("BASE_GATEWAY", address(0));
    address sepGw = vm.envOr("SEPOLIA_GATEWAY", address(0));
    address rhGw = vm.envOr("RH_GATEWAY", address(0));

    vm.startBroadcast(pk);
    if (role == keccak256("arc")) {
      NorenCcipGateway g = NorenCcipGateway(payable(arcGw));
      g.setPeer(BASE, hub, NorenCcipBase.Peer.HUB);
      g.setAllowedOrigin(RH, true);
      if (rhGw != address(0)) g.setRoute(RH, NorenCcipGateway.Route(BASE, hub, rhGw, HUB_GAS, 0));
      if (baseGw != address(0)) {
        g.setPeer(BASE, baseGw, NorenCcipBase.Peer.GATEWAY);
        g.setRoute(BASE, NorenCcipGateway.Route(BASE, baseGw, baseGw, GATEWAY_GAS, 0));
      }
      if (sepGw != address(0)) {
        g.setPeer(SEP, sepGw, NorenCcipBase.Peer.GATEWAY);
        g.setRoute(SEP, NorenCcipGateway.Route(SEP, sepGw, sepGw, SEPOLIA_GAS, 0));
      }
    } else if (role == keccak256("hub")) {
      NorenCcipHub h = NorenCcipHub(payable(hub));
      h.setPeer(ARC, arcGw, NorenCcipBase.Peer.GATEWAY);
      h.setHubRoute(ARC, NorenCcipHub.HubRoute(arcGw, ARC_GAS, 0));
      if (rhGw != address(0)) {
        h.setPeer(RH, rhGw, NorenCcipBase.Peer.GATEWAY);
        h.setHubRoute(RH, NorenCcipHub.HubRoute(rhGw, GATEWAY_GAS, 0));
      }
      uint256 fund = vm.envOr("HUB_FUND_WEI", uint256(0));
      if (fund != 0) {
        (bool ok,) = payable(hub).call{value: fund}("");
        require(ok, "fund hub");
      }
    } else if (role == keccak256("base-gateway")) {
      NorenCcipGateway g = NorenCcipGateway(payable(baseGw));
      g.setRoute(ARC, NorenCcipGateway.Route(ARC, arcGw, arcGw, ARC_GAS, 0));
      g.setPeer(ARC, arcGw, NorenCcipBase.Peer.GATEWAY);
    } else if (role == keccak256("sepolia-gateway")) {
      NorenCcipGateway g = NorenCcipGateway(payable(sepGw));
      g.setRoute(ARC, NorenCcipGateway.Route(ARC, arcGw, arcGw, ARC_GAS, 0));
      g.setPeer(ARC, arcGw, NorenCcipBase.Peer.GATEWAY);
    } else if (role == keccak256("robinhood")) {
      NorenCcipGateway g = NorenCcipGateway(payable(rhGw));
      g.setRoute(ARC, NorenCcipGateway.Route(BASE, hub, arcGw, HUB_GAS, 0));
      g.setPeer(BASE, hub, NorenCcipBase.Peer.HUB);
      g.setAllowedOrigin(ARC, true);
      NorenCcipInbox(vm.envAddress("RH_INBOX")).setReporter(ARC, vm.envAddress("ARC_ACTION_ROUTER"), true);
    } else if (role == keccak256("robinhood-to-sepolia")) {
      // Direct Robinhood -> Ethereum Sepolia lane (lists CCIP-BnM): programmable token transfers.
      NorenCcipGateway(payable(rhGw)).setRoute(SEP, NorenCcipGateway.Route(SEP, sepGw, sepGw, SEPOLIA_GAS, 0));
    } else if (role == keccak256("arc-to-sepolia")) {
      NorenCcipGateway(payable(arcGw)).setRoute(SEP, NorenCcipGateway.Route(SEP, sepGw, sepGw, SEPOLIA_GAS, 0));
    } else if (role == keccak256("sepolia-from-robinhood")) {
      NorenCcipGateway(payable(sepGw)).setPeer(RH, rhGw, NorenCcipBase.Peer.GATEWAY);
    } else {
      revert("ROLE must be arc | hub | base-gateway | sepolia-gateway | robinhood | robinhood-to-sepolia | sepolia-from-robinhood");
    }
    vm.stopBroadcast();
  }
}
