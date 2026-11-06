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

/**
 * Chainlink CCIP messages Noren sent on public testnets (docs/CCIP.md, Live runs). All delivered. Messages into Arc carry
 * instructions only: no CCIP lane carries USDC into Arc, so the value comes from Noren's Arc liquidity or from CCTP.
 */
export const CCIP_MESSAGES: { id: Hex; route: string; action: string; from: CctpChainKey; arcTx?: Hex }[] = [
  { id: "0xc54e5cf92c21ef23e7784dd1148e48a91b75eb9a0ff2bc52ab6d4de80664d504", route: "Base Sepolia → Arc", action: "CREDIT_LINE opened, 1 USDC", from: "base-sepolia", arcTx: "0x7033c22339b8a4dc77c72151cd23a273caa46da19fd0d58a85863035d57e50a2" },
  { id: "0x3414a5d397f5c4222aa8a30bc75c085b53127533b62376dc132923b6ec2df1a4", route: "Ethereum Sepolia → Arc", action: "PAY_ON_CREDIT 0.10 USDC (out of order, retried)", from: "ethereum-sepolia", arcTx: "0x78d3a38fd41c1c2b9bee066a94ad2c83837203cd5b00b9e0bd001155edc7d7ec" },
  { id: "0x8bf11c2010e50817e88d2c61a896dbcffde95af5352cda9b0c342f073bac477d", route: "Robinhood → Base hub → Arc", action: "CREDIT_LINE update, 2 USDC", from: "robinhood-testnet", arcTx: "0xf55345779ffe0773f35f63ce45889a490bf90857253d8a4cfa2124b9e442b619" },
  { id: "0x5b04344b6baea78121553f912df5dc3e959e320df7712ca4d82a5763559df93d", route: "Robinhood → Base hub → Arc", action: "PAY_ON_CREDIT 0.25 USDC", from: "robinhood-testnet", arcTx: "0x98a71c16434fbfe30dee4afcbcab6f21ac000b40b22a5b7a65c4d36806e3d867" },
  { id: "0x56603748215991241c874b9dc17bc44e0dce534ed0f0fb7746e79922b4541009", route: "Arc → Base hub → Robinhood", action: "LINE_REPORT back to Robinhood", from: "arc-testnet" },
  { id: "0x8dc21f93991c32eb1319f9ce95907708c3fa7a27d577fe5b460e5bcc61639ceb", route: "Arc → Base Sepolia", action: "AQUA_ORDER probe", from: "arc-testnet" },
  { id: "0xff21b3a60d9d5592c5316a3b288acd0a08a0c8aa73774bf67b72be18026c728e", route: "Robinhood → Ethereum Sepolia", action: "1 CCIP-BnM + action (manual execution)", from: "robinhood-testnet" },
];

/** 1inch Aqua live on Arc testnet (docs/AQUA-LIVE.md): official Aqua v1.0.0 at its own address, fills from other chains. */
export const AQUA_LIVE = {
  aqua: "0x550CD499f1E2da71527f14d6469364461966895B" as Address,
  router: "0x8717687866f988EEBe3bd1d8999DF820ffD9e295" as Address,
  settler: "0xd9f90e397770faf66b228344af5fe285b349d016" as Address,
  directSwap: "0xc7dfd9119afe91a1f77cb253d1ae9f75420ccd65e61fcba55dbe10ac21d96cd8" as Hex,
  fills: [
    { from: "arbitrum-sepolia" as CctpChainKey, burn: "0xf302af9144e518322dfa2112f8a6173e1278826e9ae56a803ebd936303556a21" as Hex, mint: "0x36e932240b6b3ad35fcad9e2a3772ea39ed41c2e3177bd6079c5bef7137895ae" as Hex, fill: "0xe6dab62029db1e6924cb6ff6e229248e7bbb29d6863c2157fdb0a9dd01568dd7" as Hex },
    { from: "ethereum-sepolia" as CctpChainKey, burn: "0xd551e5f5ba4baf7fc04675d6a911f44c39644ce7b6440bd6690462ca31bfe0e2" as Hex, mint: "0xc4d1c483154c875e08c76253fe04d2e39450e57a18496f077a8440882c4e870d" as Hex, fill: "0x243cc90eed57c6273fc790d91e73ec5af25bd29a0c3d38c20c0bbd26f955dd93" as Hex },
  ],
};

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
/** Per-merchant results already read, and the last block they cover: a refresh only reads the blocks after it. */
const scanned = new Map<string, { to: bigint; rows: CrossChainPayment[] }>();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rpcCode = (e: unknown) => { for (let c = e as { code?: number; cause?: unknown } | undefined, i = 0; c && i < 6; c = c.cause as typeof c, i++) if (typeof c.code === "number") return c.code; return undefined; };

