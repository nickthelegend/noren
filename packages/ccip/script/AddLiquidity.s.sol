// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {NorenArcActionRouter} from "../src/NorenArcActionRouter.sol";

/// @notice Adds USDC liquidity (backs PAY_ON_CREDIT) to the Arc action router. ARC_ACTION_ROUTER, AMOUNT_USDC6.
contract AddLiquidity is Script {
  function run() external {
    uint256 pk = vm.envUint("NOREN_DEPLOYER_KEY");
    NorenArcActionRouter r = NorenArcActionRouter(payable(vm.envAddress("ARC_ACTION_ROUTER")));
    uint256 amount = vm.envUint("AMOUNT_USDC6");
    vm.startBroadcast(pk);
    r.usdc().approve(address(r), amount);
    r.addLiquidity(amount);
    vm.stopBroadcast();
  }
}
