// Keeper side of the settlement desk: fetch fresh deposit calldata from the real Relay and Across
// APIs for an approved settlement, refuse it unless it meets the approved minimum, then send
// NorenSettlementDesk.executeSettlement. Read-only HTTP; the only write is to the chain you point it at.
import { decodeAbiParameters, getAddress, parseAbi, parseAbiParameters, type Address, type Hex } from "viem";

export const USDG: Address = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
export const ARC_USDC: Address = "0x3600000000000000000000000000000000000000";
export const RELAY_DEPOSITORY: Address = "0x4cD00E387622C35bDDB9b4c962C136462338BC31";
export const ACROSS_SPOKE_POOL: Address = "0xD29C85F15DF544bA632C9E25829fd29d767d7978";
export const ROBINHOOD = 4663;
export const ARC = 5042;
export const RELAY_QUOTE_URL = "https://api.relay.link/quote";
export const ACROSS_SWAP_URL = "https://app.across.to/api/swap/approval";

export const deskAbi = parseAbi([
  "struct Settlement { address merchant; uint64 requestedAt; uint16 maxSlippageBps; uint8 status; uint8 route; address arcRecipient; uint64 validUntil; uint256 amountUsdg6; uint256 minOutUsdc6; uint256 quotedOutUsdc6; }",
  "function settlement(bytes32 id) view returns (Settlement)",
  "function executeSettlement(bytes32 id, uint8 route, bytes data)",
  "event SettlementExecuted(bytes32 indexed id, uint8 route, address target, bytes32 orderRef, uint256 minOutUsdc6)",
]);

export type Approved = { desk: Address; arcRecipient: Address; amountUsdg6: bigint; minOutUsdc6: bigint };
export type Deposit = { route: "relay" | "across"; to: Address; data: Hex; quotedOutUsdc6: bigint; seconds: number; ref: string; feeUsd?: string };

/** Fresh Relay quote for the desk as depositor; returns the depositErc20 calldata. */
export async function relayDeposit(s: Approved, fetchImpl: typeof fetch = fetch): Promise<Deposit> {
  const res = await fetchImpl(RELAY_QUOTE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      user: s.desk, recipient: s.arcRecipient, originChainId: ROBINHOOD, destinationChainId: ARC,
      originCurrency: USDG, destinationCurrency: ARC_USDC, amount: s.amountUsdg6.toString(), tradeType: "EXACT_INPUT",
    }),
  });
  const q = await res.json() as {
    message?: string;
    steps?: { id: string; requestId?: string; items: { data: { to: string; data: Hex; chainId: number; value?: string } }[] }[];
    details?: { currencyOut?: { amount?: string }; timeEstimate?: number };
    fees?: { relayer?: { amountUsd?: string } };
  };
  if (res.status !== 200 || !q.steps) throw new Error(`Relay quote failed: HTTP ${res.status} ${q.message ?? ""}`);
  const step = q.steps.find((x) => x.id === "deposit");
  const tx = step?.items[0]?.data;
  if (!tx) throw new Error("Relay quote has no deposit step");
  if (tx.chainId !== ROBINHOOD || getAddress(tx.to) !== RELAY_DEPOSITORY) throw new Error(`Relay deposit target ${tx.to} on ${tx.chainId} is not the Depository on Robinhood`);
  checkRelayCalldata(tx.data, s);
  const out = BigInt(q.details?.currencyOut?.amount ?? "0");
  return { route: "relay", to: RELAY_DEPOSITORY, data: tx.data, quotedOutUsdc6: out, seconds: q.details?.timeEstimate ?? 0, ref: step?.requestId ?? "", feeUsd: q.fees?.relayer?.amountUsd };
}

export function checkRelayCalldata(data: Hex, s: Approved): void {
  if (!data.startsWith("0xe8017952") || data.length !== 2 + 8 + 64 * 4) throw new Error("Relay calldata is not depositErc20");
  const [depositor, token, amount] = decodeAbiParameters(parseAbiParameters("address, address, uint256, bytes32"), `0x${data.slice(10)}`);
  if (getAddress(depositor) !== getAddress(s.desk)) throw new Error(`Relay depositor ${depositor} is not the desk`);
  if (getAddress(token) !== USDG) throw new Error("Relay token is not USDG");
  if (amount !== s.amountUsdg6) throw new Error(`Relay amount ${amount} != ${s.amountUsdg6}`);
}

/** Fresh Across deposit for the desk as depositor and the Arc recipient. */
export async function acrossDeposit(s: Approved, fetchImpl: typeof fetch = fetch): Promise<Deposit> {
  const url = `${ACROSS_SWAP_URL}?tradeType=exactInput&amount=${s.amountUsdg6}&inputToken=${USDG}&originChainId=${ROBINHOOD}` +
    `&outputToken=${ARC_USDC}&destinationChainId=${ARC}&depositor=${s.desk}&recipient=${s.arcRecipient}`;
  const res = await fetchImpl(url);
  const q = await res.json() as { message?: string; swapTx?: { to: string; data: Hex; chainId: number }; expectedOutputAmount?: string; minOutputAmount?: string; expectedFillTime?: number; fees?: { amountUsd?: string } };
  if (res.status !== 200 || !q.swapTx) throw new Error(`Across swap/approval failed: HTTP ${res.status} ${q.message ?? ""}`);
  if (q.swapTx.chainId !== ROBINHOOD || getAddress(q.swapTx.to) !== ACROSS_SPOKE_POOL) throw new Error(`Across target ${q.swapTx.to} is not the SpokePool on Robinhood`);
  const out = checkAcrossCalldata(q.swapTx.data, s);
  return { route: "across", to: ACROSS_SPOKE_POOL, data: q.swapTx.data, quotedOutUsdc6: out, seconds: q.expectedFillTime ?? 0, ref: "", feeUsd: q.fees?.amountUsd };
}

export function checkAcrossCalldata(data: Hex, s: Approved): bigint {
  if (!data.startsWith("0xad5425c6")) throw new Error("Across calldata is not SpokePool.deposit");
  const [depositor, recipient, inputToken, outputToken, inputAmount, outputAmount, dest] = decodeAbiParameters(
    parseAbiParameters("bytes32, bytes32, bytes32, bytes32, uint256, uint256, uint256, bytes32, uint32, uint32, uint32, bytes"),
    `0x${data.slice(10)}`,
  );
  const addr = (b: Hex) => getAddress(`0x${b.slice(26)}`);
  if (addr(depositor) !== getAddress(s.desk)) throw new Error("Across depositor is not the desk");
  if (addr(recipient) !== getAddress(s.arcRecipient)) throw new Error("Across recipient is not the Arc recipient");
  if (addr(inputToken) !== USDG || addr(outputToken) !== ARC_USDC) throw new Error("Across tokens are not USDG -> Arc USDC");
  if (inputAmount !== s.amountUsdg6) throw new Error(`Across amount ${inputAmount} != ${s.amountUsdg6}`);
  if (dest !== BigInt(ARC)) throw new Error(`Across destination ${dest} is not Arc`);
  return outputAmount;
}

/** The keeper's own gate, before the desk's on-chain checks: never send below the approved minimum. */
export function meetsMinimum(d: Deposit, s: Approved): void {
  if (d.quotedOutUsdc6 < s.minOutUsdc6) {
    throw new Error(`fresh ${d.route} quote ${d.quotedOutUsdc6} USDC6 is below the approved minimum ${s.minOutUsdc6}; not executing (ask the merchant to retry)`);
  }
}
