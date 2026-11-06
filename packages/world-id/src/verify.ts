import type { WorldEnvironment } from './types.ts';

export type WorldVerifyOutcome =
  | { ok: true; nullifier?: string; environment: string }
  | { ok: false; reason: 'rejected'; code: string; detail: string; httpStatus: number }
  | { ok: false; reason: 'unreachable'; detail: string };

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/**
 * Forwards the IDKit result, unchanged, to the World Developer Portal:
 *   POST {verifyBase}/api/v4/verify/{rp_id}
 * Accepts only `success: true` with the expected environment. Everything else is a rejection with
 * the Portal's own code (for example all_verifications_failed, invalid_proof, app_not_migrated).
 */
export async function verifyWithWorld(opts: { verifyBase: string; rpId: string; environment: WorldEnvironment; idkitResponse: Record<string, unknown>; fetchImpl?: FetchLike; timeoutMs?: number }): Promise<WorldVerifyOutcome> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const url = `${opts.verifyBase.replace(/\/$/, '')}/api/v4/verify/${encodeURIComponent(opts.rpId)}`;
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...opts.idkitResponse, environment: opts.environment }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
  } catch (error: any) {
    return { ok: false, reason: 'unreachable', detail: `World ID verifier unreachable: ${String(error?.message ?? error).slice(0, 160)}` };
  }
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { /* non-JSON body handled below */ }
  if (!res.ok || body?.success !== true) {
    const first = Array.isArray(body?.results) ? body.results.find((r: any) => r && r.success === false) : undefined;
    const code = String(first?.code ?? body?.code ?? (res.ok ? 'verification_failed' : `http_${res.status}`));
    const detail = String(first?.detail ?? body?.detail ?? (text ? text.slice(0, 160) : `HTTP ${res.status}`));
    return { ok: false, reason: 'rejected', code, detail, httpStatus: res.status };
  }
  // The integration guide's rule: a success only counts if the verifier names the expected environment.
  if (body.environment !== opts.environment) {
    return { ok: false, reason: 'rejected', code: 'environment_mismatch', detail: `Verifier answered for ${body.environment ?? 'no environment'}, expected ${opts.environment}`, httpStatus: res.status };
  }
  const nullifier = typeof body.nullifier === 'string' ? body.nullifier
    : Array.isArray(body.results) ? body.results.find((r: any) => r?.success === true && typeof r.nullifier === 'string')?.nullifier : undefined;
  return { ok: true, nullifier, environment: body.environment };
}
