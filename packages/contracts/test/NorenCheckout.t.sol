// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IPrivacyPool} from 'interfaces/IPrivacyPool.sol';
import {ProofLib} from 'contracts/lib/ProofLib.sol';
import {NorenCheckout} from '../src/NorenCheckout.sol';
import {Fixture} from './fixtures/Fixture.sol';

interface Vm {
  function prank(address) external;
  function expectRevert(bytes4) external;
  function warp(uint256) external;
}

/// @notice Fork tests use SDK-generated real Groth16 proof against real pool/verifier.
contract NorenCheckoutTest {
  Vm private constant vm = Vm(address(uint160(uint256(keccak256('hevm cheat code')))));
  NorenCheckout private checkout;
  IERC20 private usdc;

  function setUp() public {
    checkout = NorenCheckout(Fixture.checkout());
    usdc = IERC20(Fixture.usdc());
  }

  function testSuccessfulPay() public {
    uint256 beforeBalance = usdc.balanceOf(Fixture.merchant());
    vm.prank(Fixture.merchant());
    checkout.pay(Fixture.withdrawal(), Fixture.proof());
    require(checkout.paid(Fixture.invoiceId()), 'not marked paid');
    require(usdc.balanceOf(Fixture.merchant()) == beforeBalance + Fixture.amount(), 'wrong payout');
  }

  function testReplayAlreadyPaid() public {
    vm.prank(Fixture.merchant());
    checkout.pay(Fixture.withdrawal(), Fixture.proof());
    vm.expectRevert(NorenCheckout.AlreadyPaid.selector);
    vm.prank(Fixture.merchant());
    checkout.pay(Fixture.withdrawal(), Fixture.proof());
  }

  function testTamperedPayeeRejectedByPoolContext() public {
    IPrivacyPool.Withdrawal memory w = Fixture.withdrawal();
    w.data = abi.encode(
      Fixture.invoiceId(), Fixture.merchant2(), Fixture.amount(), Fixture.expiry(),
      Fixture.refundPrecommitment(), Fixture.receiptCommitment()
    );
    vm.expectRevert(IPrivacyPool.ContextMismatch.selector);
    vm.prank(Fixture.merchant2());
    checkout.pay(w, Fixture.proof());
  }

  function testExpiredInvoice() public {
    vm.warp(Fixture.expiry() + 1);
    vm.expectRevert(NorenCheckout.Expired.selector);
    vm.prank(Fixture.merchant());
    checkout.pay(Fixture.withdrawal(), Fixture.proof());
  }

  function testRefundDepositUsesCustomerPrecommitment() public {
    vm.prank(Fixture.merchant());
    checkout.pay(Fixture.withdrawal(), Fixture.proof());
    uint256 beforeBalance = usdc.balanceOf(Fixture.pool());
    vm.prank(Fixture.merchant());
    usdc.approve(address(checkout), Fixture.amount() / 2);
    vm.prank(Fixture.merchant());
    checkout.refund(Fixture.invoiceId(), Fixture.amount() / 2);
    require(usdc.balanceOf(Fixture.pool()) == beforeBalance + Fixture.amount() / 2, 'refund not deposited');
    require(IEntrypoint(Fixture.entrypoint()).usedPrecommitments(Fixture.refundPrecommitment()), 'wrong precommitment');
  }

  function testRefundTooLarge() public {
    vm.prank(Fixture.merchant());
    checkout.pay(Fixture.withdrawal(), Fixture.proof());
    vm.prank(Fixture.merchant());
    vm.expectRevert(NorenCheckout.RefundTooLarge.selector);
    checkout.refund(Fixture.invoiceId(), Fixture.amount() + 1);
  }

  function testSecondRefundRejected() public {
    vm.prank(Fixture.merchant());
    checkout.pay(Fixture.withdrawal(), Fixture.proof());
    vm.prank(Fixture.merchant());
    usdc.approve(address(checkout), Fixture.amount());
    vm.prank(Fixture.merchant());
    checkout.refund(Fixture.invoiceId(), Fixture.amount() / 2);
    vm.expectRevert(NorenCheckout.AlreadyRefunded.selector);
    vm.prank(Fixture.merchant());
    checkout.refund(Fixture.invoiceId(), Fixture.amount() / 2);
  }

  function testOnlyMerchantCanSubmitItsInvoice() public {
    vm.expectRevert(NorenCheckout.NotMerchant.selector);
    vm.prank(address(0xBAD));
    checkout.pay(Fixture.withdrawal(), Fixture.proof());
  }

  function testWrongProcessooor() public {
    IPrivacyPool.Withdrawal memory w = Fixture.withdrawal();
    w.processooor = Fixture.merchant();
    vm.expectRevert(NorenCheckout.WrongProcessooor.selector);
    vm.prank(Fixture.merchant());
    checkout.pay(w, Fixture.proof());
  }
}
