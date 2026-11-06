/**
 * Reclaim Protocol (zkTLS): prove off-chain facts (a credit score, exchange KYC, a balance, an identity) to raise a
 * Noren credit limit. Everything that touches the app secret runs here, server-side:
 *   GET  /reclaim/status?address=0x…   configured?, the provider list (reclaim-providers.ts), this wallet's verified claims
 *   POST /reclaim/request {address, provider?}  ReclaimProofRequest.init(APP_ID, APP_SECRET, <provider id>) bound to the wallet;
 *                                       returns the request URL (QR) and Reclaim's status URL; the server polls it
 *   GET  /reclaim/session/:sessionId    pending | verified | failed, for the UI to poll
 * A proof counts only after the SDK's verifyProof accepts it (attestor signatures + provider hashes) and its context
 * names this wallet and this session. Stored: the proof identifier, the provider, the names of the extracted
 * parameters and one coarse statement ("credit score ≥ 700", "KYC level ≥ 1"). Never names, dates of birth, exact
 * scores or balances. Missing credentials → "Setup required" naming only the missing variable.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ReclaimProofRequest, verifyProof, type Proof, type VerificationConfig } from '@reclaimprotocol/js-sdk';
import { minimalStatement, RECLAIM_MAX_POINTS, reclaimProviders, type ReclaimProvider } from './reclaim-providers.ts';
import { newSalt, recordOnchain, type OnchainRecord, type OnchainTarget } from './reclaim-onchain.ts';
import type { Address, Hex } from 'viem';

/** Required. Provider IDs are public and come from reclaim-providers.ts (RECLAIM_PROVIDER_ID / _IDS adjust them). */
export const RECLAIM_ENV = ['RECLAIM_APP_ID', 'RECLAIM_APP_SECRET'] as const;
export type ReclaimEnv = Partial<Record<(typeof RECLAIM_ENV)[number] | 'RECLAIM_PROVIDER_ID' | 'RECLAIM_PROVIDER_IDS', string>>;

/** What Noren keeps per wallet. No raw values: only which parameters the provider proved. */
export type ReclaimRecord = {
  address: string;
  proofId: string;
  sessionId: string;
  provider: { id: string; name: string; label: string; group: ReclaimProvider['group'] };
  /** The documented boost for this provider's group (reclaim-providers.ts); the underwriter caps the total. */
  points: number;
  claim: { proved: true; statement: string; parameters: string[]; provedAt: number };
  /** Private on-chain record: kind + commitment on NorenReputation. The salt never leaves this file. */
  salt?: Hex;
  onchain?: OnchainRecord;
  verifiedAt: number;
};
type Session = { address: string; status: 'pending' | 'verified' | 'failed'; error?: string; verified?: ReclaimRecord; expiresAt: number };

const SESSION_MS = 10 * 60_000;
const isAddress = (a: unknown): a is string => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);

export function missingReclaimEnv(env: ReclaimEnv): string[] {
  return RECLAIM_ENV.filter((k) => !env[k]?.trim());
}
const setupError = (missing: string[]) => `Setup required: ${missing.join(', ')} (from the Reclaim app at dev.reclaimprotocol.org, in the Noren .env; see docs/RECLAIM.md)`;

export async function readReclaimStore(file: string): Promise<ReclaimRecord[]> {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch (e: any) { if (e.code === 'ENOENT') return []; throw e; }
}
async function writeStore(file: string, rows: ReclaimRecord[]) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(rows, null, 2), { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, file);
}
export const verifiedFor = (rows: ReclaimRecord[], address: string) => rows.filter((r) => r.address === address.toLowerCase());
const publicRecord = (r: ReclaimRecord) => ({ proofId: r.proofId, provider: r.provider, points: r.points, claim: r.claim, verifiedAt: r.verifiedAt, onchain: r.onchain });

/** After a verified proof: record kind + commitment on NorenReputation (salt kept here), and save the outcome. */
export async function attachOnchain(storeFile: string, record: ReclaimRecord, target: OnchainTarget | undefined): Promise<ReclaimRecord> {
  const salt = newSalt();
  let onchain: OnchainRecord;
  try { onchain = await recordOnchain(target, record.address as Address, record.provider.group, record.proofId, salt); }
  catch (e: any) { onchain = { status: 'unavailable', reason: `recordAttestation failed: ${String(e?.shortMessage ?? e?.message ?? e).slice(0, 160)}` }; }
  const next = { ...record, ...(onchain.status === 'recorded' ? { salt } : {}), onchain };
  const rows = await readReclaimStore(storeFile);
  await writeStore(storeFile, rows.map((r) => (r.proofId === record.proofId ? next : r)));
  return next;
}

function contextOf(p: Proof): { contextAddress?: string; reclaimSessionId?: string } {
  try { return JSON.parse(p.claimData?.context ?? '{}'); } catch { throw new Error('ReclaimProofRejected: the proof context is not valid JSON'); }
}

