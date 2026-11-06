import { createPublicClient, http, zeroHash, type Hex } from "viem";
import { gatewayAbi, hubAbi, GatewayStatus, ForwardStatus } from "./abi.ts";
import { CHAINS, HUB, ccipExplorerUrl, chainBySelector, routeOf, viemChain, type ChainKey } from "./chains.ts";
import { NorenCcipError } from "./send.ts";

export const CCIP_API = "https://api.ccip.chain.link/v2";

/** The fields Noren uses from GET https://api.ccip.chain.link/v2/messages/{messageId}. */
export type CcipApiMessage = {
  messageId: Hex;
  status: string; // SENT | COMMITTED | BLESSED | VERIFIED | SUCCESS | FAILED | ...
  sourceSelector: bigint;
  destSelector: bigint;
  sender: string;
  receiver: string;
  sendTransactionHash?: Hex;
  receiptTransactionHash?: Hex;
  readyForManualExecution: boolean;
  sendTimestamp?: string;
  receiptTimestamp?: string;
};

/** Reads one message from Chainlink's CCIP API. Returns null while the API has not indexed it yet. */
export async function getCcipMessage(messageId: Hex, fetchImpl: typeof fetch = fetch): Promise<CcipApiMessage | null> {
  const res = await fetchImpl(`${CCIP_API}/messages/${messageId}`, { headers: { accept: "application/json" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new NorenCcipError(`CCIP API ${res.status} for ${messageId}: ${await res.text()}`);
  const j = (await res.json()) as Record<string, any>;
  return {
    messageId: j.messageId,
    status: j.status,
    sourceSelector: BigInt(j.sourceNetworkInfo?.chainSelector ?? 0),
    destSelector: BigInt(j.destNetworkInfo?.chainSelector ?? 0),
    sender: j.sender,
    receiver: j.receiver,
    sendTransactionHash: j.sendTransactionHash ?? undefined,
    receiptTransactionHash: j.receiptTransactionHash ?? undefined,
    readyForManualExecution: Boolean(j.readyForManualExecution),
    sendTimestamp: j.sendTimestamp,
    receiptTimestamp: j.receiptTimestamp,
  };
}

export type Hop = {
  from: ChainKey;
  to: ChainKey;
  messageId?: Hex;
  ccipStatus: string; // CCIP API status, "NOT_SENT" when the hub has not forwarded yet
  explorer?: string;
  sendTx?: Hex;
  receiptTx?: Hex;
  readyForManualExecution?: boolean;
  /** Hub only: NONE | FORWARDED | PENDING (PENDING = anyone can call retryForward). */
  hubForward?: (typeof ForwardStatus)[number];
};

export type Journey = {
  hops: Hop[];
  /** Noren-level outcome on the destination gateway: NONE | DELIVERED | FAILED | RECOVERED. */
  final: (typeof GatewayStatus)[number];
  done: boolean;
};

/**
 * Follows a Noren message across every hop: the CCIP API status of each hop, the hub's forward (read on-chain from
 * NorenCcipHub.forwardedAs) and the destination gateway's delivery status.
 */
export async function trackJourney(firstMessageId: Hex, from: ChainKey, to: ChainKey, fetchImpl: typeof fetch = fetch): Promise<Journey> {
  const route = routeOf(from, to);
  const hops: Hop[] = [];
  let id: Hex | undefined = firstMessageId;
  for (let i = 0; i < route.length - 1; i++) {
    const hop: Hop = { from: route[i], to: route[i + 1], ccipStatus: "NOT_SENT" };
    if (id) {
      hop.messageId = id;
      hop.explorer = ccipExplorerUrl(id);
      const m = await getCcipMessage(id, fetchImpl);
      hop.ccipStatus = m?.status ?? "NOT_INDEXED";
      hop.sendTx = m?.sendTransactionHash;
      hop.receiptTx = m?.receiptTransactionHash;
      hop.readyForManualExecution = m?.readyForManualExecution;
      if (m && chainBySelector(m.destSelector)?.key !== route[i + 1]) {
        throw new NorenCcipError(`message ${id} goes to selector ${m.destSelector}, expected ${route[i + 1]}`);
      }
    }
    hops.push(hop);
    if (route[i + 1] === HUB && i + 1 < route.length - 1) {
      // Hub hop: the next messageId comes from NorenCcipHub.forwardedAs(inboundId).
      const hub = CHAINS[HUB];
      if (!hub.hub) throw new NorenCcipError("Setup required: no NorenCcipHub deployed on Base Sepolia");
      const pub = createPublicClient({ chain: viemChain(hub), transport: http(hub.rpcUrl) });
      if (id && hop.ccipStatus === "SUCCESS") {
        const st = await pub.readContract({ address: hub.hub, abi: hubAbi, functionName: "forwardStatus", args: [id] });
        hop.hubForward = ForwardStatus[st];
        const out: Hex = await pub.readContract({ address: hub.hub, abi: hubAbi, functionName: "forwardedAs", args: [id] });
        id = out === zeroHash ? undefined : out;
      } else {
        id = undefined;
      }
    }
  }
  const last = hops[hops.length - 1];
  let final: Journey["final"] = "NONE";
  const dst = CHAINS[to];
  if (last.messageId && last.ccipStatus === "SUCCESS" && dst.gateway) {
    const pub = createPublicClient({ chain: viemChain(dst), transport: http(dst.rpcUrl) });
    final = GatewayStatus[await pub.readContract({ address: dst.gateway, abi: gatewayAbi, functionName: "statusOf", args: [last.messageId] })];
  }
  return { hops, final, done: final === "DELIVERED" || final === "RECOVERED" };
}
