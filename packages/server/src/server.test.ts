import { describe, it, expect } from 'vitest';
import { encodeInvoiceData, type Invoice } from '@noren/core';
import { validatePayment, readableError, createMerchantServer, assertLocalFork, type RecordRow } from './server.ts';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeAbiParameters } from 'viem';
const invoice: Invoice = { invoiceId: `0x${'11'.repeat(32)}`, merchant: `0x${'22'.repeat(20)}`, amount: 7_500_000n, expiry: 1000n, refundPrecommitment: 123n, receiptCommitment: `0x${'33'.repeat(32)}` };
const checkout = `0x${'44'.repeat(20)}` as const;
const row: RecordRow = { invoice, status: 'open' };
const body = { withdrawal: { processooor: checkout, data: encodeInvoiceData(invoice) }, proof: { pA: [0, 0], pB: [[0, 0], [0, 0]], pC: [0, 0], pubSignals: [0, 0, '7500000', 0, 0, 0, 0, 0] } };
const listen = (server: ReturnType<typeof createServer>, port: number) => new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
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
  it('requires binding before payment', () => expect(() => validatePayment({ invoice: { invoiceId: invoice.invoiceId, merchant: invoice.merchant, amount: invoice.amount, expiry: invoice.expiry }, status: 'draft' }, body, checkout, 999n)).toThrow(/InvoiceUnbound/));
});

describe('local merchant API', () => {
  it('guards dev endpoints and creates, lists, binds and freezes drafts', async () => {
    const merchant = invoice.merchant;
    let sent = 0; let balances = 0;
    const rpc = createServer(async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const { method } = JSON.parse(raw);
      const result = method === 'eth_chainId' ? '0x4cef52' : method === 'anvil_nodeInfo' ? { forkConfig: { forkUrl: 'https://rpc.testnet.arc.io' } } : method === 'eth_getBlockByNumber' ? { number: '0x1', timestamp: '0x3e8' } : method === 'eth_call' ? encodeAbiParameters([{ type: 'address' }], [merchant]) : method === 'anvil_setBalance' ? (balances++, true) : method === 'eth_sendTransaction' ? `0x${(++sent).toString(16).padStart(64, '0')}` : method === 'eth_getTransactionReceipt' ? { transactionHash: `0x${sent.toString(16).padStart(64, '0')}`, status: '0x1', blockNumber: '0x1', logs: [] } : null;
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
    });
    await listen(rpc, 8713);
    const rpcUrl = 'http://127.0.0.1:8713';
    const dir = await mkdtemp(join(tmpdir(), 'noren-server-test-'));
    const server = createMerchantServer({ deployment: { chainId: 5042002, deploymentBlock: '1', usdc: merchant, entrypoint: merchant, pool: merchant, checkout }, rpcUrl, localUnlockedMerchant: merchant, dataFile: join(dir, 'rows.json'), dev: { aspUrl: 'http://127.0.0.1:8788', merchantToken: 'test-token' } });
    await listen(server, 8714);
    const base = 'http://127.0.0.1:8714';
    const call = async (path: string, method = 'GET', data?: unknown, token?: string) => { const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', origin: 'http://localhost:5190', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: data && JSON.stringify(data) }); return { status: r.status, cors: r.headers.get('access-control-allow-origin'), body: await r.json() }; };
    try {
      expect((await call('/config')).body.merchant).toBe(merchant);
      expect((await call('/config')).cors).toBe('http://localhost:5190');
      expect((await call(`/merchants/${merchant}/invoices`, 'POST', { amount: '7500000', expiry: '2000' })).status).toBe(401);
      const created = await call(`/merchants/${merchant}/invoices`, 'POST', { amount: '7500000', expiry: '2000' }, 'test-token');
      expect(created.status).toBe(201);
      expect(created.body.invoice.refundPrecommitment).toBeUndefined();
      expect((await call(`/invoices/${created.body.invoice.invoiceId}/pay`, 'POST', body)).body.error).toMatch(/InvoiceUnbound/);
      const bound = await call(`/invoices/${created.body.invoice.invoiceId}/bind`, 'POST', { refundPrecommitment: '123', receiptCommitment: invoice.receiptCommitment });
      expect(bound.body.invoice.refundPrecommitment).toBe('123');
      expect(bound.body.paymentLinkPayload.data).toMatch(/^0x/);
      expect((await call(`/invoices/${created.body.invoice.invoiceId}/bind`, 'POST', { refundPrecommitment: '124', receiptCommitment: invoice.receiptCommitment })).body.error).toMatch(/InvoiceAlreadyBound/);
      const second = await call(`/merchants/${merchant}/invoices`, 'POST', { amount: '1000000', expiry: '2100' }, 'test-token');
      expect(second.status).toBe(201);
      const currencies = await call('/pricing/currencies');
      expect(currencies.body.find((c: any) => c.code === 'EUR').decimals).toBe(2);
      const publicQuote = await call('/pricing/quote?currency=EUR&amount=690');
      if (publicQuote.status !== 200) throw new Error(`${publicQuote.status === 503 ? 'network required: ' : ''}Arc mainnet Chainlink quote: ${publicQuote.body.error}`);
      expect(BigInt(publicQuote.body.usdcAmount)).toBeGreaterThan(0n);
      const fiat = await call(`/merchants/${merchant}/invoices`, 'POST', { currency: 'EUR', fiatAmount: '690', expiry: '2200' }, 'test-token');
      if (fiat.status !== 201) throw new Error(`${fiat.status === 503 ? 'network required: ' : ''}Arc mainnet Chainlink fiat invoice: ${fiat.body.error}`);
      expect(fiat.body.invoice.amount).toBe(fiat.body.quote.usdcAmount);
      expect(fiat.body.quote.fiatUsd.roundId).toMatch(/^\d+$/);
      expect((await call(`/invoices/${fiat.body.invoice.invoiceId}`)).body.quote.usdcAmount).toBe(fiat.body.invoice.amount);
      const list = await call(`/merchants/${merchant}/invoices`);
      expect(list.body).toHaveLength(3);
      expect(list.body[0].quote.currency).toBe('EUR');
      expect(list.body[1].invoice.invoiceId).toBe(second.body.invoice.invoiceId);
      expect(list.body[2].status).toBe('open');
      expect((await call(`/merchants/${merchant}/invoices`, 'POST', { amount: '1', expiry: '2000', refundPrecommitment: '123' }, 'test-token')).status).toBe(400);
      const faucet = await call('/dev/faucet', 'POST', { address: merchant });
      expect(faucet.status).toBe(200);
      expect(faucet.body).toHaveProperty('gasTx'); expect(faucet.body).toHaveProperty('usdcTx');
      expect(balances).toBe(1); expect(sent).toBe(2);
      expect((await call('/dev/faucet', 'POST', { address: merchant })).status).toBe(429);
    } finally {
      await new Promise<void>(r => server.close(() => r())); await new Promise<void>(r => rpc.close(() => r())); await rm(dir, { recursive: true, force: true });
    }
    await expect(assertLocalFork('https://rpc.testnet.arc.io')).rejects.toThrow(/loopback/);
  }, 30_000);
});
