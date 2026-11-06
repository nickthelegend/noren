// A real Reclaim proof request with Nick's Reclaim app, for sending to his phone:
//   pnpm exec tsx scripts/live/reclaim-request.ts [label=github] [0x<wallet>=the app's browser test key]
// Prints only the request URL (open it on a phone, or turn it into a QR) and the status, then waits up to 30 minutes.
// When the proof arrives it is verified with the Reclaim SDK, stored with one coarse statement (data/reclaim-proofs.json,
// the same store dev:all's server and the underwriter read) and its kind + commitment are recorded on NorenReputation on
// the local Robinhood fork when one is running. RECLAIM_APP_ID / RECLAIM_APP_SECRET are read from the gitignored .env by
// name and never printed. Labels: see packages/server/src/reclaim-providers.ts.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startReclaimRequest } from '../../packages/server/src/reclaim.ts';
import { reclaimProviders } from '../../packages/server/src/reclaim-providers.ts';

for (const f of ['.env', '/Volumes/Extreme SSD/Projects/grokbot/projects/noren/.env']) if (existsSync(f)) { process.loadEnvFile(f); break; }
const label = process.argv[2] ?? 'github';
const address = process.argv[3] ?? '0x6D6C8c418564B5aA9d4f49547f7D081f9C6B42cc';
const p = reclaimProviders(process.env).find((x) => x.label === label);
if (!p) throw new Error(`unknown label ${label}; one of: ${reclaimProviders(process.env).map((x) => x.label).join(', ')}`);

// On-chain record on the local Robinhood fork, if dev:all is running it.
const rpcUrl = process.env.NOREN_RH_RPC ?? 'http://127.0.0.1:8646';
let onchain: { rpcUrl: string; reputation: `0x${string}` } | undefined;
try {
  const ok = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }).then((r) => r.ok);
  const dep = resolve('packages/robinhood/.fork/deployment.json');
  if (ok && existsSync(dep)) onchain = { rpcUrl, reputation: JSON.parse(readFileSync(dep, 'utf8')).reputation };
} catch { /* no fork running: the proof is still verified and stored */ }

const started = await startReclaimRequest({ env: process.env, address, label, storeFile: resolve('data/reclaim-proofs.json'), onchain, ttlMs: 30 * 60_000 });
console.log(`Provider: ${p.name} (${p.label}, ${p.id}), +${p.points} points, for wallet ${address}`);
console.log(`Request URL (open on a phone): ${started.reply.requestUrl}`);
console.log(`Status: pending (Reclaim session ${started.sessionId}; on-chain record: ${onchain ? `Robinhood fork ${rpcUrl}` : 'no fork running'})`);
const timer = setTimeout(() => { console.log('Status: expired after 30 minutes, no proof arrived'); process.exit(2); }, 30 * 60_000);
const s = await started.done;
clearTimeout(timer);
if (s.status !== 'verified' || !s.verified) { console.log(`Status: failed: ${s.error}`); process.exit(1); }
console.log(`Status: verified. Stored "${s.verified.claim.statement}" (proof ${s.verified.proofId.slice(0, 14)}…), +${s.verified.points} points`);
console.log(s.verified.onchain?.status === 'recorded' ? `On-chain (fork): NorenReputation.recordAttestation kind ${s.verified.onchain.kind}, tx ${s.verified.onchain.tx}` : `On-chain: ${s.verified.onchain?.reason}`);
process.exit(0);
