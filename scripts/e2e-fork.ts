import { readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createPublicClient, decodeErrorResult, encodeAbiParameters, encodeFunctionData, http, keccak256, parseAbi, toBytes, toHex, type Address, type Hex } from 'viem';
import { ARC_USDC, checkoutAbi, entrypointAbi, jsonBigints, localFork, poolAbi, usdcAbi } from '@noren/core';
import { createCustomer } from '@noren/core/customer';
import { verifyWebhook, type WebhookEvent } from '@noren/core/merchant';
import { createMerchantServer } from '../packages/server/src/server.ts';
import { createPostman } from '../packages/postman/src/postman.ts';
import { deployArc } from './deploy-arc.ts';
import { writeFoundryFixture } from './gen-fixtures.ts';

const rpc = 'http://127.0.0.1:8700';
const client: any = createPublicClient({ chain: localFork(rpc), transport: http(rpc), cacheTime: 0 });
const contractDir = resolve('packages/contracts');
const start = performance.now();
const log = (label: string, value: unknown) => console.log(`${label}: ${typeof value === 'bigint' ? value : value} (${((performance.now() - start) / 1000).toFixed(2)}s)`);
async function main() {
  const accounts = await client.request({ method: 'eth_accounts' });
  const [deployer, merchant, merchant2, outsider] = accounts as Address[];
  const shim = JSON.parse(readFileSync(resolve(contractDir, 'out/ForkUSDC.sol/ForkUSDC.json'), 'utf8'));
  await client.request({ method: 'anvil_setCode', params: [ARC_USDC, shim.deployedBytecode.object as Hex] });
  const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [deployer, 0n]));
  await client.request({ method: 'anvil_setStorageAt', params: [ARC_USDC, slot, toHex(100_000_000n, { size: 32 })] });
  const deployment = await deployArc(rpc, deployer);
  async function send(from: Address, to: Address, data: Hex, expectSuccess = true) {
    const hash = await client.request({ method: 'eth_sendTransaction', params: [{ from, to, data, gas: '0x2dc6c0' }] });
    const receipt = await client.waitForTransactionReceipt({ hash });
    log(expectSuccess ? 'tx' : 'expected revert tx', `${hash} ${receipt.status}`);
    if ((receipt.status === 'success') !== expectSuccess) {
      try { await client.call({ account: from, to, data }); } catch (e: any) { console.error('Revert detail:', e.shortMessage ?? e.message); }
      throw new Error(`Unexpected transaction status: ${hash}`);
    }
    return receipt;
  }
  async function expectRevert(from: Address, data: Hex, name: string) {
    try { await client.call({ account: from, to: deployment.checkout, data }); throw new Error(`Expected ${name}, call succeeded`); }
    catch (e: any) {
      let cursor = e, found: string | undefined;
      for (let i = 0; cursor && i < 8; i++, cursor = cursor.cause) {
        if (typeof cursor.data === 'string') try { found = decodeErrorResult({ abi: [...checkoutAbi, ...poolAbi], data: cursor.data }).errorName; break; } catch { /* inspect nested cause */ }
      }
      if (found !== name) throw new Error(`Expected ${name}, got ${found ?? e.shortMessage ?? e.message}`);
      log('attack check', name);
    }
    await send(from, deployment.checkout, data, false);
  }
  await send(merchant, deployment.checkout, encodeFunctionData({ abi: checkoutAbi, functionName: 'registerMerchant', args: [merchant] }));
  await send(merchant2, deployment.checkout, encodeFunctionData({ abi: checkoutAbi, functionName: 'registerMerchant', args: [merchant2] }));
  await send(deployer, ARC_USDC, encodeFunctionData({ abi: usdcAbi, functionName: 'approve', args: [deployment.entrypoint, 25_000_000n] }));
  const postman = createPostman({ deployment, rpcUrl: rpc, delayMs: 0, batchMs: 60_000, treeUrl: 'http://127.0.0.1:8702/asp/tree?v=1', sendRoot: (root, cid) => client.request({ method: 'eth_sendTransaction', params: [{ from: deployer, to: deployment.entrypoint, data: encodeFunctionData({ abi: entrypointAbi, functionName: 'updateRoot', args: [root, cid] }) }] }), onTx: h => log('ASP root tx', h) });
  const aspServer = postman.serve(8702);
  const customer = createCustomer({ deployment, rpcUrl: rpc, aspUrl: 'http://127.0.0.1:8702', deriveAt: async path => keccak256(toBytes(`noren-local-fork-only:${path}`)) });
  // Anvil exposes unlocked accounts on loopback; no private key enters this process.
  await Promise.all(['', '.profile.json', '.webhooks.json', '.events.json'].map(suffix => rm(`data/e2e-invoices.json${suffix}`, { force: true })));
  const merchantServer = createMerchantServer({ deployment, rpcUrl: rpc, localUnlockedMerchant: merchant, refundToken: 'local-demo-token', dataFile: 'data/e2e-invoices.json' });
  const webhookMessages: { raw: string; signature: string | null }[] = [];
  const webhookReceiver = createHttpServer(async (req, res) => { let raw = ''; for await (const chunk of req) raw += chunk; webhookMessages.push({ raw, signature: req.headers['noren-signature'] as string ?? null }); res.writeHead(200); res.end(); });
  try {
    await new Promise<void>(ok => webhookReceiver.listen(8703, '127.0.0.1', ok));
    await new Promise<void>(ok => merchantServer.listen(8701, '127.0.0.1', ok));
    const base = 'http://127.0.0.1:8701';
    const request = async (path: string, method = 'GET', value?: unknown, token?: string) => {
      const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: value === undefined ? undefined : jsonBigints(value) });
      const data = await r.json(); if (!r.ok) throw new Error(`${path}: ${data.error}`); return data;
    };
    const webhook = await request(`/merchants/${merchant}/webhooks`, 'POST', { url: 'http://127.0.0.1:8703' }, 'local-demo-token');
    async function waitWebhook(type: string, invoiceId: string, paymentTx?: string): Promise<WebhookEvent> {
      for (let i = 0; i < 100; i++) {
        for (const message of webhookMessages) { const event = await verifyWebhook(message.raw, message.signature, webhook.secret); if (event.type === type && event.data.invoiceId === invoiceId && (!paymentTx || event.data.paymentTx === paymentTx)) return event; }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error(`Timed out waiting for verified ${type} webhook`);
    }
    const [shieldTx] = await customer.shield(20_000_000n);
    log('shield target', shieldTx.to);
    const deposit = await send(deployer, shieldTx.to as Address, shieldTx.data as Hex);
    log('shield gas', deposit.gasUsed);
    await postman.tick(true);
    const initial = await customer.balance();
    if (!initial.some((x: any) => !x.tag && BigInt(x.amount) === 20_000_000n)) throw new Error('20 USDC not approved');
    // A blacklisted depositor's real pool label must stay outside the ASP set.
    const forkTokenAbi = parseAbi(['function transfer(address to,uint256 value) returns (bool)', 'function setBlacklisted(address account,bool value)']);
    const depositAbi = parseAbi(['function deposit(address asset,uint256 value,uint256 precommitment) returns (uint256)']);
    await send(deployer, ARC_USDC, encodeFunctionData({ abi: forkTokenAbi, functionName: 'transfer', args: [outsider, 1_000_000n] }));
    await send(deployer, ARC_USDC, encodeFunctionData({ abi: forkTokenAbi, functionName: 'setBlacklisted', args: [outsider, true] }));
    await send(outsider, ARC_USDC, encodeFunctionData({ abi: usdcAbi, functionName: 'approve', args: [deployment.entrypoint, 1_000_000n] }));
    await send(outsider, deployment.entrypoint, encodeFunctionData({ abi: depositAbi, functionName: 'deposit', args: [ARC_USDC, 1_000_000n, 123456789n] }));
    const beforeBlacklistTick = postman.root;
    await postman.tick(true);
    if (postman.root !== beforeBlacklistTick || postman.approvedLabels.length !== 1) throw new Error('Blacklisted deposit entered ASP set');
    log('ASP blacklist check', 'rejected');
    const refund = await customer.refundInbox();
    const amount = 7_500_000n;
    const expiry = (await client.getBlock()).timestamp + 3600n;
    const opening = customer.createReceipt();
    const receiptCommitment = opening.commitment;
    const created = await request(`/merchants/${merchant}/invoices`, 'POST', { amount, expiry }, 'local-demo-token');
    if (created.status && created.status !== 'draft') throw new Error('Invoice was not drafted');
    const bound = await request(`/invoices/${created.invoice.invoiceId}/bind`, 'POST', { refundPrecommitment: refund.nextPrecommitment, receiptCommitment });
    log('invoice', created.invoice.invoiceId);
    const invoice = { ...bound.invoice, amount, expiry, refundPrecommitment: refund.nextPrecommitment };
    await customer.rememberReceipt(invoice, opening);
    if ((await customer.receipt(invoice)).secret !== opening.secret) throw new Error('Receipt opening mismatch');
    let proofStart = performance.now();
    const stale = await customer.proveInvoicePayment(invoice);
    log('prove initial seconds', ((performance.now() - proofStart) / 1000).toFixed(3));
    const [secondTx] = await customer.shield(1_000_000n);
    await send(deployer, secondTx.to as Address, secondTx.data as Hex);
    await postman.tick(true);
    await expectRevert(merchant, encodeFunctionData({ abi: checkoutAbi, functionName: 'pay', args: [stale.withdrawal, stale.proof as any] }), 'IncorrectASPRoot');
    proofStart = performance.now();
    const fresh = await customer.proveInvoicePayment(invoice);
    log('reprove seconds', ((performance.now() - proofStart) / 1000).toFixed(3));
    const tampered = { ...fresh.withdrawal, data: encodeAbiParameters([{ type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }], [invoice.invoiceId, merchant2, amount, expiry, refund.nextPrecommitment, receiptCommitment]) };
    await expectRevert(merchant2, encodeFunctionData({ abi: checkoutAbi, functionName: 'pay', args: [tampered, fresh.proof as any] }), 'ContextMismatch');
    await expectRevert(outsider, encodeFunctionData({ abi: checkoutAbi, functionName: 'pay', args: [fresh.withdrawal, fresh.proof as any] }), 'NotMerchant');
    const expired = { ...fresh.withdrawal, data: encodeAbiParameters([{ type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }], [invoice.invoiceId, merchant, amount, 1n, refund.nextPrecommitment, receiptCommitment]) };
    await expectRevert(merchant, encodeFunctionData({ abi: checkoutAbi, functionName: 'pay', args: [expired, fresh.proof as any] }), 'Expired');
    writeFoundryFixture({ contractsDir: contractDir, checkout: deployment.checkout, pool: deployment.pool, entrypoint: deployment.entrypoint, usdc: deployment.usdc, merchant, merchant2, invoiceId: invoice.invoiceId, receiptCommitment, amount, expiry, refundPrecommitment: refund.nextPrecommitment, proof: fresh.proof });
    const foundry = execFileSync('forge', ['test', '--fork-url', rpc, '--match-contract', 'NorenCheckoutTest', '-vv'], { cwd: contractDir, encoding: 'utf8' });
    console.log(foundry.trim());
    const foundryCount = Number(foundry.match(/(\d+) tests passed, 0 failed, 0 skipped/)?.[1] ?? 0);
    if (foundryCount !== 9) throw new Error(`Expected 9 Foundry tests, got ${foundryCount}`);
    const paid = await request(`/invoices/${invoice.invoiceId}/pay`, 'POST', fresh);
    log('payment tx', paid.paymentTx);
    await waitWebhook('payment.succeeded', invoice.invoiceId, paid.paymentTx);
    const status = await request(`/invoices/${invoice.invoiceId}`);
    if (status.status !== 'paid') throw new Error('Invoice status is not paid');
    await expectRevert(merchant, encodeFunctionData({ abi: checkoutAbi, functionName: 'pay', args: [fresh.withdrawal, fresh.proof as any] }), 'AlreadyPaid');
    const returned = await request(`/invoices/${invoice.invoiceId}/refund`, 'POST', { amount: 2_500_000n }, 'local-demo-token');
    log('refund approval tx', returned.approvalTx); log('refund tx', returned.refundTx);
    const refundEvent = await waitWebhook('refund.succeeded', invoice.invoiceId, paid.paymentTx);
    if (refundEvent.data.refundTx !== returned.refundTx) throw new Error('Refund webhook transaction hash mismatch');
    const pending = await customer.refundInbox();
    if (!pending.balances.some((x: any) => x.tag === 'pending' && BigInt(x.amount) === 2_500_000n)) throw new Error('Refund is not pending in inbox');
    await postman.tick(true);
    const approved = await customer.refundInbox();
    if (!approved.balances.some((x: any) => !x.tag && BigInt(x.amount) === 2_500_000n)) throw new Error('Refund not approved');
    log('summary', jsonBigints({ foundryTests: foundryCount, status: 'refunded', refundPending: true, refundApproved: true, attackReverts: 5, totalSeconds: (performance.now() - start) / 1000 }));
  } finally { await new Promise<void>(r => merchantServer.close(() => r())); await new Promise<void>(r => aspServer.close(() => r())); await new Promise<void>(r => webhookReceiver.close(() => r())); }
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
