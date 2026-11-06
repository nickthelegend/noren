// Noren deploy for Arc testnet (chain 5042002).
//
//   Dry run (no key, no money):  pnpm exec tsx scripts/deploy-arc.ts --dry-run
//     Forks Arc testnet into Anvil on 127.0.0.1:8705, deploys the full stack from the
//     real deployer address (impersonated on the fork only), measures gas, and reports
//     how much testnet USDC that address needs. Writes deployments/5042002-dryrun.json.
//
//   Real deploy:                 pnpm exec tsx scripts/deploy-arc.ts
//     Needs NOREN_DEPLOYER_KEY (env, .env, or .env.arc-deployer). Runs the fork dry run
//     first, refuses to send anything unless the live balance covers the measured cost
//     with margin, verifies code at every address, writes deployments/5042002.json.
//
// Output is names and addresses only. The key is never printed.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createPublicClient, createWalletClient, encodeFunctionData, formatUnits, http, isAddress, type Address, type Hex, type TransactionReceipt } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ARC_CHAIN_ID, ARC_USDC, entrypointAbi, jsonBigints, localFork, usdcAbi, type Deployment } from '@noren/core';

export const ARC_TESTNET_RPC = 'https://rpc.testnet.arc.io';
export const ARC_TESTNET_EXPLORER = 'https://explorer.testnet.arc.io';
/** Dry runs use the arc agent's port block (8700-8709); 8700/8702 belong to `pnpm e2e`. */
export const DRY_RUN_PORT = 8705;
/** Funding margin over the measured cost (gas price can move between dry run and deploy). */
const MARGIN_BPS = 15_000n; // 1.5x

const contractsDir = resolve('packages/contracts');
const isLocal = (rpcUrl: string) => /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(rpcUrl);
function artifact(file: string, name = file): any {
  const path = resolve(contractsDir, `out/${file}.sol/${name}.json`);
  if (!existsSync(path)) throw new Error(`Setup required: ${path} missing; run pnpm build:contracts`);
  return JSON.parse(readFileSync(path, 'utf8'));
}
function bytecode(a: any, links: Record<string, Address> = {}): Hex {
  let result: string = a.bytecode.object;
  for (const names of Object.values(a.bytecode.linkReferences ?? {}) as any[]) for (const [name, positions] of Object.entries(names) as any) {
    const address = links[name]; if (!address) throw new Error(`Missing library ${name}`);
    for (const { start, length } of positions) { if (length !== 20) throw new Error('Bad library link'); result = result.slice(0, 2 + start * 2) + address.slice(2) + result.slice(2 + start * 2 + 40); }
  }
  return result as Hex;
}

/** Reads back what a deploy should have set: Entrypoint -> pool -> USDC, checkout -> Entrypoint + pool. Throws on any mismatch or missing code. */
export async function checkWiring(client: any, d: { entrypoint: Address; pool: Address; checkout: Address }) {
  for (const [name, address] of Object.entries(d)) if ((await client.getCode({ address }) ?? '0x') === '0x') throw new Error(`Wiring check failed: no code at ${name} ${address}`);
  const read = (address: Address, file: string, functionName: string, args: any[] = []) => client.readContract({ address, abi: artifact(file).abi, functionName, args });
  const [config, checkoutPool, checkoutEntrypoint, poolEntrypoint, poolAsset] = await Promise.all([
    read(d.entrypoint, 'Entrypoint', 'assetConfig', [ARC_USDC]), read(d.checkout, 'NorenCheckout', 'pool'), read(d.checkout, 'NorenCheckout', 'entrypoint'),
    read(d.pool, 'PrivacyPoolComplex', 'ENTRYPOINT'), read(d.pool, 'PrivacyPoolComplex', 'ASSET'),
  ]);
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (!eq((config as any)[0], d.pool) || !eq(checkoutPool, d.pool) || !eq(checkoutEntrypoint, d.entrypoint) || !eq(poolEntrypoint, d.entrypoint) || !eq(poolAsset, ARC_USDC)) throw new Error('Wiring check failed: Entrypoint, pool and checkout do not point at each other');
}

export type DeployStep = { name: string; address?: Address; tx: Hex; gasUsed: bigint; costWei: bigint };
export type DeployResult = { deployment: Deployment; steps: DeployStep[]; gasUsed: bigint; costWei: bigint };
export type DeployOptions = { key?: Hex; postman?: Address; minBalanceWei?: bigint; log?: (line: string) => void };

