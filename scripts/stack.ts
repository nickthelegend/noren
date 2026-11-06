/**
 * The local Noren stack, shared by `pnpm dev:stack` (Arc fork only) and `pnpm dev:all` (Arc + Robinhood + credit line + CRE).
 * Every chain is a local Anvil fork; nothing here sends a public transaction.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { createPublicClient, encodeAbiParameters, encodeFunctionData, http, keccak256, toHex, type Address, type Hex } from 'viem';
import { ARC_USDC, checkoutAbi, entrypointAbi, jsonBigints, localFork, type Deployment } from '@noren/core';
import { createMerchantServer, assertLocalFork, type CreditOptions } from '../packages/server/src/server.ts';
import { createPostman } from '../packages/postman/src/postman.ts';
import { deployArc } from './deploy-arc.ts';

export const PORTS = { arc: 8645, robinhood: 8646, server: 8790, asp: 8788, web: 5190 } as const;
export const arcRpc = `http://127.0.0.1:${PORTS.arc}`;
export const robinhoodRpc = `http://127.0.0.1:${PORTS.robinhood}`;
const serverUrl = `http://127.0.0.1:${PORTS.server}`;
const aspUrl = `http://127.0.0.1:${PORTS.asp}`;

type Stoppable = { stop: () => Promise<void> | void };
const stoppers: Stoppable[] = [];
let stopping = false;
export async function stopAll() {
  if (stopping) return; stopping = true;
  for (const s of stoppers.reverse()) { try { await s.stop(); } catch (e: any) { console.error('stop:', e.message); } }
}
export function onStop(stop: () => Promise<void> | void) { stoppers.push({ stop }); }
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void stopAll().then(() => process.exit(0)); });

async function rpcAlive(url: string) { try { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }); return r.ok; } catch { return false; } }

/** Starts an Anvil fork and registers it for shutdown. Refuses a port that already answers RPC. */
export async function startFork(name: string, port: number, forkUrl: string, chainId: number, ready: (url: string) => Promise<void>) {
  const url = `http://127.0.0.1:${port}`;
  if (await rpcAlive(url)) throw new Error(`Port ${port} already has an RPC server; stop it before starting the ${name} fork`);
  const anvil: ChildProcess = spawn('anvil', ['--silent', '--host', '127.0.0.1', '--fork-url', forkUrl, '--chain-id', String(chainId), '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  onStop(async () => {
    if (anvil.pid && anvil.exitCode === null) {
      anvil.kill('SIGTERM');
      await new Promise<void>(r => { anvil.once('exit', () => r()); setTimeout(r, 2000); });
      if (anvil.exitCode === null) anvil.kill('SIGKILL');
    }
  });
  let err = ''; anvil.stderr?.on('data', c => { err += String(c).slice(0, 2000); });
  for (let i = 0; i < 60; i++) {
    try { await ready(url); return url; } catch (e: any) {
      if (anvil.exitCode !== null || i === 59) throw new Error(`${name} fork failed to start: ${err.slice(0, 400) || e.message}`);
      await new Promise(r => setTimeout(r, 500));
    }
  }
  return url;
}

const ZK_BASE = 'https://raw.githubusercontent.com/0xbow-io/privacy-pools-core/7bc392dad5fa483f53cf74e25d7ad19f0fc6d85f/packages/circuits';
const ZK_FILES = ['trusted-setup/final-keys/withdraw.zkey', 'build/withdraw/withdraw_js/withdraw.wasm'];
/**
 * The browser proves with the pinned 0xbow artifacts. Serve them from the app's own origin (packages/web/public/zk,
 * gitignored) so the checkout makes no third-party request: copied from cache/zk, or fetched once here, server side.
 */
export async function ensureZkArtifacts() {
  const { existsSync } = await import('node:fs');
  const { copyFile } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  for (const f of ZK_FILES) {
    const out = resolve('packages/web/public/zk', f);
    if (existsSync(out)) continue;
    await mkdir(dirname(out), { recursive: true });
    const cached = resolve('cache/zk', encodeURIComponent(ZK_BASE), f);
    if (existsSync(cached)) { await copyFile(cached, out); continue; }
    const r = await fetch(`${ZK_BASE}/${f}`); if (!r.ok) throw new Error(`Prover artifact download failed (${r.status}): ${f}`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    await mkdir(dirname(cached), { recursive: true }); await writeFile(cached, bytes); await writeFile(out, bytes);
  }
  console.log('Prover artifacts: served by the web app from /zk (no third-party fetch in the browser)');
}

export type ArcContext = { deployment: Deployment; deployer: Address; merchant: Address; rpcUrl: string; client: any };

/**
 * Arc fork + Noren contracts + ASP postman + merchant server.
 * `credit` runs after the Arc contracts exist and before the server starts, so the server can watch NorenCreditLine.
 */
export async function startStack(opts: { credit?: (arc: ArcContext) => Promise<CreditOptions | undefined>; mounts?: (arc: ArcContext) => Promise<((req: any, res: any) => Promise<boolean>)[]> } = {}) {
  execFileSync('forge', ['build', '--skip', 'test/**'], { cwd: resolve('packages/contracts'), stdio: 'inherit' });
  await ensureZkArtifacts();
  const rpcUrl = await startFork('Arc testnet', PORTS.arc, 'https://rpc.testnet.arc.io', 5042002, assertLocalFork);
  const client: any = createPublicClient({ chain: localFork(rpcUrl), transport: http(rpcUrl), cacheTime: 0 });
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
  const aspServer = postman.serve(PORTS.asp);
  const timer = setInterval(() => postman.tick().catch(e => console.error('ASP tick:', e.message)), 1000);
  onStop(() => new Promise<void>(r => { clearInterval(timer); aspServer.closeAllConnections(); aspServer.close(() => r()); }));
  const credit = opts.credit ? await opts.credit({ deployment, deployer, merchant, rpcUrl, client }) : undefined;
  const token = randomBytes(24).toString('hex');
  // A fresh fork has fresh invoices, so clear their events too. The business name and webhook endpoints are merchant settings and stay.
  await rm('data/dev-stack-invoices.json', { force: true });
  await rm('data/dev-stack-invoices.json.events.json', { force: true });
  const mounts = opts.mounts ? await opts.mounts({ deployment, deployer, merchant, rpcUrl, client }) : [];
  const merchantServer = createMerchantServer({ deployment, rpcUrl, localUnlockedMerchant: merchant, dataFile: 'data/dev-stack-invoices.json', dev: { aspUrl, merchantToken: token }, mounts, ...(credit ? { credit } : {}) });
  await new Promise<void>((res, rej) => { merchantServer.once('error', rej); merchantServer.listen(PORTS.server, '127.0.0.1', res); });
  onStop(() => new Promise<void>(r => { merchantServer.closeAllConnections(); merchantServer.close(() => r()); }));
  console.log(`Arc fork RPC: ${rpcUrl}`);
  console.log(`Server: ${serverUrl}`);
  console.log(`ASP: ${aspUrl}`);
  console.log(`Merchant token: ${token}`);
  return { deployment, deployer, merchant, rpcUrl, token, client };
}

export function run(main: () => Promise<unknown>) {
  main().then(() => console.log('Press Ctrl-C to stop the local stack.')).catch(async e => { console.error(e); await stopAll(); process.exit(1); });
}
