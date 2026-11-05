import { describe, it, expect } from 'vitest';
import { decodeInvoiceData, encodeInvoiceData, invoiceMatches, parseInvoice } from './index.ts';
const invoice = { invoiceId: `0x${'11'.repeat(32)}` as const, merchant: `0x${'22'.repeat(20)}` as const, amount: 7_500_000n, expiry: 1_900_000_000n, refundPrecommitment: 123n, receiptCommitment: `0x${'33'.repeat(32)}` as const };
describe('invoice encoding', () => {
  it('matches the six Solidity ABI words', () => { const data = encodeInvoiceData(invoice); expect((data.length - 2) / 64).toBe(6); expect(decodeInvoiceData(data)).toEqual(invoice); });
  it('rejects changes in every bound field', () => {
    const data = encodeInvoiceData(invoice);
    for (const changed of [{ invoiceId: `0x${'44'.repeat(32)}` }, { merchant: `0x${'55'.repeat(20)}` }, { amount: 7_500_001n }, { expiry: 1_900_000_001n }, { refundPrecommitment: 124n }, { receiptCommitment: `0x${'66'.repeat(32)}` }]) expect(invoiceMatches({ ...invoice, ...changed } as any, data)).toBe(false);
  });
  it('parses JSON decimal values and rejects zero amount', () => { expect(parseInvoice({ ...invoice, amount: '7500000', expiry: '1900000000', refundPrecommitment: '123' })).toEqual(invoice); expect(() => parseInvoice({ ...invoice, amount: '0' })).toThrow(); });
});
