// Pure logic for the Noren credit bridge: event and report ABIs, log decoding, report encoding
// and the decisions each handler makes. No CRE capability calls here, so it is unit-testable
// with bun and runs unchanged inside the CRE WASM runtime (viem only, no Node built-ins).
import {
  decodeAbiParameters,
  decodeEventLog,
  encodeAbiParameters,
  getAddress,
  keccak256,
  isAddress,
  parseAbi,
  parseAbiParameters,
  toEventSelector,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";

// ---------------------------------------------------------------- ABIs (fixed interfaces)

/** NorenCredit on Robinhood Chain (packages/robinhood). */
export const robinhoodEventsAbi = parseAbi([
  "event CreditLineOpened(address indexed borrower, bytes32 indexed lineId, uint256 limitUsdc6, uint64 expiry, uint256 collateralValueUsd8)",
  "event CreditLineClosed(bytes32 indexed lineId)",
]);

/** NorenCreditLine on Arc (packages/arc-credit). */
export const creditLineAbi = parseAbi([
  "event Drawn(bytes32 indexed lineId, uint256 amount, bytes32 invoiceId, address merchant)",
  "event Repaid(bytes32 indexed lineId, uint256 amount)",
  "event CreditLineFrozen(bytes32 indexed lineId)",
  "function utilisation(bytes32 lineId) view returns (uint256 drawnUsdc6, uint256 repaidUsdc6, uint64 asOf)",
  "struct Line { address borrower; uint64 expiry; uint64 updatedAt; bool closed; uint256 limitUsdc6; uint256 drawnUsdc6; uint256 repaidUsdc6; bool unsecured; }",
  "function lines(bytes32 lineId) view returns (Line)",
  "function nullifierUsedBy(bytes32 nullifierHash) view returns (address)",
  "function maxStarterLimitUsdc6() view returns (uint256)",
]);

/**
 * Read of the Robinhood receiver's last accepted Arc snapshot, used to skip writes it would reject
 * as stale. NorenCredit (packages/robinhood) exposes it as line(lineId).asOf; the labelled
 * NorenCreditHarness as utilisation(lineId).
 */
export const robinhoodLineAbi = parseAbi([
  "struct Line { address borrower; address collateral; uint64 expiry; uint64 asOf; uint64 closeRequestedAt; uint8 status; uint256 collateralAmount; uint256 limitUsdc; uint256 drawn; uint256 repaid; }",
  "function line(bytes32 lineId) view returns (Line)",
]);
export const harnessUtilisationAbi = parseAbi([
  "function utilisation(bytes32 lineId) view returns (uint256 drawn, uint256 repaid, uint64 asOf)",
]);
/** NorenCredit LineStatus enum. */
export const LINE_STATUS = ["None", "Open", "Closing", "Closed", "Liquidated"] as const;

export const TOPIC = {
  creditLineOpened: toEventSelector("CreditLineOpened(address,bytes32,uint256,uint64,uint256)"),
  creditLineClosed: toEventSelector("CreditLineClosed(bytes32)"),
  drawn: toEventSelector("Drawn(bytes32,uint256,bytes32,address)"),
  repaid: toEventSelector("Repaid(bytes32,uint256)"),
  creditLineFrozen: toEventSelector("CreditLineFrozen(bytes32)"),
} as const;

/** NorenCreditLine.onReport kind 2: World ID human starter limit (versioned, 160 bytes). */
export const HUMAN_STARTER_REPORT_PARAMS = parseAbiParameters(
  "uint8 kind, address borrower, bytes32 nullifierHash, uint256 starterLimitUsdc6, uint64 expiry",
);
export const KIND_HUMAN_STARTER = 2;
/** NorenCreditLine.onReport kind 1 (the original 128-byte fixed interface, sent unversioned). */
export const ARC_REPORT_PARAMS = parseAbiParameters("address borrower, bytes32 lineId, uint256 limitUsdc6, uint64 expiry");
/** NorenCredit.onReport payload. */
export const ROBINHOOD_REPORT_PARAMS = parseAbiParameters("bytes32 lineId, uint256 drawnUsdc6, uint256 repaidUsdc6, uint64 asOf");

// ---------------------------------------------------------------- config

export type ChainTarget = {
  /** Robinhood only, informational: "NorenCredit" or the labelled "NorenCreditHarness". The asOf read
   *  tries utilisation(bytes32) then line(bytes32) on either, so this no longer changes behaviour. */
  receiver?: "NorenCredit" | "NorenCreditHarness";
  /** CRE chain selector name, e.g. "robinhood-testnet" or "arc-testnet". */
  chainSelectorName: string;
  /** Receiver / event source contract on that chain. */
  address: Address;
  gasLimit: string;
};

export type BridgeConfig = {
  robinhood: ChainTarget;
  arc: ChainTarget;
  /** Log trigger confidence for both chains. */
  confidence: "SAFE" | "LATEST" | "FINALIZED";
  /** Refuse to bridge a line above this limit (USDC, 6 decimals) as a sanity cap. */
  maxLimitUsdc6: string;
  /** HTTP trigger for World ID starter limits (handler 3). */
  humanStarter?: {
    /** EVM addresses allowed to sign HTTP trigger requests (the World ID server). Required for a DON deploy. */
    authorizedKeys: string[];
  };
};

export function validateConfig(config: BridgeConfig): void {
  for (const [name, t] of [["robinhood", config.robinhood], ["arc", config.arc]] as const) {
    if (!t || !t.chainSelectorName) throw new Error(`config.${name}.chainSelectorName is required`);
    if (!isAddress(t.address) || t.address === zeroAddress) {
      throw new Error(`Setup required: config.${name}.address (deploy the ${name === "arc" ? "NorenCreditLine" : "NorenCredit"} receiver first)`);
    }
    if (!/^[0-9]+$/.test(t.gasLimit)) throw new Error(`config.${name}.gasLimit must be a decimal string`);
  }
  const receiver = config.robinhood.receiver ?? "NorenCredit";
  if (receiver !== "NorenCredit" && receiver !== "NorenCreditHarness") throw new Error("config.robinhood.receiver must be NorenCredit or NorenCreditHarness");
  if (!["SAFE", "LATEST", "FINALIZED"].includes(config.confidence)) throw new Error("config.confidence must be SAFE, LATEST or FINALIZED");
  if (!/^[0-9]+$/.test(config.maxLimitUsdc6) || BigInt(config.maxLimitUsdc6) === 0n) throw new Error("config.maxLimitUsdc6 must be a positive decimal string");
  for (const k of config.humanStarter?.authorizedKeys ?? []) {
    if (!isAddress(k)) throw new Error(`config.humanStarter.authorizedKeys: ${k} is not an EVM address`);
  }
}

// ---------------------------------------------------------------- logs

export type RawLog = { address: Hex; topics: Hex[]; data: Hex };

export type OpenedEvent = { borrower: Address; lineId: Hex; limitUsdc6: bigint; expiry: bigint; collateralValueUsd8: bigint };
export type ArcActivity = { kind: "Drawn" | "Repaid" | "CreditLineFrozen"; lineId: Hex; amount: bigint; invoiceId?: Hex; merchant?: Address };

function expectSource(log: RawLog, expected: Address, what: string): void {
  if (log.address.toLowerCase() !== expected.toLowerCase()) throw new Error(`${what} log from ${log.address}, expected ${expected}`);
}

export function decodeOpened(log: RawLog, norenCredit: Address): OpenedEvent {
  expectSource(log, norenCredit, "CreditLineOpened");
  const ev = decodeEventLog({ abi: robinhoodEventsAbi, topics: log.topics as [Hex, ...Hex[]], data: log.data, strict: true });
  if (ev.eventName !== "CreditLineOpened") throw new Error(`expected CreditLineOpened, got ${ev.eventName}`);
  return ev.args;
}

export function decodeClosed(log: RawLog, norenCredit: Address): Hex {
  expectSource(log, norenCredit, "CreditLineClosed");
  const ev = decodeEventLog({ abi: robinhoodEventsAbi, topics: log.topics as [Hex, ...Hex[]], data: log.data, strict: true });
  if (ev.eventName !== "CreditLineClosed") throw new Error(`expected CreditLineClosed, got ${ev.eventName}`);
  return ev.args.lineId;
}

export function decodeArcActivity(log: RawLog, creditLine: Address): ArcActivity {
  expectSource(log, creditLine, "Drawn/Repaid/CreditLineFrozen");
  const ev = decodeEventLog({ abi: creditLineAbi, topics: log.topics as [Hex, ...Hex[]], data: log.data, strict: true });
  if (ev.eventName === "Drawn") return { kind: "Drawn", lineId: ev.args.lineId, amount: ev.args.amount, invoiceId: ev.args.invoiceId, merchant: ev.args.merchant };
  if (ev.eventName === "Repaid") return { kind: "Repaid", lineId: ev.args.lineId, amount: ev.args.amount };
  // Frozen after a Robinhood close: report the final snapshot so a fully repaid line can settle at once.
  if (ev.eventName === "CreditLineFrozen") return { kind: "CreditLineFrozen", lineId: ev.args.lineId, amount: 0n };
  throw new Error("expected Drawn, Repaid or CreditLineFrozen");
}

// ---------------------------------------------------------------- reports

export const encodeArcReport = (borrower: Address, lineId: Hex, limitUsdc6: bigint, expiry: bigint): Hex =>
  encodeAbiParameters(ARC_REPORT_PARAMS, [borrower, lineId, limitUsdc6, expiry]);

export const encodeRobinhoodReport = (lineId: Hex, drawnUsdc6: bigint, repaidUsdc6: bigint, asOf: bigint): Hex =>
  encodeAbiParameters(ROBINHOOD_REPORT_PARAMS, [lineId, drawnUsdc6, repaidUsdc6, asOf]);

/** Encoder for the World ID starter-limit report, for whichever workflow handler carries it. */
export const encodeHumanStarterReport = (borrower: Address, nullifierHash: Hex, starterLimitUsdc6: bigint, expiry: bigint): Hex =>
  encodeAbiParameters(HUMAN_STARTER_REPORT_PARAMS, [KIND_HUMAN_STARTER, borrower, nullifierHash, starterLimitUsdc6, expiry]);

export const decodeArcReport = (report: Hex) => decodeAbiParameters(ARC_REPORT_PARAMS, report);
export const decodeRobinhoodReport = (report: Hex) => decodeAbiParameters(ROBINHOOD_REPORT_PARAMS, report);

// ---------------------------------------------------------------- decisions

export type ArcLine = { borrower: Address; expiry: bigint; updatedAt: bigint; closed: boolean; limitUsdc6: bigint; unsecured: boolean };

export type Decision = { write: true; report: Hex; summary: string } | { write: false; reason: string };

/** CreditLineOpened on Robinhood -> NorenCreditLine.onReport on Arc. */
export function decideOpen(ev: OpenedEvent, arcLine: ArcLine, nowSeconds: bigint, maxLimitUsdc6: bigint): Decision {
  if (ev.limitUsdc6 === 0n) return { write: false, reason: `line ${ev.lineId} opened with limit 0` };
  if (ev.limitUsdc6 > maxLimitUsdc6) throw new Error(`line ${ev.lineId} limit ${ev.limitUsdc6} is above the bridge cap ${maxLimitUsdc6}`);
  if (ev.expiry <= nowSeconds) return { write: false, reason: `line ${ev.lineId} already expired at ${ev.expiry}` };
  if (arcLine.borrower !== zeroAddress) {
    if (arcLine.unsecured) throw new Error(`line ${ev.lineId} is a World ID starter line on Arc, not a collateral line`);
    if (arcLine.borrower.toLowerCase() !== ev.borrower.toLowerCase()) {
      throw new Error(`line ${ev.lineId} is owned by ${arcLine.borrower} on Arc, event says ${ev.borrower}`);
    }
    if (arcLine.closed) return { write: false, reason: `line ${ev.lineId} is frozen on Arc` };
    if (arcLine.limitUsdc6 === ev.limitUsdc6 && arcLine.expiry === ev.expiry) return { write: false, reason: `line ${ev.lineId} already synced to Arc` };
  }
  return {
    write: true,
    report: encodeArcReport(ev.borrower, ev.lineId, ev.limitUsdc6, ev.expiry),
    summary: `open ${ev.lineId} for ${ev.borrower}: limit ${formatUsdc(ev.limitUsdc6)} USDC until ${ev.expiry}`,
  };
}

/** CreditLineClosed on Robinhood -> NorenCreditLine.onReport(limit 0) on Arc. */
export function decideClose(lineId: Hex, arcLine: ArcLine): Decision {
  if (arcLine.borrower === zeroAddress) return { write: false, reason: `line ${lineId} was never synced to Arc` };
  if (arcLine.unsecured) return { write: false, reason: `line ${lineId} is a World ID starter line; Robinhood does not own it` };
  if (arcLine.closed) return { write: false, reason: `line ${lineId} already frozen on Arc` };
  return { write: true, report: encodeArcReport(arcLine.borrower, lineId, 0n, arcLine.expiry), summary: `freeze ${lineId} on Arc` };
}

/** Drawn/Repaid on Arc -> NorenCredit.onReport on Robinhood, with the snapshot read at the log's block. */
export function decideUtilisation(
  lineId: Hex,
  snapshot: { drawnUsdc6: bigint; repaidUsdc6: bigint; asOf: bigint; unsecured?: boolean },
  robinhoodAsOf: bigint | null,
): Decision {
  if (snapshot.unsecured) return { write: false, reason: `line ${lineId} is a World ID starter line (unsecured, Arc only); nothing to report to Robinhood` };
  if (snapshot.asOf === 0n) throw new Error(`line ${lineId} has no activity on Arc at this block`);
  if (snapshot.repaidUsdc6 > snapshot.drawnUsdc6) throw new Error(`line ${lineId} snapshot repaid > drawn`);
  if (robinhoodAsOf !== null && robinhoodAsOf >= snapshot.asOf) {
    return { write: false, reason: `Robinhood already has asOf ${robinhoodAsOf} >= ${snapshot.asOf} for ${lineId}` };
  }
  return {
    write: true,
    report: encodeRobinhoodReport(lineId, snapshot.drawnUsdc6, snapshot.repaidUsdc6, snapshot.asOf),
    summary: `utilisation ${lineId}: drawn ${formatUsdc(snapshot.drawnUsdc6)} repaid ${formatUsdc(snapshot.repaidUsdc6)} asOf ${snapshot.asOf}`,
  };
}

export function formatUsdc(v: bigint): string {
  const whole = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

// ---------------------------------------------------------------- World ID starter limit (HTTP trigger)

/** Version tag shared with packages/world-id's httpTriggerPayload. */
export const HUMAN_STARTER_TAG = "noren.human-starter.v1";
/** NorenCreditLine.MAX_STARTER_DURATION. */
export const MAX_STARTER_DURATION = 90n * 86_400n;

/** NorenCreditLine.starterLineId(borrower) = keccak256(abi.encode("noren.human-starter.v1", borrower)). */
export const starterLineId = (borrower: Address): Hex =>
  keccak256(encodeAbiParameters(parseAbiParameters("string, address"), [HUMAN_STARTER_TAG, borrower]));

export type HumanStarterRequest = { borrower: Address; nullifierHash: Hex; limitUsdc6: bigint; expiry: bigint; lineId: Hex };

/**
 * Parse and check the World ID server's JSON:
 *   { kind: "noren.human-starter.v1", borrower, nullifierHash, limitUsdc6: "<decimal string>", expiry: <unix s>, lineId? }
 * lineId is optional; if given it must equal starterLineId(borrower).
 */
export function parseHumanStarterPayload(input: unknown): HumanStarterRequest {
  if (!input || typeof input !== "object") throw new Error("human starter payload must be a JSON object");
  const p = input as Record<string, unknown>;
  if (p.kind !== HUMAN_STARTER_TAG) throw new Error(`human starter payload kind must be "${HUMAN_STARTER_TAG}"`);
  if (typeof p.borrower !== "string" || !isAddress(p.borrower) || BigInt(p.borrower) === 0n) throw new Error("human starter payload: bad borrower");
  const borrower = getAddress(p.borrower);
  if (typeof p.nullifierHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(p.nullifierHash) || BigInt(p.nullifierHash) === 0n) {
    throw new Error("human starter payload: nullifierHash must be a non-zero 32-byte hex string");
  }
  const limitRaw = typeof p.limitUsdc6 === "number" ? String(p.limitUsdc6) : p.limitUsdc6;
  if (typeof limitRaw !== "string" || !/^[0-9]+$/.test(limitRaw) || BigInt(limitRaw) === 0n) throw new Error("human starter payload: limitUsdc6 must be a positive integer");
  const expiryRaw = typeof p.expiry === "number" ? p.expiry : typeof p.expiry === "string" && /^[0-9]+$/.test(p.expiry) ? Number(p.expiry) : NaN;
  if (!Number.isSafeInteger(expiryRaw) || expiryRaw <= 0) throw new Error("human starter payload: expiry must be a unix time in seconds");
  const lineId = starterLineId(borrower);
  if (p.lineId !== undefined && (typeof p.lineId !== "string" || p.lineId.toLowerCase() !== lineId.toLowerCase())) {
    throw new Error(`human starter payload: lineId ${String(p.lineId)} is not NorenCreditLine.starterLineId(borrower) = ${lineId}`);
  }
  return { borrower, nullifierHash: p.nullifierHash.toLowerCase() as Hex, limitUsdc6: BigInt(limitRaw), expiry: BigInt(expiryRaw), lineId };
}

/** Arc-side state the workflow reads before signing, so it never signs a report the contract would revert. */
export type HumanStarterArcState = { nullifierUsedBy: Address; maxStarterLimitUsdc6: bigint; line: ArcLine };

export function decideHumanStarter(req: HumanStarterRequest, arc: HumanStarterArcState, nowSeconds: bigint): Decision {
  if (arc.nullifierUsedBy !== zeroAddress) {
    return { write: false, reason: `nullifier ${req.nullifierHash} already used by ${arc.nullifierUsedBy}` };
  }
  if (req.expiry <= nowSeconds) throw new Error(`starter expiry ${req.expiry} is in the past`);
  if (req.expiry > nowSeconds + MAX_STARTER_DURATION) throw new Error(`starter expiry ${req.expiry} is more than 90 days out`);
  if (arc.line.borrower !== zeroAddress && !arc.line.unsecured) throw new Error(`line ${req.lineId} exists on Arc and is not a starter line`);
  if (arc.line.closed) return { write: false, reason: `starter line ${req.lineId} is frozen` };
  const total = arc.line.limitUsdc6 + req.limitUsdc6;
  if (total > arc.maxStarterLimitUsdc6) throw new Error(`starter limit ${total} would exceed the Arc cap ${arc.maxStarterLimitUsdc6}`);
  return {
    write: true,
    report: encodeHumanStarterReport(req.borrower, req.nullifierHash, req.limitUsdc6, req.expiry),
    summary: `human starter for ${req.borrower}: +${formatUsdc(req.limitUsdc6)} USDC (line ${req.lineId}, nullifier ${req.nullifierHash})`,
  };
}
