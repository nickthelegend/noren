import { execFile } from 'node:child_process';
import { encodeAbiParameters, encodeFunctionData, getAddress, keccak256, parseAbi, toHex, type Address, type Hex } from 'viem';
import { Nullifier } from '@worldcoin/idkit-core/nullifier';

/**
 * The "human starter limit" report for NorenCreditLine on Arc (owned by the bridge agent).
 *
 *   report = abi.encode(bytes32 kind, address borrower, bytes32 nullifierHash, uint256 limitUsdc6, uint64 expiry)
 *   kind   = keccak256("noren.human-starter.v1")        (160 bytes, so it can't be confused with the
 *                                                         128-byte stock-collateral report)
 *   lineId = NorenCreditLine.starterLineId(borrower) = keccak256(abi.encode("noren.human-starter.v1", borrower))
 *            (the contract enforces one line per nullifierHash)
 *
 * The contract is asked to open the line once per nullifierHash, refuse a limit above its own cap,
 * and never let a stock-collateral report touch a human line (see docs/WORLD.md, "Bridge contract").
 */
export const HUMAN_STARTER_KIND: Hex = keccak256(toHex('noren.human-starter.v1'));

export const nullifierHash = (nullifier: string): Hex => toHex(Nullifier.fromHex(nullifier).toBigInt(), { size: 32 });

/**
 * The Arc line ID, exactly as the contract and the bridge derive it:
 *   NorenCreditLine.starterLineId(borrower) = keccak256(abi.encode("noren.human-starter.v1", borrower))
 * It is a pure function on-chain, so this equals the eth_call result; readStarterLineId asks the contract itself.
 */
export const starterLineId = (borrower: string): Hex =>
  keccak256(encodeAbiParameters([{ type: 'string' }, { type: 'address' }], ['noren.human-starter.v1', getAddress(borrower)]));

/** NorenCreditLine.starterLineId(borrower) by eth_call. */
export async function readStarterLineId(rpcUrl: string, creditLine: string, borrower: string): Promise<Hex> {
  const data = encodeFunctionData({ abi: parseAbi(['function starterLineId(address borrower) pure returns (bytes32)']), functionName: 'starterLineId', args: [getAddress(borrower)] });
  const r = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: creditLine, data }, 'latest'] }) });
  const j = await r.json() as { result?: string; error?: { message: string } };
  if (j.error || !j.result || !/^0x[0-9a-fA-F]{64}$/.test(j.result)) throw new Error(`starterLineId read failed: ${j.error?.message ?? j.result}`);
  return j.result as Hex;
}

export type StarterLineRequest = { borrower: Address; nullifierHash: Hex; lineId: Hex; limitUsdc6: bigint; expiry: number; report: Hex };

export function humanStarterRequest(opts: { borrower: string; nullifier: string; limitUsdc6: bigint; expiry: number }): StarterLineRequest {
  const borrower = getAddress(opts.borrower);
  const nh = nullifierHash(opts.nullifier);
  if (opts.limitUsdc6 <= 0n) throw new Error('starter limit must be positive');
  if (!Number.isInteger(opts.expiry) || opts.expiry <= 0) throw new Error('starter expiry must be a unix time');
  const report = encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'address' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint64' }],
    [HUMAN_STARTER_KIND, borrower, nh, opts.limitUsdc6, BigInt(opts.expiry)],
  );
  return { borrower, nullifierHash: nh, lineId: starterLineId(borrower), limitUsdc6: opts.limitUsdc6, expiry: opts.expiry, report };
}

/** JSON the CRE HTTP trigger receives (the workflow re-encodes and re-checks it before writing). */
export const httpTriggerPayload = (r: StarterLineRequest) => ({
  kind: 'noren.human-starter.v1', borrower: r.borrower, nullifierHash: r.nullifierHash, lineId: r.lineId, limitUsdc6: r.limitUsdc6.toString(), expiry: r.expiry,
});

