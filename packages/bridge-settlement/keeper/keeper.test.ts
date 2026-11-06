// Calls the live Relay and Across APIs (read-only) for a desk address and checks the calldata
// they return. No mocks: if an API changes its shape, these tests fail.
import { describe, expect, test } from "vitest";
import { encodeAbiParameters, parseAbiParameters, type Address } from "viem";
import { acrossDeposit, checkAcrossCalldata, checkRelayCalldata, meetsMinimum, relayDeposit, USDG, type Approved } from "./lib";

const s: Approved = {
  desk: "0x1111111111111111111111111111111111111111" as Address,
  arcRecipient: "0x90F79bf6EB2c4f870365E785982E1f101E93b906" as Address,
  amountUsdg6: 100_000_000n,
  minOutUsdc6: 99_500_000n,
};

describe("live Relay deposit", () => {
  test("depositErc20 for the desk, USDG, exact amount, meets the minimum", async () => {
    const d = await relayDeposit(s);
    expect(d.to).toBe("0x4cD00E387622C35bDDB9b4c962C136462338BC31");
    expect(d.ref).toMatch(/^0x[0-9a-f]{64}$/);
    expect(() => meetsMinimum(d, s)).not.toThrow();
    expect(() => meetsMinimum(d, { ...s, minOutUsdc6: 100_000_000n })).toThrow("below the approved minimum");
    expect(() => checkRelayCalldata(d.data, { ...s, amountUsdg6: 1n })).toThrow("Relay amount");
  }, 20_000);
});

describe("live Across deposit", () => {
  test("SpokePool.deposit from the desk to the Arc recipient for Arc USDC", async () => {
    const d = await acrossDeposit(s);
    expect(d.to).toBe("0xD29C85F15DF544bA632C9E25829fd29d767d7978");
    expect(d.quotedOutUsdc6 > 99_000_000n).toBe(true);
    expect(() => checkAcrossCalldata(d.data, { ...s, arcRecipient: s.desk })).toThrow("recipient");
  }, 20_000);
});

test("Relay calldata check refuses another depositor", () => {
  const data = `0xe8017952${encodeAbiParameters(parseAbiParameters("address, address, uint256, bytes32"), [s.arcRecipient, USDG, s.amountUsdg6, `0x${"00".repeat(32)}`]).slice(2)}` as const;
  expect(() => checkRelayCalldata(data, s)).toThrow("depositor");
});
