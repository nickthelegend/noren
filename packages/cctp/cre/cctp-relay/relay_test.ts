import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { decodeAbiParameters, type Hex } from "viem";
import { parseMessage } from "../../sdk/message";
import { decodeMessageSent, encodeReport, irisFields, routeOf, sameBurn, validateConfig, type Config } from "./relay";

// Real Circle data: Arbitrum Sepolia (domain 3) -> OP Sepolia (domain 2).
const iris = JSON.parse(readFileSync(new URL("../../fixtures/iris-arbitrum-sepolia-complete.json", import.meta.url), "utf8"));
const sent = JSON.parse(readFileSync(new URL("../../fixtures/arbitrum-sepolia-messagesent-log.json", import.meta.url), "utf8"));
const config: Config = JSON.parse(readFileSync(new URL("./config.staging.json", import.meta.url), "utf8"));
const MT = "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275";
const arb = { key: "arbitrum-sepolia", chainSelectorName: "ethereum-testnet-sepolia-arbitrum-1", domain: 3 };
const hook = config.arc.hook;
const logged = decodeMessageSent(sent.logs[0], MT);
const attested = iris.messages[0].message as Hex;

/** Rewrites destinationDomain (bytes 8..12) and destinationCaller (bytes 108..140) of a real message. */
const reroute = (m: Hex, domain: number, caller: Hex): Hex =>
  `0x${m.slice(2, 18)}${domain.toString(16).padStart(8, "0")}${m.slice(26, 218)}${caller.slice(2)}${m.slice(282)}` as Hex;
const hook32 = `0x${"0".repeat(24)}${hook.slice(2).toLowerCase()}` as Hex;

describe("Noren CCTP relay logic", () => {
  it("the staging config is valid and lists Base, Arbitrum and Ethereum Sepolia plus Robinhood", () => {
    validateConfig(config);
    const domains = config.sources.map((s) => s.domain);
    for (const d of [6, 3, 0, 35]) expect(domains).toContain(d);
  });

  it("rejects configs without a hook, with Arc as a source, or duplicate sources", () => {
    expect(() => validateConfig({ ...config, arc: { ...config.arc, hook: "0x0000000000000000000000000000000000000000" } })).toThrow(/Setup required/);
    expect(() => validateConfig({ ...config, sources: [{ key: "arc", chainSelectorName: "arc-testnet", domain: 26 }] })).toThrow(/Arc cannot/);
    expect(() => validateConfig({ ...config, sources: [arb, arb] })).toThrow(/twice/);
  });

  it("decodes the real MessageSent log and refuses other logs", () => {
    expect(parseMessage(logged).sourceDomain).toBe(3);
    expect(() => decodeMessageSent({ ...sent.logs[0], address: "0x0000000000000000000000000000000000000001" }, MT)).toThrow(/not MessageTransmitterV2/);
    expect(() => decodeMessageSent({ ...sent.logs[0], topics: ["0x" + "11".repeat(32)] }, MT)).toThrow(/not MessageSent/);
  });

  it("skips burns that are not to Arc or not for NorenArcHook", () => {
    expect(routeOf(logged, arb, hook)).toMatchObject({ relay: false, reason: "destination domain 2 is not Arc" });
    expect(routeOf(reroute(logged, 26, `0x${"0".repeat(64)}`), arb, hook)).toMatchObject({ relay: false });
    expect(routeOf(reroute(logged, 26, hook32), { ...arb, domain: 6 }, hook)).toMatchObject({ relay: false });
    expect(routeOf("0x1234", arb, hook)).toMatchObject({ relay: false });
    const r = routeOf(reroute(logged, 26, hook32), arb, hook);
    expect(r.relay).toBe(true);
  });

  it("the Iris message is the same burn as the log (Circle fills only nonce, finality, fee, expiry)", () => {
    expect(sameBurn(parseMessage(logged), parseMessage(attested))).toBeNull();
  });

  it("detects an attested message that differs from the log", () => {
    const other = parseMessage(attested);
    expect(sameBurn(parseMessage(logged), { ...other, body: { ...other.body, amount: other.body.amount + 1n } })).toMatch(/amount differs/);
    expect(sameBurn(parseMessage(logged), { ...other, body: { ...other.body, hookData: "0x01" } })).toMatch(/hookData differs/);
    expect(sameBurn(parseMessage(logged), { ...other, body: { ...other.body, feeExecuted: other.body.maxFee + 1n } })).toMatch(/exceeds maxFee/);
  });

  it("maps Iris responses to consensus fields without throwing", () => {
    expect(irisFields(200, iris).state).toBe("complete");
    expect(irisFields(404, { error: "Message not found for provided parameters" }).state).toBe("not-found");
    expect(irisFields(200, { messages: [{ status: "pending_confirmations", attestation: "PENDING" }] })).toMatchObject({ state: "pending", detail: "pending_confirmations" });
    expect(irisFields(500, null).state).toBe("error");
  });

  it("the report decodes back to (message, attestation)", () => {
    const att = iris.messages[0].attestation as Hex;
    const [m, a] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes" }], encodeReport(attested, att));
    expect(m).toBe(attested);
    expect(a).toBe(att);
  });
});
