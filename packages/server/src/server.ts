import { createServer as createHttpServer, type Server } from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createPublicClient, createWalletClient, http, decodeErrorResult, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { checkoutAbi, encodeInvoiceData, invoiceMatches, jsonBigints, localFork, parseInvoice, poolAbi, usdcAbi, type Deployment, type Invoice } from '@noren/core';

export type RecordRow = { invoice: Invoice; status: 'open' | 'paid' | 'refunded'; paymentTx?: Hex; refundTx?: Hex; refundAmount?: bigint };
export function validatePayment(row: RecordRow, body: any, checkout: Address, now: bigint) {
  if (row.status !== 'open') throw new Error('AlreadyPaid: invoice is already paid');
  if (now > row.invoice.expiry) throw new Error('Expired: invoice has expired');
  if (!body?.withdrawal || !body?.proof) throw new Error('withdrawal and proof are required');
  if (body.withdrawal.processooor?.toLowerCase() !== checkout.toLowerCase()) throw new Error('WrongProcessooor: wrong checkout contract');
  if (!invoiceMatches(row.invoice, body.withdrawal.data)) throw new Error('ContextMismatch: withdrawal does not match the stored invoice');
  if (!Array.isArray(body.proof.pubSignals) || body.proof.pubSignals.length !== 8 || BigInt(body.proof.pubSignals[2]) !== row.invoice.amount) throw new Error('AmountMismatch: proof amount differs from invoice');
  return { withdrawal: body.withdrawal as { processooor: Address; data: Hex }, proof: {
    pA: body.proof.pA.map(BigInt), pB: body.proof.pB.map((a: any[]) => a.map(BigInt)), pC: body.proof.pC.map(BigInt), pubSignals: body.proof.pubSignals.map(BigInt),
  } };
}
export function readableError(error: any): string {
  const raw = `${error?.shortMessage ?? ''} ${error?.message ?? ''}`;
  for (const name of ['AlreadyPaid', 'Expired', 'NotMerchant', 'ContextMismatch', 'IncorrectASPRoot', 'AmountMismatch', 'AlreadyRefunded', 'RefundTooLarge']) if (raw.includes(name)) return `${name}: ${name === 'IncorrectASPRoot' ? 'ASP root changed; sync and re-prove the payment' : raw.slice(0, 180)}`;
  for (let cause = error, i = 0; cause && i < 8; cause = cause.cause, i++) if (typeof cause.data === 'string') try {
    const decoded = decodeErrorResult({ abi: [...checkoutAbi, ...poolAbi], data: cause.data });
    return `${decoded.errorName}: ${decoded.errorName === 'IncorrectASPRoot' ? 'ASP root changed; sync and re-prove the payment' : 'transaction rejected'}`;
  } catch { /* inspect the next cause */ }
  return raw.includes('Setup required') ? raw : 'Transaction rejected: ' + raw.slice(0, 180);
}
export type ServerOptions = { deployment: Deployment; rpcUrl: string; merchantKey?: Hex; localUnlockedMerchant?: Address; refundToken?: string; dataFile: string; aspTree?: () => bigint[][] };
export function createMerchantServer(options: ServerOptions): Server {
  const rows = new Map<string, RecordRow>();
  const listeners = new Set<any>();
  const chain = localFork(options.rpcUrl);
  const publicClient: any = createPublicClient({ chain, transport: http(options.rpcUrl), cacheTime: 0 });
  if (options.localUnlockedMerchant && !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(options.rpcUrl)) throw new Error('Unlocked merchant is only allowed on local RPC');
  const account = options.merchantKey ? privateKeyToAccount(options.merchantKey) : options.localUnlockedMerchant;
  const merchantAddress = typeof account === 'string' ? account : account?.address;
  const wallet: any = account ? createWalletClient({ chain, account, transport: http(options.rpcUrl) }) : undefined;
  let ready = readFile(options.dataFile, 'utf8').then(s => { for (const row of JSON.parse(s)) { const invoice = parseInvoice(row.invoice); rows.set(invoice.invoiceId.toLowerCase(), { ...row, invoice }); } }).catch((e: any) => { if (e.code !== 'ENOENT') throw e; });
  async function save() { await mkdir(dirname(options.dataFile), { recursive: true }); const tmp = options.dataFile + '.tmp'; await writeFile(tmp, jsonBigints([...rows.values()])); await rename(tmp, options.dataFile); }
  function emit(type: string, row: RecordRow) { const message = `event: ${type}\ndata: ${jsonBigints({ invoiceId: row.invoice.invoiceId, paymentTx: row.paymentTx, refundTx: row.refundTx })}\n\n`; for (const l of listeners) l.write(message); }
  async function body(req: any) { let s = ''; for await (const chunk of req) { s += chunk; if (s.length > 100_000) throw new Error('Request too large'); } return s ? JSON.parse(s) : {}; }
  function send(res: any, status: number, value: unknown) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(jsonBigints(value)); }
  return createHttpServer(async (req, res) => {
    try {
      await ready;
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (req.method === 'GET' && path === '/events') { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }); res.write(': connected\n\n'); listeners.add(res); req.on('close', () => listeners.delete(res)); return; }
      if (req.method === 'GET' && path === '/asp/tree' && options.aspTree) return send(res, 200, options.aspTree());
      const create = /^\/merchants\/(0x[0-9a-fA-F]{40})\/invoices$/.exec(path);
      if (req.method === 'POST' && create) {
        if (!account || !wallet) throw new Error('Setup required: merchant key missing');
        if (create[1].toLowerCase() !== merchantAddress!.toLowerCase()) throw new Error('NotMerchant: this server does not own that merchant');
        const b = await body(req); const amount = BigInt(b.amount), expiry = BigInt(b.expiry);
        const now = (await publicClient.getBlock()).timestamp;
        if (amount <= 0n || expiry <= now || expiry > now + 30n * 24n * 3600n) throw new Error('Invalid amount or expiry');
        const invoice = parseInvoice({ invoiceId: `0x${randomBytes(32).toString('hex')}`, merchant: merchantAddress, amount, expiry, refundPrecommitment: b.refundPrecommitment, receiptCommitment: b.receiptCommitment });
        const payout = await publicClient.readContract({ address: options.deployment.checkout, abi: checkoutAbi, functionName: 'merchantPayout', args: [merchantAddress!] });
        if (payout === '0x0000000000000000000000000000000000000000') throw new Error('Setup required: merchant must register a payout first');
        const row: RecordRow = { invoice, status: 'open' }; rows.set(invoice.invoiceId.toLowerCase(), row); await save(); emit('invoice_created', row);
        return send(res, 201, { invoice, paymentLinkPayload: { invoiceId: invoice.invoiceId, checkout: options.deployment.checkout, data: encodeInvoiceData(invoice) } });
      }
      const match = /^\/invoices\/(0x[0-9a-fA-F]{64})(?:\/(pay|refund))?$/.exec(path);
      if (!match) return send(res, 404, { error: 'Not found' });
      const row = rows.get(match[1].toLowerCase()); if (!row) return send(res, 404, { error: 'Invoice not found' });
      if (req.method === 'GET' && !match[2]) return send(res, 200, { ...row, status: row.status === 'open' && (await publicClient.getBlock()).timestamp > row.invoice.expiry ? 'expired' : row.status });
      if (!account || !wallet) throw new Error('Setup required: merchant key missing');
      if (req.method === 'POST' && match[2] === 'pay') {
        const { withdrawal, proof } = validatePayment(row, await body(req), options.deployment.checkout, (await publicClient.getBlock()).timestamp);
        await publicClient.simulateContract({ account: merchantAddress, address: options.deployment.checkout, abi: [...checkoutAbi, ...poolAbi], functionName: 'pay', args: [withdrawal, proof] });
        const hash = await wallet.writeContract({ address: options.deployment.checkout, abi: checkoutAbi, functionName: 'pay', args: [withdrawal, proof as any] });
        const receipt = await publicClient.waitForTransactionReceipt({ hash }); if (receipt.status !== 'success') throw new Error('Payment transaction reverted');
        row.status = 'paid'; row.paymentTx = hash; await save(); emit('paid', row); return send(res, 200, row);
      }
      if (req.method === 'POST' && match[2] === 'refund') {
        if (!options.refundToken || req.headers.authorization !== `Bearer ${options.refundToken}`) return send(res, 401, { error: 'Merchant bearer token required' });
        if (row.status !== 'paid') throw new Error('Invoice is not paid or has already been refunded');
        const amount = BigInt((await body(req)).amount); if (amount <= 0n || amount > row.invoice.amount) throw new Error('RefundTooLarge: amount must be positive and at most invoice amount');
        const approval = await wallet.writeContract({ address: options.deployment.usdc, abi: usdcAbi, functionName: 'approve', args: [options.deployment.checkout, amount] });
        const approved = await publicClient.waitForTransactionReceipt({ hash: approval }); if (approved.status !== 'success') throw new Error('Approval reverted');
        await publicClient.simulateContract({ account: merchantAddress, address: options.deployment.checkout, abi: checkoutAbi, functionName: 'refund', args: [row.invoice.invoiceId, amount] });
        const hash = await wallet.writeContract({ address: options.deployment.checkout, abi: checkoutAbi, functionName: 'refund', args: [row.invoice.invoiceId, amount] });
        const receipt = await publicClient.waitForTransactionReceipt({ hash }); if (receipt.status !== 'success') throw new Error('Refund reverted');
        row.status = 'refunded'; row.refundTx = hash; row.refundAmount = amount; await save(); emit('refunded', row); return send(res, 200, { ...row, approvalTx: approval });
      }
      return send(res, 405, { error: 'Method not allowed' });
    } catch (error: any) { send(res, /Setup required/.test(error.message) ? 503 : 400, { error: readableError(error) }); }
  });
}
