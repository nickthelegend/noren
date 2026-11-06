// Noren end to end on the PUBLIC Arc testnet (chain 5042002): real transactions, real testnet USDC.
//
//   pnpm exec tsx scripts/live/e2e-live.ts
//
// What it does, in order (every step is a real Arc testnet transaction, recorded with an explorer link):
//   1. registerMerchant(payout) from the merchant (the Noren operator key), payout = a fresh address
//   2. funds a fresh customer key with 6 USDC from the operator
//   3. the customer shields 5 USDC into the Privacy Pools USDC pool with Kohaku (approve + deposit)
//   4. the ASP postman (packages/postman) checks USDC isBlacklisted and posts a new ASP root
//   5. the merchant server (packages/server) drafts a 2.50 USDC invoice; the customer binds it, makes the
//      withdrawal proof in Node with the same @noren/core library and zk artifacts the browser uses, and the
//      server relays NorenCheckout.pay; a signed payment.succeeded webhook is verified
//   6. the merchant refunds 1.00 USDC into the customer's shielded refund inbox (approve + refund), the
//      postman approves the refund deposit, and the customer's inbox shows it as spendable
//
// Keys: the operator key is NOREN_DEPLOYER_KEY, loaded from the main checkout's gitignored .env.arc-deployer.
// The customer key, its Kohaku seed and the payout key are generated once into the main checkout's gitignored
// .keys-live-arc.json (mode 0600). No key is ever printed.
//
// The script is resumable: data/live-arc/state.json records each finished step, so a rerun never repeats a
// transfer, shield, payment or refund. Budget guard: it refuses to start if the operator holds under 12 USDC.
//
// ASP tree: the postman serves its tree on 127.0.0.1:8801 for this run, so the on-chain root's CID points at
// a loopback URL. Anyone can check the root on-chain; only this machine could fetch the tree during the run.
import { createServer as createHttpServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { concatHex, createPublicClient, createWalletClient, decodeEventLog, erc20Abi, formatUnits, http, keccak256, toBytes, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { checkoutAbi, entrypointAbi, jsonBigints, localFork, poolAbi, type Invoice } from '@noren/core';
import { createCustomer } from '@noren/core/customer';
import { createNoren, verifyWebhook, type WebhookEvent } from '@noren/core/merchant';
import { readDeployment } from '@noren/core/node';
import { createMerchantServer } from '../../packages/server/src/server.ts';
import { createPostman } from '../../packages/postman/src/postman.ts';

export const RPC = process.env.NOREN_RPC_URL ?? 'https://rpc.testnet.arc.io';
export const EXPLORER = 'https://explorer.testnet.arc.io';
const PORTS = { server: 8800, asp: 8801, webhook: 8802 };
const SHIELD = 5_000_000n, FUND = 6_000_000n, INVOICE = 2_500_000n, REFUND = 1_000_000n;
const MIN_OPERATOR = 12_000_000n; // 6 USDC to the customer, 1 USDC refund, gas, with room for the 5 USDC reserve
const t0 = performance.now();
const say = (line: string) => console.log(`[${((performance.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${line}`);
export const txLink = (hash: string) => `${EXPLORER}/tx/${hash}`;
export const addressLink = (address: string) => `${EXPLORER}/address/${address}`;

/** The main checkout (git common dir's parent), where gitignored key files live across worktrees. */
export function mainCheckout(): string {
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  return dirname(common);
}
/** Loads NOREN_DEPLOYER_KEY from env, .env.arc-deployer here or in the main checkout. Never prints values. */
export function operatorKey(): Hex {
  for (const file of [process.env.NOREN_ENV_FILE, '.env.arc-deployer', resolve(mainCheckout(), '.env.arc-deployer')]) {
    if (process.env.NOREN_DEPLOYER_KEY) break;
    if (file && existsSync(file)) { try { process.loadEnvFile(file); } catch { throw new Error(`Could not parse env file ${file}`); } }
  }
  const key = process.env.NOREN_DEPLOYER_KEY;
  if (!key) throw new Error('Setup required: NOREN_DEPLOYER_KEY (main checkout .env.arc-deployer)');
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('NOREN_DEPLOYER_KEY is not a 0x-prefixed 32-byte hex key');
  return key as Hex;
}
type LiveKeys = { customerKey: Hex; customerSeed: Hex; payoutKey: Hex };
/** Fresh testnet-only keys for this run, created once (mode 0600) in the main checkout's gitignored .keys-live-arc.json. */
export function liveKeys(): LiveKeys {
  const file = resolve(mainCheckout(), '.keys-live-arc.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const keys: LiveKeys = { customerKey: generatePrivateKey(), customerSeed: generatePrivateKey(), payoutKey: generatePrivateKey() };
  writeFileSync(file, JSON.stringify(keys, null, 2) + '\n', { mode: 0o600 }); chmodSync(file, 0o600);
  say(`generated fresh customer and payout keys in ${file} (gitignored, 0600)`);
  return keys;
}

type Step = { step: string; tx: Hex; from: Address; to: Address; gasUsed: string; block: string; note?: string };
type State = { steps: Step[]; done: Record<string, unknown> };
const stateFile = resolve('data/live-arc/state.json');
function loadState(): State { try { return JSON.parse(readFileSync(stateFile, 'utf8')); } catch { return { steps: [], done: {} }; } }
function saveState(s: State) { mkdirSync(dirname(stateFile), { recursive: true }); writeFileSync(stateFile, jsonBigints(s) + '\n'); }
function fileStorage(name: string) {
  const path = resolve('data/live-arc', `${name}.json`);
  const read = (): Record<string, string> => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; } };
  return { get: async (k: string) => read()[k] ?? null, set: async (k: string, v: string) => { const all = read(); all[k] = v; mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(all), { mode: 0o600 }); } };
}

