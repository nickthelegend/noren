import { describe, it, expect } from 'vitest';
import { creditDrawProblem, type CreditDraw } from './credit.ts';

const merchant = `0x${'22'.repeat(20)}` as const, payout = `0x${'55'.repeat(20)}` as const;
const row = { invoice: { merchant, amount: 7_500_000n, expiry: 2000n }, status: 'draft' };
const draw: CreditDraw = { lineId: `0x${'aa'.repeat(32)}`, amount: 7_500_000n, invoiceId: `0x${'11'.repeat(32)}`, merchant, txHash: `0x${'bb'.repeat(32)}`, blockNumber: 5n, timestamp: 1500 };

describe('credit draws settle only an exact, open invoice', () => {
  it('accepts a draw to the merchant or its payout', () => {
    expect(creditDrawProblem(row, draw, payout)).toBeNull();
    expect(creditDrawProblem({ ...row, status: 'open' }, { ...draw, merchant: payout }, payout)).toBeNull();
  });
  it('rejects unknown, settled, expired, short and misdirected draws', () => {
    expect(creditDrawProblem(undefined, draw, payout)).toMatch(/UnknownInvoice/);
    expect(creditDrawProblem({ ...row, status: 'paid' }, draw, payout)).toMatch(/AlreadySettled/);
    expect(creditDrawProblem(row, { ...draw, timestamp: 2001 }, payout)).toMatch(/Expired/);
    expect(creditDrawProblem(row, { ...draw, amount: 7_499_999n }, payout)).toMatch(/AmountMismatch/);
    expect(creditDrawProblem(row, { ...draw, merchant: `0x${'66'.repeat(20)}` }, payout)).toMatch(/WrongMerchant/);
  });
});