/** Deploys verifiers, Entrypoint proxy, USDC complex pool and NorenCheckout, then registers the pool. */
export async function deployStack(rpcUrl: string, deployer: Address, opts: DeployOptions = {}): Promise<DeployResult> {
  const log = opts.log ?? console.log;
  const postman = opts.postman ?? deployer;
  const chain = localFork(rpcUrl), client: any = createPublicClient({ chain, transport: http(rpcUrl), cacheTime: 0 });
  const chainId = await client.getChainId();
  if (chainId !== ARC_CHAIN_ID) throw new Error(`Refusing chain ${chainId}; expected ${ARC_CHAIN_ID}`);
  const local = isLocal(rpcUrl);
  if (!local) {
    if (!opts.key) throw new Error('Setup required: NOREN_DEPLOYER_KEY missing');
    const native = await client.getBalance({ address: deployer });
    const need = opts.minBalanceWei ?? 1_000_000_000_000_000_000n;
    if (native < need) throw new Error(`Setup required: fund deployer ${deployer} with at least ${formatUnits(need, 18)} Arc testnet USDC (has ${formatUnits(native, 18)}); no deployment attempted`);
  }
  const account = opts.key ? privateKeyToAccount(opts.key) : deployer;
  if (opts.key && (account as any).address.toLowerCase() !== deployer.toLowerCase()) throw new Error('NOREN_DEPLOYER_KEY does not match the deployer address');
  const wallet: any = createWalletClient({ chain, account, transport: http(rpcUrl) });
  const deploymentBlock = await client.getBlockNumber();
  const steps: DeployStep[] = [];
  async function settle(name: string, hash: Hex): Promise<TransactionReceipt> {
    const receipt: TransactionReceipt = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (receipt.status !== 'success') throw new Error(`${name} reverted: ${hash}`);
    steps.push({ name, address: receipt.contractAddress ?? undefined, tx: hash, gasUsed: receipt.gasUsed, costWei: receipt.gasUsed * receipt.effectiveGasPrice });
    return receipt;
  }
  async function deploy(file: string, name = file, args: any[] = [], links: Record<string, Address> = {}) {
    const a = artifact(file, name);
    const receipt = await settle(name, await wallet.deployContract({ abi: a.abi, bytecode: bytecode(a, links), args }));
    const address = receipt.contractAddress;
    if (!address) throw new Error(`Deploy ${name} returned no address: ${receipt.transactionHash}`);
    if (!local && (await client.getCode({ address }) ?? '0x') === '0x') throw new Error(`Deploy ${name}: no code at ${address}`);
    log(`${name.padEnd(20)} ${address}`);
    return address;
  }
  async function send(name: string, to: Address, data: Hex) { await settle(name, await wallet.sendTransaction({ to, data })); }
  const poseidonT3 = await deploy('PoseidonT3');
  const poseidonT4 = await deploy('PoseidonT4');
  const withdrawalVerifier = await deploy('WithdrawalVerifier');
  const commitmentVerifier = await deploy('CommitmentVerifier');
  const implementation = await deploy('Entrypoint');
  const init = encodeFunctionData({ abi: artifact('Entrypoint').abi, functionName: 'initialize', args: [deployer, postman] });
  const entrypoint = await deploy('ERC1967Proxy', 'ERC1967Proxy', [implementation, init]);
  const pool = await deploy('PrivacyPoolComplex', 'PrivacyPoolComplex', [entrypoint, withdrawalVerifier, commitmentVerifier, ARC_USDC], { PoseidonT3: poseidonT3, PoseidonT4: poseidonT4 });
  await send('Entrypoint.registerPool', entrypoint, encodeFunctionData({ abi: entrypointAbi, functionName: 'registerPool', args: [ARC_USDC, pool, 1_000_000n, 0n, 500n] }));
  const checkout = await deploy('NorenCheckout', 'NorenCheckout', [entrypoint, pool, ARC_USDC]);
  await checkWiring(client, { entrypoint, pool, checkout });
  log('wiring check         Entrypoint -> pool -> USDC, checkout -> Entrypoint + pool: ok');
  const deployment: Deployment = { chainId, deploymentBlock: deploymentBlock.toString(), usdc: ARC_USDC, entrypoint, pool, checkout, withdrawalVerifier, commitmentVerifier };
  return { deployment, steps, gasUsed: steps.reduce((s, x) => s + x.gasUsed, 0n), costWei: steps.reduce((s, x) => s + x.costWei, 0n) };
}

