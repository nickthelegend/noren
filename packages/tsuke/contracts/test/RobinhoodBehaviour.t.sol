// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {TsukeBase, IStockAdmin, IRegistryAdmin, IPermitToken} from './TsukeBase.sol';
import {IRobinhoodStockToken} from '../src/interfaces/IRobinhoodStockToken.sol';
import {RobinhoodMainnet as RH} from '../script/RobinhoodMainnet.sol';

/// @notice Observes the real Robinhood Chain token behaviour Tsuke has to handle.
contract RobinhoodBehaviourTest is TsukeBase {
  function test_usdgSupportsEip2612Permit() public {
    _fund(RH.USDG, customer, 50e6);
    uint256 nonce = IPermitToken(RH.USDG).nonces(customer);
    uint256 deadline = block.timestamp + 1 hours;
    (uint8 v, bytes32 r, bytes32 s) = _permitSig(customerKey, RH.USDG, merchant, 25e6, deadline);
    IPermitToken(RH.USDG).permit(customer, merchant, 25e6, deadline, v, r, s);
    assertEq(usdg.allowance(customer, merchant), 25e6, 'permit allowance');
    assertEq(IPermitToken(RH.USDG).nonces(customer), nonce + 1, 'nonce bumped');
  }

  function test_stockTokenSupportsEip2612Permit() public {
    uint256 deadline = block.timestamp + 1 hours;
    (uint8 v, bytes32 r, bytes32 s) = _permitSig(customerKey, RH.TSLA, merchant, 1e18, deadline);
    IPermitToken(RH.TSLA).permit(customer, merchant, 1e18, deadline, v, r, s);
    assertEq(tsla.allowance(customer, merchant), 1e18);
  }

  function test_blockedAccountCannotSendOrReceiveStock() public {
    _fund(RH.NVDA, customer, 2e18);
    _block(customer);
    assertTrue(IRegistryAdmin(RH.STOCK_REGISTRY).isBlocked(customer));
    vm.prank(customer);
    vm.expectRevert();
    nvda.transfer(merchant, 1e18);
    vm.prank(RH.POOL_MANAGER);
    vm.expectRevert();
    nvda.transfer(customer, 1e18);
    _unblock(customer);
    vm.prank(customer);
    nvda.transfer(merchant, 1e18);
    assertEq(nvda.balanceOf(merchant), 1e18);
  }

  function test_pausedStockTokenRejectsTransfers() public {
    _fund(RH.NVDA, customer, 1e18);
    vm.prank(RH.STOCK_PAUSER);
    IStockAdmin(RH.NVDA).pause();
    assertTrue(IRobinhoodStockToken(RH.NVDA).paused());
    vm.prank(customer);
    vm.expectRevert();
    nvda.transfer(merchant, 1e18);
  }

  function test_uiMultiplierScalesUiBalanceNotRawBalance() public {
    _fund(RH.NVDA, customer, 10e18);
    uint256 m = IRobinhoodStockToken(RH.NVDA).uiMultiplier();
    assertGt(m, 1e18, 'NVDA multiplier above 1 after dividends');
    assertEq(IStockAdmin(RH.NVDA).balanceOfUI(customer), 10e18 * m / 1e18, 'UI balance = raw * multiplier');
    _setMultiplier(RH.NVDA, m * 2);
    assertEq(nvda.balanceOf(customer), 10e18, 'raw balance unchanged by a split');
    assertEq(IRobinhoodStockToken(RH.NVDA).uiMultiplier(), m * 2, 'multiplier update is immediate');
  }

  function test_wethWrapsNativeEth() public {
    vm.deal(customer, 1 ether);
    vm.prank(customer);
    weth.deposit{value: 0.4 ether}();
    assertEq(weth.balanceOf(customer), 0.4 ether);
  }
}
