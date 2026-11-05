import { describe, it, expect } from 'vitest';
import { encodeInvoiceData, type Invoice } from '@noren/core';
import { validatePayment, readableError, type RecordRow } from './server.ts';
const invoice: Invoice = { invoiceId: `0x${'11'.repeat(32)}`, merchant: `0x${'22'.repeat(20)}`, amount: 7_500_000n, expiry: 1000n, refundPrecommitment: 123n, receiptCommitment: `0x${'33'.repeat(32)}` };
const checkout = `0x${'44'.repeat(20)}` as const;
const row: RecordRow = { invoice, status: 'open' };
const body = { withdrawal: { processooor: checkout, data: encodeInvoiceData(invoice) }, proof: { pA: [0, 0], pB: [[0, 0], [0, 0]], pC: [0, 0], pubSignals: [0, 0, '7500000', 0, 0, 0, 0, 0] } };
describe('merchant relay validation', () => {
  it('accepts a matching stored invoice', () => expect(validatePayment(row, body, checkout, 999n).proof.pubSignals[2]).toBe(7_500_000n));
  it('rejects changed invoice bytes', () => expect(() => validatePayment(row, { ...body, withdrawal: { ...body.withdrawal, data: encodeInvoiceData({ ...invoice, merchant: checkout }) } }, checkout, 999n)).toThrow(/ContextMismatch/));
  it('rejects amount, processooor, replay and expiry', () => {
    expect(() => validatePayment(row, { ...body, proof: { ...body.proof, pubSignals: [0, 0, '7500001', 0, 0, 0, 0, 0] } }, checkout, 999n)).toThrow(/AmountMismatch/);
    expect(() => validatePayment(row, { ...body, withdrawal: { ...body.withdrawal, processooor: invoice.merchant } }, checkout, 999n)).toThrow(/WrongProcessooor/);
    expect(() => validatePayment({ ...row, status: 'paid' }, body, checkout, 999n)).toThrow(/AlreadyPaid/);
    expect(() => validatePayment(row, body, checkout, 1001n)).toThrow(/Expired/);
  });
  it('explains stale roots as re-prove guidance', () => expect(readableError(new Error('IncorrectASPRoot'))).toMatch(/re-prove/));
});
