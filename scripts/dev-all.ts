/**
 * `pnpm dev:all`: everything Noren needs, locally, in one command. Ctrl-C stops it all.
 *   - Arc testnet fork (8645) + Noren contracts + ASP postman (8788) + merchant server (8790)   [startStack]
 *   - Robinhood Chain (8646): a warmed snapshot of mainnet state (real Stock Tokens, USDG, Chainlink feeds) with the
 *     Robinhood contracts deployed
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
import { adoptSnapshotDeployment, deployCreditLine, deployRobinhood, type RobinhoodDeployment } from './dev-robinhood.ts';
import { creSimulate } from './cre.ts';
import { deploySettlementDesk, requestSettlement, startSettlementRelay } from './dev-settlement.ts';
import { relayDeposit, acrossDeposit } from '../packages/bridge-settlement/keeper/lib.ts';
import { prepareRobinhoodForCre, startBridgeRelay, type BridgeEntry } from './dev-bridge.ts';

const has = (p: string) => existsSync(resolve(p));
const UNDERWRITER_PORT = 8791, AI_UNDERWRITER_PORT = 8792;

/** Starts a package's HTTP server in this process on one of the web agent's ports and registers it for shutdown. */
async function listen(server: import('node:http').Server, port: number) {
  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', ok); });
  onStop(() => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }));
  return `http://127.0.0.1:${port}`;
}

