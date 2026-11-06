/**
 * dev:all, pricing: deploys NorenRateOracle (packages/contracts, cre-pricing agent) on the Arc fork with the real
 * MockKeystoneForwarder, then runs the cre-pricing workflow once in the CRE simulator with --broadcast. The workflow
 * reads live Chainlink feeds on Arc mainnet (read-only) and writes them to the oracle through the forwarder.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { encodeDeployData, parseAbi, toHex, type Address, type Hex } from 'viem';
import { creAccount, creSimulate, prepareWorkflow } from './cre.ts';
import type { ArcContext } from './stack.ts';

export const MOCK_FORWARDER: Address = '0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1';
const WORKFLOW = 'packages/cre-pricing/rate-oracle';
export const oracleAbi = parseAbi(['function lastSourceBlock() view returns (uint64)', 'function quote(string currency, uint256 fiatAmount) view returns (uint256 usdcAmount, uint80 fiatUsdRoundId, uint80 usdcUsdRoundId, uint256 oldestUpdatedAt)']);

export async function startPricing(arc: ArcContext) {
  const dir = prepareWorkflow(WORKFLOW);
  if ((await arc.client.getCode({ address: MOCK_FORWARDER }) ?? '0x') === '0x') throw new Error('MockKeystoneForwarder has no code on the Arc fork');
  const base = JSON.parse(readFileSync(resolve(dir, 'config.staging.json'), 'utf8'));
  const art = JSON.parse(readFileSync(resolve('packages/contracts/out/NorenRateOracle.sol/NorenRateOracle.json'), 'utf8'));
  const data = encodeDeployData({ abi: art.abi, bytecode: art.bytecode.object as Hex, args: [MOCK_FORWARDER, BigInt(base.sourceChainId), base.usdcUsdFeed, BigInt(base.maxAgeSeconds), base.currencies.map((c: any) => c.code), base.currencies.map((c: any) => c.feed ?? '0x0000000000000000000000000000000000000000'), base.currencies.map((c: any) => c.minorDecimals)] });
  const hash = await arc.client.request({ method: 'eth_sendTransaction', params: [{ from: arc.deployer, data }] }) as Hex;
  const receipt = await arc.client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error(`NorenRateOracle deploy reverted: ${hash}`);
  const oracle = receipt.contractAddress as Address;
  await arc.client.request({ method: 'anvil_setBalance', params: [creAccount.address, toHex(10n ** 20n)] });
  const config = { ...base, oracle: { ...base.oracle, address: oracle } };
  const t0 = Date.now();
  const out = await creSimulate({ workflowDir: dir, target: 'local-fork', rpcs: { 'arc-testnet': arc.rpcUrl }, config, broadcast: true, triggerIndex: 0 });
  const tx = /NorenRateOracle updated: .* tx (0x[0-9a-f]{64})/.exec(out)?.[1];
  const sourceBlock = await arc.client.readContract({ address: oracle, abi: oracleAbi, functionName: 'lastSourceBlock' });
  if (!tx || sourceBlock === 0n) throw new Error(`CRE pricing run wrote nothing: ${out.slice(-600)}`);
  console.log(`CRE pricing: NorenRateOracle ${oracle} updated by the simulator in ${((Date.now() - t0) / 1000).toFixed(1)} s (tx ${tx}, Arc mainnet block ${sourceBlock})`);
  return { oracle, tx, sourceBlock: String(sourceBlock) };
}