/**
 * Backwards-compatible entry used by scripts/dev-stack.ts and scripts/e2e-fork.ts.
 * A local RPC never writes deployments/5042002.json (that file means "live on Arc testnet");
 * it writes deployments/5042002-fork.json instead.
 */
export async function deployArc(rpcUrl: string, deployer: Address, key?: Hex, write = true, postman: Address = deployer): Promise<Deployment> {
  const result = await deployStack(rpcUrl, deployer, { key, postman, log: line => console.log(line) });
  if (write) writeDeployment(result, isLocal(rpcUrl) ? `${ARC_CHAIN_ID}-fork` : `${ARC_CHAIN_ID}`, { deployer, postman, rpcUrl });
  return result.deployment;
}

function writeDeployment(result: DeployResult, name: string, meta: Record<string, unknown>) {
  mkdirSync('deployments', { recursive: true });
  const record = { ...result.deployment, ...meta, gasUsed: result.gasUsed, costWei: result.costWei, steps: result.steps };
  writeFileSync(`deployments/${name}.json`, jsonBigints(record) + '\n');
  return `deployments/${name}.json`;
}

async function rpc(url: string, method: string, params: unknown[] = []): Promise<any> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body: any = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

export type DryRun = DeployResult & { liveGasPriceWei: bigint; requiredWei: bigint; balanceWei: bigint; erc20Balance: bigint };

/** Forks Arc testnet, deploys from `deployer` (impersonated on the fork only) and measures the real cost. */
export async function dryRunArc(deployer: Address, postman: Address = deployer, forkUrl = ARC_TESTNET_RPC, port = DRY_RUN_PORT): Promise<DryRun> {
  const local = `http://127.0.0.1:${port}`;
  try { await rpc(local, 'eth_chainId'); throw new Error(`Port ${port} already has an RPC server; stop it before the dry run`); } catch (e: any) { if (e.message?.includes('already has')) throw e; }
  const live: any = createPublicClient({ transport: http(forkUrl), cacheTime: 0 });
  if (await live.getChainId() !== ARC_CHAIN_ID) throw new Error(`${forkUrl} is not chain ${ARC_CHAIN_ID}`);
  const [liveGasPriceWei, balanceWei, erc20Balance] = await Promise.all([
    live.getGasPrice(), live.getBalance({ address: deployer }),
    live.readContract({ address: ARC_USDC, abi: usdcAbi, functionName: 'balanceOf', args: [deployer] }),
  ]);
  const anvil: ChildProcess = spawn('anvil', ['--silent', '--host', '127.0.0.1', '--port', String(port), '--fork-url', forkUrl, '--chain-id', String(ARC_CHAIN_ID)], { stdio: ['ignore', 'ignore', 'pipe'] });
  let anvilError = ''; anvil.stderr?.on('data', c => { anvilError += String(c).slice(0, 2000); });
  try {
    for (let i = 0; ; i++) {
      try { if (Number(await rpc(local, 'eth_chainId')) === ARC_CHAIN_ID) break; } catch { /* starting */ }
      if (anvil.exitCode !== null || i === 60) throw new Error(`Anvil fork failed to start: ${anvilError.slice(0, 500)}`);
      await new Promise(r => setTimeout(r, 500));
    }
    // Fork-only: act as the real deployer and give it gas so the measurement runs even before funding.
    await rpc(local, 'anvil_impersonateAccount', [deployer]);
    await rpc(local, 'anvil_setBalance', [deployer, '0x3635c9adc5dea00000']); // 1000 native USDC on the fork
    const result = await deployStack(local, deployer, { postman, log: line => console.log(`  fork  ${line}`) });
    // Price the measured gas at whichever is higher: the fork's effective price or the live gas price.
    const liveCost = result.gasUsed * liveGasPriceWei;
    const measured = liveCost > result.costWei ? liveCost : result.costWei;
    return { ...result, liveGasPriceWei, balanceWei, erc20Balance, requiredWei: measured * MARGIN_BPS / 10_000n };
  } finally {
    if (anvil.exitCode === null) {
      anvil.kill('SIGTERM');
      await new Promise<void>(r => { anvil.once('exit', () => r()); setTimeout(r, 3000); });
      if (anvil.exitCode === null) anvil.kill('SIGKILL');
    }
  }
}

