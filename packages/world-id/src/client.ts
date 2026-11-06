// Browser helpers for the Noren app. No secrets here: the app only ever sees the signed rp_context.
import type { HumanRequest, HumanStatus, VerifyHumanResult, WorldConfigInfo } from './types.ts';

async function call<T>(url: string, init?: RequestInit): Promise<{ ok: boolean; body: T }> {
  let res: Response;
  try { res = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } }); }
  catch (e: any) { return { ok: false, body: { status: 'error', code: 'server_unreachable', detail: `Noren server unreachable: ${e?.message ?? e}` } as T }; }
  let body: any;
  try { body = await res.json(); } catch { body = { status: 'error', code: `http_${res.status}`, detail: `Noren server answered HTTP ${res.status} without JSON` }; }
  return { ok: res.ok, body };
}

export const fetchWorldConfig = (base: string) => call<WorldConfigInfo>(`${base}/world-id/config`).then(r => r.body);
export const fetchHumanStatus = (base: string, wallet: string) => call<HumanStatus>(`${base}/world-id/status/${wallet}`).then(r => r.body);

/** Asks the Noren server to sign a World ID request for this wallet. */
export async function requestHuman(base: string, wallet: string): Promise<{ ok: true; request: HumanRequest } | { ok: false; result: VerifyHumanResult }> {
  const r = await call<any>(`${base}/world-id/request`, { method: 'POST', body: JSON.stringify({ wallet }) });
  return r.ok ? { ok: true, request: r.body as HumanRequest } : { ok: false, result: r.body as VerifyHumanResult };
}

/** Sends the IDKit result, unchanged, to the Noren server for verification. */
export async function submitProof(base: string, idkitResponse: unknown): Promise<VerifyHumanResult> {
  return (await call<VerifyHumanResult>(`${base}/world-id/verify`, { method: 'POST', body: JSON.stringify({ idkitResponse }) })).body;
}

export const retryStarter = (base: string, wallet: string) => call<HumanStatus>(`${base}/world-id/retry`, { method: 'POST', body: JSON.stringify({ wallet }) }).then(r => r.body);

/** IDKit's client-side error codes, mapped to Noren's result type. */
export function resultFromIdkitError(code: string): VerifyHumanResult {
  switch (code) {
    case 'user_rejected': case 'cancelled':
      return { status: 'cancelled', detail: 'You closed World ID before sharing a proof. Nothing was shared with Noren.' };
    case 'credential_unavailable': case 'world_id_4_not_available': case 'feature_unavailable': case 'user_presence_failed':
      return { status: 'unavailable', code, detail: 'This World ID doesn\'t have the credential Noren asks for yet. You can still use stock-backed credit.' };
    case 'max_verifications_reached': case 'nullifier_replayed':
      return { status: 'already_used', detail: 'This human already opened a Noren starter credit line.' };
    case 'timeout': case 'rp_signature_expired': case 'timestamp_too_old':
      return { status: 'expired', detail: 'The World ID request expired. Start again.' };
    case 'connection_failed':
      return { status: 'error', code, detail: 'Couldn\'t reach World ID. Check your connection and try again.' };
    default:
      return { status: 'invalid', code, detail: `World ID couldn't complete the check (${code}).` };
  }
}

export const formatUsdc6 = (v: string | bigint) => {
  const n = BigInt(v), whole = n / 1_000_000n, frac = (n % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac.slice(0, 2).padEnd(2, '0')}` : whole.toString();
};