/**
 * Verifies proofs with the Reclaim SDK and, only when they pass, records the minimal claim for `address`.
 * Order: offline checks (shape, wallet, session, replay), then the SDK's verifyProof (it fetches Reclaim's attestor
 * list, recovers the signers and checks the provider hashes). Any failure throws a readable error and stores nothing.
 */
export async function verifyAndRecord(proofs: Proof | Proof[], address: string, opts: { storeFile: string; provider: ReclaimProvider; sessionId?: string; config: VerificationConfig }): Promise<ReclaimRecord> {
  const list = Array.isArray(proofs) ? proofs : [proofs];
  if (!isAddress(address)) throw new Error('ReclaimProofRejected: invalid wallet address');
  if (!list.length) throw new Error('ReclaimProofRejected: no proofs (the app callback must not be overridden)');
  for (const p of list) {
    if (!p?.identifier || !p.claimData || !Array.isArray(p.signatures) || !p.signatures.length) throw new Error('ReclaimProofRejected: malformed proof (identifier, claimData and signatures are required)');
    const c = contextOf(p);
    if (c.contextAddress?.toLowerCase() !== address.toLowerCase()) throw new Error('ReclaimProofRejected: the proof is bound to a different wallet');
    if (opts.sessionId && c.reclaimSessionId !== opts.sessionId) throw new Error('ReclaimProofRejected: the proof belongs to a different Reclaim session');
  }
  const rows = await readReclaimStore(opts.storeFile);
  const ids = new Set(rows.map((r) => r.proofId));
  if (list.some((p) => ids.has(p.identifier))) throw new Error('ReclaimProofRejected: this proof was already used');
  const result = await verifyProof(list, opts.config);
  if (!result.isVerified) throw new Error(`ReclaimProofRejected: ${result.error?.name ?? 'Error'}: ${String(result.error?.message ?? 'verification failed').slice(0, 200)}`);
  const values = Object.assign({}, ...result.data.map((d) => d.extractedParameters ?? {})) as Record<string, unknown>;
  const parameters = Object.keys(values).sort();
  // The statement is computed from the values here, in memory; the values themselves are never stored.
  const statement = minimalStatement(opts.provider.group, values);
  const record: ReclaimRecord = {
    address: address.toLowerCase(),
    proofId: list[0].identifier,
    sessionId: opts.sessionId ?? contextOf(list[0]).reclaimSessionId ?? '',
    provider: { id: opts.provider.id, name: opts.provider.name, label: opts.provider.label, group: opts.provider.group },
    points: opts.provider.points,
    claim: { proved: true, statement, parameters, provedAt: Math.max(...list.map((p) => Number(p.claimData.timestampS) || 0)) },
    verifiedAt: Math.floor(Date.now() / 1000),
  };
  await writeStore(opts.storeFile, [...rows.filter((r) => !(r.address === record.address && r.provider.label === record.provider.label)), record]);
  return record;
}

/**
 * One real Reclaim proof request for `address` and the provider `label` (default: the first configured). The server
 * itself polls Reclaim's status URL (startSession); on success the proof is verified with the SDK, recorded with only
 * a coarse statement, and its kind + commitment go on NorenReputation. `session` updates in place; `done` settles.
 */
export async function startReclaimRequest(o: { env: ReclaimEnv; providers?: ReclaimProvider[]; address: string; label?: string; storeFile: string; onchain?: OnchainTarget; ttlMs?: number }) {
  const { env, address, storeFile, onchain } = o;
  const providers = o.providers ?? reclaimProviders(env);
  const missing = missingReclaimEnv(env);
  if (missing.length) throw Object.assign(new Error(setupError(missing)), { http: 503 });
  if (!isAddress(address)) throw Object.assign(new Error('address must be a 0x address'), { http: 400 });
  const prov = o.label ? providers.find((p) => p.label === o.label) : providers[0];
  if (!prov) throw Object.assign(new Error(`Unknown Reclaim provider "${String(o.label).slice(0, 40)}"; see GET /reclaim/status`), { http: 400 });
  const r = await ReclaimProofRequest.init(env.RECLAIM_APP_ID!, env.RECLAIM_APP_SECRET!, prov.id);
  r.setContext(address.toLowerCase(), 'Noren credit: raise my limit');
  const [requestUrl, statusUrl, sessionId] = [await r.getRequestUrl(), r.getStatusUrl(), r.getSessionId()];
  const session: Session = { address: address.toLowerCase(), status: 'pending', expiresAt: Date.now() + (o.ttlMs ?? SESSION_MS) };
  const version = r.getProviderVersion();
  let settle!: (s: Session) => void;
  const done = new Promise<Session>((ok) => { settle = ok; });
  await r.startSession({
    onSuccess: async (proofs) => {
      try {
        session.verified = await verifyAndRecord(proofs as Proof | Proof[], address, { storeFile, provider: prov, sessionId, config: { providerId: version.providerId, providerVersion: version.providerVersion, allowedTags: version.allowedTags } as VerificationConfig });
        session.verified = await attachOnchain(storeFile, session.verified, onchain);
        session.status = 'verified';
        console.log(`Reclaim: verified ${prov.name} for ${address} (proof ${session.verified.proofId.slice(0, 12)}…); on-chain: ${session.verified.onchain?.status === 'recorded' ? session.verified.onchain.tx : session.verified.onchain?.reason}`);
      } catch (e: any) { session.status = 'failed'; session.error = String(e?.message ?? e).slice(0, 300); console.error(`Reclaim: ${session.error}`); }
      settle(session);
    },
    onError: (e: any) => { if (session.status === 'pending') { session.status = 'failed'; session.error = `${e?.name ?? 'Error'}: ${String(e?.message ?? e).slice(0, 240)}`; } settle(session); },
  });
  const reply = { sessionId, requestUrl, statusUrl, provider: { label: prov.label, id: prov.id, name: prov.name, group: prov.group, points: prov.points }, expiresAt: Math.floor(session.expiresAt / 1000) };
  return { sessionId, session, reply, done };
}

