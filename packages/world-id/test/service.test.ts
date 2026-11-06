import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { decodeAbiParameters, keccak256, toHex, type Hex } from 'viem';
import { loadWorldIdConfig } from '../src/config.ts';
import { WorldIdService } from '../src/service.ts';
import { HUMAN_STARTER_KIND, starterLineId, type StarterLineRequest, type StarterLineSink } from '../src/starter.ts';
import { idkitResult, startStandin } from './standin.ts';

const KEY = keccak256(toHex('noren world-id service test key'));
const ALICE = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', BOB = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', CAROL = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
const HUMAN = '0x' + '2b'.repeat(31) + '00';

let standin: Awaited<ReturnType<typeof startStandin>>;
let dir: string;
let clock: number;
beforeAll(async () => { standin = await startStandin(8752); });
afterAll(async () => { await standin.close(); });
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'noren-world-svc-')); standin.mode = 'accept'; standin.calls.length = 0; clock = Math.floor(Date.now() / 1000); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const env = (over: Record<string, string> = {}) => ({ WORLD_APP_ID: 'app_staging_test', WORLD_RP_ID: 'rp_00000000c0ffee01', WORLD_RP_SIGNING_KEY: KEY, WORLD_VERIFY_BASE: standin.url, ...over });
function recordingSink(fail = false): StarterLineSink & { got: StarterLineRequest[] } {
  const got: StarterLineRequest[] = [];
  return { kind: 'cre-simulate', got, open: async r => { got.push(r); if (fail) throw new Error('CRE human-starter write failed: forwarder reverted'); return { txHash: `0x${'ab'.repeat(32)}` as Hex }; } };
}
const make = (over: Record<string, string> = {}, sink?: StarterLineSink) =>
  new WorldIdService({ config: loadWorldIdConfig(env(over)), dataFile: join(dir, 'world-id-nullifiers.json'), sink, now: () => clock });
async function prove(svc: WorldIdService, wallet: string, extra: Partial<Parameters<typeof idkitResult>[0]> = {}) {
  const r = await svc.request(wallet);
  if (!r.ok) throw new Error(`request failed: ${JSON.stringify(r.result)}`);
  return { req: r.request, result: idkitResult({ nonce: r.request.rp_context.nonce, wallet, ...extra }) };
}

describe('setup', () => {
  it('reports Setup required with the missing names and never signs', async () => {
    const svc = new WorldIdService({ config: loadWorldIdConfig({}), dataFile: join(dir, 'x.json') });
    expect(svc.info()).toMatchObject({ configured: false, missing: ['WORLD_APP_ID', 'WORLD_RP_ID', 'WORLD_RP_SIGNING_KEY'], credential: 'selfie', environment: 'production', starterLimitUsdc6: '25000000' });
    const r = await svc.request(ALICE);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.result).toMatchObject({ status: 'setup_required' });
    expect(await svc.verify(idkitResult({ nonce: '0x01', wallet: ALICE }))).toMatchObject({ status: 'setup_required' });
  });

  it('refuses a starter limit above the hard ceiling', () => {
    expect(() => loadWorldIdConfig(env({ NOREN_STARTER_LIMIT_USDC6: '500000000' }))).toThrow(/NOREN_STARTER_LIMIT_USDC6/);
  });
});

