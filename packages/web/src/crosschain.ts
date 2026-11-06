/**
 * Money and orders from other chains into Arc: Circle CCTP V2 (packages/cctp) and Chainlink CCIP (packages/ccip).
 * Both land in the same NorenArcActionRouter on Arc testnet. Everything here is a PUBLIC testnet: the CCTP chains,
 * Circle's Iris sandbox and the Arc testnet router. The recorded runs come from the packages' own fixtures and docs.
 */
import { createPublicClient, http, keccak256, parseAbiItem, toHex, type Address, type Hex, type PublicClient } from "viem";
import { CCTP_CHAINS, SOURCE_CHAINS, type CctpChainKey, type SourceChainKey } from "@noren/cctp";
import liveRuns from "../../cctp/fixtures/live-runs.json";
import ccipDeployments from "../../ccip/deployments.json";

export { CCTP_CHAINS, SOURCE_CHAINS, type CctpChainKey, type SourceChainKey };
export const ARC_TESTNET = CCTP_CHAINS["arc-testnet"];
export const ACTION_ROUTER = (ccipDeployments as Record<string, { NorenArcActionRouter?: string; deployTxs?: Record<string, string> }>)["5042002"].NorenArcActionRouter as Address;
const ROUTER_DEPLOY_TX = (ccipDeployments as Record<string, { deployTxs?: Record<string, string> }>)["5042002"].deployTxs?.NorenArcActionRouter as Hex;

/** The chain's logo in public/logos when one exists; the rest draw as initials (never an invented logo). */
export const CHAIN_MARK: Record<CctpChainKey, string> = {
  "ethereum-sepolia": "ETH", "base-sepolia": "Base", "arbitrum-sepolia": "Arbitrum", "op-sepolia": "OP", "avalanche-fuji": "Avalanche",
  "polygon-amoy": "Polygon", "unichain-sepolia": "Unichain", "linea-sepolia": "Linea", "worldchain-sepolia": "WORLD", "robinhood-testnet": "ROBINHOOD", "arc-testnet": "ARC",
};
/** Short names for tight rows ("Base Sepolia" → "Base"). */
export const shortChain = (k: CctpChainKey) => CCTP_CHAINS[k].name.replace(/ (Sepolia|Testnet|Fuji|Amoy)$/, "").replace(/^Robinhood Chain$/, "Robinhood");

export const explorerTx = (k: CctpChainKey, hash: string) => `${CCTP_CHAINS[k].explorer}/tx/${hash}`;
export const ccipMsgUrl = (id: string) => `https://ccip.chain.link/msg/${id}`;

/* ------------------------------------------------------------------ recorded live runs */

const byChainId = (id: number) => Object.values(CCTP_CHAINS).find((c) => c.chainId === id)!;
const hashOf = (url: string) => /0x[0-9a-fA-F]{64}/.exec(url)?.[0] ?? "";
export type CctpRun = { from: CctpChainKey; to: CctpChainKey; kind: string; amount: bigint; minted: bigint; burnTx: string; mintTx: string; events: string[] };
type RawRun = { network: string; kind: string; amountUsdc6: string; mintedUsdc6: string; burnTx: string; mintTx: string; events?: string[] };
/** Every CCTP V2 transfer Noren ran on public testnets (packages/cctp/fixtures/live-runs.json). */
export const CCTP_RUNS: CctpRun[] = (liveRuns as { runs: RawRun[] }).runs.map((r) => {
  const ids = [...r.network.matchAll(/\((\d+), (?:CCTP )?domain/g)].map((m) => Number(m[1]));
  return { from: byChainId(ids[0]).key, to: byChainId(ids[1]).key, kind: r.kind, amount: BigInt(r.amountUsdc6), minted: BigInt(r.mintedUsdc6), burnTx: hashOf(r.burnTx), mintTx: hashOf(r.mintTx), events: r.events ?? [] };
});
/** What a recorded run did on Arc, from its events (a PAY_INVOICE through hook v1 had no router, so no InvoicePaid). */
export const runLabel = (r: CctpRun) => r.kind === "pay-invoice" ? (r.events.includes("InvoicePaid") ? "Invoice paid on arrival" : "Invoice hook v1: USDC to the beneficiary") : (KIND_LABEL[r.kind] ?? r.kind);
export const KIND_LABEL: Record<string, string> = { plain: "USDC to a wallet", "pay-invoice": "Invoice paid on arrival", "aqua-order": "Aqua order opened", "earn-deposit": "Earn deposit", "credit-line": "Credit line", "pay-on-credit": "Paid on credit" };

/** Chainlink CCIP messages Noren sent on public testnets (docs/CCIP.md, Live runs). Status is read from ccip.chain.link. */
export const CCIP_MESSAGES: { id: Hex; route: string; action: string; from: CctpChainKey; sendTx?: Hex }[] = [
  { id: "0x8dc21f93991c32eb1319f9ce95907708c3fa7a27d577fe5b460e5bcc61639ceb", route: "Arc → Base Sepolia", action: "AQUA_ORDER probe", from: "arc-testnet", sendTx: "0x6131993bf7307dc79f74ed6214b148d3387b03816e1526dfa76d78fc339b1a25" },
  { id: "0xc54e5cf92c21ef23e7784dd1148e48a91b75eb9a0ff2bc52ab6d4de80664d504", route: "Base Sepolia → Arc", action: "CREDIT_LINE, 1 USDC", from: "base-sepolia", sendTx: "0x5bfb5ec70d34f079924654a3906863750cca2c78bb8438a7364a2aa058203dd7" },
  { id: "0x8bf11c2010e50817e88d2c61a896dbcffde95af5352cda9b0c342f073bac477d", route: "Robinhood → Base hub → Arc", action: "CREDIT_LINE update, 2 USDC", from: "robinhood-testnet", sendTx: "0x2b53e19627fc6e0f1821ef4b73b569ed45e8a19888c43207142c451b2293c715" },
  { id: "0x5b04344b6baea78121553f912df5dc3e959e320df7712ca4d82a5763559df93d", route: "Robinhood → Base hub → Arc", action: "PAY_ON_CREDIT, 0.25 USDC", from: "robinhood-testnet", sendTx: "0x7ea8005fe373718ec5608b33944a2b3dc1e65aaae9c6e4cfa4fb1a89f6078ed1" },
  { id: "0x3414a5d397f5c4222aa8a30bc75c085b53127533b62376dc132923b6ec2df1a4", route: "Ethereum Sepolia → Arc", action: "PAY_ON_CREDIT, 0.10 USDC", from: "ethereum-sepolia" },
];

/* ------------------------------------------------------------------ live reads */

const clients = new Map<string, PublicClient>();
export function publicFor(k: CctpChainKey): PublicClient {
  let c = clients.get(k);
  if (!c) { c = createPublicClient({ transport: http(CCTP_CHAINS[k].rpcUrl, { timeout: 20_000, retryCount: 1 }) }) as PublicClient; clients.set(k, c); }
  return c;
}

const usdcAbi = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }] as const;
/** USDC (6 dp) and native gas this address holds on a public testnet. */
export async function balancesOn(k: CctpChainKey, who: Address) {
  const c = publicFor(k);
  const [usdc, gas] = await Promise.all([c.readContract({ address: CCTP_CHAINS[k].usdc, abi: usdcAbi, functionName: "balanceOf", args: [who] }), c.getBalance({ address: who })]);
  return { usdc, gas };
}

