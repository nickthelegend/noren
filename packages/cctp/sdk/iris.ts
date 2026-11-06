import type { Hex } from "viem";
import { IRIS_SANDBOX, irisMessagesUrl, parseFastFeeBps, parseIrisMessages, type AttestationState } from "./iris-parse";

export * from "./iris-parse";

type IrisOpts = { baseUrl?: string; fetch?: typeof fetch };

const getJson = async (f: typeof fetch, url: string): Promise<{ status: number; body: unknown }> => {
  const res = await f(url, { headers: { Accept: "application/json" } });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
};

/** Fetches the attestation state for a burn once (no retries). */
export const fetchAttestation = async (sourceDomain: number, txHash: Hex, opts: IrisOpts = {}): Promise<AttestationState> => {
  const r = await getJson(opts.fetch ?? fetch, irisMessagesUrl(sourceDomain, txHash, opts.baseUrl));
  return parseIrisMessages(r.status, r.body);
};

/** Circle's fast-transfer fee (basis points) for a route. */
export const fetchFeeBps = async (sourceDomain: number, destinationDomain: number, finalityThreshold: number, opts: IrisOpts = {}): Promise<number> => {
  const r = await getJson(opts.fetch ?? fetch, `${opts.baseUrl ?? IRIS_SANDBOX}/v2/burn/USDC/fees/${sourceDomain}/${destinationDomain}`);
  return parseFastFeeBps(r.status, r.body, finalityThreshold);
};
