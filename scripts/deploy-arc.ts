import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, encodeFunctionData, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ARC_CHAIN_ID, ARC_USDC, entrypointAbi, jsonBigints, localFork, usdcAbi, type Deployment } from '@noren/core';

const contractsDir = resolve('packages/contracts');
function artifact(file: string, name = file): any { return JSON.parse(readFileSync(resolve(contractsDir, `out/${file}.sol/${name}.json`), 'utf8')); }
function bytecode(a: any, links: Record<string, Address> = {}): Hex {
  let result: string = a.bytecode.object;
  for (const names of Object.values(a.bytecode.linkReferences ?? {}) as any[]) for (const [name, positions] of Object.entries(names) as any) {
    const address = links[name]; if (!address) throw new Error(`Missing library ${name}`);
    for (const { start, length } of positions) { if (length !== 20) throw new Error('Bad library link'); result = result.slice(0, 2 + start * 2) + address.slice(2) + result.slice(2 + start * 2 + 40); }
  }
  return result as Hex;
}
export async function deployArc(rpcUrl: string, deployer: Address, key?: Hex, write = true, postman: Address = deployer): Promise<Deployment> {
  const chain = localFork(rpcUrl), client: any = createPublicClient({ chain, transport: http(rpcUrl), cacheTime: 0 });
  const chainId = await client.getChainId();
  if (chainId !== ARC_CHAIN_ID) throw new Error(`Refusing chain ${chainId}; expected ${ARC_CHAIN_ID}`);
  const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(rpcUrl);
  if (!local) {
    const native = await client.getBalance({ address: deployer });
    const erc20 = await client.readContract({ address: ARC_USDC, abi: usdcAbi, functionName: 'balanceOf', args: [deployer] });
    if (native < 1_000_000_000_000_000_000n || erc20 < 1_000_000n) throw new Error(`Setup required: fund deployer ${deployer} with at least 1 Arc testnet USDC for gas; no deployment attempted`);
  }
  const account = key ? privateKeyToAccount(key) : deployer;
  if (!local && !key) throw new Error('Setup required: NOREN_DEPLOYER_KEY missing');
  const wallet: any = createWalletClient({ chain, account, transport: http(rpcUrl) });
  const deploymentBlock = await client.getBlockNumber();
  async function deploy(file: string, name = file, args: any[] = [], links: Record<string, Address> = {}) {
    const a = artifact(file, name);
    const hash = await wallet.deployContract({ abi: a.abi, bytecode: bytecode(a, links), args });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error(`Deploy ${name} failed: ${hash}`);
    console.log(`${name}: ${receipt.contractAddress} tx ${hash}`);
    return receipt.contractAddress;
  }
  async function send(to: Address, data: Hex) { const hash = await wallet.sendTransaction({ to, data }); const receipt = await client.waitForTransactionReceipt({ hash }); if (receipt.status !== 'success') throw new Error(`Setup transaction failed: ${hash}`); console.log(`setup tx ${hash}`); }
  const poseidonT3 = await deploy('PoseidonT3');
  const poseidonT4 = await deploy('PoseidonT4');
  const withdrawalVerifier = await deploy('WithdrawalVerifier');
  const commitmentVerifier = await deploy('CommitmentVerifier');
  const implementation = await deploy('Entrypoint');
  const init = encodeFunctionData({ abi: artifact('Entrypoint').abi, functionName: 'initialize', args: [deployer, postman] });
  const entrypoint = await deploy('ERC1967Proxy', 'ERC1967Proxy', [implementation, init]);
  const pool = await deploy('PrivacyPoolComplex', 'PrivacyPoolComplex', [entrypoint, withdrawalVerifier, commitmentVerifier, ARC_USDC], { PoseidonT3: poseidonT3, PoseidonT4: poseidonT4 });
  await send(entrypoint, encodeFunctionData({ abi: entrypointAbi, functionName: 'registerPool', args: [ARC_USDC, pool, 1_000_000n, 0n, 500n] }));
  const checkout = await deploy('NorenCheckout', 'NorenCheckout', [entrypoint, pool, ARC_USDC]);
  const deployment: Deployment = { chainId, deploymentBlock: deploymentBlock.toString(), usdc: ARC_USDC, entrypoint, pool, checkout, withdrawalVerifier, commitmentVerifier };
  if (write) { mkdirSync('deployments', { recursive: true }); writeFileSync(`deployments/${chainId}.json`, jsonBigints(deployment) + '\n'); }
  return deployment;
}
if (process.argv[1]?.endsWith('deploy-arc.ts')) {
  const rpc = process.env.NOREN_RPC_URL ?? 'https://rpc.testnet.arc.io';
  const key = process.env.NOREN_DEPLOYER_KEY as Hex | undefined;
  const address = key ? privateKeyToAccount(key).address : process.env.NOREN_DEPLOYER_ADDRESS as Address;
  if (!address) throw new Error('Setup required: NOREN_DEPLOYER_ADDRESS or NOREN_DEPLOYER_KEY missing');
  await deployArc(rpc, address, key, true, (process.env.NOREN_POSTMAN_ADDRESS as Address | undefined) ?? address);
}
