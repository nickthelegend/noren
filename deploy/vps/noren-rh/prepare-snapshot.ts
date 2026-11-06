// MIT. Finishes the warmed Robinhood mainnet snapshot for the hosted demo, the way `pnpm dev:all` does at start:
// adopts the snapshot deployment, ships the Aqua maker strategies and copies the Uniswap v4 helper code from mainnet.
// Run after packages/robinhood/scripts/fork-snapshot.sh:
//   pnpm exec tsx deploy/vps/noren-rh/prepare-snapshot.ts <out-dir>
// Writes <out-dir>/robinhood-snapshot.json and <out-dir>/deployment.json. Anvil's dev accounts sign; snapshot only.
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, http } from 'viem';
import { adoptSnapshotDeployment, seedLiquidityMakers } from '../../../scripts/dev-robinhood.ts';
import { ensureUniswapOnFork } from '../../../packages/server/src/credit.ts';

const out = resolve(process.argv[2] ?? 'deploy/vps/noren-rh/snapshot');
const fork = resolve('packages/robinhood/.fork');
const snap = resolve(fork, 'robinhood-snapshot.json'), dep = resolve(fork, 'deployment.json');
if (!existsSync(snap) || !existsSync(dep)) throw new Error('Setup required: sh packages/robinhood/scripts/fork-snapshot.sh');
mkdirSync(out, { recursive: true });
const port = 8723, rpc = `http://127.0.0.1:${port}`, target = resolve(out, 'robinhood-snapshot.json');
const anvil = spawn('anvil', ['--load-state', snap, '--dump-state', target, '--chain-id', '4663', '--port', String(port), '--silent'], { stdio: 'inherit' });
const c: any = createPublicClient({ transport: http(rpc) });
for (let i = 0; i < 60; i++) { try { await c.getChainId(); break; } catch { await new Promise(r => setTimeout(r, 500)); } }
try {
  const d = await adoptSnapshotDeployment(rpc, dep);
  console.log(`Adopted snapshot: NorenGateway ${d.gateway}`);
  for (const m of await seedLiquidityMakers(rpc, dep)) console.log(`Aqua: ${m}`);
  await ensureUniswapOnFork(rpc); console.log('Uniswap v4 helper code copied from Robinhood mainnet');
  await c.request({ method: 'evm_mine', params: [] });
} finally {
  anvil.kill('SIGINT');
  await new Promise(r => anvil.once('exit', r));
}
copyFileSync(dep, resolve(out, 'deployment.json'));
console.log(`Snapshot ready: ${target} (${statSync(target).size} bytes)`);
