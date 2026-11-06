/** Fork-only cross-chain Aqua deployment and CRE courier for dev:all. */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, http, keccak256, parseAbi, toEventSelector, toHex, zeroAddress, type Address, type Hex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { creAccount, creSimulate, prepareWorkflow } from './cre.ts';

const exec = promisify(execFile);
const root = resolve('packages/xchain-aqua');
const contracts = resolve(root, 'contracts');
const workflow = resolve(root, 'cre/xchain-aqua');
const out = resolve(root, '.fork');
const mnemonic = 'test test test test test test test test test test test junk';
const account = (index: number) => mnemonicToAccount(mnemonic, { addressIndex: index });
const aqua = '0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a' as Address;
const officialRouter = '0x111111338c5091E8440b67B168bAe16a668AC0De' as Address;
const usdc = '0x3600000000000000000000000000000000000000' as Address;
const nvda = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC' as Address;
const feed = '0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15' as Address;
const forwarder = '0x0b93082D9b3C7C97fAcd250082899BAcf3af3885' as Address;
const mainnet = 'https://arc-rpc.publicnode.com';
const event = 'event XChainMessage(bytes32 indexed orderId, uint64 indexed toChainId, address indexed to, bytes payload)';
const topic = toEventSelector('XChainMessage(bytes32,uint64,address,bytes)');
const erc20 = parseAbi(['function mint(address,uint256)', 'function balanceOf(address) view returns (uint256)']);
const settlerAbi = parseAbi(['function setEscrow(uint64,address)']);

export type XChainDev = {
  settler: Address; router: Address; escrow: Address; rNVDA: Address; nvdaRoute: Hex; strategyHash: Hex;
  maker: Address; payout: Address; tokenIn: Address; srcChainId: number; deployBlockArc: bigint; deployBlockRh: bigint;
};
export type XChainEntry = {
  at: number; chain: 'robinhood' | 'arc'; kind: string; orderId: Hex; source: Hex;
  written?: Hex; skipped?: string; error?: string; ms: number;
};

async function rpc(url: string, method: string, params: unknown[] = []) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
  const json = await response.json();
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result;
}

async function forge(args: string[], env: Record<string, string> = {}) {
  try {
    const result = await exec('forge', args, { cwd: contracts, env: { ...process.env, ...env }, maxBuffer: 8 * 1024 * 1024 });
    return result.stdout;
  } catch (e: any) {
    if (e.code === 'ENOENT') throw new Error('Setup required: forge is not on PATH');
    throw new Error(`forge ${args[0]} failed: ${String(e.stderr ?? e.message).slice(-1200)}`);
  }
}

async function installOfficialCode(arcRpc: string) {
  const arc = createPublicClient({ transport: http(arcRpc) });
  for (const address of [aqua, officialRouter]) {
    let code: Hex | undefined;
    try { code = await (createPublicClient({ transport: http(mainnet) })).getBytecode({ address }); }
    catch (e: any) { throw new Error(`Setup required: Arc mainnet RPC unreachable (${String(e.message).slice(0, 160)})`); }
    if (!code || code === '0x') throw new Error(`Setup required: official 1inch bytecode missing at ${address} on Arc mainnet`);
    const current = await arc.getBytecode({ address });
    if (!current || current === '0x') await rpc(arcRpc, 'anvil_setCode', [address, code]);
    const installed = await arc.getBytecode({ address });
    if (!installed || keccak256(installed) !== keccak256(code)) throw new Error(`fork-only 1inch codehash mismatch at ${address}`);
    console.log(`Cross-chain Aqua (fork): official ${address} codehash ${keccak256(code)}`);
  }
  const slot = toHex(2n, { size: 32 });
  const value = await rpc(mainnet, 'eth_getStorageAt', [officialRouter, slot, 'latest']).catch((e: any) => { throw new Error(`Setup required: Arc mainnet RPC unreachable (${e.message})`); });
  await rpc(arcRpc, 'anvil_setStorageAt', [officialRouter, slot, value]);
}