async function main() {
  const deployment = await readDeployment(5042002);
  const chain = localFork(RPC);
  const client: any = createPublicClient({ chain, transport: http(RPC, { retryCount: 5, retryDelay: 800 }), cacheTime: 0 });
  if (await client.getChainId() !== 5042002) throw new Error(`${RPC} is not Arc testnet`);
  const operator = privateKeyToAccount(operatorKey());
  if (operator.address.toLowerCase() !== '0x4b2acf80bc6e07bbf5690f0710e25c528cb63f80') throw new Error('NOREN_DEPLOYER_KEY is not the Noren operator');
  const keys = liveKeys();
  const customerAccount = privateKeyToAccount(keys.customerKey), payout = privateKeyToAccount(keys.payoutKey).address;
  const opWallet: any = createWalletClient({ chain, account: operator, transport: http(RPC) });
  const custWallet: any = createWalletClient({ chain, account: customerAccount, transport: http(RPC) });
  const usdc = (a: Address) => client.readContract({ address: deployment.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [a] }) as Promise<bigint>;
  const state = loadState();
  say(`operator ${operator.address}  customer ${customerAccount.address}  payout ${payout}`);
  const start = { operator: await usdc(operator.address), customer: await usdc(customerAccount.address), payout: await usdc(payout) };
  say(`balances: operator ${formatUnits(start.operator, 6)}  customer ${formatUnits(start.customer, 6)}  payout ${formatUnits(start.payout, 6)} USDC`);
  state.done.startBalances ??= start;
  if (!state.done.funded && start.operator < MIN_OPERATOR) throw new Error(`Setup required: operator holds ${formatUnits(start.operator, 6)} USDC, under the ${formatUnits(MIN_OPERATOR, 6)} this run budgets`);

  async function settle(step: string, hash: Hex, note?: string) {
    const r = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (r.status !== 'success') throw new Error(`${step} reverted: ${txLink(hash)}`);
    state.steps.push({ step, tx: hash, from: r.from, to: r.to, gasUsed: r.gasUsed.toString(), block: r.blockNumber.toString(), ...(note ? { note } : {}) }); saveState(state);
    say(`${step.padEnd(30)} ${txLink(hash)}`);
    return r;
  }

  // 1. Merchant registration: the operator is the merchant; its payout is a fresh address nobody else uses.
  const registered = await client.readContract({ address: deployment.checkout, abi: checkoutAbi, functionName: 'merchantPayout', args: [operator.address] }) as Address;
  if (registered === '0x0000000000000000000000000000000000000000') await settle('registerMerchant(payout)', await opWallet.writeContract({ address: deployment.checkout, abi: checkoutAbi, functionName: 'registerMerchant', args: [payout] }), `payout ${payout}`);
  else if (registered.toLowerCase() !== payout.toLowerCase()) throw new Error(`Merchant already registered with another payout ${registered}`);
  // 2. Fund the customer (ERC-20 view of native USDC: 6 decimals).
  if (!state.done.funded) { await settle('fund customer 6 USDC', await opWallet.writeContract({ address: deployment.usdc, abi: erc20Abi, functionName: 'transfer', args: [customerAccount.address, FUND] })); state.done.funded = true; saveState(state); }

  const postman = createPostman({ deployment, rpcUrl: RPC, delayMs: 0, batchMs: 60_000, treeUrl: `http://127.0.0.1:${PORTS.asp}/asp/tree?v=1`,
    sendRoot: (root, cid) => opWallet.writeContract({ address: deployment.entrypoint, abi: entrypointAbi, functionName: 'updateRoot', args: [root, cid] }),
    onTx: h => void settle('ASP updateRoot', h).catch(e => console.error(e.message)) });
  const aspServer = postman.serve(PORTS.asp);
  const customer = createCustomer({ deployment, rpcUrl: RPC, aspUrl: `http://127.0.0.1:${PORTS.asp}`, storage: fileStorage('kohaku'),
    deriveAt: async path => keccak256(concatHex([keys.customerSeed, keccak256(toBytes(path))])) }); // same derivation as packages/web/src/wallet.ts
  const merchantToken = randomBytes(24).toString('hex');
  const merchantServer = createMerchantServer({ deployment, rpcUrl: RPC, merchantKey: operatorKey(), merchantToken, dataFile: 'data/live-arc/invoices.json' });
  const webhookMessages: { raw: string; signature: string | null }[] = [];
  const webhookReceiver = createHttpServer(async (req, res) => { let raw = ''; for await (const c of req) raw += c; webhookMessages.push({ raw, signature: (req.headers['noren-signature'] as string) ?? null }); res.writeHead(200); res.end(); });
  try {
    await new Promise<void>(ok => merchantServer.listen(PORTS.server, '127.0.0.1', ok));
    await new Promise<void>(ok => webhookReceiver.listen(PORTS.webhook, '127.0.0.1', ok));
    const base = `http://127.0.0.1:${PORTS.server}`;
    const noren = createNoren({ server: base, token: merchantToken, merchant: operator.address });
    const post = async (path: string, value: unknown) => { const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: jsonBigints(value) }); const j = await r.json(); if (!r.ok) throw new Error(`${path}: ${j.error}`); return j; };
    const hook = await noren.webhooks.create(`http://127.0.0.1:${PORTS.webhook}/noren`);
    async function waitWebhook(type: string, invoiceId: string): Promise<WebhookEvent> {
      for (let i = 0; i < 300; i++) { for (const m of webhookMessages) { const e = await verifyWebhook(m.raw, m.signature, hook.secret); if (e.type === type && e.data.invoiceId === invoiceId) return e; } await new Promise(r => setTimeout(r, 100)); }
      throw new Error(`Timed out waiting for a verified ${type} webhook`);
    }

    // 3. Shield 5 USDC with Kohaku from the customer's own address.
    if (!state.done.shielded) {
      const allowance = await client.readContract({ address: deployment.usdc, abi: erc20Abi, functionName: 'allowance', args: [customerAccount.address, deployment.entrypoint] }) as bigint;
      if (allowance < SHIELD) await settle('customer approve Entrypoint', await custWallet.writeContract({ address: deployment.usdc, abi: erc20Abi, functionName: 'approve', args: [deployment.entrypoint, SHIELD] }));
      const [tx] = await customer.shield(SHIELD) as { to: Address; data: Hex }[];
      const r = await settle('shield 5 USDC (Entrypoint.deposit)', await custWallet.sendTransaction({ to: tx.to, data: tx.data }));
      const dep = r.logs.filter((l: any) => l.address.toLowerCase() === deployment.pool.toLowerCase()).map((l: any) => { try { return decodeEventLog({ abi: poolAbi, ...l }); } catch { return undefined; } }).find((e: any) => e?.eventName === 'Deposited') as any;
      if (!dep) throw new Error('No Deposited event in the shield transaction');
      state.done.shielded = { label: dep.args.label.toString(), value: dep.args.value.toString() }; saveState(state);
    }
    // 4. ASP approval: the postman scans Deposited logs, checks USDC.isBlacklisted(depositor), posts the root.
    for (let i = 0; ; i++) {
      await postman.tick(true);
      const rows = await customer.balance() as any[];
      if (rows.some(x => !x.tag && BigInt(x.amount) > 0n)) { say(`ASP approved the deposit; spendable shielded balance ${formatUnits(rows.filter(x => !x.tag).reduce((s, x) => s + BigInt(x.amount), 0n), 6)} USDC`); break; }
      if (i === 20) throw new Error(`Deposit not approved after 20 ASP ticks: ${jsonBigints(rows)}`);
      await new Promise(r => setTimeout(r, 3000));
    }

    // 5. A 2.50 USDC invoice, paid privately.
    let invoice = state.done.invoice as any as Invoice | undefined;
    if (!state.done.paid) {
      const created = await noren.invoices.create({ amount: INVOICE, expiresIn: 3600, description: 'Live Arc testnet: private checkout' });
      const refund = await customer.refundInbox();
      const opening = customer.createReceipt();
      const bound = await post(`/invoices/${created.invoice.invoiceId}/bind`, { refundPrecommitment: refund.nextPrecommitment, receiptCommitment: opening.commitment });
      invoice = { ...bound.invoice, amount: BigInt(bound.invoice.amount), expiry: BigInt(bound.invoice.expiry), refundPrecommitment: BigInt(bound.invoice.refundPrecommitment) } as Invoice;
      await customer.rememberReceipt(invoice, opening);
      state.done.invoice = JSON.parse(jsonBigints(invoice)); saveState(state);
      say(`invoice ${invoice.invoiceId} bound (2.50 USDC, refund precommitment and receipt commitment fixed)`);
      const p0 = performance.now();
      const proof = await customer.proveInvoicePayment(invoice);
      const proveSeconds = (performance.now() - p0) / 1000;
      say(`withdrawal proof made in Node with @noren/core (snarkjs groth16, same zk artifacts as the browser) in ${proveSeconds.toFixed(2)} s`);
      const payoutBefore = await usdc(payout);
      const paid = await post(`/invoices/${invoice.invoiceId}/pay`, proof);
      const r = await settle('pay 2.50 USDC (NorenCheckout.pay)', paid.paymentTx, `relayed by the merchant server; proof ${proveSeconds.toFixed(2)} s`);
      const ev = r.logs.filter((l: any) => l.address.toLowerCase() === deployment.checkout.toLowerCase()).map((l: any) => { try { return decodeEventLog({ abi: checkoutAbi, ...l }); } catch { return undefined; } }).find((e: any) => e?.eventName === 'Paid') as any;
      if (!ev || BigInt(ev.args.amount) !== INVOICE) throw new Error('No Paid event for 2.50 USDC');
      const gained = (await usdc(payout)) - payoutBefore;
      if (gained !== INVOICE) throw new Error(`Payout gained ${formatUnits(gained, 6)} USDC, expected 2.50`);
      await waitWebhook('payment.succeeded', invoice.invoiceId);
      say('signed payment.succeeded webhook verified (HMAC-SHA256)');
      state.done.paid = { tx: paid.paymentTx, proveSeconds: Number(proveSeconds.toFixed(2)), payoutGained: gained.toString(), payer: r.from }; saveState(state);
    }
    // 6. Refund 1.00 USDC into the customer's shielded refund inbox, then the ASP approves it.
    if (!state.done.refunded) {
      const returned = await noren.invoices.refund(invoice!.invoiceId, REFUND);
      await settle('refund approve (USDC.approve)', returned.approvalTx);
      await settle('refund 1.00 USDC (NorenCheckout.refund)', returned.refundTx);
      await waitWebhook('refund.succeeded', invoice!.invoiceId);
      say('signed refund.succeeded webhook verified');
      state.done.refunded = { approvalTx: returned.approvalTx, refundTx: returned.refundTx }; saveState(state);
    }
    for (let i = 0; ; i++) {
      await postman.tick(true);
      const inbox = await customer.refundInbox();
      const spendable = (inbox.balances as any[]).filter(x => !x.tag).reduce((s, x) => s + BigInt(x.amount), 0n);
      if (spendable >= REFUND) { say(`refund inbox: ${formatUnits(spendable, 6)} USDC spendable (ASP approved)`); break; }
      if (i === 20) throw new Error(`Refund not approved after 20 ASP ticks: ${jsonBigints(inbox.balances)}`);
      await new Promise(r => setTimeout(r, 3000));
    }
    const remaining = (await customer.balance() as any[]).filter(x => !x.tag).reduce((s, x) => s + BigInt(x.amount), 0n);
    const end = { operator: await usdc(operator.address), customer: await usdc(customerAccount.address), payout: await usdc(payout) };
    state.done.endBalances = end; state.done.shieldedRemaining = remaining.toString(); state.done.finishedAt = new Date().toISOString(); saveState(state);
    say(`shielded balance left in the pool: ${formatUnits(remaining, 6)} USDC`);
    say(`balances: operator ${formatUnits(end.operator, 6)}  customer ${formatUnits(end.customer, 6)}  payout ${formatUnits(end.payout, 6)} USDC`);
    say(`done: ${state.steps.length} transactions; record in ${stateFile}`);
  } finally {
    await new Promise<void>(r => merchantServer.close(() => r()));
    await new Promise<void>(r => aspServer.close(() => r()));
    await new Promise<void>(r => webhookReceiver.close(() => r()));
  }
}
if (process.argv[1]?.endsWith('e2e-live.ts')) main().then(() => process.exit(0)).catch(e => { console.error(e?.shortMessage ?? e?.message ?? e); process.exit(1); });
