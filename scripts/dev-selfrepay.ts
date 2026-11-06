/**
 * Loans that pay themselves down, on the local Robinhood fork: a demo trader makes real Aqua fills against the
 * deposit vaults a borrower's loan is locked in, so the app can show fees earned -> "Use earnings to pay down loan"
 * -> a lower debt.
 *
 * After each NorenBorrow `Borrowed` event (any account except the trader), for every vault the borrower has shares
 * locked in, the trader (Anvil #3, the demo maker's wallet, which holds real USDG moved from a real holder by
 * deploy-fork.sh) runs three real swaps through NorenLiquidity, a few seconds apart:
 *   1. buys the asset from the best ask (the deposit vault's strategy),
 *   2. buys a little more,
 *   3. sells part back to the best bid (the same vault, which now holds the USDG from step 1).
 * NorenLiquidity books each spread as the vault's fee; nothing is minted or set. Fork only (chain 4663 on loopback).
 * NOREN_DEMO_FILLS=0 turns it off.
 */
import { createPublicClient, encodeFunctionData, http, maxUint256, parseAbi, parseAbiItem, type Address, type Hex } from 'viem';

const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' as Address;
const liqAbi = parseAbi([
  'function bestAskForAsset(address asset, uint256 assetOut) view returns (bytes32 strategyHash, uint256 usdgIn)',
  'function buyFromMakers(address asset, uint256 assetOut, uint256 maxUsdgIn, address to) returns (uint256 usdgIn, bytes32 strategyHash)',
  'function bestQuoteForAsset(address asset, uint256 assetIn) view returns (bytes32 strategyHash, uint256 usdgOut)',
  'function sellExactAsset(address asset, uint256 assetIn, uint256 minUsdgOut, address to) returns (uint256 usdgOut, bytes32 strategyHash)',
]);
const ercAbi = parseAbi(['function approve(address,uint256) returns (bool)', 'function allowance(address,address) view returns (uint256)', 'function balanceOf(address) view returns (uint256)']);
const vaultAbi = parseAbi(['function strategyHash() view returns (bytes32)', 'function asset() view returns (address)', 'function symbol() view returns (string)']);
const borrowAbi = parseAbi(['function lockedShares(address account, address vault) view returns (uint256)']);
const borrowedEv = parseAbiItem('event Borrowed(address indexed account, uint256 amountUsdg, address to, uint256 debtUsdg, uint256 limitUsdg)');
const saleEv = parseAbiItem('event MakerSale(bytes32 indexed strategyHash, address indexed maker, address indexed asset, address taker, uint256 assetOut, uint256 usdgIn, uint256 valueUsdg, uint256 feeUsdg)');

