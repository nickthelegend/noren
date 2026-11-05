// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Nivesh Gajengi
pragma solidity 0.8.28;

import {IERC20, SafeERC20} from '@oz/token/ERC20/utils/SafeERC20.sol';
import {ReentrancyGuard} from '@oz/utils/ReentrancyGuard.sol';
import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IPrivacyPool} from 'interfaces/IPrivacyPool.sol';
import {ProofLib} from 'contracts/lib/ProofLib.sol';

/// @notice Invoice-bound private checkout using a 0xbow PrivacyPoolComplex.
/// @dev Invoice creation and signing live on the merchant server. A proof's context
/// binds the entire withdrawal tuple, including invoice and refund commitment.
contract NorenCheckout is ReentrancyGuard {
  using SafeERC20 for IERC20;

  error InvalidInvoice();
  error InvalidPayout();
  error InvalidAmount();
  error InvalidRefundPrecommitment();
  error InvalidData();
  error UnknownMerchant();
  error WrongProcessooor();
  error AlreadyPaid();
  error Expired();
  error AmountMismatch();
  error NotPaid();
  error NotMerchant();
  error AlreadyRefunded();
  error RefundTooLarge();

  struct Invoice {
    address merchant;
    uint256 amount;
    uint256 refundPrecommitment;
    bool refunded;
  }

  IERC20 public immutable usdc;
  IEntrypoint public immutable entrypoint;
  IPrivacyPool public immutable pool;

  mapping(address merchant => address payout) public merchantPayout;
  mapping(bytes32 invoiceId => bool) public paid;
  mapping(bytes32 invoiceId => Invoice) public invoices;

  event MerchantRegistered(address indexed merchant, address indexed payout);
  event Paid(bytes32 indexed invoiceId, address indexed merchant, uint256 amount, bytes32 receiptCommitment);
  event Refunded(bytes32 indexed invoiceId, address indexed merchant, uint256 amount, uint256 refundPrecommitment);

  constructor(IEntrypoint entrypoint_, IPrivacyPool pool_, IERC20 usdc_) {
    entrypoint = entrypoint_;
    pool = pool_;
    usdc = usdc_;
  }

  function registerMerchant(address payout) external {
    if (payout == address(0)) revert InvalidPayout();
    merchantPayout[msg.sender] = payout;
    emit MerchantRegistered(msg.sender, payout);
  }

  /// @notice Called by the merchant's server with the customer's proof. The customer needs no gas or public wallet.
  function pay(IPrivacyPool.Withdrawal calldata w, ProofLib.WithdrawProof calldata proof) external nonReentrant {
    if (w.processooor != address(this)) revert WrongProcessooor();
    if (w.data.length != 192) revert InvalidData();
    (bytes32 invoiceId, address merchant, uint256 amount, uint256 expiry, uint256 refundPrecommitment, bytes32 receiptCommitment) =
      abi.decode(w.data, (bytes32, address, uint256, uint256, uint256, bytes32));
    if (invoiceId == bytes32(0)) revert InvalidInvoice();
    if (paid[invoiceId]) revert AlreadyPaid();
    if (block.timestamp > expiry) revert Expired();
    address payout = merchantPayout[merchant];
    if (payout == address(0)) revert UnknownMerchant();
    // Only the merchant relays its own invoices. Otherwise anyone could pay a merchant's
    // invoice id first with a different amount and block the real customer (AlreadyPaid).
    if (msg.sender != merchant) revert NotMerchant();
    if (amount == 0) revert InvalidAmount();
    if (refundPrecommitment == 0) revert InvalidRefundPrecommitment();
    // Surplus withdrawals are rejected, so no customer funds are trapped here.
    if (proof.pubSignals[2] != amount) revert AmountMismatch();

    // Set state before external calls; a revert rolls it all back.
    paid[invoiceId] = true;
    invoices[invoiceId] = Invoice(merchant, amount, refundPrecommitment, false);
    pool.withdraw(w, proof);
    usdc.safeTransfer(payout, amount);
    emit Paid(invoiceId, merchant, amount, receiptCommitment);
  }

  /// @notice One refund per paid invoice, for any amount up to its original payment.
  function refund(bytes32 invoiceId, uint256 amount) external nonReentrant {
    if (!paid[invoiceId]) revert NotPaid();
    Invoice storage invoice = invoices[invoiceId];
    if (msg.sender != invoice.merchant) revert NotMerchant();
    if (invoice.refunded) revert AlreadyRefunded();
    if (amount == 0) revert InvalidAmount();
    if (amount > invoice.amount) revert RefundTooLarge();
    invoice.refunded = true;
    usdc.safeTransferFrom(msg.sender, address(this), amount);
    usdc.forceApprove(address(entrypoint), amount);
    entrypoint.deposit(usdc, amount, invoice.refundPrecommitment);
    emit Refunded(invoiceId, msg.sender, amount, invoice.refundPrecommitment);
  }
}
