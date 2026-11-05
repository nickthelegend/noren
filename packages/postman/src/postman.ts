import { createServer, type Server } from 'node:http';
import { LeanIMT } from '@zk-kit/lean-imt';
import { hash2 } from 'maci-crypto';
import { createPublicClient, http, type Address, type Hex } from 'viem';
import { entrypointAbi, jsonBigints, localFork, poolAbi, usdcAbi, type Deployment } from '@noren/core';

export type PostmanOptions = { deployment: Deployment; rpcUrl: string; delayMs?: number; batchMs?: number; sendRoot: (root: bigint, cid: string) => Promise<Hex>; treeUrl: string; onTx?: (hash: Hex) => void };
export function createPostman(options: PostmanOptions) {
  if (options.treeUrl.length < 32 || options.treeUrl.length > 64) throw new Error('Setup required: ASP tree URL must be 32–64 bytes');
  const client: any = createPublicClient({ chain: localFork(options.rpcUrl), transport: http(options.rpcUrl), cacheTime: 0 });
  const allowed = new Set<string>();
  const seen = new Map<string, { label: bigint; depositor: Address; firstSeen: number }>();
  let nextBlock = BigInt(options.deployment.deploymentBlock);
  let postedRoot = 0n;
  let tree: bigint[][] = [];
  const snapshots = new Map<string, bigint[][]>();
  let version = 0;
  let lastPost = 0;
  let busy = false;
  function buildTree() {
    const leaves = [...allowed].map(BigInt).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    const imt = new LeanIMT((a: bigint, b: bigint) => hash2([a, b]), leaves);
    return { root: imt.root ?? 0n, nodes: leaves.length ? JSON.parse(imt.export()).map((level: string[]) => level.map(BigInt)) as bigint[][] : [] };
  }
  async function tick(force = false) {
    if (busy) return;
    busy = true;
    try {
      const head = await client.getBlockNumber();
      while (head >= nextBlock) {
        const end = nextBlock + 4999n < head ? nextBlock + 4999n : head;
        const logs = await client.getLogs({ address: options.deployment.pool, event: poolAbi.find((x: any) => x.type === 'event' && x.name === 'Deposited') as any, fromBlock: nextBlock, toBlock: end });
        for (const log of logs) {
          const args = (log as any).args;
          const label = BigInt(args.label);
          seen.set(label.toString(), { label, depositor: args.depositor, firstSeen: Date.now() });
        }
        nextBlock = end + 1n;
      }
      for (const [key, item] of seen) {
        if (allowed.has(key) || Date.now() - item.firstSeen < (options.delayMs ?? 1000)) continue;
        const blacklisted = await client.readContract({ address: options.deployment.usdc, abi: usdcAbi, functionName: 'isBlacklisted', args: [item.depositor] });
        if (!blacklisted) allowed.add(key);
      }
      const next = buildTree();
      if (next.root !== 0n && next.root !== postedRoot && (force || Date.now() - lastPost >= (options.batchMs ?? 60_000))) {
        // The CID field points to an immutable version on our endpoint.
        const cid = `${options.treeUrl.replace(/\?v=\d+$/, '')}?v=${++version}`;
        if (cid.length < 32 || cid.length > 64) throw new Error('Setup required: versioned ASP tree URL must be 32–64 bytes');
        snapshots.set(String(version), next.nodes);
        const hash = await options.sendRoot(next.root, cid);
        const receipt = await client.waitForTransactionReceipt({ hash });
        if (receipt.status !== 'success') throw new Error('ASP root update reverted');
        tree = next.nodes; postedRoot = next.root; lastPost = Date.now(); options.onTx?.(hash);
      }
    } finally { busy = false; }
  }
  function serve(port: number): Server {
    return createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/asp/tree') { res.writeHead(404); res.end(); return; }
      const snapshot = url.searchParams.has('v') ? snapshots.get(url.searchParams.get('v')!) : tree;
      if (!snapshot) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(jsonBigints(snapshot));
    }).listen(port, '127.0.0.1');
  }
  return { tick, serve, get tree() { return tree; }, get approvedLabels() { return [...allowed].map(BigInt); }, get root() { return postedRoot; } };
}
