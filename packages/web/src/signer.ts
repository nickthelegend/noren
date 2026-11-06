/**
 * The customer's active wallet, for every place the Noren app signs: Pay (USDC, private, credit), Bridge, Swap, Borrow.
 * Two modes:
 * - "privy": the user's Privy embedded wallet, through Privy's EIP-1193 provider. Transactions are filled from our own
 *   RPC (local fork or public testnet) and signed with eth_signTransaction, so the same wallet works on the forks.
 * - "browser": an injected wallet (MetaMask, Rabby…, found over EIP-6963 or window.ethereum). It signs and sends
 *   through its own EIP-1193 provider after switching to the right chain (browser-wallet.ts).
 * - "test": the original test key kept in this browser (localStorage "noren.customer.v1"). The fallback on local
 *   forks, and the default when VITE_PRIVY_APP_ID isn't set.
 * The private Kohaku balance's secrets come from the test seed in test mode, and from a deterministic signature by the
 * Privy or browser wallet otherwise (never sent anywhere; kept for this tab only).
 */
import { useSyncExternalStore } from "react";
import { getTypesForEIP712Domain, http, keccak256, numberToHex, stringify, toHex, type Account, type Address, type Hex, type HttpTransportConfig, type LocalAccount, type Transport } from "viem";
import { connectWallet, discoverWallets, injectedTransport, walletAccount, type InjectedWallet } from "./browser-wallet";
import { generatePrivateKey, privateKeyToAccount, toAccount } from "viem/accounts";

export const PRIVY_APP_ID = (import.meta.env.VITE_PRIVY_APP_ID as string | undefined)?.trim() || null;

const TEST_KEY = "noren.customer.v1", MODE_KEY = "noren.wallet.mode";
type Stored = { gasKey: Hex; seed: Hex };
/** This browser's test wallet (created on first use). Same storage slot as before Privy, so existing balances stay. */
export function testWallet(): Stored {
  try { const s = JSON.parse(localStorage.getItem(TEST_KEY) ?? "null"); if (s?.gasKey && s?.seed) return s; } catch { /* fresh below */ }
  const s = { gasKey: generatePrivateKey(), seed: generatePrivateKey() };
  try { localStorage.setItem(TEST_KEY, JSON.stringify(s)); } catch { /* private mode: wallet lives for this tab */ }
  return s;
}

export type Eip1193 = { request(a: { method: string; params?: unknown[] }): Promise<unknown> };
export type PrivyWallet = { address: Address; provider: Eip1193; userId: string; login: string };
/** A connected browser wallet. */
export type BrowserWallet = { address: Address; provider: Eip1193; name: string; rdns: string };
export type WalletMode = "privy" | "test" | "browser";
/** Privy session as the app sees it. "off" = no app ID; "loading" = SDK starting; "out" = signed out; "in" = wallet ready. */
export type PrivyStatus = "off" | "loading" | "out" | "creating" | "in" | "error";

type State = { mode: WalletMode; status: PrivyStatus; wallet: PrivyWallet | null; browser: BrowserWallet | null; error: string | null; version: number };
const BROWSER_KEY = "noren.wallet.browser";
const readMode = (): WalletMode => {
  let m: string | null = null; try { m = localStorage.getItem(MODE_KEY); } catch { /* default below */ }
  return m === "test" || m === "browser" ? m : PRIVY_APP_ID ? "privy" : "test";
};
let state: State = { mode: readMode(), status: PRIVY_APP_ID ? "loading" : "off", wallet: null, browser: null, error: null, version: 0 };
const subs = new Set<() => void>();
const set = (p: Partial<State>) => { state = { ...state, ...p, version: state.version + 1 }; subs.forEach((f) => f()); };

