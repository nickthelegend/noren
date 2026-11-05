import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { createPublicClient, encodeAbiParameters, encodeFunctionData, http, keccak256, toHex, type Address, type Hex } from 'viem';
import { ARC_USDC, checkoutAbi, entrypointAbi, jsonBigints, localFork } from '@noren/core';
import { createMerchantServer, assertLocalFork } from '../packages/server/src/server.ts';
import { createPostman } from '../packages/postman/src/postman.ts';
import { deployArc } from './deploy-arc.ts';

const rpcUrl = 'http://127.0.0.1:8645';
const serverUrl = 'http://127.0.0.1:8790';
const aspUrl = 'http://127.0.0.1:8788';
const client: any = createPublicClient({ chain: localFork(rpcUrl), transport: http(rpcUrl), cacheTime: 0 });
let anvil: ChildProcess | undefined;
let stopping = false;
let merchantServer: ReturnType<typeof createMerchantServer> | undefined;
let aspServer: ReturnType<ReturnType<typeof createPostman>['serve']> | undefined;
let timer: ReturnType<typeof setInterval> | undefined;

async function stop() {
  if (stopping) return;
  stopping = true;
  if (timer) clearInterval(timer);
  await Promise.all([merchantServer, aspServer].filter(Boolean).map(server => new Promise<void>(resolve => { server!.closeAllConnections(); server!.close(() => resolve()); })));
  if (anvil?.pid && anvil.exitCode === null) {
    anvil.kill('SIGTERM');
    await new Promise<void>(resolve => { anvil!.once('exit', () => resolve()); setTimeout(resolve, 2000); });
    if (anvil.exitCode === null) anvil.kill('SIGKILL');
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void stop().then(() => process.exit(0)); });

async function main() {
  try { await client.getChainId(); throw new Error('Port 8645 already has an RPC server; stop it before dev:stack'); } catch (e: any) { if (e.message?.includes('already has')) throw e; }
  execFileSync('forge', ['build', '--skip', 'test/**'], { cwd: resolve('packages/contracts'), stdio: 'inherit' });
  anvil = spawn('anvil', ['--silent', '--host', '127.0.0.1', '--fork-url', 'https://rpc.testnet.arc.io', '--chain-id', '5042002', '--port', '8645'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let anvilError = ''; anvil.stderr?.on('data', chunk => { anvilError += String(chunk).slice(0, 2000); });
  for (let i = 0; i < 40; i++) { try { await assertLocalFork(rpcUrl); break; } catch { if (anvil.exitCode !== null || i === 39) throw new Error(`Anvil fork failed to start: ${anvilError.slice(0, 500)}`); await new Promise(r => setTimeout(r, 500)); } }
  const [deployer, merchant] = await client.request({ method: 'eth_accounts' }) as Address[];
  const shim = JSON.parse(readFileSync(resolve('packages/contracts/out/ForkUSDC.sol/ForkUSDC.json'), 'utf8'));
  await client.request({ method: 'anvil_setCode', params: [ARC_USDC, shim.deployedBytecode.object as Hex] });
  const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [deployer, 0n]));
  await client.request({ method: 'anvil_setStorageAt', params: [ARC_USDC, slot, toHex(100_000_000n, { size: 32 })] });
  const deployment = await deployArc(rpcUrl, deployer, undefined, false);
  const register = await client.request({ method: 'eth_sendTransaction', params: [{ from: merchant, to: deployment.checkout, data: encodeFunctionData({ abi: checkoutAbi, functionName: 'registerMerchant', args: [merchant] }) }] }) as Hex;
  if ((await client.waitForTransactionReceipt({ hash: register })).status !== 'success') throw new Error('Merchant registration reverted');
  await mkdir('deployments', { recursive: true });
  await writeFile('deployments/31337-fork.json', jsonBigints(deployment) + '\n');
  const postman = createPostman({ deployment, rpcUrl, delayMs: 0, batchMs: 5000, treeUrl: `${aspUrl}/asp/tree?v=1`, sendRoot: (root, cid) => client.request({ method: 'eth_sendTransaction', params: [{ from: deployer, to: deployment.entrypoint, data: encodeFunctionData({ abi: entrypointAbi, functionName: 'updateRoot', args: [root, cid] }) }] }) });
  aspServer = postman.serve(8788);
  timer = setInterval(() => postman.tick().catch(e => console.error('ASP tick:', e.message)), 1000);
  const token = randomBytes(24).toString('hex');
  await rm('data/dev-stack-invoices.json', { force: true });
  merchantServer = createMerchantServer({ deployment, rpcUrl, localUnlockedMerchant: merchant, dataFile: 'data/dev-stack-invoices.json', dev: { aspUrl, merchantToken: token } });
  await new Promise<void>((resolve, reject) => { merchantServer!.once('error', reject); merchantServer!.listen(8790, '127.0.0.1', resolve); });
  console.log(`RPC: ${rpcUrl}`);
  console.log(`Server: ${serverUrl}`);
  console.log(`ASP: ${aspUrl}`);
  console.log(`Merchant token: ${token}`);
  console.log('Press Ctrl-C to stop the local stack.');
}
main().catch(async e => { console.error(e); await stop(); process.exit(1); });