/** Something that gets the starter report onto Arc and returns the write's tx hash. */
export type StarterLineSink = { kind: 'cre-simulate'; open(r: StarterLineRequest): Promise<{ txHash: Hex }> };

const scrub = (s: string) => s.replace(/0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/g, '0x…').replace(/\s+/g, ' ').slice(0, 240);

/**
 * Runs the bridge's CRE workflow in the local simulator with --broadcast, exactly like
 * packages/cre-bridge/scripts/fork-simulate.sh does for the log triggers:
 *   cre workflow simulate <workflow> -R <project> -T <target> --non-interactive --trigger-index N --http-payload <json> --broadcast
 * The report goes through Arc's CRE forwarder to NorenCreditLine.onReport. No DON deploy.
 */
export function creSimulateSink(opts: { projectRoot: string; workflow: string; target: string; triggerIndex: number; envFile?: string; creBin?: string; timeoutMs?: number }): StarterLineSink {
  return {
    kind: 'cre-simulate',
    open: r => new Promise((resolve, reject) => {
      const args = ['workflow', 'simulate', opts.workflow, '-R', opts.projectRoot, '-T', opts.target, '--non-interactive',
        '--trigger-index', String(opts.triggerIndex), '--http-payload', JSON.stringify(httpTriggerPayload(r)), '--broadcast'];
      if (opts.envFile) args.push('-e', opts.envFile);
      execFile(opts.creBin ?? 'cre', args, { cwd: opts.projectRoot, timeout: opts.timeoutMs ?? 240_000, maxBuffer: 8 << 20 }, (error, stdout, stderr) => {
        const out = `${stdout}\n${stderr}`;
        // Same marker the bridge script reads: "... updated on arc-testnet: tx 0x<hash>"
        const tx = [...out.matchAll(/tx (0x[0-9a-fA-F]{64})/g)].pop()?.[1] as Hex | undefined;
        if (!error && tx) return resolve({ txHash: tx });
        const why = out.split('\n').filter(l => /error|revert|fail|setup required/i.test(l)).slice(-3).join(' | ');
        reject(new Error(`CRE human-starter write failed: ${scrub(why || (error ? String(error.message) : 'no write tx in simulator output'))}`));
      });
    }),
  };
}

/**
 * NOREN_STARTER_CRE_PROJECT   the CRE project root (packages/cre-bridge)
 * NOREN_STARTER_CRE_WORKFLOW  the workflow folder inside it (the bridge's human-starter workflow)
 * NOREN_STARTER_CRE_TARGET    target in workflow.yaml (local-fork)
 * NOREN_STARTER_CRE_TRIGGER_INDEX  index of the HTTP trigger handler
 * NOREN_STARTER_CRE_ENV_FILE  optional .env for the simulator (fork keys only)
 */
export function starterSinkFromEnv(env: Record<string, string | undefined> = process.env): StarterLineSink | undefined {
  const projectRoot = env.NOREN_STARTER_CRE_PROJECT, workflow = env.NOREN_STARTER_CRE_WORKFLOW;
  if (!projectRoot || !workflow) return undefined;
  const triggerIndex = Number(env.NOREN_STARTER_CRE_TRIGGER_INDEX ?? NaN);
  if (!Number.isInteger(triggerIndex) || triggerIndex < 0) throw new Error('NOREN_STARTER_CRE_TRIGGER_INDEX must be the HTTP trigger handler index');
  return creSimulateSink({ projectRoot, workflow, target: env.NOREN_STARTER_CRE_TARGET ?? 'local-fork', triggerIndex, envFile: env.NOREN_STARTER_CRE_ENV_FILE });
}

export const STARTER_SINK_SETUP = 'Setup required: NOREN_STARTER_CRE_PROJECT, NOREN_STARTER_CRE_WORKFLOW and NOREN_STARTER_CRE_TRIGGER_INDEX (the bridge\'s human-starter CRE workflow, see docs/WORLD.md)';