export async function deployXChain(opts: { arcRpc: string; robinhoodRpc: string }): Promise<XChainDev> {
  if (!existsSync(resolve('packages/robinhood/.fork/robinhood-snapshot.json'))) throw new Error('Setup required: warmed Robinhood snapshot is missing');
  const arc = createPublicClient({ transport: http(opts.arcRpc), cacheTime: 0 });
  const rh = createPublicClient({ transport: http(opts.robinhoodRpc), cacheTime: 0 });
  const srcChainId = await rh.getChainId();
  if (srcChainId !== 46630) throw new Error(`Setup required: Robinhood fork must be chain 46630 for CRE (got ${srcChainId})`);
  const deployBlockArc = await arc.getBlockNumber();
  const deployBlockRh = await rh.getBlockNumber();
  mkdirSync(out, { recursive: true });
  await installOfficialCode(opts.arcRpc);
  const artifact = resolve('packages/aqua/swapvm-ext/out/NorenAquaSwapVMRouter.sol/NorenAquaSwapVMRouter.json');
  if (!existsSync(artifact)) {
    console.log('Cross-chain Aqua (fork): building SwapVM router artifact; this may take a few minutes');
    try { await exec('forge', ['build'], { cwd: resolve('packages/aqua/swapvm-ext'), maxBuffer: 8 * 1024 * 1024 }); }
    catch (e: any) { if (e.code === 'ENOENT') throw new Error('Setup required: forge is not on PATH'); throw new Error(`SwapVM forge build failed: ${String(e.stderr ?? e.message).slice(-1200)}`); }
    if (!existsSync(artifact)) throw new Error('Setup required: SwapVM router artifact was not produced by forge build');
  }
  const key = (i: number) => toHex(account(i).getHdKey().privateKey!);
  const script = 'script/DeployXChain.s.sol';
  console.log(`Cross-chain Aqua (fork): deploying Arc route for Robinhood chain ${srcChainId}`);
  await forge(['script', `${script}:DeployArc`, '--rpc-url', opts.arcRpc, '--private-key', key(0), '--broadcast'], { XCHAIN_RH_CHAIN_ID: String(srcChainId), XCHAIN_OUT: '../.fork/dev-arc.json' });
  const d = JSON.parse(readFileSync(resolve(out, 'dev-arc.json'), 'utf8'));
  const maker = account(3).address, payout = account(5).address;
  const chain = { id: 5042002, name: 'Arc fork', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [opts.arcRpc] } } } as const;
  const wallet = createWalletClient({ account: account(0), chain, transport: http(opts.arcRpc) });
  const mint = await wallet.writeContract({ address: usdc, abi: erc20, functionName: 'mint', args: [maker, 20_000_000_000n] });
  if ((await arc.waitForTransactionReceipt({ hash: mint })).status !== 'success') throw new Error(`fork-only maker USDC mint reverted: ${mint}`);
  await forge(['script', `${script}:MakerShip`, '--rpc-url', opts.arcRpc, '--private-key', key(3), '--broadcast'], {
    XCHAIN_SETTLER: d.settler, XCHAIN_ROUTES: d.nvdaRoute, XCHAIN_IN_TOKENS: d.rNVDA,
    XCHAIN_ALLOC: '15000000000', XCHAIN_BID_BPS: '50', XCHAIN_PAYOUT: payout, XCHAIN_OUT: '../.fork/dev-maker.json',
  });
  const strategyHash = JSON.parse(readFileSync(resolve(out, 'dev-maker.json'), 'utf8'))['0'] as Hex;
  if (!strategyHash) throw new Error('MakerShip did not write an NVDA strategy hash');
  console.log('Cross-chain Aqua (fork): deploying Robinhood NVDA escrow');
  await forge(['script', `${script}:DeploySource`, '--rpc-url', opts.robinhoodRpc, '--private-key', key(0), '--broadcast'], {
    XCHAIN_ARC_SETTLER: d.settler, XCHAIN_TOKEN: nvda, XCHAIN_FEED: feed, XCHAIN_UI: 'true',
    XCHAIN_FORWARDER: forwarder, XCHAIN_OUT: '../.fork/dev-rh.json',
  });
  const escrow = JSON.parse(readFileSync(resolve(out, 'dev-rh.json'), 'utf8')).escrow as Address;
  const set = await wallet.writeContract({ address: d.settler, abi: settlerAbi, functionName: 'setEscrow', args: [srcChainId, escrow] });
  if ((await arc.waitForTransactionReceipt({ hash: set })).status !== 'success') throw new Error(`setEscrow reverted: ${set}`);
  await rpc(opts.arcRpc, 'anvil_setBalance', [creAccount.address, toHex(10n ** 20n)]);
  console.log(`Cross-chain Aqua (fork): settler ${d.settler}, escrow ${escrow}, strategy ${strategyHash}; CRE account funded on Arc fork`);
  return { settler: d.settler, router: d.router, escrow, rNVDA: d.rNVDA, nvdaRoute: d.nvdaRoute, strategyHash, maker, payout, tokenIn: nvda, srcChainId, deployBlockArc, deployBlockRh };
}

