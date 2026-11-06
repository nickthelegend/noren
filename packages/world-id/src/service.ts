import { getAddress, isAddress } from 'viem';
import { hashSignal } from '@worldcoin/idkit-core/hashing';
import { Nullifier } from '@worldcoin/idkit-core/nullifier';
import { missingSettings, setupRequired, type WorldIdConfig } from './config.ts';
import { NullifierRegistry, type HumanRecord } from './registry.ts';
import { signNorenRequest } from './signing.ts';
import { humanStarterRequest, STARTER_SINK_SETUP, type StarterLineSink } from './starter.ts';
import { verifyWithWorld } from './verify.ts';
import type { HumanRequest, HumanStatus, StarterLine, VerifyHumanResult, WorldConfigInfo } from './types.ts';

type Pending = { wallet: `0x${string}`; expiresAt: number; used: boolean };
const MAX_PENDING = 10_000;
const RETRY_COOLDOWN_S = 30;
/** Verifier codes that mean "this human already proved this action". */
const REPLAY_CODES = new Set(['nullifier_replayed', 'max_verifications_reached']);

export type WorldIdServiceOptions = {
  config: WorldIdConfig;
  /** JSON file in the gitignored data dir, e.g. data/world-id-nullifiers.json */
  dataFile: string;
  sink?: StarterLineSink;
  /** Unix seconds. Injected by tests; defaults to the wall clock. */
  now?: () => number;
  /** Only for offline tests that point at a local stand-in of the verify endpoint. */
  fetchImpl?: Parameters<typeof verifyWithWorld>[0]['fetchImpl'];
};

const same = (a: string, b: string) => { try { return BigInt(a) === BigInt(b); } catch { return false; } };

export class WorldIdService {
  readonly registry: NullifierRegistry;
  private pending = new Map<string, Pending>();
  private retried = new Map<string, number>();
  private now: () => number;
  constructor(private opts: WorldIdServiceOptions) {
    this.registry = new NullifierRegistry(opts.dataFile);
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  }

  info(): WorldConfigInfo {
    const c = this.opts.config, missing = missingSettings(c);
    return { configured: missing.length === 0, missing, action: c.action, environment: c.environment, credential: c.credential, starterLimitUsdc6: c.starterLimitUsdc6.toString(), starterDays: c.starterDays, starterSink: this.opts.sink?.kind ?? 'none' };
  }

  /** Step 1: sign a World ID request for this wallet. The wallet becomes the proof's signal. */
  async request(wallet: string): Promise<{ ok: true; request: HumanRequest } | { ok: false; result: VerifyHumanResult }> {
    const c = this.opts.config, missing = missingSettings(c);
    if (missing.length) return { ok: false, result: { status: 'setup_required', detail: setupRequired(missing) } };
    if (typeof wallet !== 'string' || !isAddress(wallet)) return { ok: false, result: { status: 'invalid', code: 'bad_wallet', detail: 'wallet must be an EVM address' } };
    const signal = getAddress(wallet);
    if (await this.registry.findByWallet(c.action, signal)) return { ok: false, result: { status: 'already_used', detail: 'This wallet already has a starter credit line from a verified human.' } };
    this.prune();
    if (this.pending.size >= MAX_PENDING) return { ok: false, result: { status: 'error', code: 'busy', detail: 'Too many open World ID requests; try again in a few minutes.' } };
    const rp = signNorenRequest(c.signingKey, c.action);
    this.pending.set(rp.nonce.toLowerCase(), { wallet: signal, expiresAt: rp.expires_at, used: false });
    return { ok: true, request: { app_id: c.appId!, action: c.action, environment: c.environment, credential: c.credential, signal, rp_context: { rp_id: c.rpId!, ...rp }, starterLimitUsdc6: c.starterLimitUsdc6.toString() } };
  }

