// MIT
// The hosted Noren merchant server (deploy/vps): the PUBLIC Arc testnet plus the Robinhood Chain mainnet snapshot that the
// noren-rh service serves. No forks of Arc, no dev endpoints, no Arc faucet. Every key is a hot testnet key that exists only
// in the server's .env (generated on the server); see docs/DEPLOY.md "Hosted".
import { existsSync, readFileSync } from 'node:fs';
import { createPublicClient, http, type Address, type Hex } from 'viem';
import { readDeployment } from '@noren/core/node';
import { createMerchantServer, type CreditOptions } from './server.ts';
import { assertRobinhoodFork } from './credit.ts';

const env = (name: string) => { const v = process.env[name]?.trim(); if (!v) throw new Error(`Setup required: ${name} is not set`); return v; };
const key = (name: string) => { const v = env(name); if (!/^0x[0-9a-fA-F]{64}$/.test(v)) throw new Error(`Setup required: ${name} must be a 32-byte hex key`); return v as Hex; };

const rpcUrl = process.env.NOREN_RPC_URL ?? 'https://rpc.testnet.arc.io';
if (/127\.0\.0\.1|localhost/.test(rpcUrl)) throw new Error('The hosted server runs on the public Arc testnet only');
const deployment = await readDeployment(Number(process.env.NOREN_CHAIN_ID ?? 5042002));
const chain = await createPublicClient({ transport: http(rpcUrl) }).getChainId();
if (chain !== deployment.chainId) throw new Error(`NOREN_RPC_URL reports chain ${chain}, expected ${deployment.chainId}`);

// Robinhood side: the warmed mainnet snapshot (Anvil, no upstream). Internal URL for the server, public URL for browsers.
let credit: CreditOptions | undefined;
const rhRpc = process.env.NOREN_RH_SNAPSHOT_RPC;
const rhFile = process.env.NOREN_RH_DEPLOYMENT ?? '/app/robinhood/deployment.json';
if (rhRpc && existsSync(rhFile)) {
  await assertRobinhoodFork(rhRpc);
  const d = JSON.parse(readFileSync(rhFile, 'utf8'));
  const rh: any = createPublicClient({ transport: http(rhRpc), cacheTime: 0 });
  const pub: Record<string, unknown> = {
    robinhoodFromBlock: String(d.deployBlock), robinhoodChainId: Number(await rh.getChainId()), network: 'robinhood-mainnet-snapshot', forkedFromBlock: d.forkedFromBlock ?? null,
    creditLens: d.creditLens ?? null, reputation: d.reputation ?? null, borrow: d.borrow ?? null, depositVaults: d.depositVaults ?? [], aquaLiquidity: d.liquidity ?? null,
    dutchAuction: d.dutchAuction ?? null, aqua: d.aqua ?? null, creditContract: d.credit, gateway: d.gateway, vault: d.vault, stockOracle: d.oracle,
    rateOracle: process.env.NOREN_RATE_ORACLE ?? null,
  };
  credit = { liquidity: d.liquidity as Address | undefined, rateOracle: (process.env.NOREN_RATE_ORACLE || undefined) as Address | undefined, robinhoodRpc: rhRpc, gateway: d.gateway as Address, robinhoodFromBlock: BigInt(d.deployBlock), public: pub };
  console.log(`Robinhood Chain mainnet snapshot: NorenGateway ${d.gateway}, NorenVault ${d.vault} (mainnet block ${d.forkedFromBlock ?? '?'})`);
} else console.log('Setup required: NOREN_RH_SNAPSHOT_RPC / NOREN_RH_DEPLOYMENT not set; Robinhood features answer Setup required');

const mounts: ((req: any, res: any) => Promise<boolean>)[] = [];
// Reclaim (zkTLS) answers "Setup required" until RECLAIM_APP_ID / RECLAIM_APP_SECRET are set.
try {
  const { createReclaimHandler } = await import('./reclaim.ts');
  mounts.push(createReclaimHandler({ env: process.env, storeFile: (process.env.NOREN_DATA_DIR ?? '/data') + '/reclaim-proofs.json' }) as any);
} catch (e: any) { console.error(`Reclaim routes not mounted: ${String(e?.message ?? e).slice(0, 200)}`); }

const server = createMerchantServer({
  deployment, rpcUrl,
  merchantKey: key('NOREN_MERCHANT_KEY'), merchantToken: env('NOREN_MERCHANT_TOKEN'),
  dataFile: (process.env.NOREN_DATA_DIR ?? '/data') + '/invoices.json',
  privateRelay: { relayerKey: key('NOREN_RELAYER_KEY') },
  credit, mounts,
  hosted: {
    aspUrl: env('NOREN_ASP_URL'),
    robinhoodRpcPublic: process.env.NOREN_RH_RPC_PUBLIC,
    storeFunderKey: key('NOREN_STORE_FUNDER_KEY'),
    storeGasWei: BigInt(process.env.NOREN_STORE_GAS_WEI ?? '50000000000000000'),
    maxStores: Number(process.env.NOREN_MAX_STORES ?? 25),
    robinhoodFaucet: !!credit,
  },
});
server.listen(Number(process.env.PORT ?? 8790), process.env.HOST ?? '0.0.0.0', () => console.log('Noren hosted merchant server ready'));
