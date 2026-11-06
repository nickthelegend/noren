/**
 * dev:all, "Settle to Arc": the bridge agent's value bridge (packages/bridge-settlement), wired into the local stack.
 *   1. The merchant requests a settlement of its USDG on NorenSettlementDesk (Robinhood).
 *   2. The settlement-desk CRE workflow (simulator, --broadcast) fetches live Relay and Across quotes, checks them against
 *      Chainlink USDG/USD and USDC/USD, and writes approve or reject through the forwarder.
 *   3. The keeper (packages/bridge-settlement/keeper) gets fresh Relay calldata and calls executeSettlement, which deposits
 *      the USDG into the real Relay Depository contract on the fork.
 *   4. The USDC fill on Arc needs a real Relay solver, which never sees a local fork: it stays "pending" and the UI says so.
 * The warmed Robinhood snapshot holds only the state Noren touched, so the Relay Depository's code is copied in from
 * Robinhood mainnet (eth_getCode, read-only) before the desk is deployed.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, encodeDeployData, encodeFunctionData, erc20Abi, http, parseAbi, parseAbiItem, toHex, type Address, type Hex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { creAccount, creSimulate, prepareWorkflow } from './cre.ts';
import { FORWARDER } from './dev-robinhood.ts';
import { ROBINHOOD } from '../packages/server/src/credit.ts';

const MNEMONIC = 'test test test test test test test test test test test junk';
const K = {
  usdgUsd: '0x61B7e5650328764B076A108EFF5fa7282a1B9aD2' as Address,
  relay: '0x4cD00E387622C35bDDB9b4c962C136462338BC31' as Address,
  across: '0xD29C85F15DF544bA632C9E25829fd29d767d7978' as Address,
  arcUsdc: '0x3600000000000000000000000000000000000000' as Address,
  router: '0x8876789976dEcBfCbBbe364623C63652db8C0904' as Address,
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3' as Address,
};
export const deskAbi = parseAbi([
  'function requestSettlement(uint256 amountUsdg6, address arcRecipient, uint16 maxSlippageBps) returns (bytes32 id)',
  'function settlement(bytes32 id) view returns ((address merchant, uint64 requestedAt, uint16 maxSlippageBps, uint8 status, uint8 route, address arcRecipient, uint64 validUntil, uint256 amountUsdg6, uint256 minOutUsdc6, uint256 quotedOutUsdc6))',
  'function executeSettlement(bytes32 id, uint8 route, bytes data)',
  'event SettlementRequested(bytes32 indexed id, address indexed merchant, address arcRecipient, uint256 amountUsdg6, uint16 maxSlippageBps)',
  'event SettlementApproved(bytes32 indexed id, uint8 route, uint256 minOutUsdc6, uint256 quotedOutUsdc6, uint256 usdgUsd8, uint256 usdcUsd8, uint64 validUntil)',
  'event SettlementRejected(bytes32 indexed id, uint256 bestQuotedOutUsdc6, uint256 fairOutUsdc6)',
  'event SettlementExecuted(bytes32 indexed id, uint8 route, address target, bytes32 orderRef, uint256 minOutUsdc6)',
]);
export type SettlementEntry = {
  id: Hex; merchant: Address; amountUsdg6: string; arcRecipient: Address; requestTx: Hex; requestedAt: number;
  quotes?: { relay?: string; across?: string }; cre?: { written?: Hex; ms: number; decision?: string; error?: string };
  status: 'requested' | 'approved' | 'rejected' | 'executed' | 'failed';
  approved?: { minOutUsdc6: string; quotedOutUsdc6: string; usdgUsd8: string; usdcUsd8: string };
  deposit?: { route: 'relay'; tx: Hex; target: Address; quotedOutUsdc6: string; relayRequestId?: string; feeUsd?: string; gasUsed: string };
  fill: 'pending a real relayer (local fork)' | 'not started'; error?: string;
};

async function rpc(url: string, method: string, params: unknown[] = []) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json(); if (j.error) throw new Error(`${method}: ${j.error.message}`); return j.result;
}

/** Deploys NorenSettlementDesk on the Robinhood node. Call before the node's chain id changes (Anvil's signer keeps it). */
export async function deploySettlementDesk(robinhoodRpc: string) {
  const code = await rpc(ROBINHOOD.rpc, 'eth_getCode', [K.relay, 'latest']) as Hex;
  if (!code || code === '0x') throw new Error('Relay Depository has no code on Robinhood mainnet');
  await rpc(robinhoodRpc, 'anvil_setCode', [K.relay, code]);
  const owner = mnemonicToAccount(MNEMONIC, { addressIndex: 0 }), keeper = mnemonicToAccount(MNEMONIC, { addressIndex: 4 });
  const { execFileSync } = await import('node:child_process');
  execFileSync('forge', ['build'], { cwd: resolve('packages/bridge-settlement'), stdio: ['ignore', 'ignore', 'inherit'] });
  const art = JSON.parse(readFileSync(resolve('packages/bridge-settlement/out/NorenSettlementDesk.sol/NorenSettlementDesk.json'), 'utf8'));
  const data = encodeDeployData({ abi: art.abi, bytecode: art.bytecode.object as Hex, args: [ROBINHOOD.usdg, K.usdgUsd, K.relay, K.across, K.arcUsdc, K.router, K.permit2, FORWARDER.robinhood, keeper.address, owner.address] });
  const c: any = createPublicClient({ transport: http(robinhoodRpc), cacheTime: 0 });
  const hash = await rpc(robinhoodRpc, 'eth_sendTransaction', [{ from: owner.address, data }]) as Hex;
  const r = await c.waitForTransactionReceipt({ hash });
  if (r.status !== 'success' || !r.contractAddress) throw new Error(`NorenSettlementDesk deploy reverted: ${hash}`);
  await rpc(robinhoodRpc, 'anvil_setBalance', [keeper.address, toHex(10n ** 19n)]);
  return { desk: r.contractAddress as Address, deployBlock: r.blockNumber as bigint, keeper };
}

