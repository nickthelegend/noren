/**
 * dev:all, credit: deploys the other agents' contracts onto the local forks, unchanged.
 *   - Robinhood contracts (packages/robinhood): their own Deploy.s.sol on the Robinhood fork, then seeds the USDG vault from a real holder.
 *   - NorenCreditLine (packages/arc-credit) on the Arc fork, funded with fork-shim USDC.
 * Anvil's published dev accounts sign everything here; they are only meaningful on these disposable forks.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, encodeDeployData, encodeFunctionData, erc20Abi, http, parseAbi, toHex, type Address, type Hex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { ROBINHOOD } from '../packages/server/src/credit.ts';
import type { ArcContext } from './stack.ts';

const MNEMONIC = 'test test test test test test test test test test test junk';
const dev = (i: number) => mnemonicToAccount(MNEMONIC, { addressIndex: i });
/** CRE MockKeystoneForwarder addresses (simulation): Arc testnet's lives on the Arc fork; Robinhood testnet's is copied onto the Robinhood fork by the bridge setup. */
export const FORWARDER = { arc: '0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1' as Address, robinhood: '0x0b93082D9b3C7C97fAcd250082899BAcf3af3885' as Address };
const POOL_MANAGER: Address = '0x8366a39CC670B4001A1121B8F6A443A643e40951'; // Uniswap v4 PoolManager: a real USDG holder

export type RobinhoodDeployment = { oracle: Address; vault: Address; gateway: Address; credit: Address; deployBlock: bigint; owner: Address; underwriter: Address; forwarder: Address; vaultSeedTx: Hex };

async function rpc(url: string, method: string, params: unknown[] = []) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json(); if (j.error) throw new Error(`${method}: ${j.error.message}`); return j.result;
}

/** The Robinhood contracts on the fork. The fork must report chain 4663 here: Deploy.s.sol refuses any other chain. */
export async function deployRobinhood(robinhoodRpc: string, forwarder: Address = FORWARDER.robinhood): Promise<RobinhoodDeployment> {
  const owner = dev(0), underwriter = dev(9).address;
  const env = { ...process.env, NOREN_RH_OWNER: owner.address, NOREN_RH_UNDERWRITER: underwriter, NOREN_RH_FORWARDER: forwarder, NOREN_RH_INSTALLMENT_INTERVAL: '1209600', NOREN_RH_GRACE: '259200' };
  const key = toHex(owner.getHdKey().privateKey!);
  let out: string;
  try {
    out = execFileSync('forge', ['script', 'script/Deploy.s.sol:Deploy', '--rpc-url', robinhoodRpc, '--broadcast', '--private-key', key], { cwd: resolve('packages/robinhood/contracts'), env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e: any) { throw new Error(`Robinhood Deploy.s.sol failed: ${String(e.stdout ?? '').slice(-600)} ${String(e.stderr ?? '').replace(/0x[0-9a-f]{64}/gi, '0x…').slice(-400)}`); }
  const pick = (name: string) => { const m = new RegExp(`${name}\\s+(0x[0-9a-fA-F]{40})`).exec(out); if (!m) throw new Error(`Robinhood deploy printed no ${name}`); return m[1] as Address; };
  const d = { oracle: pick('NOREN_RH_ORACLE'), vault: pick('NOREN_RH_VAULT'), gateway: pick('NOREN_RH_GATEWAY'), credit: pick('NOREN_RH_CREDIT') };
  const c: any = createPublicClient({ transport: http(robinhoodRpc), cacheTime: 0 });
  const deployBlock: bigint = await c.getBlockNumber();
  // Vault liquidity: 25,000 USDG from the PoolManager (impersonated, fork only), deposited by the owner as LP.
  const seed = 25_000_000_000n;
  await rpc(robinhoodRpc, 'anvil_impersonateAccount', [POOL_MANAGER]);
  await rpc(robinhoodRpc, 'anvil_setBalance', [POOL_MANAGER, toHex(10n ** 18n)]);
  const t1 = await rpc(robinhoodRpc, 'eth_sendTransaction', [{ from: POOL_MANAGER, to: ROBINHOOD.usdg, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [owner.address, seed] }) }]);
  await c.waitForTransactionReceipt({ hash: t1 });
  await rpc(robinhoodRpc, 'anvil_stopImpersonatingAccount', [POOL_MANAGER]);
  const t2 = await rpc(robinhoodRpc, 'eth_sendTransaction', [{ from: owner.address, to: ROBINHOOD.usdg, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [d.vault, seed] }) }]);
  await c.waitForTransactionReceipt({ hash: t2 });
  const t3 = await rpc(robinhoodRpc, 'eth_sendTransaction', [{ from: owner.address, to: d.vault, data: encodeFunctionData({ abi: parseAbi(['function deposit(uint256 assets, address receiver) returns (uint256)']), functionName: 'deposit', args: [seed, owner.address] }) }]) as Hex;
  if ((await c.waitForTransactionReceipt({ hash: t3 })).status !== 'success') throw new Error(`Vault seed deposit reverted: ${t3}`);
  return { ...d, deployBlock, owner: owner.address, underwriter, forwarder, vaultSeedTx: t3 };
}

/** NorenCreditLine on the Arc fork, owned by the deployer, fed by the Arc testnet MockKeystoneForwarder, with a funded pool. */
export async function deployCreditLine(arc: ArcContext, poolUsdc = 10_000_000_000n) {
  execFileSync('forge', ['build'], { cwd: resolve('packages/arc-credit'), stdio: ['ignore', 'ignore', 'inherit'] });
  const art = JSON.parse(readFileSync(resolve('packages/arc-credit/out/NorenCreditLine.sol/NorenCreditLine.json'), 'utf8'));
  const data = encodeDeployData({ abi: art.abi, bytecode: art.bytecode.object as Hex, args: [arc.deployment.usdc, FORWARDER.arc, arc.deployer] });
  const hash = await arc.client.request({ method: 'eth_sendTransaction', params: [{ from: arc.deployer, data }] }) as Hex;
  const r = await arc.client.waitForTransactionReceipt({ hash });
  if (r.status !== 'success' || !r.contractAddress) throw new Error(`NorenCreditLine deploy reverted: ${hash}`);
  const creditLine = r.contractAddress as Address;
  const mint = await arc.client.request({ method: 'eth_sendTransaction', params: [{ from: arc.deployer, to: arc.deployment.usdc, data: encodeFunctionData({ abi: parseAbi(['function mint(address to, uint256 value)']), functionName: 'mint', args: [creditLine, poolUsdc] }) }] }) as Hex;
  if ((await arc.client.waitForTransactionReceipt({ hash: mint })).status !== 'success') throw new Error(`Credit pool funding reverted: ${mint}`);
  return { creditLine, deployBlock: r.blockNumber as bigint, deployTx: hash, poolUsdc };
}
