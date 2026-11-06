import { readFileSync } from "node:fs";
import { decodeAbiParameters, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { addressToBytes32, bytes32ToAddress, CctpMessageError, checkNorenMessage, mintedAmount, parseMessage } from "../sdk/message";

// Real Circle data: an Arbitrum Sepolia -> OP Sepolia fast transfer, as Iris and the chain report it.
const iris = JSON.parse(readFileSync(new URL("../fixtures/iris-arbitrum-sepolia-complete.json", import.meta.url), "utf8"));
const sent = JSON.parse(readFileSync(new URL("../fixtures/arbitrum-sepolia-messagesent-log.json", import.meta.url), "utf8"));
const attested = iris.messages[0].message as Hex;
const decoded = iris.messages[0].decodedMessage;

describe("parseMessage on a real CCTP V2 message", () => {
  const m = parseMessage(attested);
  it("matches Circle's own decoding field by field", () => {
    expect(m.version).toBe(1);
    expect(m.sourceDomain).toBe(Number(decoded.sourceDomain));
    expect(m.destinationDomain).toBe(Number(decoded.destinationDomain));
    expect(m.nonce).toBe(decoded.nonce);
    expect(bytes32ToAddress(m.sender).toLowerCase()).toBe(decoded.sender);
    expect(m.destinationCaller).toBe(decoded.destinationCaller);
    expect(m.minFinalityThreshold).toBe(Number(decoded.minFinalityThreshold));
    expect(m.finalityThresholdExecuted).toBe(Number(decoded.finalityThresholdExecuted));
    const b = decoded.decodedMessageBody;
    expect(bytes32ToAddress(m.body.burnToken).toLowerCase()).toBe(b.burnToken);
    expect(bytes32ToAddress(m.body.mintRecipient).toLowerCase()).toBe(b.mintRecipient);
    expect(m.body.amount).toBe(BigInt(b.amount));
    expect(m.body.maxFee).toBe(BigInt(b.maxFee));
    expect(m.body.feeExecuted).toBe(BigInt(b.feeExecuted));
    expect(m.body.expirationBlock).toBe(BigInt(b.expirationBlock));
    expect(m.body.hookData).toBe("0x");
    expect(mintedAmount(m)).toBe(BigInt(b.amount) - BigInt(b.feeExecuted));
  });

  it("parses the on-chain MessageSent copy, where Circle has not yet filled nonce, fee and expiry", () => {
    const [raw] = decodeAbiParameters([{ type: "bytes" }], sent.logs[0].data as Hex);
    const logged = parseMessage(raw);
    expect(logged.nonce).toBe(`0x${"0".repeat(64)}`);
    expect(logged.finalityThresholdExecuted).toBe(0);
    expect(logged.body.feeExecuted).toBe(0n);
    expect(logged.body.amount).toBe(m.body.amount);
    expect(logged.body.mintRecipient).toBe(m.body.mintRecipient);
  });

  it("rejects truncated, odd-length, non-hex and wrong-version input", () => {
    expect(() => parseMessage(attested.slice(0, 2 + 2 * 300) as Hex)).toThrow(CctpMessageError);
    expect(() => parseMessage(`${attested}0` as Hex)).toThrow(CctpMessageError);
    expect(() => parseMessage("0xzz" as Hex)).toThrow(CctpMessageError);
    expect(() => parseMessage(`0x00000002${attested.slice(10)}` as Hex)).toThrow(/version 2/);
    const badBody = `${attested.slice(0, 2 + 296)}00000009${attested.slice(2 + 304)}` as Hex;
    expect(() => parseMessage(badBody)).toThrow(/burn message version 9/);
  });

  it("keeps hookData after the 228-byte burn body", () => {
    const withHook = `${attested}deadbeef` as Hex;
    expect(parseMessage(withHook).body.hookData).toBe("0xdeadbeef");
  });
});

describe("checkNorenMessage", () => {
  const m = parseMessage(attested);
  const hook = "0xc0347F3f66C0867F385679a8E0ceF3DB4A3bcb45";
  it("refuses a message not routed to NorenArcHook", () => {
    expect(() => checkNorenMessage(m, { sourceDomain: 3, destinationDomain: 2, receiver: hook })).toThrow(/destinationCaller/);
  });
  it("refuses another route", () => {
    expect(() => checkNorenMessage(m, { sourceDomain: 6, destinationDomain: 2, receiver: hook })).toThrow(/source domain 3/);
    expect(() => checkNorenMessage(m, { sourceDomain: 3, destinationDomain: 26, receiver: hook })).toThrow(/destination domain 2/);
  });
});

describe("bytes32 helpers", () => {
  it("round-trips an address and rejects a dirty word", () => {
    const a = "0x4B2ACf80Bc6E07bbF5690f0710e25C528cb63F80";
    expect(bytes32ToAddress(addressToBytes32(a))).toBe(a);
    expect(() => bytes32ToAddress(`0x01${"0".repeat(22)}${a.slice(2)}` as Hex)).toThrow(/left-padded/);
  });
});