/** Loads NOREN_* settings from the first env file found; never prints values. */
function loadEnvFiles() {
  const candidates = [process.env.NOREN_ENV_FILE, '.env', '.env.arc-deployer'].filter(Boolean) as string[];
  try { // A git worktree also reads the main checkout's .env.arc-deployer.
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    candidates.push(resolve(dirname(common), '.env.arc-deployer'));
  } catch { /* not a git checkout */ }
  for (const file of candidates) if (existsSync(file)) { try { process.loadEnvFile(file); } catch { throw new Error(`Could not parse env file ${file}`); } }
}

const usdc = (wei: bigint) => `${Number(formatUnits(wei, 18)).toFixed(4)} USDC`;

async function main() {
  const args = new Set(process.argv.slice(2));
  loadEnvFiles();
  const rpcUrl = process.env.NOREN_RPC_URL ?? ARC_TESTNET_RPC;
  const raw = process.env.NOREN_DEPLOYER_KEY;
  if (raw !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new Error('NOREN_DEPLOYER_KEY is set but is not a 0x-prefixed 32-byte hex key');
  const key = raw as Hex | undefined;
  const deployer = (key ? privateKeyToAccount(key).address : process.env.NOREN_DEPLOYER_ADDRESS) as Address | undefined;
  if (!deployer || !isAddress(deployer)) throw new Error('Setup required: NOREN_DEPLOYER_KEY or NOREN_DEPLOYER_ADDRESS missing');
  const postman = (process.env.NOREN_POSTMAN_ADDRESS as Address | undefined) ?? deployer;
  if (!isAddress(postman)) throw new Error('NOREN_POSTMAN_ADDRESS is not an address');
  if (isLocal(rpcUrl)) throw new Error('NOREN_RPC_URL points at localhost; use --dry-run for a fork, or pnpm dev:stack for the local stack');

  console.log(`Deployer  ${deployer}`);
  console.log(`Postman   ${postman}`);
  console.log(`Dry run on an Anvil fork of ${rpcUrl} (127.0.0.1:${DRY_RUN_PORT}); nothing is sent to Arc testnet`);
  const dry = await dryRunArc(deployer, postman, rpcUrl);
  const file = writeDeployment(dry, `${ARC_CHAIN_ID}-dryrun`, { fork: true, forkOf: rpcUrl, deployer, postman, liveGasPriceWei: dry.liveGasPriceWei, requiredWei: dry.requiredWei });
  console.log(`Fork deploy: ${dry.steps.length} transactions, ${dry.gasUsed} gas, ${usdc(dry.costWei)} at fork prices`);
  console.log(`Live gas price ${formatUnits(dry.liveGasPriceWei, 9)} gwei; need ${usdc(dry.requiredWei)} (1.5x margin); deployer has ${usdc(dry.balanceWei)} native, ${formatUnits(dry.erc20Balance, 6)} USDC ERC-20`);
  console.log(`Dry-run record: ${file} (fork addresses, not live)`);
  if (args.has('--dry-run')) {
    if (dry.balanceWei < dry.requiredWei) console.log(`BLOCKED: fund ${deployer} with at least ${usdc(dry.requiredWei - dry.balanceWei)} more from https://faucet.circle.com (Arc Testnet)`);
    else console.log('Funded: a real deploy can run now.');
    return;
  }
  if (!key) throw new Error('Setup required: NOREN_DEPLOYER_KEY missing (the dry run above needed only the address)');
  const existing = `deployments/${ARC_CHAIN_ID}.json`;
  if (existsSync(existing) && !args.has('--redeploy')) {
    const prior = JSON.parse(readFileSync(existing, 'utf8'));
    const code = prior.checkout ? await createPublicClient({ transport: http(rpcUrl) }).getCode({ address: prior.checkout }) : undefined;
    if (code && code !== '0x') throw new Error(`${existing} already points at a live NorenCheckout ${prior.checkout}; pass --redeploy to replace it`);
  }
  console.log('Deploying to Arc testnet');
  const result = await deployStack(rpcUrl, deployer, { key, postman, minBalanceWei: dry.requiredWei, log: line => console.log(`  live  ${line}`) });
  writeDeployment(result, `${ARC_CHAIN_ID}`, { deployer, postman, rpcUrl, explorer: ARC_TESTNET_EXPLORER });
  console.log(`Deployed: ${result.steps.length} transactions, ${result.gasUsed} gas, ${usdc(result.costWei)}. Wrote ${existing}`);
  console.log(`Explorer: ${ARC_TESTNET_EXPLORER}/address/${result.deployment.checkout}`);
}

if (process.argv[1]?.endsWith('deploy-arc.ts')) main().catch(e => { console.error(e.shortMessage ?? e.message); process.exit(1); });