/** Merchant-side request, sent as the (impersonated) merchant account on the dev fork. */
export async function requestSettlement(robinhoodRpc: string, desk: Address, merchant: Address, amountUsdg6: bigint, arcRecipient: Address) {
  const c: any = createPublicClient({ transport: http(robinhoodRpc), cacheTime: 0 });
  const have: bigint = await c.readContract({ address: ROBINHOOD.usdg, abi: erc20Abi, functionName: 'balanceOf', args: [merchant] });
  if (amountUsdg6 <= 0n || amountUsdg6 > have) throw new Error(`Amount must be between 0 and your ${Number(have) / 1e6} USDG`);
  await rpc(robinhoodRpc, 'anvil_impersonateAccount', [merchant]);
  const send = async (to: Address, data: Hex) => { const h = await rpc(robinhoodRpc, 'eth_sendTransaction', [{ from: merchant, to, data }]) as Hex; const r = await c.waitForTransactionReceipt({ hash: h }); if (r.status !== 'success') throw new Error(`reverted: ${h}`); return h; };
  await send(ROBINHOOD.usdg, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [desk, amountUsdg6] }));
  return send(desk, encodeFunctionData({ abi: deskAbi, functionName: 'requestSettlement', args: [amountUsdg6, arcRecipient, 100] }));
}

