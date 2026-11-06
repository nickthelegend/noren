// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {NorenCcipGateway} from "../src/NorenCcipGateway.sol";

/// @notice Sends one Noren CCIP message through a deployed NorenCcipGateway, paying the fee in native gas.
///         GATEWAY, FINAL_CHAIN, PAYLOAD (hex). Optional ROUTE_NEXT_CHAIN/ROUTE_NEXT/ROUTE_FINAL/ROUTE_GAS set the
///         route first (owner only). Key from NOREN_DEPLOYER_KEY.
contract Send is Script {
  function run() external {
    uint256 pk = vm.envUint("NOREN_DEPLOYER_KEY");
    NorenCcipGateway gw = NorenCcipGateway(payable(vm.envAddress("GATEWAY")));
    uint64 finalChain = uint64(vm.envUint("FINAL_CHAIN"));
    bytes memory payload = vm.envBytes("PAYLOAD");

    vm.startBroadcast(pk);
    address next = vm.envOr("ROUTE_NEXT", address(0));
    if (next != address(0)) {
      gw.setRoute(
        finalChain,
        NorenCcipGateway.Route({
          nextChain: uint64(vm.envUint("ROUTE_NEXT_CHAIN")),
          nextReceiver: next,
          finalReceiver: vm.envAddress("ROUTE_FINAL"),
          gasLimit: uint32(vm.envUint("ROUTE_GAS")),
          finalityDepth: uint16(vm.envOr("ROUTE_FINALITY_DEPTH", uint256(0)))
        })
      );
    }
    uint256 fee = gw.quote(finalChain, payload, address(0), 0, address(0));
    console2.log("fee (native wei)", fee);
    bytes32 id = gw.send{value: fee + fee / 10}(finalChain, payload, address(0), 0, address(0));
    console2.log("messageId");
    console2.logBytes32(id);
    vm.stopBroadcast();
  }
}
