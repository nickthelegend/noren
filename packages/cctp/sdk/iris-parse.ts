// Pure Iris response handling (no network), shared by the SDK and the CRE relay workflow.
import { isHex, type Hex } from "viem";

/** Circle's Iris attestation API for CCTP testnets (no key). */
export const IRIS_SANDBOX = "https://iris-api-sandbox.circle.com";

/** One message as Iris reports it for a burn transaction. */
export type AttestationState =
  | { state: "not-found" }
  | { state: "pending"; status: string; delayReason: string | null; eventNonce: Hex | null }
  | { state: "complete"; message: Hex; attestation: Hex; eventNonce: Hex | null };

export class IrisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IrisError";
  }
}

export const irisMessagesUrl = (sourceDomain: number, txHash: Hex, baseUrl = IRIS_SANDBOX): string =>
  `${baseUrl}/v2/messages/${sourceDomain}?transactionHash=${txHash}`;

/**
 * Interprets a GET /v2/messages/{domain}?transactionHash= response.
 * 404 (Iris has not indexed the burn yet) is "not-found"; a message without a usable attestation is "pending";
 * anything malformed throws, so a bad response is never mistaken for a ready attestation.
 * A burn transaction holds one CCTP message; `index` picks another if it holds several.
 */
export const parseIrisMessages = (httpStatus: number, body: unknown, index = 0): AttestationState => {
  if (httpStatus === 404) return { state: "not-found" };
  if (httpStatus !== 200) {
    const msg = (body as { error?: string; message?: string } | null)?.error ?? (body as { message?: string } | null)?.message ?? "";
    throw new IrisError(`Iris returned HTTP ${httpStatus}${msg ? `: ${msg}` : ""}`);
  }
  const messages = (body as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages)) throw new IrisError("Iris response has no messages array");
  if (messages.length === 0) return { state: "not-found" };
  const m = messages[index] as Record<string, unknown> | undefined;
  if (!m) throw new IrisError(`Iris returned ${messages.length} message(s); index ${index} is out of range`);
  const status = typeof m.status === "string" ? m.status : "";
  const eventNonce = typeof m.eventNonce === "string" && isHex(m.eventNonce) ? (m.eventNonce as Hex) : null;
  const message = m.message;
  const attestation = m.attestation;
  if (status === "complete") {
    if (typeof message !== "string" || !isHex(message, { strict: true }) || message.length <= 2)
      throw new IrisError("Iris says complete but the message is not hex");
    if (typeof attestation !== "string" || !isHex(attestation, { strict: true }) || attestation.length <= 2)
      throw new IrisError("Iris says complete but the attestation is not hex");
    // Each attester signature is 65 bytes.
    if ((attestation.length - 2) % 130 !== 0) throw new IrisError(`attestation is ${(attestation.length - 2) / 2} bytes, not a multiple of 65`);
    return { state: "complete", message: message as Hex, attestation: attestation as Hex, eventNonce };
  }
  if (status === "") throw new IrisError("Iris message has no status");
  return { state: "pending", status, delayReason: typeof m.delayReason === "string" ? m.delayReason : null, eventNonce };
};

/** Fast-transfer fee in basis points for a route, from GET /v2/burn/USDC/fees/{src}/{dst}. */
export const parseFastFeeBps = (httpStatus: number, body: unknown, finalityThreshold: number): number => {
  if (httpStatus !== 200 || !Array.isArray(body)) throw new IrisError(`Iris fee lookup returned HTTP ${httpStatus}`);
  const row = (body as Array<{ finalityThreshold?: number; minimumFee?: number }>).find((r) => r.finalityThreshold === finalityThreshold);
  if (!row || typeof row.minimumFee !== "number" || !Number.isFinite(row.minimumFee) || row.minimumFee < 0)
    throw new IrisError(`Iris has no fee for finality threshold ${finalityThreshold}`);
  return row.minimumFee;
};

/**
 * maxFee for depositForBurn: the quoted bps (fractional, e.g. 1.4) of the amount, rounded up, plus a
 * safety margin (default 50%) so a fee change between quote and burn does not demote it to standard.
 */
export const maxFeeFor = (amount: bigint, feeBps: number, marginPct = 50): bigint => {
  if (amount <= 0n) throw new IrisError("amount must be positive");
  const milliBps = BigInt(Math.ceil(feeBps * 1000 * (100 + marginPct) / 100));
  const fee = (amount * milliBps + 10_000_000n - 1n) / 10_000_000n;
  return fee >= amount ? amount - 1n : fee;
};
