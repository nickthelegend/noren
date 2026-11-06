import { createServer as createHttpServer, type Server } from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';
import { createPublicClient, createWalletClient, http, decodeErrorResult, encodeFunctionData, toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { checkoutAbi, encodeInvoiceData, invoiceMatches, jsonBigints, localFork, parseInvoice, poolAbi, usdcAbi, type Deployment, type Invoice } from '@noren/core';
import { CURRENCIES, DEFAULT_PRICE_RPC, quoteUsdc, type UsdcQuote } from '@noren/core/pricing';
import { creditDrawProblem, gatewayAbi, robinhoodFaucet, watchCreditDraws, watchStockPayments } from './credit.ts';

export type DraftInvoice = Pick<Invoice, 'invoiceId' | 'merchant' | 'amount' | 'expiry'> & Partial<Pick<Invoice, 'refundPrecommitment' | 'receiptCommitment'>>;
export type RecordRow = { invoice: DraftInvoice; status: 'draft' | 'open' | 'paid' | 'refunded'; quote?: UsdcQuote; paymentTx?: Hex; refundTx?: Hex; refundAmount?: bigint; createdAt?: number; boundAt?: number; paidAt?: number; refundedAt?: number; description?: string; paymentGasUsed?: string; refundGasUsed?: string; paymentBlock?: string; method?: 'private' | 'credit' | 'stocks'; creditLineId?: Hex; stock?: { asset: Address; assetIn: string; usdgOut: string; priceUsd8: string; chainId: number } };
type Endpoint = { id: string; merchant: string; url: string; createdAt: number; secret: string };
type Delivery = { endpointId: string; url: string; attempt: number; status: number | null; ok: boolean; ms: number; error?: string; at: number };
type MerchantEvent = { id: string; merchant: string; type: string; created: number; data: { invoiceId: Hex; amount: string; status: string; method: string | null; description: string | null; paymentTx: Hex | null; refundTx: Hex | null; refundAmount: string | null; quote: UsdcQuote | null }; deliveries: Delivery[] };
export function validatePayment(row: RecordRow, body: any, checkout: Address, now: bigint) {
  if (row.status === 'draft') throw new Error('InvoiceUnbound: customer must bind the invoice before paying');
  if (row.status !== 'open') throw new Error('AlreadyPaid: invoice is already paid');
  if (now > row.invoice.expiry) throw new Error('Expired: invoice has expired');
  if (!body?.withdrawal || !body?.proof) throw new Error('withdrawal and proof are required');
  if (body.withdrawal.processooor?.toLowerCase() !== checkout.toLowerCase()) throw new Error('WrongProcessooor: wrong checkout contract');
  if (!invoiceMatches(row.invoice as Invoice, body.withdrawal.data)) throw new Error('ContextMismatch: withdrawal does not match the stored invoice');
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
export type ServerOptions = { deployment: Deployment; rpcUrl: string; priceRpcUrl?: string; merchantKey?: Hex; localUnlockedMerchant?: Address; refundToken?: string; merchantToken?: string; dataFile: string; aspTree?: () => bigint[][]; dev?: { aspUrl: string; merchantToken: string; faucetUsdc?: bigint; faucetGas?: bigint }; credit?: CreditOptions;
  /** Extra route handlers mounted before Noren's own (World ID's createWorldIdHandler). Return true when handled. */
  mounts?: ((req: any, res: any) => Promise<boolean>)[] };
/** Pay later: NorenCreditLine on this Arc chain, plus what the web app needs to reach the Robinhood side. */
export type CreditOptions = { bridgeLog?: () => unknown[]; creditLine?: Address; fromBlock?: bigint; robinhoodRpc?: string; gateway?: Address; robinhoodFromBlock?: bigint; public?: Record<string, unknown> };
const loopback = (url: string) => { try { const u = new URL(url); return (u.protocol === 'http:' || u.protocol === 'https:') && ['localhost', '127.0.0.1'].includes(u.hostname); } catch { return false; } };
export async function assertLocalFork(rpcUrl: string, expectedChain = 5042002) {
  if (!loopback(rpcUrl)) throw new Error('Setup required: dev endpoints require a loopback RPC');
  const rpc = async (method: string) => { const r = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }) }); const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result; };
  const chain = Number(BigInt(await rpc('eth_chainId')));
  if (chain !== expectedChain) throw new Error(`Setup required: dev endpoints require fork chain ${expectedChain}; RPC returned ${chain}`);
  try { const info = await rpc('anvil_nodeInfo'); if (!info?.forkConfig?.forkUrl) throw new Error('Anvil is not forked'); }
  catch { throw new Error('Setup required: dev endpoints require an Anvil fork; anvil_nodeInfo has no fork configuration'); }
}
export function createMerchantServer(options: ServerOptions): Server {
  const rows = new Map<string, RecordRow>();
  const listeners = new Set<any>();
  const endpoints: Endpoint[] = []; const events: MerchantEvent[] = []; const profiles = new Map<string, string>();
  const token = options.dev?.merchantToken ?? options.merchantToken ?? options.refundToken;
  const authorized = (req: any) => !!token && req.headers.authorization === `Bearer ${token}`;
  const owns = (address: string) => !!merchantAddress && address.toLowerCase() === merchantAddress.toLowerCase();
  async function readSidecar(path: string) { try { return JSON.parse(await readFile(path, 'utf8')); } catch (e: any) { if (e.code === 'ENOENT') return undefined; throw e; } }
  async function saveSidecar(path: string, value: unknown) { await mkdir(dirname(path), { recursive: true }); const temp = `${path}.tmp`; await writeFile(temp, jsonBigints(value), { mode: 0o600 }); await rename(temp, path); }
  let eventSave = Promise.resolve();
  function persistEvents() { eventSave = eventSave.then(() => saveSidecar(options.dataFile + '.events.json', events)).catch(() => {}); return eventSave; }
  const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  async function deliver(event: MerchantEvent, endpoint: Endpoint, raw: string) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (attempt > 1) await pause(attempt === 2 ? 1000 : 4000);
      const at = Math.floor(Date.now() / 1000), start = performance.now(); let status: number | null = null; let error: string | undefined;
      try { const signature = createHmac('sha256', endpoint.secret).update(`${at}.${raw}`).digest('hex'); const response = await fetch(endpoint.url, { method: 'POST', headers: { 'content-type': 'application/json', 'noren-signature': `t=${at},v1=${signature}` }, body: raw, signal: AbortSignal.timeout(5000) }); status = response.status; }
      catch (e: any) { error = e?.message ?? 'Network error'; }
      const ok = status !== null && status >= 200 && status < 300; event.deliveries.push({ endpointId: endpoint.id, url: endpoint.url, attempt, status, ok, ms: Math.round(performance.now() - start), ...(error ? { error } : {}), at }); await persistEvents(); if (ok) break;
    }
  }
  function publish(type: MerchantEvent['type'], row: RecordRow, created: number) {
    emit(type, row); const event: MerchantEvent = { id: `evt_${randomBytes(8).toString('hex')}`, merchant: row.invoice.merchant.toLowerCase(), type, created, data: { invoiceId: row.invoice.invoiceId, amount: row.invoice.amount.toString(), status: row.status, method: row.method ?? null, description: row.description ?? null, paymentTx: row.paymentTx ?? null, refundTx: row.refundTx ?? null, refundAmount: row.refundAmount?.toString() ?? null, quote: row.quote ?? null }, deliveries: [] };
    events.unshift(event); events.length = Math.min(events.length, 200); void persistEvents(); const raw = jsonBigints({ id: event.id, type: event.type, created: event.created, data: event.data });
    for (const endpoint of endpoints.filter(e => e.merchant === event.merchant)) void deliver(event, endpoint, raw);
  }
  const chain = localFork(options.rpcUrl);
  const publicClient: any = createPublicClient({ chain, transport: http(options.rpcUrl), cacheTime: 0 });
  if (options.dev && (!loopback(options.rpcUrl) || options.deployment.chainId !== 5042002)) throw new Error('Setup required: dev endpoints require loopback RPC and fork chain 5042002');
  const devReady = options.dev ? assertLocalFork(options.rpcUrl) : Promise.resolve();
  void devReady.catch(() => {});
  const faucetUsed = new Set<string>();
  if (options.localUnlockedMerchant && !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(options.rpcUrl)) throw new Error('Unlocked merchant is only allowed on local RPC');
  const account = options.merchantKey ? privateKeyToAccount(options.merchantKey) : options.localUnlockedMerchant;
  const merchantAddress = typeof account === 'string' ? account : account?.address;
  const wallet: any = account ? createWalletClient({ chain, account, transport: http(options.rpcUrl) }) : undefined;
  let ready = (async () => { const saved = await readSidecar(options.dataFile); for (const row of saved ?? []) { const invoice = row.status === 'draft' ? { ...row.invoice, amount: BigInt(row.invoice.amount), expiry: BigInt(row.invoice.expiry) } : parseInvoice(row.invoice); const quote = row.quote ? { ...row.quote, fiatAmount: BigInt(row.quote.fiatAmount), usdcAmount: BigInt(row.quote.usdcAmount), fiatUsd: { ...row.quote.fiatUsd, answer: BigInt(row.quote.fiatUsd.answer), roundId: BigInt(row.quote.fiatUsd.roundId), updatedAt: BigInt(row.quote.fiatUsd.updatedAt) }, usdcUsd: { ...row.quote.usdcUsd, answer: BigInt(row.quote.usdcUsd.answer), roundId: BigInt(row.quote.usdcUsd.roundId), updatedAt: BigInt(row.quote.usdcUsd.updatedAt) } } : undefined; rows.set(invoice.invoiceId.toLowerCase(), { ...row, invoice, quote, refundAmount: row.refundAmount === undefined ? undefined : BigInt(row.refundAmount) }); } for (const endpoint of await readSidecar(options.dataFile + '.webhooks.json') ?? []) endpoints.push(endpoint); for (const event of (await readSidecar(options.dataFile + '.events.json') ?? []).slice(0, 200)) events.push(event); const savedProfiles = await readSidecar(options.dataFile + '.profile.json') ?? {}; for (const [address, name] of Object.entries(savedProfiles)) profiles.set(address, name as string); })();
  async function save() { await mkdir(dirname(options.dataFile), { recursive: true }); const tmp = options.dataFile + '.tmp'; await writeFile(tmp, jsonBigints([...rows.values()])); await rename(tmp, options.dataFile); }
  function emit(type: string, row: RecordRow) { const message = `event: ${type}\ndata: ${jsonBigints({ invoiceId: row.invoice.invoiceId, paymentTx: row.paymentTx, refundTx: row.refundTx })}\n\n`; for (const l of listeners) l.write(message); }
  async function body(req: any) { let s = ''; for await (const chunk of req) { s += chunk; if (s.length > 100_000) throw new Error('Request too large'); } return s ? JSON.parse(s) : {}; }
  function send(res: any, status: number, value: unknown) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(jsonBigints(value)); }
  // Pay later: a Drawn log on NorenCreditLine that matches an open invoice settles it. Mismatches are logged, never settled.
  const creditWatch = options.credit?.creditLine ? watchCreditDraws({ rpcUrl: options.rpcUrl, creditLine: options.credit.creditLine, fromBlock: options.credit.fromBlock, onError: e => console.error('Credit watcher:', e.message), onDraw: async draw => {
    await ready;
    const row = rows.get(draw.invoiceId.toLowerCase());
    const payout = row ? await publicClient.readContract({ address: options.deployment.checkout, abi: checkoutAbi, functionName: 'merchantPayout', args: [row.invoice.merchant] }) as string : undefined;
    const problem = creditDrawProblem(row, draw, payout);
    if (problem || !row) { console.warn(`Credit draw ${draw.txHash} not applied: ${problem}`); return; }
    row.status = 'paid'; row.method = 'credit'; row.creditLineId = draw.lineId; row.paymentTx = draw.txHash; row.paidAt = draw.timestamp; row.paymentBlock = draw.blockNumber.toString();
    const receipt = await publicClient.getTransactionReceipt({ hash: draw.txHash }); row.paymentGasUsed = receipt.gasUsed.toString();
    await save(); emit('paid', row); publish('payment.succeeded', row, row.paidAt);
  } }) : undefined;
  // Pay with stock: the invoice is mirrored on NorenGateway (Robinhood) and settles when its InvoicePaid log appears.
  const rh = options.credit?.robinhoodRpc ? createPublicClient({ transport: http(options.credit.robinhoodRpc), cacheTime: 0 }) as any : undefined;
  const stockWatch = rh && options.credit?.gateway && merchantAddress ? watchStockPayments({ rpcUrl: options.credit.robinhoodRpc!, gateway: options.credit.gateway, merchant: merchantAddress, fromBlock: options.credit.robinhoodFromBlock, onError: e => console.error('Stock watcher:', e.message), onPaid: async p => {
    await ready;
    const row = rows.get(p.invoiceId.toLowerCase());
    if (!row || (row.status !== 'draft' && row.status !== 'open')) { console.warn(`Stock payment ${p.txHash} not applied: ${row ? `invoice is ${row.status}` : 'unknown invoice'}`); return; }
    row.status = 'paid'; row.method = 'stocks'; row.paymentTx = p.txHash; row.paidAt = p.timestamp; row.paymentBlock = p.blockNumber.toString();
    row.stock = { asset: p.asset, assetIn: p.assetIn.toString(), usdgOut: p.usdgOut.toString(), priceUsd8: p.priceUsd8.toString(), chainId: Number(await rh.getChainId()) };
    const receipt = await rh.getTransactionReceipt({ hash: p.txHash }); row.paymentGasUsed = receipt.gasUsed.toString();
    await save(); emit('paid', row); publish('payment.succeeded', row, row.paidAt);
  } }) : undefined;
  /** Mirrors a Noren invoice onto NorenGateway as the merchant (USDC and USDG both have 6 decimals). Idempotent. */
  const mirroring = new Map<string, Promise<unknown>>();
  /** One mirror per invoice at a time: a second request waits for the first instead of racing it into InvoiceExists. */
  function mirrorOnce(row: RecordRow) {
    const key = row.invoice.invoiceId.toLowerCase();
    const p = (mirroring.get(key) ?? Promise.resolve()).catch(() => {}).then(() => mirrorOnRobinhood(row));
    mirroring.set(key, p); return p;
  }
  async function mirrorOnRobinhood(row: RecordRow) {
    if (!rh || !options.credit?.gateway) throw new Error('Setup required: NorenGateway is not deployed on the Robinhood fork (pnpm dev:all with packages/robinhood)');
    if (!merchantAddress) throw new Error('Setup required: merchant key missing');
    const gateway = options.credit.gateway, id = row.invoice.invoiceId;
    const existing = await rh.readContract({ address: gateway, abi: gatewayAbi, functionName: 'invoice', args: [merchantAddress, id] });
    if (existing.status === 0) {
      const data = encodeFunctionData({ abi: gatewayAbi, functionName: 'createInvoice', args: [id, row.invoice.amount, row.invoice.expiry] });
      let hash: Hex;
      // On the dev fork the merchant is an Anvil account. Anvil's built-in signer keeps the fork's original chain id after
      // anvil_setChainId (dev:all serves Robinhood as 46630 for CRE), so send as an impersonated account instead.
      if (options.localUnlockedMerchant) { await rh.request({ method: 'anvil_impersonateAccount', params: [merchantAddress] }); hash = await rh.request({ method: 'eth_sendTransaction', params: [{ from: merchantAddress, to: gateway, data }] }); }
      else hash = await createWalletClient({ account: account as any, transport: http(options.credit.robinhoodRpc!) }).sendTransaction({ to: gateway, data, chain: null } as any);
      const receipt = await rh.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error(`NorenGateway.createInvoice reverted: ${hash}`);
    }
    return { gateway, merchant: merchantAddress, invoiceId: id, amountUsdg: row.invoice.amount.toString(), expiry: row.invoice.expiry.toString() };
  }
  const server = createHttpServer(async (req, res) => {
    try {
      await ready; await devReady;
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;
      if (options.dev && req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': req.headers.origin === 'http://localhost:5190' || req.headers.origin === 'http://127.0.0.1:5190' ? req.headers.origin : '', 'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS', 'access-control-allow-headers': 'content-type, authorization' }); res.end(); return; }
      if (options.dev) { const origin = req.headers.origin; if (origin === 'http://localhost:5190' || origin === 'http://127.0.0.1:5190') res.setHeader('access-control-allow-origin', origin); }
      for (const mount of options.mounts ?? []) if (await mount(req, res)) return;
      if (req.method === 'GET' && path === '/config' && options.dev) return send(res, 200, { chainId: options.deployment.chainId, rpcUrl: options.rpcUrl, aspUrl: options.dev.aspUrl, deployment: options.deployment, merchant: merchantAddress, credit: options.credit ? { creditLine: options.credit.creditLine ?? null, robinhoodRpc: options.credit.robinhoodRpc ?? null, gateway: options.credit.gateway ?? null, ...options.credit.public } : null });
      if (req.method === 'GET' && path === '/credit/bridge') { if (!options.credit?.bridgeLog) throw new Error('Setup required: the CRE credit bridge relay is not running (pnpm dev:all with packages/cre-bridge)'); return send(res, 200, options.credit.bridgeLog()); }
      if (req.method === 'GET' && path === '/pricing/currencies') return send(res, 200, CURRENCIES);
      if (req.method === 'GET' && path === '/pricing/quote') {
        const currency = url.searchParams.get('currency') ?? '';
        const amount = url.searchParams.get('amount') ?? '';
        if (!/^\d+$/.test(amount) || BigInt(amount) <= 0n) throw new Error('amount must be a positive integer in minor units');
        return send(res, 200, await quoteUsdc({ currency, fiatAmount: BigInt(amount), rpcUrl: options.priceRpcUrl ?? process.env.NOREN_PRICE_RPC ?? DEFAULT_PRICE_RPC }));
      }
      if (req.method === 'POST' && path === '/dev/faucet' && options.dev) {
        const address = (await body(req)).address as string;
        if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('Invalid faucet address');
        const target = address.toLowerCase(); if (faucetUsed.has(target)) return send(res, 429, { error: 'Faucet already used for this address' });
        faucetUsed.add(target);
        try {
          const gas = options.dev.faucetGas ?? 10n ** 18n;
          await publicClient.request({ method: 'anvil_setBalance', params: [address, toHex(gas)] });
          const gasTx = await publicClient.request({ method: 'eth_sendTransaction', params: [{ from: merchantAddress, to: address, value: '0x1' }] }) as Hex;
          const gasReceipt = await publicClient.waitForTransactionReceipt({ hash: gasTx }); if (gasReceipt.status !== 'success') throw new Error('Faucet gas transfer reverted');
          const mintData = encodeFunctionData({ abi: [{ type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }], outputs: [] }], functionName: 'mint', args: [address as Address, options.dev.faucetUsdc ?? 50_000_000n] });
          const hash = await publicClient.request({ method: 'eth_sendTransaction', params: [{ from: merchantAddress, to: options.deployment.usdc, data: mintData }] }) as Hex;
          const receipt = await publicClient.waitForTransactionReceipt({ hash }); if (receipt.status !== 'success') throw new Error('Faucet mint reverted');
          return send(res, 200, { gasTx, usdcTx: hash });
        } catch (e) { faucetUsed.delete(target); throw e; }
      }
      if (req.method === 'POST' && path === '/dev/robinhood-faucet' && options.dev) {
        if (!options.credit?.robinhoodRpc) throw new Error('Setup required: start the Robinhood fork with pnpm dev:all');
        const address = (await body(req)).address as string;
        if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('Invalid faucet address');
        const target = 'rh:' + address.toLowerCase(); if (faucetUsed.has(target)) return send(res, 429, { error: 'Robinhood faucet already used for this address' });
        faucetUsed.add(target);
        try { return send(res, 200, await robinhoodFaucet(options.credit.robinhoodRpc, address as Address)); } catch (e) { faucetUsed.delete(target); throw e; }
      }
      if (req.method === 'GET' && path === '/events') { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }); res.write(': connected\n\n'); listeners.add(res); req.on('close', () => listeners.delete(res)); return; }
      if (req.method === 'GET' && path === '/asp/tree' && options.aspTree) return send(res, 200, options.aspTree());
      const merchantRoute = /^\/merchants\/(0x[0-9a-fA-F]{40})\/(profile|webhooks|events)(?:\/(we_[0-9a-f]{12}))?$/.exec(path);
      if (merchantRoute) {
        const address = merchantRoute[1].toLowerCase(), kind = merchantRoute[2], endpointId = merchantRoute[3];
        if (kind === 'profile' && req.method === 'GET') return send(res, 200, { merchant: merchantRoute[1], name: profiles.get(address) ?? null });
        if (!authorized(req)) return send(res, 401, { error: 'Merchant bearer token required' });
        if (!owns(address)) return send(res, 403, { error: 'NotMerchant: this server does not own that merchant' });
        if (kind === 'profile' && req.method === 'POST') { const value = (await body(req)).name; if (typeof value !== 'string' || !value.trim() || value.trim().length > 48) throw new Error('name must be 1-48 characters'); profiles.set(address, value.trim()); await saveSidecar(options.dataFile + '.profile.json', Object.fromEntries(profiles)); return send(res, 200, { merchant: merchantRoute[1], name: value.trim() }); }
        if (kind === 'webhooks' && req.method === 'GET' && !endpointId) return send(res, 200, endpoints.filter(e => e.merchant === address).map(({ id, url, createdAt }) => ({ id, url, createdAt })));
        if (kind === 'webhooks' && req.method === 'POST' && !endpointId) { const value = (await body(req)).url; let parsed: URL; try { parsed = new URL(value); } catch { throw new Error('url must be an http or https URL'); } if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('url must be an http or https URL'); const endpoint = { id: `we_${randomBytes(6).toString('hex')}`, merchant: address, url: parsed.toString(), createdAt: Number((await publicClient.getBlock()).timestamp), secret: `whsec_${randomBytes(32).toString('hex')}` }; endpoints.push(endpoint); await saveSidecar(options.dataFile + '.webhooks.json', endpoints); return send(res, 201, { id: endpoint.id, url: endpoint.url, createdAt: endpoint.createdAt, secret: endpoint.secret }); }
        if (kind === 'webhooks' && req.method === 'DELETE' && endpointId) { const index = endpoints.findIndex(e => e.merchant === address && e.id === endpointId); if (index < 0) return send(res, 404, { error: 'Webhook endpoint not found' }); endpoints.splice(index, 1); await saveSidecar(options.dataFile + '.webhooks.json', endpoints); return send(res, 200, { deleted: true }); }
        if (kind === 'events' && req.method === 'GET') return send(res, 200, events.filter(e => e.merchant === address));
        return send(res, 405, { error: 'Method not allowed' });
      }
      const create = /^\/merchants\/(0x[0-9a-fA-F]{40})\/invoices$/.exec(path);
      if (req.method === 'GET' && create) { const now = (await publicClient.getBlock()).timestamp; return send(res, 200, [...rows.values()].filter(r => r.invoice.merchant.toLowerCase() === create[1].toLowerCase()).reverse().map(r => ({ ...r, status: ['draft', 'open'].includes(r.status) && now > r.invoice.expiry ? 'expired' : r.status }))); }
      if (req.method === 'POST' && create) {
        if (!authorized(req)) return send(res, 401, { error: 'Merchant bearer token required' });
        if (!account || !wallet) throw new Error('Setup required: merchant key missing');
        if (create[1].toLowerCase() !== merchantAddress!.toLowerCase()) throw new Error('NotMerchant: this server does not own that merchant');
        const b = await body(req); const expiry = BigInt(b.expiry);
        const fiat = b.currency !== undefined || b.fiatAmount !== undefined;
        if (fiat && (b.amount !== undefined || typeof b.currency !== 'string' || !/^\d+$/.test(String(b.fiatAmount ?? '')))) throw new Error('Provide either amount or currency and fiatAmount');
        if (!fiat && b.amount === undefined) throw new Error('amount is required');
        if (b.description !== undefined && (typeof b.description !== 'string' || !b.description.trim() || b.description.trim().length > 120)) throw new Error('description must be 1-120 characters');
        const now = (await publicClient.getBlock()).timestamp;
        if (expiry <= now || expiry > now + 30n * 24n * 3600n) throw new Error('Invalid amount or expiry');
        if (b.refundPrecommitment !== undefined || b.receiptCommitment !== undefined) throw new Error('Create a draft with amount and expiry only; customer binds commitments');
        const quote = fiat ? await quoteUsdc({ currency: b.currency, fiatAmount: BigInt(b.fiatAmount), rpcUrl: options.priceRpcUrl ?? process.env.NOREN_PRICE_RPC ?? DEFAULT_PRICE_RPC }) : undefined;
        const amount = quote?.usdcAmount ?? BigInt(b.amount);
        if (amount <= 0n) throw new Error('Invalid amount or expiry');
        const invoice: DraftInvoice = { invoiceId: `0x${randomBytes(32).toString('hex')}` as Hex, merchant: merchantAddress!, amount, expiry };
        const payout = await publicClient.readContract({ address: options.deployment.checkout, abi: checkoutAbi, functionName: 'merchantPayout', args: [merchantAddress!] });
        if (payout === '0x0000000000000000000000000000000000000000') throw new Error('Setup required: merchant must register a payout first');
        const row: RecordRow = { invoice, status: 'draft', createdAt: Number(now), ...(quote ? { quote } : {}), ...(b.description === undefined ? {} : { description: b.description.trim() }) }; rows.set(invoice.invoiceId.toLowerCase(), row); await save(); emit('invoice_created', row); publish('invoice.created', row, Number(now));
        return send(res, 201, { invoice, ...(quote ? { quote } : {}), paymentLinkPayload: { invoiceId: invoice.invoiceId, checkout: options.deployment.checkout } });
      }
      const match = /^\/invoices\/(0x[0-9a-fA-F]{64})(?:\/(bind|pay|refund|robinhood))?$/.exec(path);
      if (!match) return send(res, 404, { error: 'Not found' });
      const row = rows.get(match[1].toLowerCase()); if (!row) return send(res, 404, { error: 'Invoice not found' });
      if (req.method === 'GET' && !match[2]) return send(res, 200, { ...row, merchantName: profiles.get(row.invoice.merchant.toLowerCase()) ?? null, status: ['draft', 'open'].includes(row.status) && (await publicClient.getBlock()).timestamp > row.invoice.expiry ? 'expired' : row.status });
      if (req.method === 'POST' && match[2] === 'robinhood') {
        if (row.status !== 'draft' && row.status !== 'open') throw new Error(`InvoiceNotOpen: invoice is ${row.status}`);
        if ((await publicClient.getBlock()).timestamp > row.invoice.expiry) throw new Error('Expired: invoice has expired');
        return send(res, 200, await mirrorOnce(row));
      }
      if (req.method === 'POST' && match[2] === 'bind') {
        if (row.status !== 'draft') throw new Error('InvoiceAlreadyBound: invoice is immutable');
        if ((await publicClient.getBlock()).timestamp > row.invoice.expiry) throw new Error('Expired: invoice has expired');
        const b = await body(req);
        const invoice = parseInvoice({ ...row.invoice, refundPrecommitment: b.refundPrecommitment, receiptCommitment: b.receiptCommitment });
        row.invoice = invoice; row.status = 'open'; row.boundAt = Number((await publicClient.getBlock()).timestamp); await save(); emit('invoice_bound', row); publish('invoice.bound', row, row.boundAt);
        return send(res, 200, { invoice, paymentLinkPayload: { invoiceId: invoice.invoiceId, checkout: options.deployment.checkout, data: encodeInvoiceData(invoice) } });
      }
      if (!account || !wallet) throw new Error('Setup required: merchant key missing');
      if (req.method === 'POST' && match[2] === 'pay') {
        const { withdrawal, proof } = validatePayment(row, await body(req), options.deployment.checkout, (await publicClient.getBlock()).timestamp);
        await publicClient.simulateContract({ account: merchantAddress, address: options.deployment.checkout, abi: [...checkoutAbi, ...poolAbi], functionName: 'pay', args: [withdrawal, proof] });
        const hash = await wallet.writeContract({ address: options.deployment.checkout, abi: checkoutAbi, functionName: 'pay', args: [withdrawal, proof as any] });
        const receipt = await publicClient.waitForTransactionReceipt({ hash }); if (receipt.status !== 'success') throw new Error('Payment transaction reverted');
        row.status = 'paid'; row.method = 'private'; row.paymentTx = hash; row.paidAt = Number((await publicClient.getBlock()).timestamp); row.paymentGasUsed = receipt.gasUsed.toString(); row.paymentBlock = receipt.blockNumber.toString(); await save(); emit('paid', row); publish('payment.succeeded', row, row.paidAt); return send(res, 200, row);
      }
      if (req.method === 'POST' && match[2] === 'refund') {
        if (!authorized(req)) return send(res, 401, { error: 'Merchant bearer token required' });
        if (row.status !== 'paid') throw new Error('Invoice is not paid or has already been refunded');
        if (row.method === 'credit' || row.method === 'stocks') throw new Error(`RefundUnsupported: this invoice was paid ${row.method === 'credit' ? 'on credit (pay later)' : 'with Stock Tokens on Robinhood Chain'}, not from the private pool`);
        const amount = BigInt((await body(req)).amount); if (amount <= 0n || amount > row.invoice.amount) throw new Error('RefundTooLarge: amount must be positive and at most invoice amount');
        const approval = await wallet.writeContract({ address: options.deployment.usdc, abi: usdcAbi, functionName: 'approve', args: [options.deployment.checkout, amount] });
        const approved = await publicClient.waitForTransactionReceipt({ hash: approval }); if (approved.status !== 'success') throw new Error('Approval reverted');
        await publicClient.simulateContract({ account: merchantAddress, address: options.deployment.checkout, abi: checkoutAbi, functionName: 'refund', args: [row.invoice.invoiceId, amount] });
        const hash = await wallet.writeContract({ address: options.deployment.checkout, abi: checkoutAbi, functionName: 'refund', args: [row.invoice.invoiceId, amount] });
        const receipt = await publicClient.waitForTransactionReceipt({ hash }); if (receipt.status !== 'success') throw new Error('Refund reverted');
        row.status = 'refunded'; row.refundTx = hash; row.refundAmount = amount; row.refundedAt = Number((await publicClient.getBlock()).timestamp); row.refundGasUsed = receipt.gasUsed.toString(); await save(); emit('refunded', row); publish('refund.succeeded', row, row.refundedAt); return send(res, 200, { ...row, approvalTx: approval });
      }
      return send(res, 405, { error: 'Method not allowed' });
    } catch (error: any) { const message = String(error?.message ?? error); send(res, /Setup required|StalePrice|InvalidPrice/.test(message) ? 503 : 400, { error: /StalePrice|InvalidPrice/.test(message) ? message : readableError(error) }); }
  });
  server.on('close', () => { creditWatch?.stop(); stockWatch?.stop(); });
  return server;
}
