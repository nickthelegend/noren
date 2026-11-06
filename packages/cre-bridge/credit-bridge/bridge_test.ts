import { describe, expect, test } from "bun:test";
import { encodeAbiParameters, encodeEventTopics, keccak256, parseAbiParameters, stringToHex, zeroAddress, type Address, type Hex } from "viem";
import {
  creditLineAbi,
  decideClose,
  decideOpen,
  decideUtilisation,
  decodeArcActivity,
  decodeArcReport,
  decodeClosed,
  decodeOpened,
  decodeRobinhoodReport,
  decideHumanStarter,
  encodeHumanStarterReport,
  parseHumanStarterPayload,
  starterLineId,
  formatUsdc,
  TOPIC,
  robinhoodEventsAbi,
  validateConfig,
  type ArcLine,
  type BridgeConfig,
} from "./bridge";

const NOREN_CREDIT: Address = "0x1111111111111111111111111111111111111111";
const CREDIT: Address = "0x2222222222222222222222222222222222222222";
const BORROWER: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const MERCHANT: Address = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const LINE: Hex = keccak256(stringToHex("line-1"));
const INVOICE: Hex = keccak256(stringToHex("inv-1"));
const NOW = 1_762_400_000n;

const emptyLine: ArcLine = { borrower: zeroAddress, expiry: 0n, updatedAt: 0n, closed: false, limitUsdc6: 0n, unsecured: false };

const openedLog = (address: Address = NOREN_CREDIT) => ({
  address,
  topics: encodeEventTopics({ abi: robinhoodEventsAbi, eventName: "CreditLineOpened", args: { borrower: BORROWER, lineId: LINE } }) as Hex[],
  data: encodeAbiParameters(parseAbiParameters("uint256, uint64, uint256"), [500_000_000n, NOW + 86_400n, 123_456_789_00n]),
});

const config = (): BridgeConfig => ({
  robinhood: { chainSelectorName: "robinhood-testnet", address: NOREN_CREDIT, gasLimit: "500000" },
  arc: { chainSelectorName: "arc-testnet", address: CREDIT, gasLimit: "500000" },
  confidence: "SAFE",
  maxLimitUsdc6: "100000000000",
});

describe("topics", () => {
  test("match the fixed event signatures", () => {
    expect(TOPIC.creditLineOpened).toBe(keccak256(stringToHex("CreditLineOpened(address,bytes32,uint256,uint64,uint256)")));
    expect(TOPIC.creditLineClosed).toBe(keccak256(stringToHex("CreditLineClosed(bytes32)")));
    expect(TOPIC.drawn).toBe(keccak256(stringToHex("Drawn(bytes32,uint256,bytes32,address)")));
    expect(TOPIC.repaid).toBe(keccak256(stringToHex("Repaid(bytes32,uint256)")));
  });
});

describe("validateConfig", () => {
  test("accepts a complete config", () => expect(() => validateConfig(config())).not.toThrow());
  test("zero receiver is Setup required", () => {
    const c = config();
    c.arc.address = zeroAddress;
    expect(() => validateConfig(c)).toThrow("Setup required: config.arc.address");
  });
  test("bad confidence and cap", () => {
    expect(() => validateConfig({ ...config(), confidence: "NOPE" as never })).toThrow("confidence");
    expect(() => validateConfig({ ...config(), maxLimitUsdc6: "0" })).toThrow("maxLimitUsdc6");
  });
});

describe("decode logs", () => {
  test("CreditLineOpened", () => {
    const ev = decodeOpened(openedLog(), NOREN_CREDIT);
    expect(ev.borrower).toBe(BORROWER);
    expect(ev.lineId).toBe(LINE);
    expect(ev.limitUsdc6).toBe(500_000_000n);
    expect(ev.expiry).toBe(NOW + 86_400n);
  });
  test("rejects a log from another contract", () => {
    expect(() => decodeOpened(openedLog(CREDIT), NOREN_CREDIT)).toThrow("expected 0x1111");
  });
  test("CreditLineClosed", () => {
    const log = { address: NOREN_CREDIT, topics: encodeEventTopics({ abi: robinhoodEventsAbi, eventName: "CreditLineClosed", args: { lineId: LINE } }) as Hex[], data: "0x" as Hex };
    expect(decodeClosed(log, NOREN_CREDIT)).toBe(LINE);
    expect(() => decodeOpened(log, NOREN_CREDIT)).toThrow();
  });
  test("Drawn and Repaid", () => {
    const drawn = {
      address: CREDIT,
      topics: encodeEventTopics({ abi: creditLineAbi, eventName: "Drawn", args: { lineId: LINE } }) as Hex[],
      data: encodeAbiParameters(parseAbiParameters("uint256, bytes32, address"), [120_000_000n, INVOICE, MERCHANT]),
    };
    expect(decodeArcActivity(drawn, CREDIT)).toEqual({ kind: "Drawn", lineId: LINE, amount: 120_000_000n, invoiceId: INVOICE, merchant: MERCHANT });
    const repaid = {
      address: CREDIT,
      topics: encodeEventTopics({ abi: creditLineAbi, eventName: "Repaid", args: { lineId: LINE } }) as Hex[],
      data: encodeAbiParameters(parseAbiParameters("uint256"), [20_000_000n]),
    };
    expect(decodeArcActivity(repaid, CREDIT)).toEqual({ kind: "Repaid", lineId: LINE, amount: 20_000_000n });
  });
});

