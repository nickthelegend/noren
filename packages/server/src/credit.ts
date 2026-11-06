/**
 * Pay later and pay with stocks, on the merchant server.
 * - Watches NorenCreditLine `Drawn` logs on Arc and settles the matching Noren invoice (method "credit").
 * - A Robinhood-fork faucet that moves real Stock Tokens and USDG from mainnet holders by impersonation (Anvil only).
 * The NorenCreditLine ABI here is the fixed interface in NOREN-AGENTS-CONTEXT.md, not a guess.
 */
import { createPublicClient, encodeFunctionData, erc20Abi, http, parseAbi, parseUnits, toHex, type Address, type Hex } from 'viem';

export const creditLineAbi = parseAbi([
  'function payInvoice(bytes32 lineId, address merchant, uint256 amount, bytes32 invoiceId)',
  'function repay(bytes32 lineId, uint256 amount)',
  'event Drawn(bytes32 indexed lineId, uint256 amount, bytes32 invoiceId, address merchant)',
  'event Repaid(bytes32 indexed lineId, uint256 amount)',
]);

export type CreditDraw = { lineId: Hex; amount: bigint; invoiceId: Hex; merchant: Address; txHash: Hex; blockNumber: bigint; timestamp: number };

/** Why a credit draw can't settle an invoice, or null when it can. Pure, so it is unit-tested without a chain. */
export function creditDrawProblem(row: { invoice: { merchant: string; amount: bigint; expiry: bigint }; status: string } | undefined, draw: CreditDraw, payout: string | undefined): string | null {
  if (!row) return 'UnknownInvoice: no Noren invoice with that id';
  if (row.status !== 'draft' && row.status !== 'open') return `AlreadySettled: invoice is ${row.status}`;
  if (BigInt(draw.timestamp) > row.invoice.expiry) return 'Expired: drawn after the invoice expired';
  if (draw.amount !== row.invoice.amount) return `AmountMismatch: drew ${draw.amount}, invoice is ${row.invoice.amount}`;
  const to = draw.merchant.toLowerCase();
  if (to !== row.invoice.merchant.toLowerCase() && to !== payout?.toLowerCase()) return 'WrongMerchant: credit went to another address';
  return null;
}

/** Polls Drawn logs from `fromBlock` and hands each one to `onDraw` in block order. Returns a stop function. */
export function watchCreditDraws(opts: { rpcUrl: string; creditLine: Address; fromBlock?: bigint; intervalMs?: number; onDraw: (d: CreditDraw) => Promise<void>; onError?: (e: Error) => void }) {
  const client: any = createPublicClient({ transport: http(opts.rpcUrl), cacheTime: 0 });
  let next: bigint | undefined = opts.fromBlock;
  let busy = false, stopped = false;
  const tick = async () => {
    if (busy || stopped) return; busy = true;
    try {
      const head: bigint = await client.getBlockNumber();
      if (next === undefined) next = head + 1n;
      if (next > head) return;
      const logs = await client.getLogs({ address: opts.creditLine, event: creditLineAbi[2], fromBlock: next, toBlock: head });
      const times = new Map<bigint, number>();
      for (const log of logs) {
        if (!times.has(log.blockNumber)) times.set(log.blockNumber, Number((await client.getBlock({ blockNumber: log.blockNumber })).timestamp));
        await opts.onDraw({ lineId: log.args.lineId, amount: log.args.amount, invoiceId: log.args.invoiceId, merchant: log.args.merchant, txHash: log.transactionHash, blockNumber: log.blockNumber, timestamp: times.get(log.blockNumber)! });
      }
      next = head + 1n;
    } catch (e: any) { opts.onError?.(e); } finally { busy = false; }
  };
  const timer = setInterval(tick, opts.intervalMs ?? 1500);
  void tick();
  return { stop: () => { stopped = true; clearInterval(timer); }, tick };
}

/* ------------------------------------------------------------------ Robinhood fork faucet */