run(async () => {
  const missing: string[] = [];
  // Robinhood Chain *mainnet* state: real Stock Tokens and Chainlink feeds (Robinhood testnet has neither). The public RPC
  // keeps only ~10 minutes of state, so a live fork breaks; dev:all loads the Robinhood package's warmed snapshot
  // (mainnet state at a block, with NorenCredit/NorenGateway/NorenVault deployed by its own scripts).
  const snapshot = resolve('packages/robinhood/.fork/robinhood-snapshot.json');
  let robinhood: RobinhoodDeployment | undefined;
  let robinhoodRpc: string;
  if (existsSync(snapshot)) {
    robinhoodRpc = await startFork('Robinhood Chain', PORTS.robinhood, { state: snapshot }, ROBINHOOD.chainId, assertRobinhoodFork);
    robinhood = await adoptSnapshotDeployment(robinhoodRpc, resolve('packages/robinhood/.fork/deployment.json'));
    console.log(`Robinhood snapshot: ${robinhoodRpc} (mainnet block ${robinhood.forkedFromBlock}); NorenCredit ${robinhood.credit}, NorenGateway ${robinhood.gateway}, NorenVault ${robinhood.vault}`);
  } else {
    robinhoodRpc = await startFork('Robinhood Chain', PORTS.robinhood, ROBINHOOD.rpc, ROBINHOOD.chainId, assertRobinhoodFork);
    missing.push('Robinhood snapshot: run sh packages/robinhood/scripts/fork-snapshot.sh once (a live fork of the public RPC stops working after ~10 minutes)');
    if (has('packages/robinhood/contracts/script/Deploy.s.sol')) {
      try { robinhood = await deployRobinhood(robinhoodRpc); } catch (e: any) { missing.push(`Robinhood deploy failed: ${e.message}`); }
    }
  }
  const rh: any = createPublicClient({ transport: http(robinhoodRpc), cacheTime: 0 });

  let settle: { desk: Address; deployBlock: bigint; keeper: any; relay?: ReturnType<typeof startSettlementRelay> } | undefined;
  if (has('packages/bridge-settlement/src/NorenSettlementDesk.sol')) {
    try { settle = await deploySettlementDesk(robinhoodRpc); console.log(`NorenSettlementDesk on Robinhood: ${settle.desk}`); }
    catch (e: any) { missing.push(`Settle to Arc: desk deploy failed: ${e.message}`); }
  }
  const bridgeReady = has('packages/cre-bridge/credit-bridge/workflow.yaml');
  if (bridgeReady) {
    try { await prepareRobinhoodForCre(robinhoodRpc); console.log('Robinhood fork now served as chain 46630 (CRE robinhood-testnet) with the real robinhood-testnet MockKeystoneForwarder'); }
    catch (e: any) { missing.push(`CRE bridge setup failed: ${e.message}`); }
  }
  let bridgeLog: BridgeEntry[] | undefined, creditLineAddr: Address | undefined, arcCreditFrom: bigint | undefined;
  const stack = await startStack({
    mounts: async (arc) => {
      // World ID: one unsecured starter credit line per verified human; Noren keeps only the nullifier.
      if (!has('packages/world-id/src/server.ts')) { missing.push('packages/world-id: merge the world-id branch'); return [settle ? settlementHandler(settle, robinhoodRpc, arc) : missingSettlementHandler()]; }
      if (existsSync('.env')) process.loadEnvFile('.env');
      const w = await import('../packages/world-id/src/server.ts');
      const config = w.loadWorldIdConfig(process.env);
      const gaps = w.missingSettings(config);
      if (gaps.length) missing.push(`World ID: ${gaps.join(', ')} (Nick creates the World Developer Portal app, action "noren-credit")`);
      const workflow = resolve('packages/cre-bridge/credit-bridge');
      // The bridge workflow's HTTP trigger (onHumanStarter) is its fourth handler.
      const bridgeMain = existsSync(resolve(workflow, 'main.ts')) ? (await import('node:fs')).readFileSync(resolve(workflow, 'main.ts'), 'utf8') : '';
      const httpIndex = process.env.NOREN_STARTER_CRE_TRIGGER_INDEX ? Number(process.env.NOREN_STARTER_CRE_TRIGGER_INDEX) : /onHumanStarter,\s*\)/.test(bridgeMain) ? 3 : undefined;
      const sink = httpIndex === undefined ? undefined : {
        kind: 'cre-simulate' as const,
        async open(r: any) {
          const base = JSON.parse((await import('node:fs')).readFileSync(resolve(workflow, 'config.staging.json'), 'utf8'));
          const out = await creSimulate({ workflowDir: workflow, target: 'local-fork', rpcs: { 'arc-testnet': arc.rpcUrl, 'robinhood-testnet': robinhoodRpc }, config: { ...base, robinhood: { ...base.robinhood, address: robinhood?.credit }, arc: { ...base.arc, address: creditLineAddr } }, broadcast: true, triggerIndex: httpIndex, httpPayload: w.httpTriggerPayload(r) });
          const tx = /updated on [a-z-]+: tx (0x[0-9a-f]{64})/.exec(out)?.[1];
          if (!tx) throw new Error('CRE human-starter run wrote nothing');
          return { txHash: tx as `0x${string}` };
        },
      };
      if (!sink) missing.push('World ID starter line: the bridge workflow has no HTTP trigger yet; verified humans are recorded and the line opens on retry');
      const worldId = w.createWorldIdHandler(new w.WorldIdService({ config, dataFile: resolve('data/world-id-nullifiers.json'), sink, ...(creditLineAddr ? { arc: { rpcUrl: arc.rpcUrl, creditLine: creditLineAddr } } : {}) }));
      return [worldId, settle ? settlementHandler(settle, robinhoodRpc, arc) : missingSettlementHandler()];
    },
    credit: async (arc: ArcContext): Promise<CreditOptions> => {
      const pub: Record<string, unknown> = { robinhoodFromBlock: String(robinhood?.deployBlock ?? (await rh.getBlockNumber())), arcFromBlock: String(await arc.client.getBlockNumber()) };
      if (settle) pub.settlementDesk = settle.desk;
      if (has('packages/cre-pricing')) {
        try { const p = await startPricing(arc); pub.rateOracle = p.oracle; pub.rateOracleTx = p.tx; pub.rateSourceBlock = p.sourceBlock; }
        catch (e: any) { missing.push(`CRE pricing run failed: ${e.message}`); }
      } else missing.push('packages/cre-pricing: merge the cre-pricing branch');
      let creditLine: Address | undefined;
      if (has('packages/arc-credit/src/NorenCreditLine.sol')) {
        try { const c = await deployCreditLine(arc); creditLine = creditLineAddr = c.creditLine; arcCreditFrom = c.deployBlock; pub.arcFromBlock = String(c.deployBlock); console.log(`NorenCreditLine on Arc fork: ${c.creditLine} (pool ${Number(c.poolUsdc) / 1e6} USDC)`); }
        catch (e: any) { missing.push(`NorenCreditLine deploy failed: ${e.message}`); }
      } else missing.push('packages/arc-credit (NorenCreditLine): merge the cre-bridge branch');
      if (has('packages/robinhood/underwriter/src/server.ts') && robinhood) {
        try {
          Object.assign(process.env, { NOREN_RH_CREDIT: robinhood.credit, NOREN_RH_RPC: robinhoodRpc, NOREN_RH_DECISIONS_LOG: resolve('data/underwriter-decisions.jsonl') }); // history stays on Robinhood mainnet (read-only)
          const { server } = await import('../packages/robinhood/underwriter/src/server.ts' as string);
          pub.underwriterUrl = await listen(server, UNDERWRITER_PORT);
        } catch (e: any) { missing.push(`History underwriter failed to start: ${e.message}`); }
      } else missing.push('packages/robinhood/underwriter: merge the Robinhood branch with the underwriter');
      if (has('packages/ai-underwriter/src/server.ts')) {
        try {
          const { createCreditServer } = await import('../packages/ai-underwriter/src/server.ts');
          const { loadEnv } = await import('../packages/ai-underwriter/src/env.ts');
          loadEnv();
          pub.aiUnderwriterUrl = await listen(createCreditServer({ decisionsPath: resolve('data/ai-decisions.jsonl'), robinhoodUnderwriterUrl: `http://127.0.0.1:${UNDERWRITER_PORT}` }), AI_UNDERWRITER_PORT);
          if (!process.env.ZG_PC_API_KEY) missing.push('0G credit check: ZG_PC_API_KEY is not set (Nick creates it on 0G Private Computer); checks are refused until then');
        } catch (e: any) { missing.push(`0G credit check failed to start: ${e.message}`); }
      }
      if (robinhood) Object.assign(pub, { aquaLiquidity: robinhood.liquidity ?? null, aqua: robinhood.aqua ?? null, creditContract: robinhood.credit, gateway: robinhood.gateway, vault: robinhood.vault, stockOracle: robinhood.oracle, robinhoodFromBlock: String(robinhood.deployBlock) });
      pub.robinhoodChainId = Number(await rh.getChainId());
      return { liquidity: robinhood?.liquidity, rateOracle: pub.rateOracle as Address | undefined, bridgeLog: () => bridgeLog ?? [], creditLine, robinhoodRpc, gateway: robinhood?.gateway, robinhoodFromBlock: robinhood?.deployBlock, public: pub };
    },
  });

  if (bridgeReady && robinhood && creditLineAddr && arcCreditFrom !== undefined) {
    const relay = startBridgeRelay({ arcRpc: stack.rpcUrl, robinhoodRpc, credit: robinhood.credit, creditLine: creditLineAddr, arcFrom: arcCreditFrom, rhFrom: robinhood.deployBlock });
    bridgeLog = relay.log; onStop(relay.stop);
    console.log('CRE credit bridge: relaying CreditLineOpened/Closed (Robinhood) and Drawn/Repaid (Arc) through the CRE simulator with --broadcast');
  } else if (!bridgeReady) missing.push('packages/cre-bridge (CRE credit bridge workflow): merge the cre-bridge branch');
  if (settle && bridgeReady) {
    try { settle.relay = startSettlementRelay({ robinhoodRpc, desk: settle.desk, fromBlock: settle.deployBlock, keeper: settle.keeper }); onStop(settle.relay.stop); console.log('Settle to Arc: CRE settlement-desk workflow + Relay keeper armed (the Arc fill needs a real relayer)'); }
    catch (e: any) { missing.push(`Settle to Arc relay failed: ${e.message}`); }
  }
  for (const m of missing) console.log(`Setup required: ${m}`);
  console.log(`Web: pnpm --filter @noren/web dev  →  http://localhost:${PORTS.web}/#/credit`);
  return stack;
});

