import type { Address } from "viem";
import deployments from "../deployments.json" with { type: "json" };

/** CCTP V2 finality thresholds: 1000 = fast transfer (soft finality, small fee), 2000 = standard (hard finality). */
export const FINALITY_FAST = 1000;
export const FINALITY_STANDARD = 2000;

/** Circle CCTP V2 contracts: one CREATE2 address on every testnet. */
export const TOKEN_MESSENGER_V2: Address = "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA";
export const MESSAGE_TRANSMITTER_V2: Address = "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275";

export type CctpChainKey =
  | "ethereum-sepolia"
  | "base-sepolia"
  | "arbitrum-sepolia"
  | "op-sepolia"
  | "avalanche-fuji"
  | "polygon-amoy"
  | "unichain-sepolia"
  | "linea-sepolia"
  | "worldchain-sepolia"
  | "ink-sepolia"
  | "robinhood-testnet"
  | "arc-testnet";

/** Every chain except Arc: the places Noren pulls USDC liquidity from. */
export type SourceChainKey = Exclude<CctpChainKey, "arc-testnet">;

export type CctpChain = {
  key: CctpChainKey;
  name: string;
  chainId: number;
  /** Circle CCTP domain id. */
  domain: number;
  rpcUrl: string;
  explorer: string;
  /** Native gas token symbol. */
  gas: string;
  /** Circle USDC (6 decimals), resolved on-chain via TokenMinterV2.getLocalToken(26, Arc USDC). */
  usdc: Address;
  tokenMessenger: Address;
  messageTransmitter: Address;
  /** CRE chain selector name (log trigger source / write target). */
  creChain: string;
};

const chain = (c: Omit<CctpChain, "tokenMessenger" | "messageTransmitter">): CctpChain => ({
  ...c,
  tokenMessenger: TOKEN_MESSENGER_V2,
  messageTransmitter: MESSAGE_TRANSMITTER_V2,
});

/**
 * CCTP V2 testnets linked to Arc (domain 26). Each row was checked on-chain (scripts/verify-chains.ts,
 * fixtures/chains-verified.json): code at both Circle contracts, MessageTransmitterV2.localDomain() == domain,
 * TokenMessengerV2.remoteTokenMessengers(26) set, and USDC = localMinter.getLocalToken(26, Arc USDC).
 */