/**
 * eth_getLogs over [from, to] in windows (10k blocks, newest first). The public Arc testnet RPC answers -32005 ("rate
 * limit exceeded", which viem reports as "Request exceeds defined limit") when called too fast, and -32012 ("requested
 * range too large") on busy ranges: the first is retried with backoff, the second halves the window.
 */
async function logsInWindows<T>(read: (lo: bigint, hi: bigint) => Promise<T[]>, from: bigint, to: bigint, step = 10_000n): Promise<T[]> {
  const out: T[] = [];
  for (let hi = to; hi >= from;) {
    const lo = hi - step + 1n > from ? hi - step + 1n : from;
    let logs: T[] | null = null;
    for (let attempt = 0; logs === null; attempt++) {
      try { logs = await read(lo, hi); }
      catch (e) {
        const code = rpcCode(e);
        if (code === -32012 && step > 500n) { step /= 2n; break; }
        if (code === -32005 && attempt < 5) { await wait(400 * 2 ** attempt); continue; }
        throw e;
      }
    }
    if (logs === null) continue; // window shrank: retry the same hi with the smaller step
    out.push(...logs.reverse());
    if (lo === from) break;
    hi = lo - 1n;
    await wait(120); // stay under the public RPC's request rate
  }
  return out;
}

/**
 * InvoicePaid on the live NorenArcActionRouter for one merchant: payments that arrived from another chain over CCTP
 * (source = CCTP domain) or CCIP (source = chain selector). Reads from the router's deploy block in 10k-block windows,
 * then caches, so a refresh reads only new blocks.
 */
export async function crossChainPayments(merchant: Address): Promise<CrossChainPayment[]> {
  const arc = publicFor("arc-testnet");
  routerFrom ??= arc.getTransactionReceipt({ hash: ROUTER_DEPLOY_TX }).then((r) => r.blockNumber).catch((e) => { routerFrom = null; throw e; });
  const floor = await routerFrom;
  const key = merchant.toLowerCase(), prev = scanned.get(key);
  const head = await arc.getBlockNumber();
  const from = prev ? prev.to + 1n : floor;
  if (prev && from > head) return prev.rows;
  const cctp = keccak256(toHex("CCTP")), ccip = keccak256(toHex("CCIP"));
  const logs = await logsInWindows((lo, hi) => arc.getLogs({ address: ACTION_ROUTER, event: invoicePaid, args: { merchant }, fromBlock: lo, toBlock: hi }), from, head);
  const fresh = logs.map((l): CrossChainPayment => {
    const a = l.args as { invoiceId: Hex; payer: Address; amount: bigint; rail: Hex; source: bigint; onCredit: boolean };
    const rail = a.rail === cctp ? "CCTP" : a.rail === ccip ? "CCIP" : "other";
    const src = rail === "CCTP" ? (Object.values(CCTP_CHAINS).find((c) => BigInt(c.domain) === a.source)?.key ?? null) : rail === "CCIP" ? (CCIP_SELECTORS[a.source.toString()] ?? null) : null;
    return { invoiceId: a.invoiceId, payer: a.payer, amount: a.amount, rail, from: src, fromLabel: src ? CCTP_CHAINS[src].name : `${rail} source ${a.source}`, onCredit: a.onCredit, tx: l.transactionHash!, block: l.blockNumber! };
  });
  const rows = [...fresh, ...(prev?.rows ?? [])];
  scanned.set(key, { to: head, rows });
  return rows;
}
