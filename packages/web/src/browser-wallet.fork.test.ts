// Browser wallet mode against a local Arc testnet fork (anvil on port 8891, started and stopped here).
// The wallet under test is an injected EIP-1193 provider announced over EIP-6963, the shape MetaMask or the film
// recorder's test wallet has: it signs with an anvil dev key and broadcasts through the RPC the app adds for the chain.
// Run: pnpm --dir packages/web exec vitest run src/browser-wallet.fork.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createPublicClient, createWalletClient, defineChain, erc20Abi, http, keccak256, maxUint256, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { localFork } from "@noren/core";
import { connectWallet, discoverWallets, injectedTransport, type Eip1193 } from "./browser-wallet";
import { AuthState } from "../../server/src/auth";

const PORT = 8891, RPC = `http://127.0.0.1:${PORT}`;
const USDC: Address = "0x3600000000000000000000000000000000000000";
const KEY: Hex = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // anvil dev account #1 (public)

/** An injected wallet: EIP-1193 requests, EIP-6963 announcement, chain list built by wallet_addEthereumChain. */
function injectWallet(target: EventTarget, opts: { broadcast?: boolean } = {}) {
  const account = privateKeyToAccount(KEY);
  const rpcs = new Map<number, string>([[1, "https://eth.example.invalid"]]);
  let chainId = 1;
  const calls: string[] = [];
  const provider: Eip1193 = {
    async request({ method, params = [] }) {
      calls.push(method);
      const p = params as any[];
      switch (method) {
        case "eth_requestAccounts": case "eth_accounts": return [account.address];
        case "eth_chainId": return toHex(chainId);
        case "wallet_switchEthereumChain": { const id = Number(p[0].chainId); if (!rpcs.has(id)) throw Object.assign(new Error("Unrecognized chain ID"), { code: 4902 }); chainId = id; return null; }
        case "wallet_addEthereumChain": rpcs.set(Number(p[0].chainId), p[0].rpcUrls[0]); return null;
        case "personal_sign": return account.signMessage({ message: { raw: p[0] } });
        case "eth_sendTransaction": {
          const t = p[0];
          if (opts.broadcast === false) return keccak256(toHex(`elsewhere-${Date.now()}`)); // a wallet broadcasting via another RPC
          const chain = defineChain({ id: chainId, name: "x", nativeCurrency: { name: "x", symbol: "x", decimals: 18 }, rpcUrls: { default: { http: [rpcs.get(chainId)!] } } });
          const w = createWalletClient({ account, chain, transport: http(rpcs.get(chainId)) });
          return w.sendTransaction({ to: t.to, data: t.data, value: t.value ? BigInt(t.value) : undefined, gas: t.gas ? BigInt(t.gas) : undefined, chain });
        }
        default: throw Object.assign(new Error(`Unsupported method ${method}`), { code: 4200 });
      }
    },
  };
  target.addEventListener("eip6963:requestProvider", () => target.dispatchEvent(Object.assign(new Event("eip6963:announceProvider"), { detail: { info: { uuid: "test-wallet", name: "Test Injected", icon: "", rdns: "dev.noren.test" }, provider } })));
  return { provider, account, calls };
}

let anvil: ChildProcess;
beforeAll(async () => {
  anvil = spawn("anvil", ["--silent", "--fork-url", "https://rpc.testnet.arc.io", "--chain-id", "5042002", "--port", String(PORT)], { stdio: "ignore" });
  const pub = createPublicClient({ transport: http(RPC) });
  for (let i = 0; i < 60; i++) { try { await pub.getChainId(); return; } catch { await new Promise((r) => setTimeout(r, 500)); } }
  throw new Error("anvil fork of Arc testnet didn't start");
}, 40_000);
afterAll(() => { anvil?.kill(); });