export type SelfRepayDeployment = { borrow: Address; liquidity: Address; demoMaker: Address; depositVaults: { asset: Address; vault: Address }[]; deployBlock: bigint | number | string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function startSelfRepayFills(rpc: string, d: SelfRepayDeployment, log: (s: string) => void = console.log) {
  if (process.env.NOREN_DEMO_FILLS === '0') return { stop() {} };
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(rpc)) throw new Error('Demo fills run only on a local fork');
  const c: any = createPublicClient({ transport: http(rpc), cacheTime: 0 });
  const trader = d.demoMaker;
  let from = BigInt(d.deployBlock);
  let stopped = false;
  let busy = false;

  const send = async (to: Address, data: Hex, what: string): Promise<Hex> => {
    const hash = (await c.request({ method: 'eth_sendTransaction', params: [{ from: trader, to, data }] })) as Hex;
    const r = await c.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error(`${what} reverted: ${hash}`);
    return hash;
  };
  const ensureAllowance = async (token: Address) => {
    if ((await c.readContract({ address: token, abi: ercAbi, functionName: 'allowance', args: [trader, d.liquidity] })) < 10n ** 30n)
      await send(token, encodeFunctionData({ abi: ercAbi, functionName: 'approve', args: [d.liquidity, maxUint256] }), 'approve');
  };
  const feeOf = async (hash: Hex) => {
    const r = await c.getTransactionReceipt({ hash });
    const logs = await c.getLogs({ address: d.liquidity, event: saleEv, fromBlock: r.blockNumber, toBlock: r.blockNumber });
    return logs.find((l: any) => l.transactionHash === hash)?.args.feeUsdg as bigint | undefined;
  };

  /** Three real fills against `vault`'s Aqua strategy (skipped with a reason when it isn't the best price). */
  const fillsFor = async (vault: Address) => {
    const [asset, h, sym] = await Promise.all([
      c.readContract({ address: vault, abi: vaultAbi, functionName: 'asset' }) as Promise<Address>,
      c.readContract({ address: vault, abi: vaultAbi, functionName: 'strategyHash' }) as Promise<Hex>,
      c.readContract({ address: vault, abi: vaultAbi, functionName: 'symbol' }) as Promise<string>,
    ]);
    const eth = asset.toLowerCase() === WETH.toLowerCase();
    const [big, small] = eth ? [2n * 10n ** 17n, 10n ** 17n] : [5n * 10n ** 17n, 25n * 10n ** 16n];
    const name = eth ? 'ETH' : sym.replace(/^n/, '');
    await ensureAllowance(asset);
    for (const amt of [big, small]) {
      const [best, usdgIn] = (await c.readContract({ address: d.liquidity, abi: liqAbi, functionName: 'bestAskForAsset', args: [asset, amt] })) as [Hex, bigint];
      if (best.toLowerCase() !== h.toLowerCase()) { log(`Demo fills (fork): ${sym}'s ask is not the best price for ${name} right now; skipped`); return; }
      const tx = await send(d.liquidity, encodeFunctionData({ abi: liqAbi, functionName: 'buyFromMakers', args: [asset, amt, (usdgIn * 10_050n) / 10_000n, trader] }), 'buyFromMakers');
      const fee = await feeOf(tx);
      log(`Demo fills (fork): trader bought ${Number(amt) / 1e18} ${name} from ${sym}'s Aqua strategy, fee ${fee === undefined ? '?' : (Number(fee) / 1e6).toFixed(4)} USDG (tx ${tx})`);
      await sleep(4000);
    }
    const [bestBid] = (await c.readContract({ address: d.liquidity, abi: liqAbi, functionName: 'bestQuoteForAsset', args: [asset, small] })) as [Hex, bigint];
    if (bestBid.toLowerCase() !== h.toLowerCase()) { log(`Demo fills (fork): ${sym}'s bid is not the best price for ${name} right now; sell-back skipped`); return; }
    const tx = await send(d.liquidity, encodeFunctionData({ abi: liqAbi, functionName: 'sellExactAsset', args: [asset, small, 0n, trader] }), 'sellExactAsset');
    log(`Demo fills (fork): trader sold ${Number(small) / 1e18} ${name} back to ${sym}'s bid (tx ${tx})`);
  };

  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      const head: bigint = await c.getBlockNumber();
      if (head < from) return;
      const logs = await c.getLogs({ address: d.borrow, event: borrowedEv, fromBlock: from, toBlock: head });
      from = head + 1n;
      await ensureAllowance('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168');
      for (const l of logs) {
        const who = l.args.account as Address;
        if (who.toLowerCase() === trader.toLowerCase()) continue;
        for (const { vault } of d.depositVaults) {
          if (stopped) return;
          if ((await c.readContract({ address: d.borrow, abi: borrowAbi, functionName: 'lockedShares', args: [who, vault] })) === 0n) continue;
          await fillsFor(vault).catch((e: Error) => log(`Demo fills (fork): ${e.message.split('\n')[0]}`));
        }
        // the fills ran from the trader's account, after this block; don't react to our own blocks
        from = (await c.getBlockNumber()) + 1n;
      }
    } catch (e: any) {
      log(`Demo fills (fork): ${String(e.message).split('\n')[0]}`);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), 3000);
  log(`Demo fills (fork): after each borrow, a trader makes 3 real Aqua fills against every vault the borrower locked (NOREN_DEMO_FILLS=0 turns it off)`);
  return { stop() { stopped = true; clearInterval(timer); } };
}
