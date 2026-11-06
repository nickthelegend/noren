import { describe, expect, it } from "vitest";
import {
  ActionKind,
  RAIL_CCIP,
  RAIL_CCTP,
  aquaOrder,
  creditLine,
  decodeAction,
  decodeEnvelope,
  encodeEnvelope,
  payOnCredit,
  shield,
  SNARK_SCALAR_FIELD,
} from "../sdk/action.ts";
import { CHAINS, hasDirectLane, routeOf } from "../sdk/chains.ts";

const LINE = "0x0b4322a18fbe7d9cf4e50a027a3f771fb454931671bc287fae07034fb904a38c";
const INVOICE = "0xfeedfe09c75cd20cb9bca1d6deeaa6c5c3a9f3f3ac9b496a9a4ce42efed687ba";
// `cast abi-encode` (Solidity ABI) of the PAY_ON_CREDIT payload sent live from Robinhood on Nov 6 2026.
const SOLIDITY_VECTOR =
  "0x00000000000000000000000000000000000000000000000000000000000000050000000000000000000000004b2acf80bc6e07bbf5690f0710e25c528cb63f80feedfe09c75cd20cb9bca1d6deeaa6c5c3a9f3f3ac9b496a9a4ce42efed687ba000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000800b4322a18fbe7d9cf4e50a027a3f771fb454931671bc287fae07034fb904a38c000000000000000000000000b593984447db7acc5221a6df2827ac0c9cf7d96efeedfe09c75cd20cb9bca1d6deeaa6c5c3a9f3f3ac9b496a9a4ce42efed687ba000000000000000000000000000000000000000000000000000000000003d090";

describe("Noren action ABI", () => {
  it("payOnCredit matches the Solidity encoding byte for byte", () => {
    const hex = payOnCredit({
      borrower: "0x4B2ACf80Bc6E07bbF5690f0710e25C528cb63F80",
      lineId: LINE,
      merchant: "0xB593984447dB7AcC5221a6df2827aC0C9cf7d96E",
      invoiceId: INVOICE,
      amountUsdc6: 250_000n,
    });
    expect(hex).toBe(SOLIDITY_VECTOR);
    const a = decodeAction(hex);
    expect(a.kind).toBe(ActionKind.PAY_ON_CREDIT);
    expect(a.ref).toBe(INVOICE);
  });

  it("shield matches the Solidity encoding and rejects non-field precommitments", () => {
    // cast abi-encode "f(uint8,address,bytes32,bytes)" 7 <beneficiary> keccak256("noren-shield") abi.encode(uint256(123456789))
    const hex = shield({ beneficiary: "0x4B2ACf80Bc6E07bbF5690f0710e25C528cb63F80", precommitment: 123456789n });
    expect(hex).toBe("0x00000000000000000000000000000000000000000000000000000000000000070000000000000000000000004b2acf80bc6e07bbf5690f0710e25c528cb63f80eae8be53a47541e72362bfd94d76ab05c65e10646a06378e38bc3b29bdb8caca0000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000075bcd15");
    expect(decodeAction(hex).kind).toBe(ActionKind.SHIELD);
    expect(() => shield({ beneficiary: "0x4B2ACf80Bc6E07bbF5690f0710e25C528cb63F80", precommitment: 0n })).toThrow(/field element/);
    expect(() => shield({ beneficiary: "0x4B2ACf80Bc6E07bbF5690f0710e25C528cb63F80", precommitment: SNARK_SCALAR_FIELD })).toThrow(/field element/);
  });

  it("round-trips credit lines and Aqua orders", () => {
    const line = decodeAction(
      creditLine({ borrower: "0x0000000000000000000000000000000000000001", lineId: `0x${"11".repeat(32)}`, limitUsdc6: 5n, expiry: 9n, asOf: 2n }),
    );
    expect(line.kind).toBe(ActionKind.CREDIT_LINE);
    const order = decodeAction(aquaOrder({ beneficiary: "0x0000000000000000000000000000000000000002", ref: `0x${"22".repeat(32)}`, order: "0xc0ffee" }));
    expect(order.params).toBe("0xc0ffee");
  });

  it("rail ids are keccak256 of the rail name, as in NorenArcAction.sol", () => {
    expect(RAIL_CCIP).toBe("0x5fa42365004d29017b6e1fff462c90ecf163a6f09987e7af7e4b8c324fc7cc5f");
    expect(RAIL_CCTP).toBe("0xb15c6f4cb2704b59886404596581f035599143a4de893556943a4865c51863a5");
  });

  it("envelope round-trips", () => {
    const e = {
      version: 1,
      originChain: CHAINS.robinhood.selector,
      originSender: "0x4B2ACf80Bc6E07bbF5690f0710e25C528cb63F80" as const,
      nonce: 2n,
      finalChain: CHAINS.arc.selector,
      finalReceiver: "0x55005e60b4d4Bed4156BC635B1342bC55d9B6247" as const,
      prevMessageId: `0x${"ab".repeat(32)}` as const,
      payload: SOLIDITY_VECTOR as `0x${string}`,
    };
    expect(decodeEnvelope(encodeEnvelope(e))).toEqual(e);
  });
});

describe("routes", () => {
  it("Robinhood and Arc go through the Base Sepolia hub; Sepolia and Base reach Arc directly", () => {
    expect(hasDirectLane("robinhood", "arc")).toBe(false);
    expect(routeOf("robinhood", "arc")).toEqual(["robinhood", "baseSepolia", "arc"]);
    expect(routeOf("arc", "robinhood")).toEqual(["arc", "baseSepolia", "robinhood"]);
    expect(routeOf("sepolia", "arc")).toEqual(["sepolia", "arc"]);
    expect(routeOf("baseSepolia", "arc")).toEqual(["baseSepolia", "arc"]);
  });

  it("every chain has a gateway recorded in deployments.json", () => {
    for (const c of Object.values(CHAINS)) expect(c.gateway, c.name).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(CHAINS.baseSepolia.hub).toMatch(/^0x/);
    expect(CHAINS.arc.actionRouter).toMatch(/^0x/);
  });
});
