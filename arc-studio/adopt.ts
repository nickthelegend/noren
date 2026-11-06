// Verifies the contracts Arc Studio deployed (arc-studio/studio.json) on Arc testnet and, if the
// wiring is correct, writes them as Noren's live deployment: deployments/5042002.json.
//
//   pnpm exec tsx arc-studio/adopt.ts
//
// Studio-reported addresses are untrusted until this passes: code must exist at each address and
// Entrypoint -> pool -> USDC, checkout -> Entrypoint + pool must read back on-chain.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, http, type Address } from 'viem';
import { ARC_CHAIN_ID, ARC_USDC, jsonBigints, type Deployment } from '@noren/core';
import { ARC_TESTNET_EXPLORER, ARC_TESTNET_RPC, checkWiring } from '../scripts/deploy-arc.ts';

const rpcUrl = process.env.NOREN_RPC_URL ?? ARC_TESTNET_RPC;
if (/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(rpcUrl)) throw new Error('adopt writes the live record deployments/5042002.json; refusing a local RPC');
if (!existsSync('arc-studio/studio.json')) throw new Error('arc-studio/studio.json missing: run sh arc-studio/import.sh first');
const studio = JSON.parse(readFileSync('arc-studio/studio.json', 'utf8'));
const find = (name: string): Address => {
  const hits = studio.deployments.filter((d: any) => d.contract === name || d.contract.endsWith(`:${name}`));
  if (hits.length !== 1) throw new Error(`Expected exactly one Studio deployment named ${name}, found ${hits.length}`);
  return hits[0].address;
};
const client: any = createPublicClient({ transport: http(rpcUrl), cacheTime: 0 });
if (await client.getChainId() !== ARC_CHAIN_ID) throw new Error(`${rpcUrl} is not Arc testnet`);
// The Entrypoint users call is the proxy, not the implementation.
const d = { entrypoint: find('ERC1967Proxy'), pool: find('PrivacyPoolComplex'), checkout: find('NorenCheckout') };
await checkWiring(client, d);
const optional = (name: string) => { try { return find(name); } catch { return undefined; } };
const blockOf = async (name: string) => {
  const tx = studio.deployments.find((x: any) => x.contract === name || x.contract.endsWith(`:${name}`))?.txHash;
  return tx ? (await client.getTransactionReceipt({ hash: tx })).blockNumber : undefined;
};
const firstBlock = (await blockOf('PoseidonT3')) ?? (await blockOf('ERC1967Proxy'));
if (firstBlock === undefined) throw new Error('No deploy tx hash from Studio to anchor deploymentBlock; the postman scans logs from it');
const deployment: Deployment = {
  chainId: ARC_CHAIN_ID, deploymentBlock: firstBlock.toString(), usdc: ARC_USDC, ...d,
  withdrawalVerifier: optional('WithdrawalVerifier'), commitmentVerifier: optional('CommitmentVerifier'),
};
const out = `deployments/${ARC_CHAIN_ID}.json`;
if (existsSync(out)) {
  const prior = JSON.parse(readFileSync(out, 'utf8'));
  if (prior.checkout && prior.checkout.toLowerCase() !== d.checkout.toLowerCase() && !process.argv.includes('--replace')) throw new Error(`${out} already holds checkout ${prior.checkout}; pass --replace to adopt Studio's`);
}
mkdirSync('deployments', { recursive: true });
writeFileSync(out, jsonBigints({ ...deployment, source: 'arc-studio', studioUrl: studio.webUrl, rpcUrl, explorer: ARC_TESTNET_EXPLORER, rateOracle: optional('NorenRateOracle'), creditLine: optional('NorenCreditLine') }) + '\n');
writeFileSync('arc-studio/studio.json', JSON.stringify({ ...studio, verifiedOnChain: true, verifiedAt: new Date().toISOString() }, null, 2) + '\n');
for (const [k, v] of Object.entries(d)) console.log(`${k.padEnd(11)} ${v}  ${ARC_TESTNET_EXPLORER}/address/${v}`);
console.log(`Verified on Arc testnet; wrote ${out}`);
