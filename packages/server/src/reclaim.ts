/**
 * Reclaim Protocol (zkTLS): prove one off-chain fact (for example an exchange or bank account) to raise a Noren
 * credit limit. Everything that touches the app secret runs here, server-side:
 *   GET  /reclaim/status?address=0x…   configured?, the provider, and this wallet's verified claim (if any)
 *   POST /reclaim/request {address}     ReclaimProofRequest.init(APP_ID, APP_SECRET, PROVIDER_ID) bound to the wallet;
 *                                       returns the request URL (QR) and Reclaim's status URL; the server polls it
 *   GET  /reclaim/session/:sessionId    pending | verified | failed, for the UI to poll
 * A proof counts only after the SDK's verifyProof accepts it (attestor signatures + provider hashes) and its context
 * names this wallet and this session. Stored: the proof identifier, the provider and the names of the extracted
 * parameters. Never the parameter values or any other personal data. Missing credentials → "Setup required".
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ReclaimProofRequest, verifyProof, type Proof, type VerificationConfig } from '@reclaimprotocol/js-sdk';

export const RECLAIM_ENV = ['RECLAIM_APP_ID', 'RECLAIM_APP_SECRET', 'RECLAIM_PROVIDER_ID'] as const;
export type ReclaimEnv = Partial<Record<(typeof RECLAIM_ENV)[number] | 'RECLAIM_PROVIDER_NAME', string>>;

/** What Noren keeps per wallet. No raw values: only which parameters the provider proved. */
export type ReclaimRecord = {
  address: string;
  proofId: string;
  sessionId: string;
  provider: { id: string; name: string };
  claim: { proved: true; parameters: string[]; provedAt: number };
  verifiedAt: number;
};
type Session = { address: string; status: 'pending' | 'verified' | 'failed'; error?: string; verified?: ReclaimRecord; expiresAt: number };

const SESSION_MS = 10 * 60_000;
const isAddress = (a: unknown): a is string => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);

export function missingReclaimEnv(env: ReclaimEnv): string[] {
  return RECLAIM_ENV.filter((k) => !env[k]?.trim());
}
const setupError = (missing: string[]) => `Setup required: ${missing.join(', ')} (${missing.length === 1 && missing[0] === 'RECLAIM_PROVIDER_ID'
  ? 'add a provider to the Reclaim app at dev.reclaimprotocol.org and set its ID'
  : 'create the app and add a provider at dev.reclaimprotocol.org, then set them'} in the Noren .env; see docs/RECLAIM.md)`;

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
export const verifiedFor = (rows: ReclaimRecord[], address: string) => rows.find((r) => r.address === address.toLowerCase()) ?? null;

function contextOf(p: Proof): { contextAddress?: string; reclaimSessionId?: string } {
  try { return JSON.parse(p.claimData?.context ?? '{}'); } catch { throw new Error('ReclaimProofRejected: the proof context is not valid JSON'); }
}

/**
 * Verifies proofs with the Reclaim SDK and, only when they pass, records the minimal claim for `address`.
 * Order: offline checks (shape, wallet, session, replay), then the SDK's verifyProof (it fetches Reclaim's attestor
 * list, recovers the signers and checks the provider hashes). Any failure throws a readable error and stores nothing.
 */