describe('success path', () => {
  it('verifies with World, stores only the nullifier row, and asks the bridge for a 25 USDC line', async () => {
    const sink = recordingSink();
    const svc = make({}, sink);
    const { req, result } = await prove(svc, ALICE, { nullifier: HUMAN });
    expect(req).toMatchObject({ app_id: 'app_staging_test', action: 'noren-credit', credential: 'selfie', signal: ALICE, starterLimitUsdc6: '25000000' });
    expect(JSON.stringify(req)).not.toContain(KEY.slice(2));

    const out = await svc.verify(result);
    expect(out).toMatchObject({ status: 'verified', credential: 'selfie', starter: { status: 'submitted', txHash: `0x${'ab'.repeat(32)}`, limitUsdc6: '25000000', lineId: starterLineId(ALICE) } });

    // The IDKit result reached the verifier unchanged (plus the asserted environment).
    expect(standin.calls).toHaveLength(1);
    expect(standin.calls[0].rpId).toBe('rp_00000000c0ffee01');
    expect(standin.calls[0].body).toEqual({ ...result, environment: 'production' });

    // The bridge gets the human-starter report keyed by the nullifier.
    const [r] = sink.got;
    const [kind, borrower, nh, limit, expiry] = decodeAbiParameters([{ type: 'bytes32' }, { type: 'address' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint64' }], r.report);
    expect([kind, borrower, BigInt(nh), limit, Number(expiry)]).toEqual([HUMAN_STARTER_KIND, ALICE, BigInt(HUMAN), 25_000_000n, clock + 30 * 86400]);

    const file = JSON.parse(await readFile(join(dir, 'world-id-nullifiers.json'), 'utf8'));
    expect(file.humans).toHaveLength(1);
    expect(Object.keys(file.humans[0]).sort()).toEqual(['action', 'credential', 'nullifier', 'starter', 'verifiedAt', 'wallet']);
    expect(JSON.stringify(file)).not.toMatch(/proof|sybil|integrity|jwt/);
    expect(await svc.status(ALICE)).toMatchObject({ verified: true, credential: 'selfie', starter: { status: 'submitted' } });
  });

  it('says Setup required for the line when no bridge sink is configured, and retries once it is', async () => {
    const svc = make();
    const { result } = await prove(svc, ALICE);
    const out = await svc.verify(result);
    expect(out).toMatchObject({ status: 'verified', starter: { status: 'setup_required' } });
    expect(out.status === 'verified' && out.starter.status === 'setup_required' && out.starter.detail).toMatch(/^Setup required: NOREN_STARTER_CRE_PROJECT/);
  });

  it('keeps the human verified when the Arc write fails and lets them retry (cooldown 30 s)', async () => {
    const failing = recordingSink(true);
    const file = join(dir, 'world-id-nullifiers.json');
    const svc = new WorldIdService({ config: loadWorldIdConfig(env()), dataFile: file, sink: failing, now: () => clock });
    const { result } = await prove(svc, ALICE);
    expect(await svc.verify(result)).toMatchObject({ status: 'verified', starter: { status: 'failed', detail: expect.stringContaining('forwarder reverted') } });
    const fixed = new WorldIdService({ config: loadWorldIdConfig(env()), dataFile: file, sink: recordingSink(), now: () => clock });
    expect(await fixed.retryStarter(ALICE)).toMatchObject({ verified: true, starter: { status: 'submitted' } });
    expect(await fixed.retryStarter(BOB)).toEqual({ verified: false });
  });
});

describe('one credit line per human (nullifier reuse)', () => {
  it('refuses the same human on a second wallet without calling World again', async () => {
    const svc = make({}, recordingSink());
    expect(await svc.verify((await prove(svc, ALICE, { nullifier: HUMAN })).result)).toMatchObject({ status: 'verified' });
    const again = await svc.verify((await prove(svc, BOB, { nullifier: HUMAN.toUpperCase().replace('0X', '0x') })).result);
    expect(again).toMatchObject({ status: 'already_used' });
    expect(standin.calls).toHaveLength(1);
  });

  it('refuses a second request for a wallet that already has a human line', async () => {
    const svc = make();
    await svc.verify((await prove(svc, ALICE)).result);
    const r = await svc.request(ALICE.toLowerCase());
    expect(!r.ok && r.result.status).toBe('already_used');
  });

  it('maps World\'s own nullifier_replayed to already used', async () => {
    standin.mode = 'replayed';
    const svc = make();
    expect(await svc.verify((await prove(svc, ALICE)).result)).toMatchObject({ status: 'already_used' });
  });

  it('lets only one of two simultaneous proofs from the same human open a line', async () => {
    const svc = make({}, recordingSink());
    const a = await prove(svc, ALICE, { nullifier: HUMAN }), b = await prove(svc, CAROL, { nullifier: HUMAN });
    const outs = await Promise.all([svc.verify(a.result), svc.verify(b.result)]);
    expect(outs.map(o => o.status).sort()).toEqual(['already_used', 'verified']);
    expect(await svc.registry.count()).toBe(1);
  });
});

describe('invalid proofs', () => {
  it('passes World\'s rejection through and claims nothing, so a real proof still works later', async () => {
    standin.mode = 'reject';
    const svc = make();
    expect(await svc.verify((await prove(svc, ALICE, { nullifier: HUMAN })).result)).toMatchObject({ status: 'invalid', code: 'verification_error' });
    expect(await svc.registry.count()).toBe(0);
    standin.mode = 'accept';
    expect(await svc.verify((await prove(svc, ALICE, { nullifier: HUMAN })).result)).toMatchObject({ status: 'verified' });
  });

  it.each([
    ['wrong_action', { action: 'claim-airdrop' }],
    ['wrong_environment', { environment: 'staging' }],
    ['wrong_credential', { identifier: 'proof_of_human' }],
    ['signal_mismatch', { signalOf: '0x000000000000000000000000000000000000dEaD' }],
    ['bad_nullifier', { nullifier: '0x' + 'f'.repeat(64) }],
  ] as const)('rejects %s before calling World', async (code, extra) => {
    const svc = make();
    const { result } = await prove(svc, ALICE, extra as any);
    expect(await svc.verify(result)).toMatchObject({ status: 'invalid', code });
    expect(standin.calls).toHaveLength(0);
  });

  it('rejects legacy 3.0 proofs, session proofs, unknown nonces and junk', async () => {
    const svc = make();
    const { result } = await prove(svc, ALICE);
    expect(await svc.verify({ ...result, protocol_version: '3.0' })).toMatchObject({ code: 'protocol_version' });
    expect(await svc.verify({ ...result, session_id: 'session_abc' })).toMatchObject({ code: 'session_proof' });
    expect(await svc.verify({ ...result, nonce: '0x' + '00'.repeat(32) })).toMatchObject({ code: 'unknown_request' });
    expect(await svc.verify(null)).toMatchObject({ code: 'malformed' });
    expect(await svc.verify({ ...result, responses: [...result.responses, result.responses[0]] })).toMatchObject({ code: 'wrong_credential' });
    expect(standin.calls).toHaveLength(0);
  });

  it('uses each signed request once', async () => {
    standin.mode = 'reject';
    const svc = make();
    const { result } = await prove(svc, ALICE);
    expect((await svc.verify(result)).status).toBe('invalid');
    expect(await svc.verify(result)).toMatchObject({ status: 'invalid', code: 'request_already_used' });
    expect(standin.calls).toHaveLength(1);
  });

  it('does not trust a verifier success for another environment or another nullifier', async () => {
    const svc = make();
    standin.mode = 'wrong_env';
    expect(await svc.verify((await prove(svc, ALICE)).result)).toMatchObject({ status: 'invalid', code: 'environment_mismatch' });
    standin.mode = 'other_nullifier';
    expect(await svc.verify((await prove(svc, BOB)).result)).toMatchObject({ status: 'invalid', code: 'nullifier_mismatch' });
    expect(await svc.registry.count()).toBe(0);
  });

  it('reports an unreachable verifier as an error, not a rejection', async () => {
    const svc = make({ WORLD_VERIFY_BASE: 'http://127.0.0.1:8753' });
    expect(await svc.verify((await prove(svc, ALICE)).result)).toMatchObject({ status: 'error', code: 'verifier_unreachable' });
  });
});

describe('expired requests', () => {
  it('expires a request 300 s after signing and never calls World for it', async () => {
    const svc = make();
    const { req, result } = await prove(svc, ALICE);
    clock = req.rp_context.expires_at + 1;
    expect(await svc.verify(result)).toMatchObject({ status: 'expired' });
    expect(standin.calls).toHaveLength(0);
    // and the stale nonce is gone for good
    expect(await svc.verify(result)).toMatchObject({ status: 'invalid', code: 'unknown_request' });
  });

  it('accepts a proof right up to the expiry second', async () => {
    const svc = make();
    const { req, result } = await prove(svc, ALICE);
    clock = req.rp_context.expires_at;
    expect((await svc.verify(result)).status).toBe('verified');
  });
});
