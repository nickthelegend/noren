// Pure logic for Noren's CCTP relay workflow (unit-tested in relay_test.ts, no CRE runtime needed).
import { decodeAbiParameters, encodeAbiParameters, keccak256, toHex, type Address, type Hex } from "viem";
import { addressToBytes32, parseMessage, type CctpMessage } from "../../sdk/message";
import { irisMessagesUrl, parseIrisMessages, type AttestationState } from "../../sdk/iris-parse";

export const MESSAGE_SENT: Hex = keccak256(toHex("MessageSent(bytes)"));
export const ARC_DOMAIN = 26;

export type SourceConfig = { key: string; chainSelectorName: string; domain: number };
export type Config = {
  arc: { chainSelectorName: string; hook: Address; gasLimit: string };
  messageTransmitter: Address;
  sources: SourceConfig[];
  irisBaseUrl: string;
  confidence: "SAFE" | "LATEST" | "FINALIZED";
};

export const validateConfig = (c: Config): void => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(c.arc.hook) || /^0x0{40}$/.test(c.arc.hook)) throw new Error("Setup required: config arc.hook (NorenArcHook on Arc Testnet)");
  if (!/^0x[0-9a-fA-F]{40}$/.test(c.messageTransmitter)) throw new Error("config messageTransmitter is not an address");
  if (!Array.isArray(c.sources) || c.sources.length === 0) throw new Error("config sources is empty");
  const seen = new Set<number>();
  for (const s of c.sources) {
    if (s.domain === ARC_DOMAIN) throw new Error("Arc cannot be a source of the Arc relay");
    if (seen.has(s.domain)) throw new Error(`source domain ${s.domain} listed twice`);
    seen.add(s.domain);
  }
  if (!c.irisBaseUrl.startsWith("https://")) throw new Error("irisBaseUrl must be https");
};

/** The `bytes message` of a MessageTransmitterV2 MessageSent log (its data is abi.encode(bytes)). */
export const decodeMessageSent = (log: { address: Hex; topics: Hex[]; data: Hex }, transmitter: Address): Hex => {
  if (log.address.toLowerCase() !== transmitter.toLowerCase()) throw new Error(`log from ${log.address}, not MessageTransmitterV2`);
  if (log.topics[0]?.toLowerCase() !== MESSAGE_SENT) throw new Error("log is not MessageSent(bytes)");
  const [message] = decodeAbiParameters([{ type: "bytes" }], log.data);
  return message;
};

export type Route = { relay: true; message: CctpMessage } | { relay: false; reason: string };

/** Only messages from this source to Arc whose destinationCaller is NorenArcHook are Noren's to relay. */
export const routeOf = (messageHex: Hex, source: SourceConfig, hook: Address): Route => {
  let m: CctpMessage;
  try {
    m = parseMessage(messageHex);
  } catch (e) {
    return { relay: false, reason: `not a CCTP V2 burn message (${(e as Error).message})` };
  }
  if (m.sourceDomain !== source.domain) return { relay: false, reason: `source domain ${m.sourceDomain}, trigger is for ${source.domain}` };
  if (m.destinationDomain !== ARC_DOMAIN) return { relay: false, reason: `destination domain ${m.destinationDomain} is not Arc` };
  if (m.destinationCaller !== addressToBytes32(hook)) return { relay: false, reason: `destinationCaller ${m.destinationCaller} is not NorenArcHook` };
  return { relay: true, message: m };
};

/**
 * The attested message must be the burn the log announced. Iris fills in nonce, finalityThresholdExecuted,
 * feeExecuted and expirationBlock; every other field must match byte for byte.
 */
export const sameBurn = (logged: CctpMessage, attested: CctpMessage): string | null => {
  const pairs: Array<[string, unknown, unknown]> = [
    ["sourceDomain", logged.sourceDomain, attested.sourceDomain],
    ["destinationDomain", logged.destinationDomain, attested.destinationDomain],
    ["sender", logged.sender, attested.sender],
    ["recipient", logged.recipient, attested.recipient],
    ["destinationCaller", logged.destinationCaller, attested.destinationCaller],
    ["minFinalityThreshold", logged.minFinalityThreshold, attested.minFinalityThreshold],
    ["burnToken", logged.body.burnToken, attested.body.burnToken],
    ["mintRecipient", logged.body.mintRecipient, attested.body.mintRecipient],
    ["amount", logged.body.amount, attested.body.amount],
    ["messageSender", logged.body.messageSender, attested.body.messageSender],
    ["maxFee", logged.body.maxFee, attested.body.maxFee],
    ["hookData", logged.body.hookData.toLowerCase(), attested.body.hookData.toLowerCase()],
  ];
  for (const [k, a, b] of pairs) if (a !== b) return `${k} differs: log ${String(a)}, Iris ${String(b)}`;
  if (attested.body.feeExecuted > attested.body.maxFee) return `feeExecuted ${attested.body.feeExecuted} exceeds maxFee ${attested.body.maxFee}`;
  return null;
};

/** Fields every DON node must agree on (identical aggregation). */
export type IrisFields = { state: string; message: string; attestation: string; detail: string };

export const irisFields = (httpStatus: number, body: unknown): IrisFields => {
  let s: AttestationState;
  try {
    s = parseIrisMessages(httpStatus, body);
  } catch (e) {
    return { state: "error", message: "", attestation: "", detail: (e as Error).message };
  }
  if (s.state === "complete") return { state: "complete", message: s.message, attestation: s.attestation, detail: "" };
  if (s.state === "pending") return { state: "pending", message: "", attestation: "", detail: `${s.status}${s.delayReason ? ` (${s.delayReason})` : ""}` };
  return { state: "not-found", message: "", attestation: "", detail: "Iris has not indexed the burn yet" };
};

export const irisUrl = (c: Config, domain: number, txHash: Hex): string => irisMessagesUrl(domain, txHash, c.irisBaseUrl);

/** The report NorenArcHook.onReport decodes: abi.encode(bytes message, bytes attestation). */
export const encodeReport = (message: Hex, attestation: Hex): Hex => encodeAbiParameters([{ type: "bytes" }, { type: "bytes" }], [message, attestation]);

export const hookAbi = [
  { type: "function", name: "processed", stateMutability: "view", inputs: [{ name: "nonce", type: "bytes32" }], outputs: [{ name: "", type: "bool" }] },
] as const;