/** Handler 0 watches Robinhood ORDER; handler 1 watches Arc FILLED/EXPIRED. */
export function startXChainRelay(opts: { arcRpc: string; robinhoodRpc: string; dev: XChainDev }): { list(): XChainEntry[]; stop(): void } {
  const dir = prepareWorkflow(workflow);
  const config = {
    chains: [
      { name: 'robinhood', chainSelectorName: 'robinhood-testnet', chainId: opts.dev.srcChainId, escrow: opts.dev.escrow, settler: zeroAddress, gasLimit: '1500000' },
      { name: 'arc', chainSelectorName: 'arc-testnet', chainId: 5042002, escrow: zeroAddress, settler: opts.dev.settler, gasLimit: '3000000' },
    ], maxPriceAgeSec: 259200, confidence: 'SAFE', prices: [], schedule: '0 */10 * * * *',
  };
  const rpcs = { 'robinhood-testnet': opts.robinhoodRpc, 'arc-testnet': opts.arcRpc };
  const rh = createPublicClient({ transport: http(opts.robinhoodRpc), cacheTime: 0 });
  const arc = createPublicClient({ transport: http(opts.arcRpc), cacheTime: 0 });
  const entries: XChainEntry[] = [];
  let nextRh = opts.dev.deployBlockRh, nextArc = opts.dev.deployBlockArc, busy = false, stopped = false;

  async function relay(chain: 'robinhood' | 'arc', log: any) {
    const client = chain === 'robinhood' ? rh : arc;
    const started = Date.now();
    const kind = chain === 'robinhood' ? 'ORDER' : Number(BigInt(log.args.payload.slice(0, 66))) === 3 ? 'FILLED' : 'EXPIRED';
    const entry: XChainEntry = { at: Math.floor(started / 1000), chain, kind, orderId: log.args.orderId, source: log.transactionHash, ms: 0 };
    try {
      const receipt = await client.getTransactionReceipt({ hash: log.transactionHash });
      // CRE's --evm-event-index selects from the complete receipt log list (including ERC20 Transfer logs).
      const index = receipt.logs.findIndex(l => l.logIndex === log.logIndex && l.topics[0]?.toLowerCase() === topic.toLowerCase());
      if (index < 0) throw new Error('XChainMessage missing from source transaction receipt');
      const output = await creSimulate({ workflowDir: dir, target: 'local-fork', rpcs, config, broadcast: true,
        triggerIndex: chain === 'robinhood' ? 0 : 1, txHash: log.transactionHash, eventIndex: index });
      entry.written = /Delivered to [^\n]*: tx (0x[0-9a-fA-F]{64})/.exec(output)?.[1] as Hex | undefined;
      if (!entry.written) entry.skipped = /No write: ([^\n]*)/.exec(output)?.[1]?.trim() ?? 'no write reported';
    } catch (e: any) { entry.error = String(e.message).slice(-500); }
    entry.ms = Date.now() - started;
    entries.unshift(entry); entries.length = Math.min(entries.length, 100);
    console.log(`Cross-chain Aqua CRE (fork): ${chain} ${kind} ${entry.orderId.slice(0, 10)}… → ${entry.written ?? entry.skipped ?? entry.error} (${(entry.ms / 1000).toFixed(1)} s)`);
  }

  async function tick() {
    if (busy || stopped) return; busy = true;
    try {
      const [rhHead, arcHead] = await Promise.all([rh.getBlockNumber(), arc.getBlockNumber()]);
      const logs: { chain: 'robinhood' | 'arc'; log: any }[] = [];
      if (nextRh <= rhHead) {
        for (const log of await rh.getLogs({ address: opts.dev.escrow, event: parseAbi([event])[0], fromBlock: nextRh, toBlock: rhHead })) logs.push({ chain: 'robinhood', log });
        nextRh = rhHead + 1n;
      }
      if (nextArc <= arcHead) {
        for (const log of await arc.getLogs({ address: opts.dev.settler, event: parseAbi([event])[0], fromBlock: nextArc, toBlock: arcHead })) logs.push({ chain: 'arc', log });
        nextArc = arcHead + 1n;
      }
      for (const item of logs) { if (stopped) break; await relay(item.chain, item.log); }
    } catch (e: any) { console.error(`Cross-chain Aqua CRE (fork): ${e.message}`); }
    finally { busy = false; }
  }
  const timer = setInterval(tick, 2000);
  void tick();
  return { list: () => [...entries], stop: () => { stopped = true; clearInterval(timer); } };
}
