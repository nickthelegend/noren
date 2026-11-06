/**
 * `pnpm dev:all`: everything Noren needs, locally, in one command. Ctrl-C stops it all.
 *   - Arc testnet fork (8645) + Noren contracts + ASP postman (8788) + merchant server (8790)   [startStack]
 *   - Robinhood Chain mainnet fork (8646): real Stock Tokens, USDG and Chainlink feeds
 *   - NorenCredit, NorenGateway, NorenVault + underwriter (packages/robinhood), NorenCreditLine (packages/arc-credit),
 *     and the Chainlink CRE bridge in the CRE CLI simulator (packages/cre-bridge), when those packages are present
 * A missing package is reported as "Setup required" and the rest still starts; nothing is faked in its place.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, http, type Address } from 'viem';
import { assertRobinhoodFork, ROBINHOOD } from '../packages/server/src/credit.ts';
import type { CreditOptions } from '../packages/server/src/server.ts';
import { onStop, PORTS, run, startFork, startStack, type ArcContext } from './stack.ts';
import { startPricing } from './dev-pricing.ts';
import { deployCreditLine, deployRobinhood, type RobinhoodDeployment } from './dev-robinhood.ts';
import { prepareRobinhoodForCre, startBridgeRelay, type BridgeEntry } from './dev-bridge.ts';

const has = (p: string) => existsSync(resolve(p));

run(async () => {
  // Robinhood Chain *mainnet* state: real Stock Tokens and Chainlink feeds (Robinhood testnet has neither).
  const robinhoodRpc = await startFork('Robinhood Chain', PORTS.robinhood, ROBINHOOD.rpc, ROBINHOOD.chainId, assertRobinhoodFork);
  const rh: any = createPublicClient({ transport: http(robinhoodRpc), cacheTime: 0 });
  const rhFromBlock: bigint = await rh.getBlockNumber();
  console.log(`Robinhood fork RPC: ${robinhoodRpc} (mainnet state from block ${rhFromBlock})`);
  const missing: string[] = [];

  let robinhood: RobinhoodDeployment | undefined;
  if (has('packages/robinhood/contracts/script/Deploy.s.sol')) {
    try {
      robinhood = await deployRobinhood(robinhoodRpc);
      console.log(`Robinhood fork: NorenCredit ${robinhood.credit}, NorenGateway ${robinhood.gateway}, NorenVault ${robinhood.vault} (seeded 25,000 USDG, tx ${robinhood.vaultSeedTx})`);
    } catch (e: any) { missing.push(`Robinhood deploy failed: ${e.message}`); }
  } else missing.push('packages/robinhood (NorenCredit + underwriter): merge the Robinhood contracts branch (tsuke-credit)');

  const bridgeReady = has('packages/cre-bridge/credit-bridge/workflow.yaml');
  if (bridgeReady) {
    try { await prepareRobinhoodForCre(robinhoodRpc); console.log('Robinhood fork now served as chain 46630 (CRE robinhood-testnet) with the real robinhood-testnet MockKeystoneForwarder'); }
    catch (e: any) { missing.push(`CRE bridge setup failed: ${e.message}`); }
  }
  let bridgeLog: BridgeEntry[] | undefined, creditLineAddr: Address | undefined, arcCreditFrom: bigint | undefined;
  const stack = await startStack({
    credit: async (arc: ArcContext): Promise<CreditOptions> => {
      const pub: Record<string, unknown> = { robinhoodFromBlock: String(rhFromBlock), arcFromBlock: String(await arc.client.getBlockNumber()) };
      if (has('packages/cre-pricing')) {
        try { const p = await startPricing(arc); pub.rateOracle = p.oracle; pub.rateOracleTx = p.tx; pub.rateSourceBlock = p.sourceBlock; }
        catch (e: any) { missing.push(`CRE pricing run failed: ${e.message}`); }
      } else missing.push('packages/cre-pricing: merge the cre-pricing branch');
      let creditLine: Address | undefined;
      if (has('packages/arc-credit/src/NorenCreditLine.sol')) {
        try { const c = await deployCreditLine(arc); creditLine = creditLineAddr = c.creditLine; arcCreditFrom = c.deployBlock; pub.arcFromBlock = String(c.deployBlock); console.log(`NorenCreditLine on Arc fork: ${c.creditLine} (pool ${Number(c.poolUsdc) / 1e6} USDC)`); }
        catch (e: any) { missing.push(`NorenCreditLine deploy failed: ${e.message}`); }
      } else missing.push('packages/arc-credit (NorenCreditLine): merge the cre-bridge branch');
      if (robinhood) Object.assign(pub, { robinhood: robinhood.credit, gateway: robinhood.gateway, vault: robinhood.vault, stockOracle: robinhood.oracle, robinhoodFromBlock: String(robinhood.deployBlock) });
      pub.robinhoodChainId = Number(await rh.getChainId());
      return { bridgeLog: () => bridgeLog ?? [], creditLine, robinhoodRpc, gateway: robinhood?.gateway, robinhoodFromBlock: robinhood?.deployBlock, public: pub };
    },
  });

  if (bridgeReady && robinhood && creditLineAddr && arcCreditFrom !== undefined) {
    const relay = startBridgeRelay({ arcRpc: stack.rpcUrl, robinhoodRpc, credit: robinhood.credit, creditLine: creditLineAddr, arcFrom: arcCreditFrom, rhFrom: robinhood.deployBlock });
    bridgeLog = relay.log; onStop(relay.stop);
    console.log('CRE credit bridge: relaying CreditLineOpened/Closed (Robinhood) and Drawn/Repaid (Arc) through the CRE simulator with --broadcast');
  } else if (!bridgeReady) missing.push('packages/cre-bridge (CRE credit bridge workflow): merge the cre-bridge branch');
  for (const m of missing) console.log(`Setup required: ${m}`);
  console.log(`Web: pnpm --filter @noren/web dev  →  http://localhost:${PORTS.web}/#/credit`);
  return stack;
});
