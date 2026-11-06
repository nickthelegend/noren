// "Arrive private" on the PUBLIC Arc testnet: deploys NorenShieldSink and a NorenArcHook build that validates SHIELD,
// then wires them up. Additive: the live NorenArcActionRouter and the live NorenArcHook v2 are not changed, except that
// the router allowlists the sink as a CCTP rail (so the sink can forward every non-SHIELD action to it).
//
//   pnpm exec tsx scripts/live/private-deploy.ts
//
//   1. NorenShieldSink(usdc, Entrypoint, PrivacyPool, NorenArcActionRouter, keccak256("CCTP"), operator)
//   2. NorenArcHook(MessageTransmitterV2, usdc, TokenMessengerV2, MockKeystoneForwarder, operator)  (the privacy hook)
//   3. hook.setRouter(sink)   4. sink.setRail(hook, true)   5. router.setRail(sink, keccak256("CCTP"))
//
// Every tx is sent by the operator key under the shared nonce lock /private/tmp/noren-arc-deployer.lock. Resumable:
// finished steps are kept in scripts/live/private-deployments.json, which is also the public record.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, http, keccak256, parseAbi, toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { localFork } from '@noren/core';
import { readDeployment } from '@noren/core/node';
import { withArcLock } from '../../packages/cctp/scripts/lib.ts';
import { operatorKey, RPC, txLink, addressLink } from './e2e-live.ts';

export const RECORD = resolve('scripts/live/private-deployments.json');
export const ROUTER: Address = '0x3D2ddF0C08ed3574c25f07E5113CaaB5Db6FA7A4';
export const TRANSMITTER: Address = '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275';
export const TOKEN_MESSENGER: Address = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA'; // Circle TokenMessengerV2 (CCTP V2 testnets)
export const FORWARDER: Address = '0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1';
export const RAIL_CCTP = keccak256(toHex('CCTP'));
const OPERATOR = '0x4b2acf80bc6e07bbf5690f0710e25c528cb63f80';

type Tx = { step: string; tx: Hex; gasUsed: string; block: string; url: string };
export type PrivateDeployments = { network: string; chainId: number; operator: Address; NorenShieldSink?: Address; NorenArcHook?: Address; router: Address; txs: Tx[] };
export const readRecord = (): PrivateDeployments => existsSync(RECORD) ? JSON.parse(readFileSync(RECORD, 'utf8')) : { network: 'Arc Testnet (PUBLIC)', chainId: 5042002, operator: '0x4B2ACf80Bc6E07bbF5690f0710e25C528cb63F80', router: ROUTER, txs: [] };
const save = (r: PrivateDeployments) => writeFileSync(RECORD, JSON.stringify(r, null, 2) + '\n');
const artifact = (pkg: string, file: string, name: string) => {
  const a = JSON.parse(readFileSync(resolve('packages', pkg, 'out', file, `${name}.json`), 'utf8'));
  return { abi: a.abi, bytecode: a.bytecode.object as Hex };
};

async function main() {
  execFileSync('forge', ['build'], { cwd: resolve('packages/ccip'), stdio: 'inherit' });
  execFileSync('forge', ['build'], { cwd: resolve('packages/cctp'), stdio: 'inherit' });
  const sink = artifact('ccip', 'NorenShieldSink.sol', 'NorenShieldSink');
  const hook = artifact('cctp', 'NorenArcHook.sol', 'NorenArcHook');
  const d = await readDeployment(5042002);
  const chain = localFork(RPC);
  const client: any = createPublicClient({ chain, transport: http(RPC, { retryCount: 5, retryDelay: 800 }), cacheTime: 0 });
  if (await client.getChainId() !== 5042002) throw new Error(`${RPC} is not Arc testnet`);
  const operator = privateKeyToAccount(operatorKey());
  if (operator.address.toLowerCase() !== OPERATOR) throw new Error('NOREN_DEPLOYER_KEY is not the Noren operator');
  const wallet: any = createWalletClient({ chain, account: operator, transport: http(RPC) });
  const rec = readRecord();
  const routerAbi = parseAbi(['function owner() view returns (address)', 'function setRail(address rail, bytes32 railId)', 'function railOf(address) view returns (bytes32)']);
  if ((await client.readContract({ address: ROUTER, abi: routerAbi, functionName: 'owner' }) as string).toLowerCase() !== OPERATOR) throw new Error('the operator does not own NorenArcActionRouter');

  const settle = async (step: string, hash: Hex) => {
    const r = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (r.status !== 'success') throw new Error(`${step} reverted: ${txLink(hash)}`);
    rec.txs.push({ step, tx: hash, gasUsed: r.gasUsed.toString(), block: r.blockNumber.toString(), url: txLink(hash) }); save(rec);
    console.log(`${step.padEnd(44)} ${txLink(hash)}`);
    return r;
  };
  const done = (step: string) => rec.txs.some(t => t.step === step);

  await withArcLock(async () => {
    if (!rec.NorenShieldSink) {
      const hash = await wallet.deployContract({ abi: sink.abi, bytecode: sink.bytecode, args: [d.usdc, d.entrypoint, d.pool, ROUTER, RAIL_CCTP, operator.address] });
      const r = await settle('deploy NorenShieldSink', hash);
      rec.NorenShieldSink = r.contractAddress; save(rec);
    }
    if (!rec.NorenArcHook) {
      const hash = await wallet.deployContract({ abi: hook.abi, bytecode: hook.bytecode, args: [TRANSMITTER, d.usdc, TOKEN_MESSENGER, FORWARDER, operator.address] });
      const r = await settle('deploy NorenArcHook (SHIELD-aware)', hash);
      rec.NorenArcHook = r.contractAddress; save(rec);
    }
    if (!done('hook.setRouter(sink)')) await settle('hook.setRouter(sink)', await wallet.writeContract({ address: rec.NorenArcHook, abi: hook.abi, functionName: 'setRouter', args: [rec.NorenShieldSink] }));
    if (!done('sink.setRail(hook, true)')) await settle('sink.setRail(hook, true)', await wallet.writeContract({ address: rec.NorenShieldSink, abi: sink.abi, functionName: 'setRail', args: [rec.NorenArcHook, true] }));
    if (!done('router.setRail(sink, CCTP)')) await settle('router.setRail(sink, CCTP)', await wallet.writeContract({ address: ROUTER, abi: routerAbi, functionName: 'setRail', args: [rec.NorenShieldSink, RAIL_CCTP] }));
  });

  // Read back the wiring from chain.
  const hookRouter = await client.readContract({ address: rec.NorenArcHook, abi: hook.abi, functionName: 'router' });
  const sinkRail = await client.readContract({ address: rec.NorenShieldSink, abi: sink.abi, functionName: 'isRail', args: [rec.NorenArcHook] });
  const routerRail = await client.readContract({ address: ROUTER, abi: routerAbi, functionName: 'railOf', args: [rec.NorenShieldSink] });
  if ((hookRouter as string).toLowerCase() !== rec.NorenShieldSink!.toLowerCase() || !sinkRail || routerRail !== RAIL_CCTP) throw new Error('wiring check failed');
  console.log(`NorenShieldSink ${addressLink(rec.NorenShieldSink!)}\nNorenArcHook    ${addressLink(rec.NorenArcHook!)}\nwiring verified on-chain: hook -> sink -> router (CCTP rail)`);
}
if (process.argv[1]?.endsWith('private-deploy.ts')) main().then(() => process.exit(0)).catch(e => { console.error(e?.shortMessage ?? e?.message ?? e); process.exit(1); });
