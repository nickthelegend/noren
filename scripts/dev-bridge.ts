/**
 * dev:all, credit bridge: runs the cre-bridge workflow (packages/cre-bridge, unchanged) in the CRE simulator for every
 * bridge event on the local forks, with --broadcast, so each write goes report -> MockKeystoneForwarder -> onReport:
 *   handler 0  Robinhood CreditLineOpened  -> Arc NorenCreditLine.onReport (limit)
 *   handler 1  Robinhood CreditLineClosed  -> Arc NorenCreditLine.onReport (limit 0, frozen)
 *   handler 2  Arc Drawn / Repaid          -> Robinhood NorenCredit.onReport (utilisation)
 * The simulator only knows Robinhood *testnet*, so the Robinhood mainnet fork is served as chain 46630 and the real
 * robinhood-testnet MockKeystoneForwarder (code + its two storage slots) is copied onto it, as the bridge's own
 * fork-simulate.sh does.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, encodeAbiParameters, http, keccak256, parseAbiItem, toHex, type Address, type Hex } from 'viem';
import { creAccount, creSimulate, prepareWorkflow } from './cre.ts';
import { FORWARDER } from './dev-robinhood.ts';

const WORKFLOW = 'packages/cre-bridge/credit-bridge';
const RH_TESTNET = 'https://rpc.testnet.chain.robinhood.com';
export type BridgeEntry = { at: number; handler: 0 | 1 | 2; event: string; source: Hex; lineId: Hex; written?: Hex; skipped?: string; error?: string; ms: number };

async function rpc(url: string, method: string, params: unknown[] = []) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json(); if (j.error) throw new Error(`${method}: ${j.error.message}`); return j.result;
}

/** Serves the Robinhood fork under chain 46630 and installs the real robinhood-testnet MockKeystoneForwarder. */
export async function prepareRobinhoodForCre(robinhoodRpc: string) {
  await rpc(robinhoodRpc, 'anvil_setChainId', [46630]);
  const code = await rpc(RH_TESTNET, 'eth_getCode', [FORWARDER.robinhood, 'latest']) as Hex;
  if (!code || code === '0x') throw new Error('robinhood-testnet MockKeystoneForwarder not found on Robinhood Testnet');
  await rpc(robinhoodRpc, 'anvil_setCode', [FORWARDER.robinhood, code]);
  const selfSlot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [FORWARDER.robinhood, 2n])); // s_forwarders[self]
  for (const slot of [toHex(0n, { size: 32 }), selfSlot]) await rpc(robinhoodRpc, 'anvil_setStorageAt', [FORWARDER.robinhood, slot, await rpc(RH_TESTNET, 'eth_getStorageAt', [FORWARDER.robinhood, slot, 'latest'])]);
  await rpc(robinhoodRpc, 'anvil_setBalance', [creAccount.address, toHex(10n ** 20n)]);
}

const opened = parseAbiItem('event CreditLineOpened(address indexed borrower, bytes32 indexed lineId, uint256 limitUsdc6, uint64 expiry, uint256 collateralValueUsd8)');
const closed = parseAbiItem('event CreditLineClosed(bytes32 indexed lineId)');
const drawn = parseAbiItem('event Drawn(bytes32 indexed lineId, uint256 amount, bytes32 invoiceId, address merchant)');
const repaid = parseAbiItem('event Repaid(bytes32 indexed lineId, uint256 amount)');

/** Polls both forks and runs the workflow once per event, in order. Returns the log and a stop function. */
export function startBridgeRelay(opts: { arcRpc: string; robinhoodRpc: string; credit: Address; creditLine: Address; arcFrom: bigint; rhFrom: bigint }) {
  const dir = prepareWorkflow(WORKFLOW);
  const base = JSON.parse(readFileSync(resolve(dir, 'config.staging.json'), 'utf8'));
  const config = { ...base, robinhood: { ...base.robinhood, address: opts.credit }, arc: { ...base.arc, address: opts.creditLine } };
  const rpcs = { 'arc-testnet': opts.arcRpc, 'robinhood-testnet': opts.robinhoodRpc };
  const arc: any = createPublicClient({ transport: http(opts.arcRpc), cacheTime: 0 });
  const rh: any = createPublicClient({ transport: http(opts.robinhoodRpc), cacheTime: 0 });
  const log: BridgeEntry[] = [];
  let nextArc = opts.arcFrom, nextRh = opts.rhFrom, busy = false, stopped = false;

  async function relay(handler: 0 | 1 | 2, event: string, l: any) {
    const t0 = Date.now();
    const entry: BridgeEntry = { at: Math.floor(t0 / 1000), handler, event, source: l.transactionHash, lineId: l.args.lineId, ms: 0 };
    try {
      const out = await creSimulate({ workflowDir: dir, target: 'local-fork', rpcs, config, broadcast: true, triggerIndex: handler, txHash: l.transactionHash, eventIndex: Number(l.logIndex) });
      entry.written = /updated on [a-z-]+: tx (0x[0-9a-f]{64})/.exec(out)?.[1] as Hex | undefined;
      if (!entry.written) entry.skipped = /No write: (.*)/.exec(out)?.[1]?.trim() ?? 'no write reported';
    } catch (e: any) { entry.error = e.message.slice(-300); }
    entry.ms = Date.now() - t0;
    log.unshift(entry); log.length = Math.min(log.length, 100);
    console.log(`CRE bridge: ${event} ${l.transactionHash.slice(0, 10)}… → handler ${handler}: ${entry.written ? `wrote ${entry.written}` : entry.skipped ?? entry.error} (${(entry.ms / 1000).toFixed(1)} s)`);
  }

  async function tick() {
    if (busy || stopped) return; busy = true;
    try {
      const [rhHead, arcHead]: bigint[] = await Promise.all([rh.getBlockNumber(), arc.getBlockNumber()]);
      const events: [bigint, number, 0 | 1 | 2, string, any][] = [];
      if (nextRh <= rhHead) {
        for (const l of await rh.getLogs({ address: opts.credit, event: opened, fromBlock: nextRh, toBlock: rhHead })) events.push([0n, Number(l.blockNumber), 0, 'CreditLineOpened', l]);
        for (const l of await rh.getLogs({ address: opts.credit, event: closed, fromBlock: nextRh, toBlock: rhHead })) events.push([0n, Number(l.blockNumber), 1, 'CreditLineClosed', l]);
        nextRh = rhHead + 1n;
      }
      if (nextArc <= arcHead) {
        for (const l of await arc.getLogs({ address: opts.creditLine, event: drawn, fromBlock: nextArc, toBlock: arcHead })) events.push([1n, Number(l.blockNumber), 2, 'Drawn', l]);
        for (const l of await arc.getLogs({ address: opts.creditLine, event: repaid, fromBlock: nextArc, toBlock: arcHead })) events.push([1n, Number(l.blockNumber), 2, 'Repaid', l]);
        nextArc = arcHead + 1n;
      }
      events.sort((a, b) => (a[0] === b[0] ? a[1] - b[1] || Number(a[4].logIndex) - Number(b[4].logIndex) : 0));
      for (const [, , h, name, l] of events) { if (stopped) break; await relay(h, name, l); }
    } catch (e: any) { console.error('CRE bridge relay:', e.message); } finally { busy = false; }
  }
  const timer = setInterval(tick, 2000);
  return { log, stop: () => { stopped = true; clearInterval(timer); } };
}