/** Called by the Privy bridge (privy.tsx) whenever the Privy session or its embedded wallet changes. */
export function setPrivy(status: PrivyStatus, wallet: PrivyWallet | null, error: string | null = null) {
  const same = state.status === status && state.error === error && state.wallet?.address === wallet?.address && state.wallet?.provider === wallet?.provider;
  if (!same) set({ status, wallet, error });
}
export function setWalletMode(mode: WalletMode) {
  if (mode === "privy" && !PRIVY_APP_ID) return;
  try { localStorage.setItem(MODE_KEY, mode); } catch { /* tab-only */ }
  set({ mode });
}
const activeOf = (s: State): WalletMode => (s.mode === "privy" && s.status === "in" && s.wallet ? "privy" : s.mode === "browser" && s.browser ? "browser" : "test");
/** The wallet that signs: Privy or browser wallet once connected; otherwise the test wallet. */
export const activeMode = (): WalletMode => activeOf(state);
const external = () => (activeMode() === "privy" ? state.wallet! : activeMode() === "browser" ? state.browser! : null);
export function useSigner() {
  const s = useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => state);
  const active = activeOf(s);
  const address = active === "privy" ? s.wallet!.address : active === "browser" ? s.browser!.address : privateKeyToAccount(testWallet().gasKey).address;
  return { ...s, active, address, signerKey: `${active}:${active === "test" ? "test" : address}` };
}

let unwatch: (() => void) | null = null;
/** Connects a browser wallet (opens its prompt) and makes it the active wallet. */
export async function connectBrowserWallet(w: InjectedWallet) {
  const address = await connectWallet(w.provider);
  adoptBrowser(w, address);
}
function adoptBrowser(w: InjectedWallet, address: Address) {
  unwatch?.();
  const onAccounts = (a: unknown) => { const next = (a as Address[])?.[0]; set({ browser: next ? { ...state.browser!, address: next } : null }); };
  w.provider.on?.("accountsChanged", onAccounts);
  unwatch = () => w.provider.removeListener?.("accountsChanged", onAccounts);
  try { localStorage.setItem(MODE_KEY, "browser"); localStorage.setItem(BROWSER_KEY, w.info.rdns); } catch { /* tab-only */ }
  set({ mode: "browser", browser: { address, provider: w.provider, name: w.info.name, rdns: w.info.rdns }, error: null });
}
/** On load in browser mode: reconnect, without a prompt, to the wallet used last time if it still lists this site. */
export async function restoreBrowserWallet() {
  if (state.mode !== "browser" || state.browser) return;
  let rdns: string | null = null; try { rdns = localStorage.getItem(BROWSER_KEY); } catch { /* none */ }
  const w = (await discoverWallets()).find((x) => x.info.rdns === rdns);
  const address = w ? await walletAccount(w.provider) : null;
  if (w && address) adoptBrowser(w, address);
}
export function disconnectBrowserWallet() { unwatch?.(); unwatch = null; set({ browser: null }); }

/** viem account backed by Privy's EIP-1193 provider (embedded wallet). */
function privyAccount(w: PrivyWallet): LocalAccount {
  const rpc = <T>(method: string, params: unknown[]) => w.provider.request({ method, params }) as Promise<T>;
  return toAccount({
    address: w.address,
    signMessage: ({ message }) => rpc<Hex>("personal_sign", [typeof message === "string" ? toHex(message) : typeof message.raw === "string" ? message.raw : toHex(message.raw), w.address]),
    signTypedData: (td) => {
      const { domain = {}, message, primaryType } = td as { domain?: Record<string, unknown>; message: unknown; primaryType: string; types: Record<string, unknown> };
      const types = { EIP712Domain: getTypesForEIP712Domain({ domain: domain as never }), ...(td as { types: Record<string, unknown> }).types };
      return rpc<Hex>("eth_signTypedData_v4", [w.address, stringify({ domain, message, primaryType, types })]);
    },
    async signTransaction(tx) {
      if (!tx.chainId) throw new Error("Can't sign: transaction has no chain ID");
      // Privy's request shape (ethers-style): gasLimit, numeric chainId/type/nonce, hex quantities.
      const q = (v?: bigint) => (v === undefined ? undefined : numberToHex(v));
      const t = tx as { to?: Address | null; data?: Hex; value?: bigint; nonce?: number; gas?: bigint; gasPrice?: bigint; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint; type?: string };
      const req = {
        from: w.address, to: t.to ?? undefined, data: t.data, value: q(t.value ?? 0n), nonce: t.nonce, gasLimit: q(t.gas), chainId: tx.chainId,
        ...(t.maxFeePerGas !== undefined ? { type: 2, maxFeePerGas: q(t.maxFeePerGas), maxPriorityFeePerGas: q(t.maxPriorityFeePerGas ?? 0n) } : { type: 0, gasPrice: q(t.gasPrice) }),
      };
      try { return await rpc<Hex>("eth_signTransaction", [req]); }
      catch (e) { throw new Error(`Your Privy wallet didn't sign the transaction (chain ${tx.chainId}): ${(e as Error).message ?? e}`); }
    },
  });
}