const invoicePaid = parseAbiItem("event InvoicePaid(bytes32 indexed invoiceId, address indexed merchant, address indexed payer, uint256 amount, bytes32 rail, uint64 source, bool onCredit)");
export type CrossChainPayment = { invoiceId: Hex; payer: Address; amount: bigint; rail: "CCTP" | "CCIP" | "other"; from: CctpChainKey | null; fromLabel: string; onCredit: boolean; tx: Hex; block: bigint };

/** CCIP chain selectors Noren deployed on (packages/ccip/sdk/chains.ts). */
const CCIP_SELECTORS: Record<string, CctpChainKey> = { "3034092155422581607": "arc-testnet", "2032988798112970440": "robinhood-testnet", "10344971235874465080": "base-sepolia", "16015286601757825753": "ethereum-sepolia" };
let routerFrom: Promise<bigint> | null = null;

/**
 * InvoicePaid on the live NorenArcActionRouter for one merchant: payments that arrived from another chain over CCTP
 * (source = CCTP domain) or CCIP (source = chain selector). Scans newest-first in 10k-block windows.
 */
export async function crossChainPayments(merchant: Address, opts: { maxWindows?: number } = {}): Promise<CrossChainPayment[]> {
  const arc = publicFor("arc-testnet");
  routerFrom ??= arc.getTransactionReceipt({ hash: ROUTER_DEPLOY_TX }).then((r) => r.blockNumber);
  const floor = await routerFrom;
  const cctp = keccak256(toHex("CCTP")), ccip = keccak256(toHex("CCIP"));
  const out: CrossChainPayment[] = [];
  const step = 10_000n;
  let windows = 0;
  for (let hi = await arc.getBlockNumber(); hi >= floor && windows < (opts.maxWindows ?? 40); hi -= step, windows++) {
    const lo = hi - step + 1n > floor ? hi - step + 1n : floor;
    const logs = await arc.getLogs({ address: ACTION_ROUTER, event: invoicePaid, args: { merchant }, fromBlock: lo, toBlock: hi });
    for (const l of logs.reverse()) {
      const a = l.args as { invoiceId: Hex; payer: Address; amount: bigint; rail: Hex; source: bigint; onCredit: boolean };
      const rail = a.rail === cctp ? "CCTP" : a.rail === ccip ? "CCIP" : "other";
      const from = rail === "CCTP" ? (Object.values(CCTP_CHAINS).find((c) => BigInt(c.domain) === a.source)?.key ?? null) : rail === "CCIP" ? (CCIP_SELECTORS[a.source.toString()] ?? null) : null;
      out.push({ invoiceId: a.invoiceId, payer: a.payer, amount: a.amount, rail, from, fromLabel: from ? CCTP_CHAINS[from].name : `${rail} source ${a.source}`, onCredit: a.onCredit, tx: l.transactionHash!, block: l.blockNumber! });
    }
    if (lo === floor) break;
  }
  return out;
}