describe("Browser wallet (EIP-6963 + EIP-1193) on an Arc testnet fork", () => {
  it("finds the wallet over EIP-6963, and window.ethereum when nothing announces", async () => {
    const page = new EventTarget(); injectWallet(page);
    const list = await discoverWallets(page as never);
    expect(list.map((w) => w.info.name)).toEqual(["Test Injected"]);
    const legacy = Object.assign(new EventTarget(), { ethereum: { isMetaMask: true, request: async () => [] } });
    expect((await discoverWallets(legacy as never)).map((w) => w.info.name)).toEqual(["MetaMask"]);
    expect(await discoverWallets(new EventTarget() as never)).toEqual([]);
  });

  it("connects, signs a SIWE message the Noren server accepts, and sends a fork transaction (adding the chain first)", async () => {
    const page = new EventTarget(); const { calls } = injectWallet(page);
    const [w] = await discoverWallets(page as never);
    const address = await connectWallet(w.provider);
    const chain = localFork(RPC);
    const pub = createPublicClient({ chain, transport: http(RPC) });
    const wallet = createWalletClient({ chain, account: { address, type: "json-rpc" }, transport: injectedTransport(w.provider, RPC) });

    // SIWE, exactly as Noren Merchant signs it, checked by the server's AuthState.
    const auth = new AuthState(pub, 5042002, ["localhost:5190"]);
    const message = createSiweMessage({ domain: "localhost:5190", address, uri: "http://localhost:5190", version: "1", chainId: 5042002, nonce: auth.nonce(), issuedAt: new Date(), statement: "Sign in to Noren Merchant." });
    const session = await auth.siwe(message, await wallet.signMessage({ message }));
    expect(session.address).toBe(address);

    // One real transaction on the fork: approve USDC. The wallet starts on chain 1, gets 4902, adds Arc with our RPC.
    await pub.request({ method: "anvil_setBalance" as never, params: [address, toHex(10n ** 21n)] as never });
    const hash = await wallet.writeContract({ address: USDC, abi: erc20Abi, functionName: "approve", args: [address, maxUint256] });
    const r = await pub.waitForTransactionReceipt({ hash });
    expect(r.status).toBe("success"); expect(r.from.toLowerCase()).toBe(address.toLowerCase());
    expect(await pub.readContract({ address: USDC, abi: erc20Abi, functionName: "allowance", args: [address, address] })).toBe(maxUint256);
    expect(calls).toEqual(expect.arrayContaining(["wallet_addEthereumChain", "wallet_switchEthereumChain", "eth_sendTransaction", "personal_sign"]));
  }, 60_000);

  it("fails loudly when the wallet broadcasts through another RPC", async () => {
    const page = new EventTarget(); const { provider, account } = injectWallet(page, { broadcast: false });
    const chain = localFork(RPC);
    const wallet = createWalletClient({ chain, account: { address: account.address, type: "json-rpc" }, transport: injectedTransport(provider, RPC, undefined, 1500) });
    await expect(wallet.sendTransaction({ to: account.address, value: 1n })).rejects.toThrow(/never reached http:\/\/127\.0\.0\.1:8891/);
  }, 30_000);

  it("makes the browser wallet the app's active wallet, with private-balance keys from its signature", async () => {
    const page = new EventTarget(); injectWallet(page);
    const [w] = await discoverWallets(page as never);
    const s = await import("./signer");
    await s.connectBrowserWallet(w);
    expect(s.activeMode()).toBe("browser");
    expect(s.activeAccount()).toEqual({ address: privateKeyToAccount(KEY).address, type: "json-rpc" });
    const seed = await s.kohakuSeed();
    const expected = keccak256(await privateKeyToAccount(KEY).signMessage({ message: s.seedMessage(privateKeyToAccount(KEY).address) }));
    expect(seed).toBe(expected);
    expect(s.activeKey()).toBe(`browser:${privateKeyToAccount(KEY).address.toLowerCase()}`);
    s.disconnectBrowserWallet(); expect(s.activeMode()).toBe("test");
  });
});
