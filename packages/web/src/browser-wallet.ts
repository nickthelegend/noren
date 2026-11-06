/**
 * Browser wallets (MetaMask, Rabby, any injected EIP-1193 wallet): discovery via EIP-6963 with a window.ethereum
 * fallback, chain switching (wallet_switchEthereumChain, then wallet_addEthereumChain), and a viem transport that sends
 * signing calls to the wallet and everything else to our own RPC.
 */
import { custom, http, type Address, type Chain, type Hex, type HttpTransportConfig, type Transport } from "viem";

export type Eip1193 = { request(a: { method: string; params?: unknown[] }): Promise<unknown>; on?: (e: string, f: (...a: unknown[]) => void) => void; removeListener?: (e: string, f: (...a: unknown[]) => void) => void };
export type WalletInfo = { uuid: string; name: string; icon: string; rdns: string };
export type InjectedWallet = { info: WalletInfo; provider: Eip1193 };
type Host = EventTarget & { ethereum?: Eip1193 & { isMetaMask?: boolean; isRabby?: boolean } };

const host = (): Host | null => (typeof window !== "undefined" ? (window as unknown as Host) : null);

/**
 * Wallets announced over EIP-6963 within `waitMs`, else window.ethereum as a single unnamed wallet.
 * Every call re-requests announcements, so a wallet injected after page load is still found.
 */
export function discoverWallets(target: Host | null = host(), waitMs = 250): Promise<InjectedWallet[]> {
  if (!target) return Promise.resolve([]);
  return new Promise((done) => {
    const found = new Map<string, InjectedWallet>();
    const on = (e: Event) => { const d = (e as CustomEvent<InjectedWallet>).detail; if (d?.provider && d.info?.uuid) found.set(d.info.uuid, d); };
    target.addEventListener("eip6963:announceProvider", on);
    target.dispatchEvent(new Event("eip6963:requestProvider"));
    setTimeout(() => {
      target.removeEventListener("eip6963:announceProvider", on);
      const list = [...found.values()];
      const eth = target.ethereum;
      if (!list.length && eth) list.push({ info: { uuid: "window.ethereum", rdns: "window.ethereum", icon: "", name: eth.isRabby ? "Rabby" : eth.isMetaMask ? "MetaMask" : "Browser wallet" }, provider: eth });
      done(list);
    }, waitMs);
  });
}

const codeOf = (e: unknown): number | undefined => {
  const x = e as { code?: number; data?: { originalError?: { code?: number } }; cause?: { code?: number } };
  return x?.data?.originalError?.code ?? x?.code ?? x?.cause?.code;
};

/** Asks the wallet for its accounts (opens the wallet's connect prompt) and returns the first. */
export async function connectWallet(p: Eip1193): Promise<Address> {
  const accounts = (await p.request({ method: "eth_requestAccounts" })) as Address[];
  if (!accounts?.[0]) throw new Error("The wallet returned no account");
  return accounts[0];
}
/** The wallet's current account without a prompt (null when not connected to this site). */
export async function walletAccount(p: Eip1193): Promise<Address | null> {
  try { return ((await p.request({ method: "eth_accounts" })) as Address[])[0] ?? null; } catch { return null; }
}

/** Puts the wallet on `chain`, adding it (with our RPC) when the wallet doesn't know it (error 4902). */
export async function ensureChain(p: Eip1193, chain: Chain, rpcUrl: string) {
  const want = `0x${chain.id.toString(16)}`;
  const now = String(await p.request({ method: "eth_chainId" })).toLowerCase();
  if (now === want) return;
  try { await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] }); }
  catch (e) {
    if (codeOf(e) !== 4902) throw new Error(`Your wallet didn't switch to ${chain.name} (chain ${chain.id}): ${(e as Error).message ?? e}`);
    await p.request({ method: "wallet_addEthereumChain", params: [{ chainId: want, chainName: chain.name, nativeCurrency: chain.nativeCurrency, rpcUrls: [rpcUrl], ...(chain.blockExplorers?.default.url ? { blockExplorerUrls: [chain.blockExplorers.default.url] } : {}) }] });
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] });
  }
}

const WALLET_METHODS = new Set(["eth_sendTransaction", "personal_sign", "eth_sign", "eth_signTypedData_v4", "eth_accounts", "eth_requestAccounts"]);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * viem transport for a browser wallet on `url`: reads, gas estimates and receipts go to our RPC; signing and
 * eth_sendTransaction go to the wallet, after switching it to the client's chain. A wallet broadcasts through its own
 * RPC for that chain ID, which on a local fork must be the fork: if the transaction never reaches `url`, this fails
 * with the exact setting to change instead of waiting forever.
 */
export function injectedTransport(p: Eip1193, url: string, opts?: HttpTransportConfig, seenTimeoutMs = 30_000): Transport {
  const base = http(url, opts);
  return (params) => {
    const rpc = base(params);
    return custom({
      async request({ method, params: args }: { method: string; params?: unknown }) {
        if (!WALLET_METHODS.has(method)) return rpc.request({ method, params: args } as never);
        if (method === "eth_sendTransaction" && params.chain) await ensureChain(p, params.chain, url);
        const out = await p.request({ method, params: args as unknown[] });
        if (method === "eth_sendTransaction") {
          for (const t0 = Date.now(); ; await wait(500)) {
            if (await rpc.request({ method: "eth_getTransactionByHash", params: [out as Hex] } as never).catch(() => null)) break;
            if (Date.now() - t0 > seenTimeoutMs) throw new Error(`Your wallet sent transaction ${out} through another RPC: it never reached ${url}. Point your wallet's chain ${params.chain?.id ?? ""} network at ${url} and try again.`);
          }
        }
        return out;
      },
    })(params);
  };
}
