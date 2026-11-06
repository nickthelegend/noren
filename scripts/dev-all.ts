/**
 * `pnpm dev:all`: everything Noren + Tsuke needs, locally, in one command. Ctrl-C stops it all.
 *   - Arc testnet fork (8645) + Noren contracts + ASP postman (8788) + merchant server (8790)   [startStack]
 *   - Robinhood Chain mainnet fork (8646): real Stock Tokens, USDG and Chainlink feeds
 *   - TsukeCredit + underwriter (packages/tsuke), NorenCreditLine (packages/arc-credit),
 *     and the Chainlink CRE bridge in the CRE CLI simulator (packages/cre-bridge), when those packages are present
 * A missing package is reported as "Setup required" and the rest still starts; nothing is faked in its place.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Address } from 'viem';
import { assertRobinhoodFork, ROBINHOOD } from '../packages/server/src/credit.ts';
import type { CreditOptions } from '../packages/server/src/server.ts';
import { PORTS, run, startFork, startStack, type ArcContext } from './stack.ts';
import { startPricing } from './dev-pricing.ts';

const has = (p: string) => existsSync(resolve(p));

run(async () => {
  const robinhoodRpc = await startFork('Robinhood Chain', PORTS.robinhood, ROBINHOOD.rpc, ROBINHOOD.chainId, assertRobinhoodFork);
  const rhFromBlock = String(await fetch(robinhoodRpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' }).then(r => r.json()).then(j => BigInt(j.result)));
  console.log(`Robinhood fork RPC: ${robinhoodRpc} (chain ${ROBINHOOD.chainId}, from block ${rhFromBlock})`);
  const missing: string[] = [];

  const stack = await startStack({
    credit: async (arc: ArcContext): Promise<CreditOptions> => {
      const pub: Record<string, unknown> = { robinhoodFromBlock: rhFromBlock, arcFromBlock: String(await arc.client.getBlockNumber()) };
      if (has('packages/cre-pricing')) {
        try { const p = await startPricing(arc); pub.rateOracle = p.oracle; pub.rateOracleTx = p.tx; pub.rateSourceBlock = p.sourceBlock; }
        catch (e: any) { missing.push(`CRE pricing run failed: ${e.message}`); }
      } else missing.push('packages/cre-pricing: merge the cre-pricing branch');
      let creditLine: Address | undefined;
      if (!has('packages/tsuke')) missing.push('packages/tsuke (TsukeCredit + underwriter): merge the tsuke-credit branch');
      if (!has('packages/arc-credit')) missing.push('packages/arc-credit (NorenCreditLine): merge the cre-bridge branch');
      if (!has('packages/cre-bridge')) missing.push('packages/cre-bridge (CRE workflow): merge the cre-bridge branch');
      return { creditLine, robinhoodRpc, public: pub };
    },
  });

  for (const m of missing) console.log(`Setup required: ${m}`);
  console.log(`Web: pnpm --filter @noren/web dev  →  http://localhost:${PORTS.web}/#/credit`);
  return stack;
});
