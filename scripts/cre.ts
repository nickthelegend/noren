/**
 * Runs a CRE workflow in the CRE CLI simulator against the local forks.
 * Each run gets a throwaway project root whose project.yaml points the workflow's chains at our fork RPCs, so the
 * workflow packages stay untouched. The broadcast key is one of Anvil's published dev keys (public mnemonic), used
 * on the local forks only and written to a 0600 temp file, never printed.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mnemonicToAccount } from 'viem/accounts';
import { bytesToHex } from 'viem';

const MNEMONIC = 'test test test test test test test test test test test junk';
/** Anvil dev account 9 signs CRE broadcasts, so it never races the deployer (0) or the merchant (1) for nonces. */
export const creAccount = mnemonicToAccount(MNEMONIC, { addressIndex: 9 });

export type CreRun = { workflowDir: string; target: string; rpcs: Record<string, string>; config: unknown; broadcast?: boolean; triggerIndex?: number; txHash?: string; eventIndex?: number; httpPayload?: unknown };

export function prepareWorkflow(workflowDir: string) {
  const dir = resolve(workflowDir);
  if (!existsSync(join(dir, 'workflow.yaml'))) throw new Error(`Setup required: ${dir}/workflow.yaml missing`);
  try { execFileSync('cre', ['version'], { stdio: 'ignore' }); } catch { throw new Error('Setup required: CRE CLI (cre) not on PATH'); }
  if (!existsSync(join(dir, 'node_modules'))) execFileSync('bun', ['install', '--frozen-lockfile'], { cwd: dir, stdio: 'inherit' });
  return dir;
}

function projectRoot(run: CreRun) {
  const root = mkdtempSync(join(tmpdir(), 'noren-cre-'));
  const rpcs = Object.entries(run.rpcs).map(([name, url]) => `    - chain-name: ${name}\n      url: ${url}`).join('\n');
  writeFileSync(join(root, 'project.yaml'), `${run.target}:\n  rpcs:\n${rpcs}\n`);
  writeFileSync(join(root, 'config.json'), JSON.stringify(run.config, null, 2));
  // The CLI finds project.yaml by walking up from the workflow's real path, so copy the workflow sources into our root
  // (node_modules is linked, not copied). The package itself is never modified.
  const src = resolve(run.workflowDir), dst = join(root, 'workflow');
  cpSync(src, dst, { recursive: true, filter: f => !/node_modules|\.cre_build_tmp|config\.local-fork/.test(f.slice(src.length)) });
  symlinkSync(join(src, 'node_modules'), join(dst, 'node_modules'));
  const key = bytesToHex(creAccount.getHdKey().privateKey!);
  writeFileSync(join(root, 'fork.env'), `CRE_ETH_PRIVATE_KEY=${key}\n`, { mode: 0o600 });
  return root;
}

function args(run: CreRun, root: string, extra: string[]) {
  return ['workflow', 'simulate', 'workflow', '-R', root, '-T', run.target, '--config', join(root, 'config.json'), '-e', join(root, 'fork.env'), '--non-interactive',
    ...(run.triggerIndex === undefined ? [] : ['--trigger-index', String(run.triggerIndex)]),
    ...(run.txHash ? ['--evm-tx-hash', run.txHash, '--evm-event-index', String(run.eventIndex ?? 0)] : []),
    ...(run.httpPayload === undefined ? [] : ['--http-payload', JSON.stringify(run.httpPayload)]),
    ...(run.broadcast ? ['--broadcast'] : []), ...extra];
}

/** One simulation run; resolves with the simulator's output, rejects with its tail on failure. */
export function creSimulate(run: CreRun): Promise<string> {
  const root = projectRoot(run);
  return new Promise((ok, fail) => {
    const p = spawn('cre', args(run, root, []), { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', c => { out += c; }); p.stderr.on('data', c => { out += c; });
    p.on('close', code => { rmSync(root, { recursive: true, force: true }); code === 0 ? ok(out) : fail(new Error(`cre workflow simulate exited ${code}: ${out.slice(-800)}`)); });
  });
}

/** `cre workflow simulate --listen`: stays up and runs the workflow for every matching log. Returns the child process. */
export function creListen(run: CreRun, onLine: (line: string) => void): ChildProcess {
  const root = projectRoot(run);
  const p = spawn('cre', args(run, root, ['--listen']), { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  const feed = (c: Buffer) => { buf += c; const lines = buf.split('\n'); buf = lines.pop() ?? ''; for (const l of lines) if (l.trim()) onLine(l); };
  p.stdout.on('data', feed); p.stderr.on('data', feed);
  p.on('close', () => rmSync(root, { recursive: true, force: true }));
  return p;
}
