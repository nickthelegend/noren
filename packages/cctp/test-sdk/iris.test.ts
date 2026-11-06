import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { IrisError, maxFeeFor, parseFastFeeBps, parseIrisMessages } from "../sdk/iris-parse";
import { fetchAttestation, fetchFeeBps } from "../sdk/iris";

const complete = JSON.parse(readFileSync(new URL("../fixtures/iris-arbitrum-sepolia-complete.json", import.meta.url), "utf8"));

describe("parseIrisMessages (recorded Iris responses)", () => {
  it("returns message and attestation when complete", () => {
    const s = parseIrisMessages(200, complete);
    expect(s.state).toBe("complete");
    if (s.state !== "complete") return;
    expect(s.message).toBe(complete.messages[0].message);
    expect((s.attestation.length - 2) / 130).toBe(2); // two 65-byte attester signatures
  });
  it("404 means Iris has not indexed the burn yet", () => {
    expect(parseIrisMessages(404, { error: "Message not found for provided parameters" })).toEqual({ state: "not-found" });
  });
  it("pending_confirmations is pending, never ready", () => {
    const pending = { messages: [{ ...complete.messages[0], status: "pending_confirmations", attestation: "PENDING", delayReason: "insufficient_fee" }] };
    expect(parseIrisMessages(200, pending)).toMatchObject({ state: "pending", status: "pending_confirmations", delayReason: "insufficient_fee" });
  });
  it("a complete status with a bad attestation throws instead of relaying", () => {
    const bad = { messages: [{ ...complete.messages[0], attestation: "PENDING" }] };
    expect(() => parseIrisMessages(200, bad)).toThrow(IrisError);
    const short = { messages: [{ ...complete.messages[0], attestation: "0x1234" }] };
    expect(() => parseIrisMessages(200, short)).toThrow(/multiple of 65/);
  });
  it("other HTTP errors and malformed bodies throw", () => {
    expect(() => parseIrisMessages(429, { error: "rate limited" })).toThrow(/429: rate limited/);
    expect(() => parseIrisMessages(200, { nope: 1 })).toThrow(/no messages array/);
    expect(() => parseIrisMessages(200, { messages: [{}] })).toThrow(/no status/);
  });
});

describe("fees", () => {
  it("reads the fast-transfer bps row", () => {
    const body = [{ finalityThreshold: 1000, minimumFee: 1.3 }, { finalityThreshold: 2000, minimumFee: 0 }];
    expect(parseFastFeeBps(200, body, 1000)).toBe(1.3);
    expect(parseFastFeeBps(200, body, 2000)).toBe(0);
    expect(() => parseFastFeeBps(200, body, 500)).toThrow(IrisError);
  });
  it("maxFee covers the quoted bps with a 50% margin, rounded up", () => {
    expect(maxFeeFor(1_000_000n, 1.3)).toBe(195n); // 1.3 bps of 1 USDC = 130 units, x1.5
    expect(maxFeeFor(1n, 1.3)).toBe(0n); // never the whole amount
    expect(maxFeeFor(10_000_000n, 0)).toBe(0n);
    expect(() => maxFeeFor(0n, 1)).toThrow();
  });
});

describe("live Iris sandbox (network)", () => {
  it("answers the real Arbitrum Sepolia transfer and the Base Sepolia -> Arc fee route", async () => {
    const s = await fetchAttestation(3, "0xdcd2611c6f1cb703179e0fb3316dd03314b14a791ae82999419c976b7b0f6818");
    expect(s.state).toBe("complete");
    const bps = await fetchFeeBps(6, 26, 1000);
    expect(bps).toBeGreaterThanOrEqual(0);
  });
});