/**
 * The account that signs right now: the Privy embedded wallet or the test key (local accounts), or a browser wallet
 * (a JSON-RPC account: viem sends eth_sendTransaction, which walletTransport routes to the wallet).
 */
export function activeAccount(): Account {
  const m = activeMode();
  return m === "privy" ? privyAccount(state.wallet!) : m === "browser" ? { address: state.browser!.address, type: "json-rpc" } : privateKeyToAccount(testWallet().gasKey);
}
/** The transport every wallet client uses on `url`: plain HTTP, or HTTP plus the browser wallet for signing. */
export function walletTransport(url: string, opts?: HttpTransportConfig): Transport {
  return activeMode() === "browser" ? injectedTransport(state.browser!.provider, url, opts) : http(url, opts);
}
/** Stable key for the active wallet: namespaces caches (Kohaku sync state) and re-creates clients when it changes. */
export const activeKey = () => { const w = external(); return w ? `${activeMode()}:${w.address.toLowerCase()}` : "test"; };

/** The message the Privy wallet signs to derive the private balance's secrets. Changing it changes the balance. */
export const seedMessage = (a: Address) =>
  `Noren private balance\n\nSign to open your private Noren balance on this device. This derives the keys of your private notes. It costs nothing and sends no transaction. Only sign this on the Noren app.\n\nWallet: ${a}\nVersion: 1`;

const seeds = new Map<string, Promise<Hex>>();
/**
 * Root secret for the Kohaku notes. Test mode: the stored test seed (unchanged). Privy mode: keccak256 of the wallet's
 * signature over seedMessage, which is deterministic for an ECDSA key (RFC 6979). A fingerprint check makes a
 * non-deterministic signer fail loudly instead of silently opening an empty balance.
 */
export function kohakuSeed(): Promise<Hex> {
  const w = external();
  if (!w) return Promise.resolve(testWallet().seed);
  const a = w.address.toLowerCase(), cacheKey = `noren.kohaku.seed.${a}`, fpKey = `noren.kohaku.fp.${a}`;
  if (!seeds.has(a)) seeds.set(a, (async () => {
    try { const c = sessionStorage.getItem(cacheKey) as Hex | null; if (c) return c; } catch { /* derive below */ }
    const sig = (await w.provider.request({ method: "personal_sign", params: [toHex(seedMessage(w.address)), w.address] })) as Hex;
    const seed = keccak256(sig), fp = keccak256(keccak256(seed));
    let known: string | null = null; try { known = localStorage.getItem(fpKey); } catch { /* no fingerprint store */ }
    if (known && known !== fp) throw new Error("This wallet signed the private-balance message differently than last time, so its private balance can't be reopened. Use the wallet you shielded with, or the Test wallet.");
    try { localStorage.setItem(fpKey, fp); sessionStorage.setItem(cacheKey, seed); } catch { /* tab-only */ }
    return seed;
  })().catch((e) => { seeds.delete(a); throw e; }));
  return seeds.get(a)!;
}

/** What the Privy bridge (privy.tsx) exposes to code outside React's Privy context (Noren Merchant's sign-in). */
export type PrivyConnected = { address: Address; walletClientType: string; getEthereumProvider: () => Promise<Eip1193> };
export type PrivyActions = {
  /** Opens Privy's login modal (email, wallet); resolves with the Privy user ID once signed in, rejects if closed. */
  login: () => Promise<string>;
  logout: () => Promise<void>;
  getAccessToken: () => Promise<string | null>;
  authenticated: boolean; userId: string | null; primaryWallet: Address | null; email: string | null;
  wallets: PrivyConnected[];
};
let actions: PrivyActions | null = null;
export const registerPrivyActions = (a: PrivyActions | null) => { actions = a; };
export const privyActions = () => actions;
/** Waits (up to `ms`) for a condition on the bridge's latest state, e.g. the embedded wallet appearing after login. */
export async function waitForPrivy<T>(pick: (a: PrivyActions) => T | null | undefined, ms = 20_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = actions ? pick(actions) : null;
    if (v) return v;
    if (Date.now() > until) throw new Error("Privy didn't finish signing in. Try again.");
    await new Promise((r) => setTimeout(r, 200));
  }
}
