// Real trades against Noren's 1inch Aqua makers on the local Robinhood fork, so locked Earn shares earn fees the
// Credit page can put toward a line ("your NVDA earned Y in fees → paid down your line"). Fork only.
// A trader (Anvil's published dev key #3, which holds funds only on a local fork) buys NVDA from the makers with USDG
// through NorenLiquidity.buyFromMakers; the maker that fills it (the nNVDA vault when it quotes best) keeps the spread.
//   pnpm exec tsx scripts/dev-maker-fill.ts [rounds=3] [nvdaPerRound=0.2]
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, http, parseUnits, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createNorenEarn, STOCKS, USDG, WETH } from '../packages/robinhood/sdk/src/index.ts';
import { robinhoodFaucet } from '../packages/server/src/credit.ts';

const RPC = process.env.NOREN_RH_RPC ?? 'http://127.0.0.1:8646';
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(RPC)) throw new Error('Refusing: this script only targets a local fork');
const rounds = Number(process.argv[2] ?? 3), per = parseUnits(process.argv[3] ?? '0.2', 18);
const pc: any = createPublicClient({ transport: http(RPC), cacheTime: 0 });
if (!(await pc.request({ method: 'anvil_nodeInfo' }).catch(() => null))) throw new Error(`Refusing: ${RPC} is not an Anvil fork`);
const d = JSON.parse(readFileSync(resolve('packages/robinhood/.fork/deployment.json'), 'utf8'));
const trader = privateKeyToAccount('0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6' as Hex); // Anvil #3, fork only
const wc = createWalletClient({ account: trader, transport: http(RPC) });
const earn = createNorenEarn({ publicClient: pc, walletClient: wc as any, addresses: { ...d, usdg: USDG, weth: WETH, rpcUrl: RPC } });
const nNVDA = (d.depositVaults as { asset: string; vault: string }[]).find((v) => v.asset.toLowerCase() === STOCKS.NVDA.toLowerCase())?.vault.toLowerCase();

await robinhoodFaucet(RPC, trader.address, { nvda: '0', usdg: '400', eth: '1' }).catch((e) => console.log(`faucet: ${e.message}`));
for (let i = 0; i < rounds; i++) {
  const { receipt, sale } = await earn.buyAsset({ asset: STOCKS.NVDA, amountOut: per });
  const a = (sale as any)?.args ?? {};
  const who = String(a.maker ?? '').toLowerCase();
  console.log(`fork tx ${receipt.transactionHash}  trader bought ${Number(per) / 1e18} NVDA from ${who === nNVDA ? 'the nNVDA vault (Earn shares)' : who === String(d.vault).toLowerCase() ? 'the lender pool NorenVault' : who || 'a maker'}${a.feeUsdg !== undefined ? `, maker fee ${(Number(a.feeUsdg) / 1e6).toFixed(4)} USDG` : ''}`);
}
