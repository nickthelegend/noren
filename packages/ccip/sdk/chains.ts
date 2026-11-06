import type { Address, Chain } from "viem";
import deployments from "../deployments.json" with { type: "json" };

/** A chain Noren's CCIP rail touches. Selectors and routers come from Chainlink's CCIP directory API. */
export type NorenCcipChain = {
  key: ChainKey;
  chainId: number;
  name: string;
  selector: bigint;
  router: Address;
  rpcUrl: string;
  explorer: string;
  /** NorenCcipGateway on this chain (undefined until deployed). */
  gateway?: Address;
  /** NorenCcipHub (Base Sepolia only). */
  hub?: Address;
  /** NorenArcActionRouter (Arc only). */
  actionRouter?: Address;
  /** NorenCcipInbox (Robinhood only). */
  inbox?: Address;
  nativeSymbol: string;
};

export type ChainKey = "arc" | "robinhood" | "baseSepolia" | "sepolia";

const d = deployments as unknown as Record<string, Record<string, unknown>>;
const addr = (chainId: number, name: string) => (d[String(chainId)]?.[name] as Address | undefined) ?? undefined;

export const CHAINS: Record<ChainKey, NorenCcipChain> = {
  arc: {
    key: "arc",
    chainId: 5042002,
    name: "Arc Testnet",
    selector: 3034092155422581607n,
    router: "0xdE4E7FED43FAC37EB21aA0643d9852f75332eab8",
    rpcUrl: "https://rpc.testnet.arc.io",
    explorer: "https://explorer.testnet.arc.io",
    gateway: addr(5042002, "NorenCcipGateway"),
    actionRouter: addr(5042002, "NorenArcActionRouter"),
    nativeSymbol: "USDC",
  },
  robinhood: {
    key: "robinhood",
    chainId: 46630,
    name: "Robinhood Chain Testnet",
    selector: 2032988798112970440n,
    router: "0x30D197C6F5bE050D5525dD94d01760FaCdB67e7C",
    rpcUrl: "https://rpc.testnet.chain.robinhood.com",
    explorer: "https://explorer.testnet.chain.robinhood.com",
    gateway: addr(46630, "NorenCcipGateway"),
    inbox: addr(46630, "NorenCcipInbox"),
    nativeSymbol: "ETH",
  },
  baseSepolia: {
    key: "baseSepolia",
    chainId: 84532,
    name: "Base Sepolia",
    selector: 10344971235874465080n,
    router: "0xD3b06cEbF099CE7DA4AcCf578aaebFDBd6e88a93",
    rpcUrl: "https://sepolia.base.org",
    explorer: "https://sepolia.basescan.org",
    gateway: addr(84532, "NorenCcipGateway"),
    hub: addr(84532, "NorenCcipHub"),
    nativeSymbol: "ETH",
  },
  sepolia: {
    key: "sepolia",
    chainId: 11155111,
    name: "Ethereum Sepolia",
    selector: 16015286601757825753n,
    router: "0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59",
    rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
    explorer: "https://sepolia.etherscan.io",
    gateway: addr(11155111, "NorenCcipGateway"),
    nativeSymbol: "ETH",
  },
};

/** The hub that relays between chains with no direct CCIP lane (Robinhood <-> Arc). */
export const HUB: ChainKey = "baseSepolia";

/**
 * Direct CCIP lanes Noren uses, verified against https://docs.chain.link/api/ccip/v1/lanes?environment=testnet
 * (Nov 6 2026). Robinhood and Arc share no lane, so that pair goes through the Base Sepolia hub.
 */
const DIRECT = new Set(["robinhood>baseSepolia", "baseSepolia>robinhood", "baseSepolia>arc", "arc>baseSepolia", "sepolia>arc", "arc>sepolia", "robinhood>sepolia", "sepolia>robinhood"]);

export const hasDirectLane = (from: ChainKey, to: ChainKey) => DIRECT.has(`${from}>${to}`);

/** Hops a Noren message takes from `from` to `to`. */
export const routeOf = (from: ChainKey, to: ChainKey): ChainKey[] => {
  if (from === to) throw new Error(`from and to are both ${from}`);
  if (hasDirectLane(from, to)) return [from, to];
  if (hasDirectLane(from, HUB) && hasDirectLane(HUB, to)) return [from, HUB, to];
  throw new Error(`no CCIP route from ${from} to ${to}`);
};

export const chainBySelector = (selector: bigint): NorenCcipChain | undefined =>
  Object.values(CHAINS).find((c) => c.selector === selector);

export const viemChain = (c: NorenCcipChain): Chain => ({
  id: c.chainId,
  name: c.name,
  nativeCurrency: { name: c.nativeSymbol, symbol: c.nativeSymbol, decimals: 18 },
  rpcUrls: { default: { http: [c.rpcUrl] } },
  blockExplorers: { default: { name: "explorer", url: c.explorer } },
});

export const ccipExplorerUrl = (messageId: string) => `https://ccip.chain.link/msg/${messageId}`;