/** Robinhood Chain mainnet addresses (verified by live RPC, Nov 6 2026). Holders are only impersonated on a local Anvil fork. */
export const ROBINHOOD = {
  chainId: 4663,
  /** Robinhood testnet's id, which CRE's robinhood-testnet forwarder and chain selector expect. */
  creChainId: 46630,
  rpc: 'https://rpc.mainnet.chain.robinhood.com',
  explorer: 'https://robinhoodchain.blockscout.com',
  usdg: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as Address,
  stocks: {
    TSLA: '0x322F0929c4625eD5bAd873c95208D54E1c003b2d', AAPL: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9', NVDA: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC', SPY: '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C',
    AMZN: '0x12f190a9F9d7D37a250758b26824B97CE941bF54', MSFT: '0xe93237C50D904957Cf27E7B1133b510C669c2e74', GOOGL: '0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3', META: '0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35',
  } as Record<string, Address>,
  feeds: {
    TSLA: '0x4A1166a659A55625345e9515b32adECea5547C38', AAPL: '0x6B22A786bAa607d76728168703a39Ea9C99f2cD0', NVDA: '0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15', SPY: '0x319724394D3A0e3669269846abE664Cd621f9f6A',
    MSFT: '0x45C3C877C15E6BA2EBB19eA114Ea508d14C1Af2E', GOOGL: '0xF6f373a037c30F0e5010d854385cA89185AE638b', AMZN: '0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C', META: '0x7C38C00C30BEe9378381E7B6135d7283356D71b1',
    ETH: '0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9', USDG: '0x61B7e5650328764B076A108EFF5fa7282a1B9aD2',
  } as Record<string, Address>,
  /** Uniswap v4 PoolManager: a real holder of both, and its balances are in the warmed snapshot. */
  holders: { NVDA: '0x8366a39CC670B4001A1121B8F6A443A643e40951' as Address, USDG: '0x8366a39CC670B4001A1121B8F6A443A643e40951' as Address },
};

const isLoopback = (url: string) => { try { return ['127.0.0.1', 'localhost'].includes(new URL(url).hostname); } catch { return false; } };

/** Refuses anything but a loopback Anvil fork of Robinhood Chain mainnet. */
export async function assertRobinhoodFork(rpcUrl: string) {
  if (!isLoopback(rpcUrl)) throw new Error('Setup required: the Robinhood faucet needs a loopback Anvil fork RPC');
  const rpc = async (method: string) => { const r = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }) }); const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result; };
  const chain = Number(BigInt(await rpc('eth_chainId')));
  // 46630 is accepted because the CRE simulator only knows Robinhood *testnet*: dev:all runs the mainnet fork under that id.
  if (chain !== ROBINHOOD.chainId && chain !== ROBINHOOD.creChainId) throw new Error(`Setup required: Robinhood fork must report chain ${ROBINHOOD.chainId} or ${ROBINHOOD.creChainId}; RPC returned ${chain}`);
  const info = await rpc('anvil_nodeInfo').catch(() => null);
  if (!info) throw new Error('Setup required: the Robinhood RPC is not a local Anvil node');
  // Either a live fork of mainnet, or a warmed snapshot of mainnet state (anvil --load-state): both carry the real
  // Stock Token and Chainlink contracts. A snapshot outlives the public RPC's ~10 minutes of historical state.
  if (info.forkConfig?.forkUrl && !String(info.forkConfig.forkUrl).includes('rpc.mainnet.chain.robinhood.com')) throw new Error('Setup required: the Robinhood fork must fork Robinhood Chain mainnet (real Stock Tokens and Chainlink feeds)');
  const code = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [ROBINHOOD.stocks.NVDA, 'latest'] }) }).then(r => r.json());
  if (!code.result || code.result === '0x') throw new Error('Setup required: no NVDA Stock Token contract on this Robinhood node');
}

/** Gives `to` gas ETH, NVDA and USDG on the Robinhood fork by impersonating real mainnet holders. Returns the tx hashes. */
export async function robinhoodFaucet(rpcUrl: string, to: Address, amounts = { nvda: '6', usdg: '120', eth: '1' }) {
  await assertRobinhoodFork(rpcUrl);
  const client: any = createPublicClient({ transport: http(rpcUrl), cacheTime: 0 });
  await client.request({ method: 'anvil_setBalance', params: [to, toHex(parseUnits(amounts.eth, 18))] });
  const out: Record<string, Hex> = {};
  for (const [symbol, token, holder, value] of [['NVDA', ROBINHOOD.stocks.NVDA, ROBINHOOD.holders.NVDA, parseUnits(amounts.nvda, 18)], ['USDG', ROBINHOOD.usdg, ROBINHOOD.holders.USDG, parseUnits(amounts.usdg, 6)]] as const) {
    const have: bigint = await client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [holder] });
    if (have < value) throw new Error(`Faucet empty: the ${symbol} holder on this fork has ${have}, needs ${value}. Restart the Robinhood fork.`);
    await client.request({ method: 'anvil_impersonateAccount', params: [holder] });
    try {
      await client.request({ method: 'anvil_setBalance', params: [holder, toHex(10n ** 18n)] });
      const hash = await client.request({ method: 'eth_sendTransaction', params: [{ from: holder, to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, value] }) }] }) as Hex;
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error(`${symbol} transfer reverted on the fork (Stock Tokens may restrict transfers): ${hash}`);
      out[symbol] = hash;
    } finally { await client.request({ method: 'anvil_stopImpersonatingAccount', params: [holder] }); }
  }
  // A little of every other Stock Token, from the snapshot's demo customer (Anvil's published account #1, seeded from the
  // Uniswap v4 PoolManager by deploy-fork.sh), so each one can pay at checkout. Skips a token the demo account lacks.
  const demo = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address;
  await client.request({ method: 'anvil_impersonateAccount', params: [demo] });
  try {
    for (const sym of ['TSLA', 'AAPL', 'SPY', 'MSFT', 'AMZN', 'GOOGL', 'META']) {
      const token = ROBINHOOD.stocks[sym], value = parseUnits(sym === 'SPY' || sym === 'META' || sym === 'MSFT' ? '0.5' : '1', 18);
      const have: bigint = await client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [demo] });
      if (have < value) continue;
      const hash = await client.request({ method: 'eth_sendTransaction', params: [{ from: demo, to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, value] }) }] }) as Hex;
      if ((await client.waitForTransactionReceipt({ hash })).status === 'success') out[sym] = hash;
    }
  } finally { await client.request({ method: 'anvil_stopImpersonatingAccount', params: [demo] }); }
  return out;
}