export async function verifyAndRecord(proofs: Proof | Proof[], address: string, opts: { storeFile: string; provider: { id: string; name: string }; sessionId?: string; config: VerificationConfig }): Promise<ReclaimRecord> {
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
  const parameters = [...new Set(result.data.flatMap((d) => Object.keys(d.extractedParameters ?? {})))].sort();
  const record: ReclaimRecord = {
    address: address.toLowerCase(),
    proofId: list[0].identifier,
    sessionId: opts.sessionId ?? contextOf(list[0]).reclaimSessionId ?? '',
    provider: opts.provider,
    claim: { proved: true, parameters, provedAt: Math.max(...list.map((p) => Number(p.claimData.timestampS) || 0)) },
    verifiedAt: Math.floor(Date.now() / 1000),
  };
  await writeStore(opts.storeFile, [...rows.filter((r) => r.address !== record.address), record]);
  return record;
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

export function createReclaimHandler({ env, storeFile }: { env: ReclaimEnv; storeFile: string }) {
  const sessions = new Map<string, Session>();
  const provider = () => (env.RECLAIM_PROVIDER_ID ? { id: env.RECLAIM_PROVIDER_ID, name: env.RECLAIM_PROVIDER_NAME?.trim() || 'Reclaim provider' } : null);

  async function request(address: string) {
    const missing = missingReclaimEnv(env);
    if (missing.length) throw Object.assign(new Error(setupError(missing)), { http: 503 });
    const prov = provider()!;
    const r = await ReclaimProofRequest.init(env.RECLAIM_APP_ID!, env.RECLAIM_APP_SECRET!, prov.id);
    r.setContext(address.toLowerCase(), 'Noren credit: raise my limit');
    const [requestUrl, statusUrl, sessionId] = [await r.getRequestUrl(), r.getStatusUrl(), r.getSessionId()];
    const s: Session = { address: address.toLowerCase(), status: 'pending', expiresAt: Date.now() + SESSION_MS };
    sessions.set(sessionId, s);
    const version = r.getProviderVersion();
    await r.startSession({
      onSuccess: async (proofs) => {
        try { s.verified = await verifyAndRecord(proofs as Proof | Proof[], address, { storeFile, provider: prov, sessionId, config: { providerId: version.providerId, providerVersion: version.providerVersion, allowedTags: version.allowedTags } as VerificationConfig }); s.status = 'verified'; console.log(`Reclaim: verified ${prov.name} for ${address} (proof ${s.verified.proofId.slice(0, 12)}…)`); }
        catch (e: any) { s.status = 'failed'; s.error = String(e?.message ?? e).slice(0, 300); console.error(`Reclaim: ${s.error}`); }
      },
      onError: (e: any) => { if (s.status === 'pending') { s.status = 'failed'; s.error = `${e?.name ?? 'Error'}: ${String(e?.message ?? e).slice(0, 240)}`; } },
    });
    return { sessionId, requestUrl, statusUrl, provider: prov, expiresAt: Math.floor(s.expiresAt / 1000) };
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
        const verified = address ? verifiedFor(await readReclaimStore(storeFile), address) : null;
        return send(req, res, 200, { configured: !missing.length, missing, ...(missing.length ? { error: setupError(missing) } : {}), provider: provider(), verified: verified && { proofId: verified.proofId, provider: verified.provider, claim: verified.claim, verifiedAt: verified.verifiedAt } }), true;
      }
      if (req.method === 'POST' && url.pathname === '/reclaim/request') {
        const { address } = await readJson(req);
        if (!isAddress(address)) return send(req, res, 400, { error: 'address must be a 0x address' }), true;
        return send(req, res, 200, await request(address)), true;
      }
      const m = /^\/reclaim\/session\/([\w-]+)$/.exec(url.pathname);
      if (req.method === 'GET' && m) {
        const s = sessions.get(m[1]);
        if (!s) return send(req, res, 404, { error: 'Unknown Reclaim session (sessions live in this server process; start again)' }), true;
        if (s.status === 'pending' && Date.now() > s.expiresAt) { s.status = 'failed'; s.error = 'Expired: no proof arrived within 10 minutes; start again'; }
        return send(req, res, 200, { status: s.status, ...(s.error ? { error: s.error } : {}), ...(s.verified ? { verified: { proofId: s.verified.proofId, provider: s.verified.provider, claim: s.verified.claim, verifiedAt: s.verified.verifiedAt } } : {}) }), true;
      }
      return send(req, res, 404, { error: `No Reclaim route ${req.method} ${url.pathname}` }), true;
    } catch (e: any) {
      const message = String(e?.message ?? e).slice(0, 300);
      return send(req, res, typeof e?.http === 'number' ? e.http : 502, { error: message.startsWith('Setup required') ? message : `Reclaim: ${message}` }), true;
    }
  };
}