const ORIGINS = new Set(['http://localhost:5190', 'http://127.0.0.1:5190']);
function send(req: IncomingMessage, res: ServerResponse, status: number, value: unknown) {
  const origin = req.headers.origin;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (origin && ORIGINS.has(origin)) Object.assign(headers, { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' });
  res.writeHead(status, headers);
  res.end(status === 204 ? undefined : JSON.stringify(value));
}
async function readJson(req: IncomingMessage) {
  let s = '';
  for await (const chunk of req) { s += chunk; if (s.length > 10_000) throw Object.assign(new Error('Request too large'), { http: 413 }); }
  try { return s ? JSON.parse(s) : {}; } catch { throw Object.assign(new Error('Body must be JSON'), { http: 400 }); }
}

export function createReclaimHandler({ env, storeFile, onchain }: { env: ReclaimEnv; storeFile: string; onchain?: OnchainTarget }) {
  const sessions = new Map<string, Session>();
  const providers = reclaimProviders(env);

  async function request(address: string, label?: string) {
    const started = await startReclaimRequest({ env, providers, address, label, storeFile, onchain });
    sessions.set(started.sessionId, started.session);
    return started.reply;
  }

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://local');
    if (url.pathname !== '/reclaim' && !url.pathname.startsWith('/reclaim/')) return false;
    try {
      if (req.method === 'OPTIONS') return send(req, res, 204, null), true;
      if (req.method === 'GET' && url.pathname === '/reclaim/status') {
        const address = url.searchParams.get('address');
        if (address !== null && !isAddress(address)) return send(req, res, 400, { error: 'address must be a 0x address' }), true;
        const missing = missingReclaimEnv(env);
        const verified = address ? verifiedFor(await readReclaimStore(storeFile), address) : [];
        const total = Math.min(RECLAIM_MAX_POINTS, verified.reduce((a, r) => a + r.points, 0));
        return send(req, res, 200, { configured: !missing.length, missing, ...(missing.length ? { error: setupError(missing) } : {}), providers, maxPoints: RECLAIM_MAX_POINTS, points: total, verified: verified.map(publicRecord) }), true;
      }
      if (req.method === 'POST' && url.pathname === '/reclaim/request') {
        const { address, provider } = await readJson(req);
        if (!isAddress(address)) return send(req, res, 400, { error: 'address must be a 0x address' }), true;
        return send(req, res, 200, await request(address, typeof provider === 'string' ? provider : undefined)), true;
      }
      const m = /^\/reclaim\/session\/([\w-]+)$/.exec(url.pathname);
      if (req.method === 'GET' && m) {
        const s = sessions.get(m[1]);
        if (!s) return send(req, res, 404, { error: 'Unknown Reclaim session (sessions live in this server process; start again)' }), true;
        if (s.status === 'pending' && Date.now() > s.expiresAt) { s.status = 'failed'; s.error = 'Expired: no proof arrived within 10 minutes; start again'; }
        return send(req, res, 200, { status: s.status, ...(s.error ? { error: s.error } : {}), ...(s.verified ? { verified: publicRecord(s.verified) } : {}) }), true;
      }
      return send(req, res, 404, { error: `No Reclaim route ${req.method} ${url.pathname}` }), true;
    } catch (e: any) {
      const message = String(e?.message ?? e).slice(0, 300);
      return send(req, res, typeof e?.http === 'number' ? e.http : 502, { error: message.startsWith('Setup required') ? message : `Reclaim: ${message}` }), true;
    }
  };
}
