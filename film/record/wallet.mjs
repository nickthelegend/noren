/**
 * An injected test wallet for the film's recordings: an EIP-1193 provider announced over EIP-6963
 * ("Test wallet (injected)"), also set as window.ethereum when the page has none.
 *
 * The private key stays in Node. The page only holds a thin provider that calls one Playwright binding; signing
 * (personal_sign, eth_signTypedData_v4, eth_sendTransaction) happens here with viem, and transactions are broadcast
 * to the RPC of the wallet's current chain. Every other JSON-RPC read is forwarded to that same RPC.
 * wallet_switchEthereumChain / wallet_addEthereumChain change the chain and emit chainChanged.
 *
 * Key: record/state/wallet-key.json (gitignored with record/state/, mode 0600), generated once. Never printed.
 *
 *   import { installWallet } from "./wallet.mjs";
 *   const w = await installWallet(ctx, { net: "fork" });   // before the first page.goto
 *   w.address                                                // public address, safe to log
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createWalletClient, http, hexToString, isHex, defineChain } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
// WALLET_KEY=customer keeps a second persona (the shopper) apart from the merchant's key
const KEY_FILE = `${HERE}state/wallet-key${process.env.WALLET_KEY ? "-" + process.env.WALLET_KEY.replace(/[^a-z0-9-]/gi, "") : ""}.json`;

/** chainId -> RPC. "fork": the local stack from `pnpm dev:all`; "live": the public testnets. */
export const NETS = {
  fork: { 5042002: "http://127.0.0.1:8645", 46630: "http://127.0.0.1:8646" },
  live: { 5042002: "https://rpc.testnet.arc.io", 46630: "https://rpc.testnet.chain.robinhood.com" },
};
const NAMES = { 5042002: "Arc Testnet", 46630: "Robinhood Chain Testnet" };

function loadKey() {
  mkdirSync(`${HERE}state`, { recursive: true });
  if (!existsSync(KEY_FILE)) {
    writeFileSync(KEY_FILE, JSON.stringify({ privateKey: generatePrivateKey(), note: "film recorder test wallet; test networks only" }) + "\n", { mode: 0o600 });
  }
  chmodSync(KEY_FILE, 0o600);
  const { privateKey } = JSON.parse(readFileSync(KEY_FILE, "utf8"));
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error(`${KEY_FILE} does not hold a private key`);
  return privateKey;
}

const ICON = "data:image/svg+xml;base64," + Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#101a3c"/>' +
  '<rect x="12" y="20" width="40" height="28" rx="6" fill="none" stroke="#efe8db" stroke-width="4"/>' +
  '<circle cx="42" cy="34" r="4" fill="#e8643c"/></svg>').toString("base64");

/** The provider that runs in the page. It has no key: every request goes to the Node binding. */
const PAGE = ({ info, chainId0 }) => {
  if (window.__nrTestWallet) return;
  const listeners = {};
  const emit = (ev, v) => (listeners[ev] || []).forEach((f) => { try { f(v); } catch {} });
  let chainId = chainId0;
  try { const s = sessionStorage.getItem("__nrTestWalletChain"); if (s) chainId = s; } catch {}
  const provider = {
    isNorenTestWallet: true,
    async request({ method, params }) {
      const r = await window.__nrWallet({ method, params: params ?? [], chainId });
      if (r && r.error) { const e = new Error(r.error.message); e.code = r.error.code; throw e; }
      if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") {
        const next = r.chainId;
        if (next && next !== chainId) { chainId = next; try { sessionStorage.setItem("__nrTestWalletChain", chainId); } catch {} emit("chainChanged", chainId); }
        return null;
      }
      if (method === "eth_requestAccounts") emit("accountsChanged", r.result);
      return r.result;
    },
    on(ev, f) { (listeners[ev] = listeners[ev] || []).push(f); return provider; },
    removeListener(ev, f) { listeners[ev] = (listeners[ev] || []).filter((x) => x !== f); return provider; },
  };
  window.__nrTestWallet = provider;
  if (!window.ethereum) Object.defineProperty(window, "ethereum", { value: provider, configurable: true, writable: true });
  const detail = Object.freeze({ info: Object.freeze(info), provider });
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
};

