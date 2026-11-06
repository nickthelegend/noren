// Live checks against the real World Developer Portal (no stand-ins). Run:
//   pnpm --filter @noren/world-id live
// 1. Always: posts a well-formed but fake Selfie Check result for an RP that does not exist and
//    checks that Noren reads the Portal's real rejection as `invalid` (never as success).
// 2. With WORLD_APP_ID / WORLD_RP_ID / WORLD_RP_SIGNING_KEY set: signs a real noren-credit request
//    with the RP key and posts a fake proof under the real rp_id. A registered World ID 4.0 RP answers
//    with a proof failure; app_not_migrated or a 404 means the Portal setup is incomplete.
// A real success needs a person to approve in World App or the Simulator: use `pnpm --filter @noren/world-id harness`.
import './env.ts';
import { loadWorldIdConfig, missingSettings, setupRequired } from '../src/config.ts';
import { signNorenRequest } from '../src/signing.ts';
import { verifyWithWorld } from '../src/verify.ts';

const fakeResult = (environment: string, nonce = '0x00' + 'aa'.repeat(31)) => ({
  protocol_version: '4.0', nonce, action: 'noren-credit', environment,
  responses: [{ identifier: 'selfie', signal_hash: '0x0', proof: ['0x1', '0x2', '0x3', '0x4', '0x5'], nullifier: '0x1234', issuer_schema_id: 11, expires_at_min: 1788302888, sybil_score: 10 }],
});

let failed = false;
const check = (name: string, ok: boolean, detail: string) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`); if (!ok) failed = true; };

const cfg = loadWorldIdConfig();
const unknown = await verifyWithWorld({ verifyBase: cfg.verifyBase, rpId: 'rp_0000000000000000', environment: 'production', idkitResponse: fakeResult('production') });
check('real verifier rejects a fake proof for an unknown RP', !unknown.ok && unknown.reason === 'rejected',
  unknown.ok ? 'UNEXPECTED SUCCESS' : unknown.reason === 'rejected' ? `HTTP ${unknown.httpStatus} ${unknown.code}: ${unknown.detail}` : unknown.detail);

const missing = missingSettings(cfg);
if (missing.length) {
  console.log(`BLOCKED  live RP check: ${setupRequired(missing)}`);
} else {
  const rp = signNorenRequest(cfg.signingKey, cfg.action);
  check('RP signing key signs a noren-credit request', /^0x[0-9a-f]{130}$/.test(rp.signature), `nonce ${rp.nonce.slice(0, 12)}…, expires in ${rp.expires_at - rp.created_at} s`);
  const out = await verifyWithWorld({ verifyBase: cfg.verifyBase, rpId: cfg.rpId!, environment: cfg.environment, idkitResponse: fakeResult(cfg.environment, rp.nonce) });
  const setupProblem = !out.ok && out.reason === 'rejected' && (out.code === 'app_not_migrated' || out.httpStatus === 404);
  check(`real verifier knows ${cfg.rpId} (${cfg.environment}) and rejects a fake proof`, !out.ok && out.reason === 'rejected' && !setupProblem,
    out.ok ? 'UNEXPECTED SUCCESS' : out.reason === 'rejected' ? `HTTP ${out.httpStatus} ${out.code}: ${out.detail}${setupProblem ? ' (finish World ID 4.0 setup in the Portal)' : ''}` : out.detail);
}
process.exit(failed ? 1 : 0);
