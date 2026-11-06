// OFFLINE TEST STAND-IN for the World Developer Portal endpoint POST /api/v4/verify/{rp_id}.
// It is not a World ID verifier: it answers with the response shapes from the Portal's OpenAPI
// reference so the Noren server's checks around the call can be tested without a network.
// Production code always calls https://developer.world.org. scripts/live-check.ts hits the real one.
import { createServer, type Server } from 'node:http';
import { keccak256, toHex } from 'viem';
import { hashSignal } from '@worldcoin/idkit-core/hashing';

export type StandinMode = 'accept' | 'reject' | 'replayed' | 'wrong_env' | 'other_nullifier';

export async function startStandin(port: number) {
  const calls: { rpId: string; body: any }[] = [];
  let mode: StandinMode = 'accept';
  const server: Server = createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const rpId = decodeURIComponent((req.url ?? '').split('/').pop() ?? '');
    const body = JSON.parse(raw); calls.push({ rpId, body });
    const item = body.responses?.[0];
    const reply = (status: number, json: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };
    if (mode === 'reject') return reply(400, { success: false, code: 'all_verifications_failed', detail: 'All proof verifications failed.', results: [{ identifier: item?.identifier, success: false, code: 'verification_error', detail: 'On-chain proof verification failed.' }] });
    if (mode === 'replayed') return reply(400, { success: false, code: 'all_verifications_failed', detail: 'All proof verifications failed.', results: [{ identifier: item?.identifier, success: false, code: 'nullifier_replayed', detail: 'Nullifier already used.' }] });
    const nullifier = mode === 'other_nullifier' ? '0x' + '07'.repeat(31) : item?.nullifier;
    return reply(200, { success: true, action: body.action, nullifier, environment: mode === 'wrong_env' ? 'staging' : body.environment, results: [{ identifier: item?.identifier, success: true, nullifier }] });
  });
  await new Promise<void>(r => server.listen(port, '127.0.0.1', () => r()));
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    set mode(m: StandinMode) { mode = m; },
    close: () => new Promise<void>(r => server.close(() => r())),
  };
}

/** The IDKit result shape for a one-time Selfie Check (from the IDKit integration guide), bound to a request. */
export function idkitResult(opts: { nonce: string; wallet: string; nullifier?: string; action?: string; environment?: string; identifier?: string; signalOf?: string }) {
  return {
    protocol_version: '4.0',
    nonce: opts.nonce,
    action: opts.action ?? 'noren-credit',
    environment: opts.environment ?? 'production',
    integrity_bundle: { version: 2, signature_format: 'apple_app_attest', timestamp: 1788302923, signature: 'a1b2c3d4', jwt: 'eyJ.test' },
    responses: [{
      identifier: opts.identifier ?? 'selfie',
      signal_hash: hashSignal(opts.signalOf ?? opts.wallet),
      proof: ['0x111', '0x222', '0x333', '0x444', '0x555'],
      nullifier: opts.nullifier ?? toHex(BigInt(keccak256(toHex(opts.wallet))) >> 8n, { size: 32 }),
      issuer_schema_id: 11,
      expires_at_min: 1788302888,
      sybil_score: 10,
    }],
  };
}