  /** Step 2: check the IDKit result, verify it with World, enforce one line per human, open the starter line. */
  async verify(idkitResponse: any): Promise<VerifyHumanResult> {
    const c = this.opts.config, missing = missingSettings(c);
    if (missing.length) return { status: 'setup_required', detail: setupRequired(missing) };
    const bad = (code: string, detail: string): VerifyHumanResult => ({ status: 'invalid', code, detail });
    if (!idkitResponse || typeof idkitResponse !== 'object' || Array.isArray(idkitResponse)) return bad('malformed', 'idkitResponse must be the IDKit result object');
    if (idkitResponse.protocol_version !== '4.0') return bad('protocol_version', 'Noren accepts World ID 4.0 uniqueness proofs only');
    if (idkitResponse.session_id !== undefined) return bad('session_proof', 'A session proof cannot open a credit line; a one-time uniqueness proof is required');
    if (idkitResponse.action !== c.action) return bad('wrong_action', `Proof is for action "${String(idkitResponse.action)}", expected "${c.action}"`);
    if (idkitResponse.environment !== c.environment) return bad('wrong_environment', `Proof is from ${String(idkitResponse.environment)}, this server verifies ${c.environment}`);
    if (typeof idkitResponse.nonce !== 'string') return bad('malformed', 'nonce is missing');
    const pending = this.pending.get(idkitResponse.nonce.toLowerCase());
    if (!pending) return bad('unknown_request', 'This proof was not requested by this server (unknown nonce)');
    if (this.now() > pending.expiresAt) { this.pending.delete(idkitResponse.nonce.toLowerCase()); return { status: 'expired', detail: 'The World ID request expired. Start again.' }; }
    if (pending.used) return bad('request_already_used', 'This request was already submitted once');
    const responses = Array.isArray(idkitResponse.responses) ? idkitResponse.responses : [];
    const item = responses.find((r: any) => r?.identifier === c.credential);
    if (!item || responses.length !== 1) return bad('wrong_credential', `Expected exactly one ${c.credential} proof`);
    if (typeof item.signal_hash !== 'string' || !same(item.signal_hash, hashSignal(pending.wallet))) return bad('signal_mismatch', 'Proof is not bound to the wallet that requested it');
    let nullifier: `0x${string}`;
    try { nullifier = Nullifier.fromHex(String(item.nullifier)).toHex() as `0x${string}`; } catch { return bad('bad_nullifier', 'nullifier is not a field element'); }

    if (await this.registry.find(c.action, nullifier)) { pending.used = true; return { status: 'already_used', detail: 'This human already opened a Noren starter credit line.' }; }
    pending.used = true; // single use from here on, whatever the verifier says

    const outcome = await verifyWithWorld({ verifyBase: c.verifyBase, rpId: c.rpId!, environment: c.environment, idkitResponse, fetchImpl: this.opts.fetchImpl });
    if (!outcome.ok && outcome.reason === 'unreachable') return { status: 'error', code: 'verifier_unreachable', detail: outcome.detail };
    if (!outcome.ok && outcome.reason === 'rejected') {
      if (REPLAY_CODES.has(outcome.code)) return { status: 'already_used', detail: 'World ID says this human already used the noren-credit action.' };
      return bad(outcome.code, `World ID rejected the proof: ${outcome.detail}`);
    }
    if (outcome.ok && outcome.nullifier !== undefined && !same(outcome.nullifier, nullifier)) return bad('nullifier_mismatch', 'Verifier nullifier differs from the submitted one');

    const expiry = this.now() + c.starterDays * 86_400;
    const req = humanStarterRequest({ borrower: pending.wallet, nullifier, limitUsdc6: c.starterLimitUsdc6, expiry });
    const base = { lineId: req.lineId, limitUsdc6: req.limitUsdc6.toString(), expiry };
    const claimed = await this.registry.claim({ action: c.action, nullifier, credential: c.credential, verifiedAt: this.now(), wallet: pending.wallet, starter: { status: 'setup_required', ...base, detail: STARTER_SINK_SETUP } });
    if (!claimed.ok) return { status: 'already_used', detail: claimed.taken === 'human' ? 'This human already opened a Noren starter credit line.' : 'This wallet already has a starter credit line from a verified human.' };
    this.pending.delete(idkitResponse.nonce.toLowerCase());
    const starter = await this.openStarter(claimed.record);
    return { status: 'verified', credential: c.credential, nullifier, starter };
  }

  /** Re-sends the starter write for a verified wallet whose first write failed or had no sink yet. */
  async retryStarter(wallet: string): Promise<HumanStatus> {
    if (typeof wallet !== 'string' || !isAddress(wallet)) return { verified: false };
    const row = await this.registry.findByWallet(this.opts.config.action, getAddress(wallet));
    if (!row) return { verified: false };
    const key = row.wallet.toLowerCase(), last = this.retried.get(key) ?? 0;
    const starter = row.starter.status === 'submitted' || this.now() - last < RETRY_COOLDOWN_S ? row.starter : (this.retried.set(key, this.now()), await this.openStarter(row));
    return { verified: true, credential: row.credential, verifiedAt: row.verifiedAt, starter };
  }

  async status(wallet: string): Promise<HumanStatus> {
    if (typeof wallet !== 'string' || !isAddress(wallet)) return { verified: false };
    const row = await this.registry.findByWallet(this.opts.config.action, getAddress(wallet));
    return row ? { verified: true, credential: row.credential, verifiedAt: row.verifiedAt, starter: row.starter } : { verified: false };
  }

  private async openStarter(row: HumanRecord): Promise<StarterLine> {
    const { lineId, limitUsdc6, expiry } = row.starter;
    const nullifier = '0x' + BigInt(row.nullifier).toString(16);
    let starter: StarterLine;
    if (!this.opts.sink) starter = { status: 'setup_required', lineId, limitUsdc6, expiry, detail: STARTER_SINK_SETUP };
    else {
      try {
        const req = humanStarterRequest({ borrower: row.wallet, nullifier, limitUsdc6: BigInt(limitUsdc6), expiry });
        const { txHash } = await this.opts.sink.open(req);
        starter = { status: 'submitted', lineId, limitUsdc6, expiry, txHash };
      } catch (error: any) {
        starter = { status: 'failed', lineId, limitUsdc6, expiry, detail: String(error?.message ?? error).slice(0, 300) };
      }
    }
    await this.registry.setStarter(row.action, nullifier, starter);
    return starter;
  }

  private prune() {
    const now = this.now();
    for (const [nonce, p] of this.pending) if (now > p.expiresAt) this.pending.delete(nonce);
  }
}
