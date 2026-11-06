/**
 * `pnpm e2e:credit`: the pay-with-stocks and pay-later flows, end to end, against a running `pnpm dev:all`.
 *   1. fork faucet: real NVDA + USDG to a fresh borrower on the Robinhood fork
 *   2. EIP-712 credit attestation from the history underwriter (a wallet holding stock gets at least the collateral-only tier)
 *   3. NorenCredit.applyAttestation + openCreditLine on Robinhood (NVDA collateral at the Chainlink price)
 *   4. CRE bridge (simulator, --broadcast) writes the limit to NorenCreditLine on Arc
 *   5. a Noren invoice is paid later from the line on Arc; the merchant server settles it (method "credit")
 *   6. a second invoice is paid with NVDA through NorenGateway; the server settles it (method "stocks")
 *   7. CRE bridge carries Drawn back to NorenCredit on Robinhood
 *   8. the borrower repays half on Arc; CRE carries Repaid back
 * Every chain is a local Anvil fork; borrower keys are fresh random keys; nothing touches a public chain.
 */
import { createPublicClient, createWalletClient, erc20Abi, http, parseAbi, parseAbiItem, parseUnits, toHex, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { localFork } from '@noren/core';
import { ROBINHOOD } from '../packages/server/src/credit.ts';

const SERVER = 'http://127.0.0.1:8790';
const token = process.env.NOREN_MERCHANT_TOKEN;
if (!token) throw new Error('Setup required: NOREN_MERCHANT_TOKEN (the token pnpm dev:all printed)');
const t0 = Date.now(), at = () => `${((Date.now() - t0) / 1000).toFixed(1)} s`;
const results: [string, string][] = [];
const ok = (step: string, detail: string) => { results.push([step, detail]); console.log(`✓ ${step} (${at()}): ${detail}`); };
const json = async (path: string, init?: RequestInit) => { const r = await fetch(SERVER + path, init); const j = await r.json(); if (!r.ok) throw new Error(`${path}: ${j.error}`); return j; };
async function until<T>(what: string, f: () => Promise<T | undefined | null | false>, ms = 120_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await f().catch(() => undefined); if (v) return v; if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 1000)); }
}

const cfg = await json('/config');
const c = cfg.credit;
if (!c?.creditLine || !c?.creditContract || !c?.gateway || !c?.robinhoodRpc) throw new Error('Setup required: start pnpm dev:all with the Robinhood contracts, NorenCreditLine and the CRE bridge');
const rhChain = { id: c.robinhoodChainId, name: 'Robinhood fork', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [c.robinhoodRpc] } } } as const;
const arcChain = localFork(cfg.rpcUrl);
const rh: any = createPublicClient({ chain: rhChain, transport: http(c.robinhoodRpc, { timeout: 60_000 }), cacheTime: 0 });
const arc: any = createPublicClient({ chain: arcChain, transport: http(cfg.rpcUrl), cacheTime: 0 });
const borrower = privateKeyToAccount(generatePrivateKey());
const rhW = createWalletClient({ chain: rhChain, transport: http(c.robinhoodRpc, { timeout: 60_000 }), account: borrower });
const arcW = createWalletClient({ chain: arcChain, transport: http(cfg.rpcUrl), account: borrower });
const send = async (w: any, pub: any, req: any) => { const hash = await w.writeContract(req); const r = await pub.waitForTransactionReceipt({ hash }); if (r.status !== 'success') throw new Error(`${req.functionName} reverted: ${hash}`); return { hash: hash as Hex, gas: r.gasUsed as bigint }; };

const creditAbi = parseAbi([
  'function applyAttestation((address borrower,uint8 tier,uint256 limitUsdg,uint16 collateralRatioBps,uint256 nonce,uint64 expiry) a, bytes signature)',
  'function attestationNonce(address) view returns (uint256)',
  'function creditTerms(address) view returns (uint8 tier, uint256 limitUsdg, uint16 ratioBps, uint256 availableUsdg)',
  'function openCreditLine(address collateral, uint256 collateralAmount, uint256 limitUsdc6, uint64 expiry) payable returns (bytes32)',
  'function line(bytes32) view returns ((address borrower,address collateral,uint64 expiry,uint64 asOf,uint64 closeRequestedAt,uint8 status,uint256 collateralAmount,uint256 limitUsdc,uint256 drawn,uint256 repaid))',
  'event CreditLineOpened(address indexed borrower, bytes32 indexed lineId, uint256 limitUsdc6, uint64 expiry, uint256 collateralValueUsd8)',
]);
const lineAbi = parseAbi([
  'function lines(bytes32) view returns ((address borrower,uint64 expiry,uint64 updatedAt,bool closed,uint256 limitUsdc6,uint256 drawnUsdc6,uint256 repaidUsdc6))',
  'function payInvoice(bytes32 lineId, address merchant, uint256 amount, bytes32 invoiceId)', 'function repay(bytes32 lineId, uint256 amount)',
]);
const gatewayAbi = parseAbi(['function quote(address merchant, bytes32 invoiceId, address asset) view returns (uint256 assetIn, uint256 priceUsd8, bool marketClosed)', 'function pay(bytes32 invoiceId, address merchant, address asset, uint256 maxAssetIn) payable returns (uint256)']);