export async function installWallet(ctx, { net = "fork", chainId = 5042002, rpcs = {}, log = () => {} } = {}) {
  const account = privateKeyToAccount(loadKey());
  const rpc = { ...NETS[net], ...rpcs };
  const hex = (n) => "0x" + Number(n).toString(16);
  const clientFor = (id) => {
    const url = rpc[Number(id)];
    if (!url) throw Object.assign(new Error(`Test wallet: no RPC for chain ${Number(id)}`), { code: 4902 });
    const chain = defineChain({ id: Number(id), name: NAMES[Number(id)] ?? `Chain ${Number(id)}`, nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [url] } } });
    return { url, wallet: createWalletClient({ account, chain, transport: http(url) }) };
  };
  const forward = async (url, method, params) => {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const j = await r.json();
    if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code });
    return j.result;
  };
  const same = (a) => typeof a === "string" && a.toLowerCase() === account.address.toLowerCase();

  await ctx.exposeBinding("__nrWallet", async (_source, { method, params, chainId: cur }) => {
    try {
      const id = Number(cur);
      switch (method) {
        case "eth_requestAccounts": case "eth_accounts": return { result: [account.address] };
        case "eth_chainId": return { result: hex(id) };
        case "net_version": return { result: String(id) };
        case "wallet_switchEthereumChain": {
          const next = Number(params[0]?.chainId);
          if (!rpc[next]) return { error: { code: 4902, message: `Unrecognized chain ${next}` } };
          log(`wallet: switch to chain ${next}`); return { chainId: hex(next) };
        }
        case "wallet_addEthereumChain": {
          const p = params[0] ?? {}, next = Number(p.chainId);
          // the dapp's RPC for this chain wins (the app hands the wallet its fork or testnet RPC here)
          if (p.rpcUrls?.[0]) { if (rpc[next] !== p.rpcUrls[0]) log(`wallet: chain ${next} via ${p.rpcUrls[0]}`); rpc[next] = p.rpcUrls[0]; }
          if (!rpc[next]) return { error: { code: 4902, message: `No RPC for chain ${next}` } };
          return { chainId: hex(next) };
        }
        case "personal_sign": {
          const [data, addr] = params;
          if (!same(addr)) return { error: { code: 4100, message: "Test wallet: unknown account" } };
          const message = isHex(data) ? { raw: data } : data;
          log(`wallet: personal_sign ${(isHex(data) ? hexToString(data) : String(data)).split("\n")[0].slice(0, 70)}`);
          return { result: await account.signMessage({ message }) };
        }
        case "eth_signTypedData_v4": {
          const [addr, json] = params;
          if (!same(addr)) return { error: { code: 4100, message: "Test wallet: unknown account" } };
          const t = typeof json === "string" ? JSON.parse(json) : json;
          const { EIP712Domain, ...types } = t.types;
          log(`wallet: eth_signTypedData_v4 ${t.primaryType}`);
          return { result: await account.signTypedData({ domain: t.domain, types, primaryType: t.primaryType, message: t.message }) };
        }
        case "eth_sendTransaction": {
          const tx = params[0] ?? {};
          if (tx.from && !same(tx.from)) return { error: { code: 4100, message: "Test wallet: unknown account" } };
          const { wallet } = clientFor(id);
          const hash = await wallet.sendTransaction({
            to: tx.to ?? undefined, data: tx.data ?? tx.input ?? undefined, value: tx.value ? BigInt(tx.value) : undefined,
            gas: tx.gas ? BigInt(tx.gas) : undefined, nonce: tx.nonce !== undefined ? Number(tx.nonce) : undefined,
          });
          log(`wallet: sent ${hash} on chain ${id}`);
          return { result: hash };
        }
        case "eth_sign": case "eth_signTransaction":
          return { error: { code: 4200, message: `Test wallet: ${method} is not supported` } };
        default: return { result: await forward(clientFor(id).url, method, params) };
      }
    } catch (e) {
      return { error: { code: e.code ?? -32603, message: String(e.shortMessage ?? e.message ?? e) } };
    }
  });
  await ctx.addInitScript(PAGE, { info: { uuid: randomUUID(), name: "Test wallet (injected)", icon: ICON, rdns: "dev.noren.film.testwallet" }, chainId0: hex(chainId) });
  return { address: account.address };
}