describe("decideOpen", () => {
  const ev = () => decodeOpened(openedLog(), NOREN_CREDIT);
  test("new line -> Arc report in the fixed layout", () => {
    const d = decideOpen(ev(), emptyLine, NOW, 100_000_000_000n);
    expect(d.write).toBe(true);
    if (!d.write) return;
    expect(decodeArcReport(d.report)).toEqual([BORROWER, LINE, 500_000_000n, NOW + 86_400n]);
    expect((d.report.length - 2) / 2).toBe(128);
  });
  test("already synced is skipped", () => {
    const d = decideOpen(ev(), { borrower: BORROWER, expiry: NOW + 86_400n, updatedAt: NOW, closed: false, limitUsdc6: 500_000_000n, unsecured: false }, NOW, 10n ** 12n);
    expect(d).toEqual({ write: false, reason: `line ${LINE} already synced to Arc` });
  });
  test("frozen line is never reopened", () => {
    const d = decideOpen(ev(), { borrower: BORROWER, expiry: NOW + 86_400n, updatedAt: NOW, closed: true, limitUsdc6: 0n, unsecured: false }, NOW, 10n ** 12n);
    expect(d.write).toBe(false);
  });
  test("expired event is skipped", () => {
    expect(decideOpen(ev(), emptyLine, NOW + 86_400n, 10n ** 12n).write).toBe(false);
  });
  test("over the cap fails loudly", () => {
    expect(() => decideOpen(ev(), emptyLine, NOW, 1n)).toThrow("above the bridge cap");
  });
  test("borrower mismatch fails loudly", () => {
    expect(() => decideOpen(ev(), { ...emptyLine, borrower: MERCHANT }, NOW, 10n ** 12n)).toThrow("is owned by");
  });
});

describe("decideClose", () => {
  test("freezes a synced line with limit 0", () => {
    const d = decideClose(LINE, { borrower: BORROWER, expiry: NOW + 5n, updatedAt: NOW, closed: false, limitUsdc6: 9n, unsecured: false });
    expect(d.write).toBe(true);
    if (d.write) expect(decodeArcReport(d.report)).toEqual([BORROWER, LINE, 0n, NOW + 5n]);
  });
  test("skips unknown and already frozen lines", () => {
    expect(decideClose(LINE, emptyLine).write).toBe(false);
    expect(decideClose(LINE, { borrower: BORROWER, expiry: 1n, updatedAt: 1n, closed: true, limitUsdc6: 0n, unsecured: false }).write).toBe(false);
  });
});

describe("decideUtilisation", () => {
  const snap = { drawnUsdc6: 120_000_000n, repaidUsdc6: 20_000_000n, asOf: NOW + 2n };
  test("builds the Robinhood report in the fixed layout", () => {
    const d = decideUtilisation(LINE, snap, NOW);
    expect(d.write).toBe(true);
    if (d.write) expect(decodeRobinhoodReport(d.report)).toEqual([LINE, 120_000_000n, 20_000_000n, NOW + 2n]);
  });
  test("skips when Robinhood already has this snapshot or newer", () => {
    expect(decideUtilisation(LINE, snap, NOW + 2n).write).toBe(false);
  });
  test("writes without a pre-check when the view is absent", () => {
    expect(decideUtilisation(LINE, snap, null).write).toBe(true);
  });
  test("refuses an empty or inconsistent snapshot", () => {
    expect(() => decideUtilisation(LINE, { ...snap, asOf: 0n }, null)).toThrow("no activity");
    expect(() => decideUtilisation(LINE, { ...snap, repaidUsdc6: snap.drawnUsdc6 + 1n }, null)).toThrow("repaid > drawn");
  });
});

test("formatUsdc", () => {
  expect(formatUsdc(500_000_000n)).toBe("500");
  expect(formatUsdc(1_250_000n)).toBe("1.25");
  expect(formatUsdc(1n)).toBe("0.000001");
});