/* ------------------------------------------------------------------ Pay with stock: NorenGateway on Robinhood */

/** NorenGateway (packages/robinhood): a merchant invoice in USDG that a customer pays with USDG, ETH or a Stock Token. */
export const gatewayAbi = parseAbi([
  'function createInvoice(bytes32 invoiceId, uint128 amountUsdg, uint64 expiry)',
  'function invoice(address merchant, bytes32 invoiceId) view returns ((uint128 amountUsdg, uint64 expiry, uint8 status, address payer, address asset, uint256 assetIn))',
  'function quote(address merchant, bytes32 invoiceId, address asset) view returns (uint256 assetIn, uint256 priceUsd8, bool marketClosed)',
  'function pay(bytes32 invoiceId, address merchant, address asset, uint256 maxAssetIn) payable returns (uint256 assetIn)',
  'event InvoicePaid(address indexed merchant, bytes32 indexed invoiceId, address indexed payer, address asset, uint256 assetIn, uint256 usdgOut, uint256 priceUsd8)',
]);

export type StockPayment = { merchant: Address; invoiceId: Hex; payer: Address; asset: Address; assetIn: bigint; usdgOut: bigint; priceUsd8: bigint; txHash: Hex; blockNumber: bigint; timestamp: number };

/** Watches InvoicePaid for every merchant on the Robinhood fork. */
export function watchStockPayments(opts: { rpcUrl: string; gateway: Address; fromBlock?: bigint; intervalMs?: number; onPaid: (p: StockPayment) => Promise<void>; onError?: (e: Error) => void }) {
  const client: any = createPublicClient({ transport: http(opts.rpcUrl), cacheTime: 0 });
  let next = opts.fromBlock, busy = false, stopped = false;
  const tick = async () => {
    if (busy || stopped) return; busy = true;
    try {
      const head: bigint = await client.getBlockNumber();
      if (next === undefined) next = head + 1n;
      if (next > head) return;
      const logs = await client.getLogs({ address: opts.gateway, event: gatewayAbi[4], fromBlock: next, toBlock: head });
      for (const log of logs) {
        const block = await client.getBlock({ blockNumber: log.blockNumber });
        await opts.onPaid({ merchant: log.args.merchant, invoiceId: log.args.invoiceId, payer: log.args.payer, asset: log.args.asset, assetIn: log.args.assetIn, usdgOut: log.args.usdgOut, priceUsd8: log.args.priceUsd8, txHash: log.transactionHash, blockNumber: log.blockNumber, timestamp: Number(block.timestamp) });
      }
      next = head + 1n;
    } catch (e: any) { opts.onError?.(e); } finally { busy = false; }
  };
  const timer = setInterval(tick, opts.intervalMs ?? 1500);
  void tick();
  return { stop: () => { stopped = true; clearInterval(timer); }, tick };
}

/** The snapshot omits these two runtime codes; copy only their actual Robinhood mainnet code onto a verified fork. */
export async function ensureUniswapOnFork(rpcUrl: string) {
  await assertRobinhoodFork(rpcUrl);
  const local: any = createPublicClient({ transport: http(rpcUrl), cacheTime: 0 });
  const mainnet: any = createPublicClient({ transport: http(ROBINHOOD.rpc), cacheTime: 0 });
  for (const address of ['0x8876789976dEcBfCbBbe364623C63652db8C0904', '0x000000000022D473030F116dDEE9F6B43aC78BA3'] as Address[]) {
    const existing: Hex | undefined = await local.getCode({ address });
    if (existing && existing !== '0x') continue;
    const code: Hex | undefined = await mainnet.getCode({ address });
    if (!code || code === '0x') throw new Error(`Setup required: no Robinhood mainnet code at ${address}`);
    await local.request({ method: 'anvil_setCode', params: [address, code] });
  }
}