// 1. faucet
const f = await json('/dev/robinhood-faucet', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: borrower.address }) });
ok('Robinhood fork faucet', `3 NVDA (tx ${f.NVDA}) and 120 USDG (tx ${f.USDG}) moved from real mainnet holders to fresh borrower ${borrower.address}`);

// 2. attestation
const nonce = await rh.readContract({ address: c.creditContract, abi: creditAbi, functionName: 'attestationNonce', args: [borrower.address] });
if (!c.underwriterUrl) throw new Error('Setup required: the history underwriter is not running (pnpm dev:all with packages/robinhood/underwriter)');
const r = await fetch(`${c.underwriterUrl}/attest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ borrower: borrower.address }) }).then(r => r.json());
if (r.declined || !r.attestation) throw new Error(`Underwriter declined the borrower: ${r.reason ?? r.error}`);
const attestation = { ...r.attestation, limitUsdg: BigInt(r.attestation.limitUsdg), nonce: BigInt(r.attestation.nonce), expiry: BigInt(r.attestation.expiry) };
const signature: Hex = r.signature;
const signer = `underwriter service ${r.signer}${r.score ? `, score ${r.score.score}/100` : ''}${r.zg ? `, 0G: ${r.zg.status ?? r.zg.source ?? 'see decision'}` : ''}`;
void nonce;
const applied = await send(rhW, rh, { address: c.creditContract, abi: creditAbi, functionName: 'applyAttestation', args: [attestation, signature] });
const terms = await rh.readContract({ address: c.creditContract, abi: creditAbi, functionName: 'creditTerms', args: [borrower.address] });
ok('EIP-712 attestation verified on-chain', `tier ${terms[0]}, collateral ratio ${terms[2] / 100}%, signed by ${signer}; applyAttestation tx ${applied.hash}`);

// 3. open the line: 2 NVDA at the Chainlink price
const collateral = parseUnits('2', 18);
await send(rhW, rh, { address: ROBINHOOD.stocks.NVDA, abi: erc20Abi, functionName: 'approve', args: [c.creditContract, collateral] });
const limit = 150_000_000n, expiry = BigInt(Math.floor(Date.now() / 1000) + 30 * 86400);
const opened = await send(rhW, rh, { address: c.creditContract, abi: creditAbi, functionName: 'openCreditLine', args: [ROBINHOOD.stocks.NVDA, collateral, limit, expiry] });
const [ev] = await rh.getLogs({ address: c.creditContract, event: parseAbiItem('event CreditLineOpened(address indexed borrower, bytes32 indexed lineId, uint256 limitUsdc6, uint64 expiry, uint256 collateralValueUsd8)'), args: { borrower: borrower.address }, fromBlock: BigInt(c.robinhoodFromBlock) });
const lineId: Hex = ev.args.lineId;
ok('Credit line opened on Robinhood', `2 NVDA locked (collateral $${(Number(ev.args.collateralValueUsd8) / 1e8).toFixed(2)} at Chainlink), limit 150 USDC, line ${lineId}, tx ${opened.hash}`);

// 4. CRE: Robinhood → Arc
const tOpen = Date.now();
await until('the CRE bridge to sync the line to Arc', async () => (await arc.readContract({ address: c.creditLine, abi: lineAbi, functionName: 'lines', args: [lineId] })).limitUsdc6 === limit);
const bridge1 = await until('the CRE bridge log entry', async () => (await json('/credit/bridge')).find((e: any) => e.source === opened.hash && e.written), 30_000);
ok('CRE bridge → Arc', `NorenCreditLine limit 150 USDC after ${((Date.now() - tOpen) / 1000).toFixed(1)} s; forwarder tx ${bridge1.written} (${(bridge1.ms / 1000).toFixed(1)} s in the CRE simulator)`);

// 5. pay later on Arc
const merchant = cfg.merchant as Address;
const expiryInv = String(Math.floor(Date.now() / 1000) + 3600);
const inv = await json(`/merchants/${merchant}/invoices`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ amount: '7500000', expiry: expiryInv, description: 'Pour-over, beans to go' }) });
const invoiceId: Hex = inv.invoice.invoiceId;
await arc.request({ method: 'anvil_setBalance', params: [borrower.address, toHex(10n ** 18n)] });
const drawTx = await send(arcW, arc, { address: c.creditLine, abi: lineAbi, functionName: 'payInvoice', args: [lineId, merchant, 7_500_000n, invoiceId] });
const settled = await until('the merchant server to settle the credit payment', async () => { const r = await json(`/invoices/${invoiceId}`); return r.status === 'paid' && r.method === 'credit' && r; });
ok('Pay later: invoice settled', `7.50 USDC drawn on Arc (tx ${drawTx.hash}, ${drawTx.gas} gas); server marked ${invoiceId.slice(0, 10)}… paid, method ${settled.method}`);

// 8. pay with stocks
const inv2 = await json(`/merchants/${merchant}/invoices`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ amount: '7500000', expiry: expiryInv, description: 'Ceramic mug' }) });
const id2: Hex = inv2.invoice.invoiceId;
const m = await json(`/invoices/${id2}/robinhood`, { method: 'POST' });
const [assetIn, priceUsd8] = await rh.readContract({ address: m.gateway, abi: gatewayAbi, functionName: 'quote', args: [m.merchant, id2, ROBINHOOD.stocks.NVDA] }); // quote() follows the same route as pay()
const max = assetIn + assetIn / 100n;
await send(rhW, rh, { address: ROBINHOOD.stocks.NVDA, abi: erc20Abi, functionName: 'approve', args: [m.gateway, max] });
const payTx = await send(rhW, rh, { address: m.gateway, abi: gatewayAbi, functionName: 'pay', args: [id2, m.merchant, ROBINHOOD.stocks.NVDA, max] });
const s2 = await until('the merchant server to settle the stock payment', async () => { const r = await json(`/invoices/${id2}`); return r.status === 'paid' && r.method === 'stocks' && r; });
ok('Pay with stocks: invoice settled', `${(Number(assetIn) / 1e18).toFixed(6)} NVDA at $${(Number(priceUsd8) / 1e8).toFixed(2)} (tx ${payTx.hash}); merchant received ${(Number(s2.stock.usdgOut) / 1e6).toFixed(2)} USDG via ${s2.stock.route === 'aqua-maker' ? `a 1inch Aqua maker (fee ${(Number(s2.stock.makerFeeUsdg) / 1e6).toFixed(4)} USDG)` : 'the vault'}; server method ${s2.method}`);

// 6. CRE: Arc Drawn → Robinhood
await until('Drawn to reach NorenCredit', async () => (await rh.readContract({ address: c.creditContract, abi: creditAbi, functionName: 'line', args: [lineId] })).drawn === 7_500_000n);
const bridge2 = await until('the CRE bridge log entry', async () => (await json('/credit/bridge')).find((e: any) => e.source === drawTx.hash && e.written), 30_000);
ok('CRE bridge → Robinhood (Drawn)', `NorenCredit line drawn = 7.50 USDC; forwarder tx ${bridge2.written}`);

// 7. repay half on Arc
await arc.request({ method: 'eth_sendTransaction', params: [{ from: cfg.merchant, to: cfg.deployment.usdc, data: (await import('viem')).encodeFunctionData({ abi: parseAbi(['function mint(address,uint256)']), functionName: 'mint', args: [borrower.address, 10_000_000n] }) }] });
await send(arcW, arc, { address: cfg.deployment.usdc, abi: erc20Abi, functionName: 'approve', args: [c.creditLine, 3_750_000n] });
const repayTx = await send(arcW, arc, { address: c.creditLine, abi: lineAbi, functionName: 'repay', args: [lineId, 3_750_000n] });
await until('Repaid to reach NorenCredit', async () => (await rh.readContract({ address: c.creditContract, abi: creditAbi, functionName: 'line', args: [lineId] })).repaid === 3_750_000n);
const bridge3 = await until('the CRE bridge log entry', async () => (await json('/credit/bridge')).find((e: any) => e.source === repayTx.hash && e.written), 30_000);
ok('Repay + CRE bridge → Robinhood (Repaid)', `3.75 USDC repaid on Arc (tx ${repayTx.hash}); NorenCredit repaid = 3.75 USDC; forwarder tx ${bridge3.written}`);

console.log(`\nAll ${results.length} steps passed in ${at()} (local forks only).`);