describe("World ID starter lines", () => {
  const starter: ArcLine = { borrower: BORROWER, expiry: NOW + 5n, updatedAt: NOW, closed: false, limitUsdc6: 25_000_000n, unsecured: true };
  test("Drawn/Repaid on a starter line is not reported to Robinhood", () => {
    const d = decideUtilisation(LINE, { drawnUsdc6: 1n, repaidUsdc6: 0n, asOf: NOW, unsecured: true }, null);
    expect(d.write).toBe(false);
  });
  test("a Robinhood close never touches a starter line", () => {
    expect(decideClose(LINE, starter).write).toBe(false);
  });
  test("a Robinhood open colliding with a starter line fails loudly", () => {
    expect(() => decideOpen(decodeOpened(openedLog(), NOREN_CREDIT), starter, NOW, 10n ** 12n)).toThrow("World ID starter line");
  });
  test("kind 2 report encodes to the 160-byte versioned layout", () => {
    const nullifier = keccak256(stringToHex("nullifier"));
    const r = encodeHumanStarterReport(BORROWER, nullifier, 25_000_000n, NOW + 86_400n);
    expect((r.length - 2) / 2).toBe(160);
    expect(BigInt(r.slice(0, 66))).toBe(2n);
  });
});

describe("World ID HTTP payload (handler 3)", () => {
  const nullifier = keccak256(stringToHex("world-nullifier"));
  const body = (extra: Record<string, unknown> = {}) => ({
    kind: "noren.human-starter.v1", borrower: BORROWER, nullifierHash: nullifier, limitUsdc6: "25000000", expiry: Number(NOW + 86_400n), ...extra,
  });
  const empty: ArcLine = { borrower: zeroAddress, expiry: 0n, updatedAt: 0n, closed: false, limitUsdc6: 0n, unsecured: false };
  const arc = { nullifierUsedBy: zeroAddress as Address, maxStarterLimitUsdc6: 25_000_000n, line: empty };

  test("starterLineId matches NorenCreditLine.starterLineId (keccak256(abi.encode(string, address)))", () => {
    expect(starterLineId(BORROWER)).toBe(
      keccak256(encodeAbiParameters(parseAbiParameters("string, address"), ["noren.human-starter.v1", BORROWER])),
    );
  });
  test("parses the world-id httpTriggerPayload shape", () => {
    const r = parseHumanStarterPayload(body({ lineId: starterLineId(BORROWER) }));
    expect(r).toEqual({ borrower: BORROWER, nullifierHash: nullifier, limitUsdc6: 25_000_000n, expiry: NOW + 86_400n, lineId: starterLineId(BORROWER) });
  });
  test("rejects a wrong kind, bad fields and a foreign lineId", () => {
    expect(() => parseHumanStarterPayload(body({ kind: keccak256(stringToHex("noren.human-starter.v1")) }))).toThrow("kind must be");
    expect(() => parseHumanStarterPayload(body({ borrower: "0x1234" }))).toThrow("bad borrower");
    expect(() => parseHumanStarterPayload(body({ nullifierHash: "0x00" }))).toThrow("nullifierHash");
    expect(() => parseHumanStarterPayload(body({ limitUsdc6: "-1" }))).toThrow("limitUsdc6");
    expect(() => parseHumanStarterPayload(body({ expiry: "soon" }))).toThrow("expiry");
    expect(() => parseHumanStarterPayload(body({ lineId: keccak256(stringToHex("other")) }))).toThrow("is not NorenCreditLine.starterLineId");
  });
  test("builds the kind 2 report", () => {
    const d = decideHumanStarter(parseHumanStarterPayload(body()), arc, NOW);
    expect(d.write).toBe(true);
    if (d.write) expect(d.report).toBe(encodeHumanStarterReport(BORROWER, nullifier, 25_000_000n, NOW + 86_400n));
  });
  test("skips a used nullifier, refuses over-cap and bad expiry", () => {
    const req = parseHumanStarterPayload(body());
    expect(decideHumanStarter(req, { ...arc, nullifierUsedBy: MERCHANT }, NOW).write).toBe(false);
    expect(() => decideHumanStarter(req, { ...arc, line: { ...empty, borrower: BORROWER, unsecured: true, limitUsdc6: 1n } }, NOW)).toThrow("exceed the Arc cap");
    expect(() => decideHumanStarter(req, arc, NOW + 86_400n)).toThrow("in the past");
    expect(() => decideHumanStarter(parseHumanStarterPayload(body({ expiry: Number(NOW + 91n * 86_400n) })), arc, NOW)).toThrow("90 days");
    expect(() => decideHumanStarter(req, { ...arc, line: { ...empty, borrower: BORROWER } }, NOW)).toThrow("not a starter line");
  });
});

test("CreditLineFrozen decodes as Arc activity (handler 2 reports the final snapshot)", () => {
  const log = { address: CREDIT, topics: encodeEventTopics({ abi: creditLineAbi, eventName: "CreditLineFrozen", args: { lineId: LINE } }) as Hex[], data: "0x" as Hex };
  expect(decodeArcActivity(log, CREDIT)).toEqual({ kind: "CreditLineFrozen", lineId: LINE, amount: 0n });
  expect(TOPIC.creditLineFrozen).toBe(keccak256(stringToHex("CreditLineFrozen(bytes32)")));
});
