/**
 * Checks the injected test wallet end to end in a real Chromium page against a throwaway Anvil (chain 5042002 on
 * 127.0.0.1:8898, started and killed here): EIP-6963 announce, window.ethereum, eth_requestAccounts, personal_sign
 * and eth_signTypedData_v4 (verified with viem), eth_sendTransaction (mined on Anvil), a forwarded read, and
 * wallet_switchEthereumChain with chainChanged.   node wallet.test.mjs
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { createPublicClient, http, verifyMessage, verifyTypedData, parseEther } from "viem";
import { installWallet } from "./wallet.mjs";

const PORT = 8898, RPC = `http://127.0.0.1:${PORT}`;
const anvil = spawn("anvil", ["--port", String(PORT), "--chain-id", "5042002", "--silent"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"} ${m}`); if (!c) failed++; };
try {
  const pub = createPublicClient({ transport: http(RPC) });
  for (let i = 0; i < 40; i++) { try { await pub.getChainId(); break; } catch { await sleep(250); } }
  const b = await chromium.launch({ headless: true });
  const ctx = await b.newContext();
  const w = await installWallet(ctx, { net: "fork", rpcs: { 5042002: RPC, 46630: RPC } });
  // fund the test wallet from Anvil's published dev account 0 (local only)
  await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "anvil_setBalance", params: [w.address, "0x56BC75E2D63100000"] }) });
  const p = await ctx.newPage();
  await p.route("http://wallet.test/", (route) => route.fulfill({ contentType: "text/html", body: "<html><body>wallet test</body></html>" }));
  await p.goto("http://wallet.test/");
  const r = await p.evaluate(async () => {
    const seen = [];
    window.addEventListener("eip6963:announceProvider", (e) => seen.push(e.detail.info.name));
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    const eth = window.ethereum;
    const changes = []; eth.on("chainChanged", (c) => changes.push(c));
    const [addr] = await eth.request({ method: "eth_requestAccounts" });
    const chain0 = await eth.request({ method: "eth_chainId" });
    const msg = "Sign in to Noren Merchant\nNonce: abc123";
    const sig = await eth.request({ method: "personal_sign", params: [msg, addr] });
    const typed = { types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "chainId", type: "uint256" }], Mail: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }] },
      domain: { name: "Noren", chainId: 5042002 }, primaryType: "Mail", message: { to: addr, amount: "7" } };
    const tsig = await eth.request({ method: "eth_signTypedData_v4", params: [addr, JSON.stringify(typed)] });
    const hash = await eth.request({ method: "eth_sendTransaction", params: [{ from: addr, to: "0x000000000000000000000000000000000000dEaD", value: "0x2386f26fc10000" }] });
    const bal = await eth.request({ method: "eth_getBalance", params: ["0x000000000000000000000000000000000000dEaD", "latest"] });
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0xb626" }] });
    const chain1 = await eth.request({ method: "eth_chainId" });
    let unknown = null; try { await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x1" }] }); } catch (e) { unknown = e.code; }
    return { seen, addr, chain0, sig, msg, typed, tsig, hash, bal, chain1, changes, unknown, keyInPage: JSON.stringify(Object.keys(window)).includes("privateKey") };
  });
  ok(r.seen.includes("Test wallet (injected)"), "EIP-6963 announces \"Test wallet (injected)\"");
  ok(r.addr === w.address, "eth_requestAccounts returns the Node-side account");
  ok(r.chain0 === "0x4cef52", "eth_chainId starts on Arc testnet (5042002)");
  ok(await verifyMessage({ address: w.address, message: r.msg, signature: r.sig }), "personal_sign verifies (signed in Node)");
  const { EIP712Domain, ...types } = r.typed.types;
  ok(await verifyTypedData({ address: w.address, domain: r.typed.domain, types, primaryType: "Mail", message: r.typed.message, signature: r.tsig }), "eth_signTypedData_v4 verifies");
  const rc = await pub.waitForTransactionReceipt({ hash: r.hash });
  ok(rc.status === "success" && rc.from.toLowerCase() === w.address.toLowerCase(), `eth_sendTransaction mined from the test wallet (${r.hash.slice(0, 10)}…)`);
  ok(BigInt(r.bal) === parseEther("0.01"), "eth_getBalance forwarded to the chain's RPC");
  ok(r.chain1 === "0xb626" && r.changes[0] === "0xb626", "wallet_switchEthereumChain to Robinhood (46630) emits chainChanged");
  ok(r.unknown === 4902, "an unknown chain is refused with 4902");
  ok(!r.keyInPage, "no key material on window");
  await b.close();
} finally { anvil.kill("SIGTERM"); }
console.log(failed ? `${failed} failed` : "all passed"); process.exit(failed ? 1 : 0);