/** Merchant routes for Settle to Arc (bearer token as for the rest of the merchant API). */
function missingSettlementHandler() {
  return async (req: any, res: any) => {
    if (!/^\/(bridge\/|merchants\/0x[0-9a-fA-F]{40}\/settlements$)/.test(new URL(req.url ?? '/', 'http://x').pathname)) return false;
    res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'Setup required: NorenSettlementDesk is not deployed on the Robinhood fork' })); return true;
  };
}
function settlementHandler(settle: { desk: Address; relay?: ReturnType<typeof startSettlementRelay> }, robinhoodRpc: string, arc: ArcContext & { token: string }) {
  return async (req: any, res: any) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const m = /^\/merchants\/(0x[0-9a-fA-F]{40})\/settlements$/.exec(url.pathname);
    const consumer = /^\/bridge\/settlements\/(0x[0-9a-fA-F]{40})$/.exec(url.pathname);
    if (!m && !consumer && url.pathname !== '/bridge/quote') return false;
    const send = (status: number, v: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString() : x)); return true; };
    if (consumer && req.method === 'GET') return send(200, { desk: settle.desk, settlements: (settle.relay?.list() ?? []).filter(e => e.merchant.toLowerCase() === consumer[1].toLowerCase()) });
    if (url.pathname === '/bridge/quote' && req.method === 'GET') {
      const amount = url.searchParams.get('amountUsdg6') ?? '', recipient = url.searchParams.get('recipient') ?? '';
      if (!/^\d+$/.test(amount) || BigInt(amount) < 1_000_000n || BigInt(amount) > 1_000_000_000_000n || !/^0x[0-9a-fA-F]{40}$/.test(recipient)) return send(400, { error: 'Invalid quote: amountUsdg6 must be 1..1,000,000 USDG and recipient must be an address' });
      const input = { desk: settle.desk, arcRecipient: recipient as Address, amountUsdg6: BigInt(amount), minOutUsdc6: 0n };
      const [relay, across] = await Promise.allSettled([relayDeposit(input), acrossDeposit(input)]);
      return send(200, { relay: relay.status === 'fulfilled' ? { outUsdc6: relay.value.quotedOutUsdc6.toString(), seconds: relay.value.seconds, feeUsd: relay.value.feeUsd ?? null } : { error: String(relay.reason?.message ?? relay.reason) }, across: across.status === 'fulfilled' ? { outUsdc6: across.value.quotedOutUsdc6.toString(), seconds: across.value.seconds } : { error: String(across.reason?.message ?? across.reason) } });
    }
    if (!m) return send(405, { error: 'Method not allowed' });
    if (!req.norenAuthenticated?.()) return send(401, { error: 'Merchant bearer token required' });
    if (!req.norenMerchantAllowed?.(m[1])) return send(403, { error: 'NotMerchant: this key does not belong to that store' });
    const rh: any = createPublicClient({ transport: http(robinhoodRpc), cacheTime: 0 });
    try {
      if (req.method === 'GET') {
        const usdg = await rh.readContract({ address: ROBINHOOD.usdg, abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }], functionName: 'balanceOf', args: [m[1]] });
        return send(200, { desk: settle.desk, usdg: String(usdg), relay: !!settle.relay, settlements: (settle.relay?.list() ?? []).filter(e => e.merchant.toLowerCase() === m[1].toLowerCase()) });
      }
      if (req.method === 'POST') {
        let raw = ''; for await (const c of req) raw += c;
        const amount = BigInt(JSON.parse(raw || '{}').amountUsdg6 ?? '0');
        const tx = await requestSettlement(robinhoodRpc, settle.desk, m[1] as Address, amount, m[1] as Address);
        return send(200, { requestTx: tx });
      }
      return send(405, { error: 'Method not allowed' });
    } catch (e: any) { return send(400, { error: String(e.message).slice(0, 240) }); }
  };
}
