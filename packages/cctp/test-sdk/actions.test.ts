import { createPublicClient, http, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { norenArcHookAbi } from "../sdk/abi";
import { decodeAction, encodeAction, toBytes32 } from "../sdk/actions";
import { ARC, NOREN_ARC_HOOK } from "../sdk/chains";

const alice = "0x4B2ACf80Bc6E07bbF5690f0710e25C528cb63F80";
const merchant = "0x00000000000000000000000000000000000000aa";

describe("encodeAction (shared Arc action ABI)", () => {
  it("encodes each kind as abi.encode(uint8, address, bytes32, bytes)", () => {
    const inv = decodeAction(encodeAction({ kind: "pay-invoice", merchant, invoiceId: "inv-42" }, alice));
    expect(inv.kind).toBe(1);
    expect(inv.beneficiary).toBe(alice);
    expect(inv.ref).toBe(toBytes32("noren"));
    expect(decodeAction(encodeAction({ kind: "earn-deposit", vault: merchant }, alice)).kind).toBe(2);
    expect(decodeAction(encodeAction({ kind: "aqua-order", order: "0x0102" }, alice)).params).toBe("0x0102");
    expect(decodeAction(encodeAction({ kind: "credit-line", lineId: toBytes32("line"), limitUsdc6: 5_000_000n, expiry: 2_000_000_000 }, alice)).kind).toBe(4);
  });
  it("rejects bad inputs", () => {
    expect(() => encodeAction({ kind: "aqua-order", order: "0x" }, alice)).toThrow();
    expect(() => encodeAction({ kind: "pay-invoice", merchant, invoiceId: "x".repeat(33) }, alice)).toThrow(/32 bytes/);
    expect(() => encodeAction({ kind: "earn-deposit", vault: merchant }, "0x0000000000000000000000000000000000000000")).toThrow(/beneficiary/);
    expect(() => decodeAction(`${encodeAction({ kind: "earn-deposit", vault: merchant }, alice)}00` as Hex)).toThrow();
  });
});

describe("the deployed NorenArcHook on Arc Testnet agrees (live eth_call)", () => {
  const arc = createPublicClient({ transport: http(ARC.rpcUrl) });
  it("validateAction accepts every SDK encoding and names the beneficiary", async () => {
    if (!NOREN_ARC_HOOK) throw new Error("Setup required: NorenArcHook in deployments.json");
    for (const a of [
      encodeAction({ kind: "pay-invoice", merchant, invoiceId: "inv-42" }, alice),
      encodeAction({ kind: "earn-deposit", vault: merchant }, alice),
      encodeAction({ kind: "aqua-order", order: "0x0102030405" }, alice),
      encodeAction({ kind: "credit-line", lineId: toBytes32("line"), limitUsdc6: 5_000_000n, expiry: 2_000_000_000 }, alice),
    ]) {
      const [valid, , beneficiary, reason] = await arc.readContract({ address: NOREN_ARC_HOOK, abi: norenArcHookAbi, functionName: "validateAction", args: [a] });
      expect(reason).toBe("");
      expect(valid).toBe(true);
      expect(beneficiary).toBe(alice);
    }
    const [valid, , , reason] = await arc.readContract({ address: NOREN_ARC_HOOK, abi: norenArcHookAbi, functionName: "validateAction", args: ["0xdeadbeef"] });
    expect(valid).toBe(false);
    expect(reason).toBe("action shorter than 160 bytes");
  });
  it("is wired to Circle's MessageTransmitterV2 on domain 26 and the CRE forwarder", async () => {
    if (!NOREN_ARC_HOOK) throw new Error("Setup required");
    expect(await arc.readContract({ address: NOREN_ARC_HOOK, abi: norenArcHookAbi, functionName: "localDomain" })).toBe(26);
    expect(await arc.readContract({ address: NOREN_ARC_HOOK, abi: norenArcHookAbi, functionName: "forwarder" })).toBe("0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1");
  });
});
