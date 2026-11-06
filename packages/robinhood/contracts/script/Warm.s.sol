// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from 'forge-std/Script.sol';
import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {Math} from '@oz/utils/math/Math.sol';
import {NorenAssetOracle} from '../src/NorenAssetOracle.sol';
import {NorenVault} from '../src/NorenVault.sol';
import {NorenGateway} from '../src/NorenGateway.sol';
import {NorenCredit} from '../src/NorenCredit.sol';
import {RobinhoodMainnet as RH} from './RobinhoodMainnet.sol';

interface IPermit {
  function nonces(address) external view returns (uint256);
  function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/// @notice Simulation only (never run with --broadcast). Walks every demo flow from the demo
/// accounts so the fork caches each storage slot those flows touch. Robinhood's public RPC keeps
/// state for only ~10 minutes of blocks, so scripts/fork-snapshot.sh warms the fork with this,
/// dumps it, and serves the snapshot without an upstream.
contract Warm is Script {
  // Anvil published dev keys (#1 customer, #9 underwriter): fork use only.
  uint256 internal constant CUSTOMER_KEY = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
  uint256 internal constant UNDERWRITER_KEY = 0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6;
  bytes32 internal constant PERMIT_TYPEHASH =
    keccak256('Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)');

  NorenAssetOracle oracle;
  NorenVault vault;
  NorenGateway gateway;
  NorenCredit credit;
  address customer;
  address merchant;
  address forwarder;
  address owner;

  function run() external {
    oracle = NorenAssetOracle(vm.envAddress('NOREN_RH_ORACLE'));
    vault = NorenVault(vm.envAddress('NOREN_RH_VAULT'));
    gateway = NorenGateway(payable(vm.envAddress('NOREN_RH_GATEWAY')));
    credit = NorenCredit(payable(vm.envAddress('NOREN_RH_CREDIT')));
    customer = vm.addr(CUSTOMER_KEY);
    merchant = vm.envAddress('NOREN_RH_MERCHANT');
    forwarder = credit.forwarder();
    owner = credit.owner();

    address[10] memory all = [RH.USDG, RH.WETH, RH.TSLA, RH.AAPL, RH.NVDA, RH.SPY, RH.AMZN, RH.MSFT, RH.GOOGL, RH.META];
    address[4] memory spenders = [address(gateway), address(credit), address(vault), merchant];
    address[4] memory people = [customer, merchant, owner, forwarder];
    for (uint256 i; i < all.length; ++i) {
      oracle.price(all[i]);
      for (uint256 p; p < people.length; ++p) {
        IERC20(all[i]).balanceOf(people[p]);
        oracle.checkTransferable(all[i], people[p], address(vault));
        oracle.checkTransferable(all[i], people[p], address(credit));
        for (uint256 s; s < spenders.length; ++s) IERC20(all[i]).allowance(people[p], spenders[s]);
      }
      IERC20(all[i]).balanceOf(address(vault));
      IERC20(all[i]).balanceOf(address(credit));
      IERC20(all[i]).balanceOf(address(gateway));
      if (i != 1) IPermit(all[i]).nonces(customer);
    }

    // Underwriting
    NorenCredit.Attestation memory a = NorenCredit.Attestation(
      customer, 3, 2_500e6, 13_000, credit.attestationNonce(customer), uint64(block.timestamp + 30 days)
    );
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(UNDERWRITER_KEY, credit.hashAttestation(a));
    credit.applyAttestation(a, abi.encodePacked(r, s, v));

    // Payments: USDG (approve and permit), Stock Tokens (approve and permit), ETH
    _pay('warm-usdg', RH.USDG, false);
    _pay('warm-usdg-permit', RH.USDG, true);
    _pay('warm-nvda', RH.NVDA, false);
    _pay('warm-tsla-permit', RH.TSLA, true);
    _pay('warm-aapl', RH.AAPL, false);
    vm.prank(merchant);
    gateway.createInvoice(keccak256('warm-eth'), 25e6, uint64(block.timestamp + 1 days));
    (uint256 q,,) = gateway.quote(merchant, keccak256('warm-eth'), address(0));
    vm.prank(customer);
    gateway.pay{value: q}(keccak256('warm-eth'), merchant, address(0), q);

    // Pay in 4 with NVDA and with ETH, repay, liquidation views
    uint256 planId = _plan('warm-plan-nvda', RH.NVDA);
    vm.startPrank(customer);
    IERC20(RH.USDG).approve(address(credit), type(uint256).max);
    credit.repay(planId, 1);
    vm.stopPrank();
    credit.planLiquidatable(planId);
    _planEth('warm-plan-eth');

    // Arc credit line with TSLA: open, report, close, settle
    (uint256 col,) = oracle.assetForUsd8(RH.TSLA, 300e8, 0);
    vm.startPrank(customer);
    IERC20(RH.TSLA).approve(address(credit), col);
    bytes32 lineId = credit.openCreditLine(RH.TSLA, col, 200e6, uint64(block.timestamp + 30 days));
    vm.stopPrank();
    vm.prank(forwarder);
    credit.onReport('', abi.encode(lineId, uint256(50e6), uint256(0), uint64(block.timestamp)));
    credit.lineLiquidatable(lineId);
    vm.prank(customer);
    credit.closeCreditLine(lineId);
    vm.warp(vm.getBlockTimestamp() + 1);
    vm.prank(forwarder);
    credit.onReport('', abi.encode(lineId, uint256(50e6), uint256(50e6), uint64(vm.getBlockTimestamp())));

    // Vault: LP deposit/redeem by the customer, inventory purchase
    vm.startPrank(customer);
    IERC20(RH.USDG).approve(address(vault), type(uint256).max);
    vault.deposit(100e6, customer);
    vault.redeem(vault.balanceOf(customer), customer, customer);
    vault.buyInventory(RH.NVDA, 1e15, type(uint256).max);
    vm.stopPrank();
    vault.totalAssets();
    credit.creditTerms(customer);
    credit.history(customer);
    console2.log('warmed demo flows for', customer);
  }

  function _pay(string memory tag, address asset, bool permit) internal {
    bytes32 id = keccak256(bytes(tag));
    vm.prank(merchant);
    gateway.createInvoice(id, 25e6, uint64(block.timestamp + 1 days));
    (uint256 q,,) = gateway.quote(merchant, id, asset);
    if (permit) {
      uint256 deadline = block.timestamp + 1 hours;
      bytes32 digest = keccak256(
        abi.encodePacked(
          '\x19\x01',
          IPermit(asset).DOMAIN_SEPARATOR(),
          keccak256(abi.encode(PERMIT_TYPEHASH, customer, address(gateway), q, IPermit(asset).nonces(customer), deadline))
        )
      );
      (uint8 v, bytes32 r, bytes32 s) = vm.sign(CUSTOMER_KEY, digest);
      vm.prank(customer);
      gateway.payWithPermit(id, merchant, asset, q, deadline, v, r, s);
    } else {
      vm.startPrank(customer);
      IERC20(asset).approve(address(gateway), q);
      gateway.pay(id, merchant, asset, q);
      vm.stopPrank();
    }
  }

  function _plan(string memory tag, address asset) internal returns (uint256 planId) {
    bytes32 id = keccak256(bytes(tag));
    vm.prank(merchant);
    gateway.createInvoice(id, 100e6, uint64(block.timestamp + 1 days));
    (uint256 col,) = oracle.assetForUsd8(asset, oracle.usdgToUsd8(100e6, Math.Rounding.Ceil) * 15_000 / 10_000, 0);
    vm.startPrank(customer);
    IERC20(asset).approve(address(credit), col);
    planId = credit.openPlan(id, merchant, asset, col);
    vm.stopPrank();
  }

  function _planEth(string memory tag) internal {
    bytes32 id = keccak256(bytes(tag));
    vm.prank(merchant);
    gateway.createInvoice(id, 50e6, uint64(block.timestamp + 1 days));
    (uint256 col,) = oracle.assetForUsd8(RH.WETH, oracle.usdgToUsd8(50e6, Math.Rounding.Ceil) * 15_000 / 10_000, 0);
    vm.prank(customer);
    credit.openPlan{value: col}(id, merchant, address(0), col);
  }
}
