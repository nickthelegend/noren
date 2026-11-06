// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {NorenCcipGateway} from "../src/NorenCcipGateway.sol";
import {NorenCcipHub} from "../src/NorenCcipHub.sol";
import {NorenArcActionRouter, INorenCcipSender} from "../src/NorenArcActionRouter.sol";
import {NorenCcipInbox} from "../src/NorenCcipInbox.sol";
import {INorenActionSink} from "../src/interfaces/INorenActionSink.sol";
import {NorenArcAction} from "../src/libraries/NorenArcAction.sol";

/// @notice Deploys Noren's CCIP contracts on one public testnet. Peers and routes are wired by Configure.s.sol
///         once the other chains are deployed. The key comes from NOREN_DEPLOYER_KEY (never on the command line).
///         ROLE = arc | hub | gateway | gateway-inbox
contract Deploy is Script {
  address internal constant ARC_USDC = 0x3600000000000000000000000000000000000000;
  uint64 internal constant RH = 2032988798112970440;
  uint64 internal constant BASE = 10344971235874465080;
  uint64 internal constant SEP = 16015286601757825753;

  function run() external {
    uint256 pk = vm.envUint("NOREN_DEPLOYER_KEY");
    address deployer = vm.addr(pk);
    string memory role = vm.envString("ROLE");
    address router = vm.envAddress("CCIP_ROUTER");
    uint64 selector = uint64(vm.envUint("CCIP_SELECTOR"));
    bytes32 r = keccak256(bytes(role));

    vm.startBroadcast(pk);
    if (r == keccak256("arc")) {
      NorenCcipGateway gw = new NorenCcipGateway(router, selector, deployer);
      NorenArcActionRouter actions = new NorenArcActionRouter(IERC20(ARC_USDC), deployer);
      gw.setApp(INorenActionSink(address(actions)));
      actions.setRail(address(gw), NorenArcAction.RAIL_CCIP);
      actions.setCcipGateway(INorenCcipSender(address(gw)));
      // Demo credit authority: the deployer plays NorenCredit's operator on each source chain (documented).
      actions.setCreditAuthority(NorenArcAction.RAIL_CCIP, RH, deployer, true);
      actions.setCreditAuthority(NorenArcAction.RAIL_CCIP, BASE, deployer, true);
      actions.setCreditAuthority(NorenArcAction.RAIL_CCIP, SEP, deployer, true);
      uint256 liq = vm.envOr("ARC_LIQUIDITY_USDC6", uint256(0));
      if (liq != 0) {
        IERC20(ARC_USDC).approve(address(actions), liq);
        actions.addLiquidity(liq);
      }
      console2.log("NorenCcipGateway", address(gw));
      console2.log("NorenArcActionRouter", address(actions));
    } else if (r == keccak256("hub")) {
      NorenCcipHub hub = new NorenCcipHub(router, selector, deployer);
      console2.log("NorenCcipHub", address(hub));
    } else if (r == keccak256("gateway")) {
      NorenCcipGateway gw = new NorenCcipGateway(router, selector, deployer);
      console2.log("NorenCcipGateway", address(gw));
    } else if (r == keccak256("gateway-inbox")) {
      NorenCcipGateway gw = new NorenCcipGateway(router, selector, deployer);
      NorenCcipInbox inbox = new NorenCcipInbox(address(gw), deployer);
      gw.setApp(INorenActionSink(address(inbox)));
      console2.log("NorenCcipGateway", address(gw));
      console2.log("NorenCcipInbox", address(inbox));
    } else {
      revert("ROLE must be arc | hub | gateway | gateway-inbox");
    }
    vm.stopBroadcast();
  }
}