export const CCTP_CHAINS: Record<CctpChainKey, CctpChain> = {
  "ethereum-sepolia": chain({ key: "ethereum-sepolia", name: "Ethereum Sepolia", chainId: 11155111, domain: 0, gas: "ETH",
    rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com", explorer: "https://sepolia.etherscan.io",
    usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", creChain: "ethereum-testnet-sepolia" }),
  "avalanche-fuji": chain({ key: "avalanche-fuji", name: "Avalanche Fuji", chainId: 43113, domain: 1, gas: "AVAX",
    rpcUrl: "https://api.avax-test.network/ext/bc/C/rpc", explorer: "https://testnet.snowtrace.io",
    usdc: "0x5425890298aed601595a70AB815c96711a31Bc65", creChain: "avalanche-testnet-fuji" }),
  "op-sepolia": chain({ key: "op-sepolia", name: "OP Sepolia", chainId: 11155420, domain: 2, gas: "ETH",
    rpcUrl: "https://sepolia.optimism.io", explorer: "https://sepolia-optimism.etherscan.io",
    usdc: "0x5fd84259d66Cd46123540766Be93DFE6D43130D7", creChain: "ethereum-testnet-sepolia-optimism-1" }),
  "arbitrum-sepolia": chain({ key: "arbitrum-sepolia", name: "Arbitrum Sepolia", chainId: 421614, domain: 3, gas: "ETH",
    rpcUrl: "https://sepolia-rollup.arbitrum.io/rpc", explorer: "https://sepolia.arbiscan.io",
    usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", creChain: "ethereum-testnet-sepolia-arbitrum-1" }),
  "base-sepolia": chain({ key: "base-sepolia", name: "Base Sepolia", chainId: 84532, domain: 6, gas: "ETH",
    rpcUrl: "https://sepolia.base.org", explorer: "https://sepolia.basescan.org",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", creChain: "ethereum-testnet-sepolia-base-1" }),
  "polygon-amoy": chain({ key: "polygon-amoy", name: "Polygon Amoy", chainId: 80002, domain: 7, gas: "POL",
    rpcUrl: "https://polygon-amoy-bor-rpc.publicnode.com", explorer: "https://amoy.polygonscan.com",
    usdc: "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582", creChain: "polygon-testnet-amoy" }),
  "unichain-sepolia": chain({ key: "unichain-sepolia", name: "Unichain Sepolia", chainId: 1301, domain: 10, gas: "ETH",
    rpcUrl: "https://sepolia.unichain.org", explorer: "https://sepolia.uniscan.xyz",
    usdc: "0x31d0220469e10c4E71834a79b1f276d740d3768F", creChain: "ethereum-testnet-sepolia-unichain-1" }),
  "linea-sepolia": chain({ key: "linea-sepolia", name: "Linea Sepolia", chainId: 59141, domain: 11, gas: "ETH",
    rpcUrl: "https://rpc.sepolia.linea.build", explorer: "https://sepolia.lineascan.build",
    usdc: "0xFEce4462D57bD51A6A552365A011b95f0E16d9B7", creChain: "ethereum-testnet-sepolia-linea-1" }),
  "worldchain-sepolia": chain({ key: "worldchain-sepolia", name: "World Chain Sepolia", chainId: 4801, domain: 14, gas: "ETH",
    rpcUrl: "https://worldchain-sepolia.g.alchemy.com/public", explorer: "https://sepolia.worldscan.org",
    usdc: "0x66145f38cBAC35Ca6F1Dfb4914dF98F1614aeA88", creChain: "ethereum-testnet-sepolia-worldchain-1" }),
  "ink-sepolia": chain({ key: "ink-sepolia", name: "Ink Sepolia", chainId: 763373, domain: 21, gas: "ETH",
    rpcUrl: "https://rpc-gel-sepolia.inkonchain.com", explorer: "https://explorer-sepolia.inkonchain.com",
    usdc: "0xFabab97dCE620294D2B0b0e46C68964e326300Ac", creChain: "ink-testnet-sepolia" }),
  "robinhood-testnet": chain({ key: "robinhood-testnet", name: "Robinhood Chain Testnet", chainId: 46630, domain: 35, gas: "ETH",
    rpcUrl: "https://rpc.testnet.chain.robinhood.com", explorer: "https://explorer.testnet.chain.robinhood.com",
    usdc: "0x2FD79307e37Ff0d60AE26A108FBA5B22bfC34b12", creChain: "robinhood-testnet" }),
  "arc-testnet": chain({ key: "arc-testnet", name: "Arc Testnet", chainId: 5042002, domain: 26, gas: "USDC",
    rpcUrl: "https://rpc.testnet.arc.io", explorer: "https://explorer.testnet.arc.io",
    usdc: "0x3600000000000000000000000000000000000000", creChain: "arc-testnet" }),
};

export const ARC = CCTP_CHAINS["arc-testnet"];
export const SOURCE_CHAINS = Object.values(CCTP_CHAINS).filter((c) => c.key !== "arc-testnet") as Array<CctpChain & { key: SourceChainKey }>;

type ArcDeployment = { NorenArcHook?: string; deployTx?: string; deployBlock?: number; forwarder?: string };
const arcDeployment = (deployments as Record<string, ArcDeployment>)[String(ARC.chainId)] ?? {};

/** NorenArcHook on Arc Testnet: the destinationCaller of every Noren burn, and the CRE relay's write target. */
export const NOREN_ARC_HOOK: Address | null = (arcDeployment.NorenArcHook as Address | undefined) ?? null;
export const NOREN_ARC_HOOK_DEPLOY_BLOCK: bigint = BigInt(arcDeployment.deployBlock ?? 0);

export const chainByDomain = (domain: number): CctpChain => {
  const c = Object.values(CCTP_CHAINS).find((x) => x.domain === domain);
  if (!c) throw new Error(`CCTP domain ${domain} is not a Noren chain`);
  return c;
};

export const txUrl = (chain: CctpChainKey, hash: string): string => `${CCTP_CHAINS[chain].explorer}/tx/${hash}`;
export const addressUrl = (chain: CctpChainKey, address: string): string => `${CCTP_CHAINS[chain].explorer}/address/${address}`;