/** Watches SettlementRequested, runs the CRE settlement-desk workflow, then the keeper's Relay deposit. */
export function startSettlementRelay(opts: { robinhoodRpc: string; desk: Address; fromBlock: bigint; keeper: ReturnType<typeof mnemonicToAccount> }) {
  const dir = prepareWorkflow('packages/bridge-settlement/cre/settlement-desk');
  const base = JSON.parse(readFileSync(resolve(dir, 'config.staging.json'), 'utf8'));
  const config = { ...base, desk: { ...base.desk, address: opts.desk } };
  const c: any = createPublicClient({ transport: http(opts.robinhoodRpc), cacheTime: 0 });
  const entries = new Map<string, SettlementEntry>();
  let next = opts.fromBlock, busy = false, stopped = false;
  const requested = parseAbiItem('event SettlementRequested(bytes32 indexed id, address indexed merchant, address arcRecipient, uint256 amountUsdg6, uint16 maxSlippageBps)');

  async function handle(l: any) {
    const id = l.args.id as Hex;
    const e: SettlementEntry = { id, merchant: l.args.merchant, amountUsdg6: String(l.args.amountUsdg6), arcRecipient: l.args.arcRecipient, requestTx: l.transactionHash, requestedAt: Math.floor(Date.now() / 1000), status: 'requested', fill: 'not started' };
    entries.set(id.toLowerCase(), e);
    const t0 = Date.now();
    try {
      await rpc(opts.robinhoodRpc, 'anvil_setBalance', [creAccount.address, toHex(10n ** 20n)]);
      const out = await creSimulate({ workflowDir: dir, target: 'local-fork', rpcs: { 'robinhood-testnet': opts.robinhoodRpc }, config, broadcast: true, triggerIndex: 0, txHash: l.transactionHash, eventIndex: Number(l.logIndex) });
      e.quotes = { relay: /Relay quote: (.*)/.exec(out)?.[1]?.trim(), across: /Across quote: (.*)/.exec(out)?.[1]?.trim() };
      e.cre = { written: /NorenSettlementDesk updated on [a-z-]+: tx (0x[0-9a-f]{64})/.exec(out)?.[1] as Hex | undefined, ms: Date.now() - t0, decision: /Decision: (.*)/.exec(out)?.[1]?.trim() };
    } catch (err: any) { e.cre = { ms: Date.now() - t0, error: String(err.message).slice(-300) }; e.status = 'failed'; e.error = 'CRE settlement workflow failed'; return; }
    const s = await c.readContract({ address: opts.desk, abi: deskAbi, functionName: 'settlement', args: [id] });
    if (Number(s.status) !== 2) { e.status = 'rejected'; return; }
    e.status = 'approved';
    const [ap] = await c.getLogs({ address: opts.desk, event: deskAbi[4], args: { id }, fromBlock: opts.fromBlock });
    if (ap) e.approved = { minOutUsdc6: String(ap.args.minOutUsdc6), quotedOutUsdc6: String(ap.args.quotedOutUsdc6), usdgUsd8: String(ap.args.usdgUsd8), usdcUsd8: String(ap.args.usdcUsd8) };
    // The keeper must use the route the workflow approved. Only the Relay Depository is mirrored onto the snapshot node;
    // the Across SpokePool (a proxy with much more state) is not, so an Across approval is shown but not deposited here.
    if (Number(s.route) !== 1) { e.fill = 'not started'; e.error = 'CRE approved Across. The Across SpokePool is not on this snapshot node, so the keeper stops here; packages/bridge-settlement/scripts/fork-settle.sh runs the Across deposit on a live fork.'; return; }
    try {
      const { relayDeposit, meetsMinimum } = await import('../packages/bridge-settlement/keeper/lib.ts');
      const approved = { desk: opts.desk, arcRecipient: s.arcRecipient as Address, amountUsdg6: s.amountUsdg6 as bigint, minOutUsdc6: s.minOutUsdc6 as bigint };
      const d = await relayDeposit(approved);
      meetsMinimum(d, approved);
      const chain = { id: Number(await c.getChainId()), name: 'Robinhood (local)', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [opts.robinhoodRpc] } } } as const;
      const w = createWalletClient({ account: opts.keeper, chain, transport: http(opts.robinhoodRpc) });
      const hash = await w.writeContract({ address: opts.desk, abi: deskAbi, functionName: 'executeSettlement', args: [id, 1, d.data] });
      const r = await c.waitForTransactionReceipt({ hash });
      if (r.status !== 'success') throw new Error(`executeSettlement reverted: ${hash}`);
      e.deposit = { route: 'relay', tx: hash, target: d.to, quotedOutUsdc6: d.quotedOutUsdc6.toString(), relayRequestId: d.ref || undefined, feeUsd: d.feeUsd, gasUsed: r.gasUsed.toString() };
      e.status = 'executed'; e.fill = 'pending a real relayer (local fork)';
    } catch (err: any) { e.status = 'failed'; e.error = `Keeper: ${String(err.message).slice(0, 240)}`; }
    console.log(`Settle to Arc ${id.slice(0, 10)}…: ${e.status}${e.deposit ? ` (Relay deposit ${e.deposit.tx})` : e.error ? ` (${e.error})` : ''}`);
  }

  async function tick() {
    if (busy || stopped) return; busy = true;
    try {
      const head: bigint = await c.getBlockNumber();
      if (next <= head) { const logs = await c.getLogs({ address: opts.desk, event: requested, fromBlock: next, toBlock: head }); next = head + 1n; for (const l of logs) await handle(l); }
    } catch (e: any) { console.error('Settle to Arc relay:', e.message); } finally { busy = false; }
  }
  const timer = setInterval(tick, 2000);
  return { list: () => [...entries.values()].reverse(), stop: () => { stopped = true; clearInterval(timer); } };
}
