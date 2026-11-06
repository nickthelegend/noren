// Funds a browser test key from the Noren deployer for live CCTP runs from the app's UI. Public testnets only, small
// capped amounts. The deployer key is read from the gitignored env file (packages/cctp/scripts/lib.ts) and never
// printed; every deployer transaction runs under the shared nonce lock.
//   pnpm exec tsx scripts/live/fund-test-key.ts 0x<test key address>                       Robinhood ⇄ Arc (default)
//   pnpm exec tsx scripts/live/fund-test-key.ts 0x<test key address> ethereum-sepolia base-sepolia arbitrum-sepolia
// Robinhood ⇄ Arc: at most 1 USDC on Arc testnet and 0.003 ETH (gas) on Robinhood Chain testnet.
// Any other source chain: tops the key up to 0.6 USDC and that chain's gas allowance. When the deployer holds too
// little USDC on that chain, it brings the difference out of Arc with Circle CCTP V2 (burn on Arc, Circle attests,
// the deployer mints it on the source chain straight to the test key), so nothing is faked.
import { createPublicClient, erc20Abi, http, isAddress, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CCTP_CHAINS, type SourceChainKey } from "../../packages/cctp/sdk/chains";
import { attestFromArc, burnFromArc, mintFromArc } from "../../packages/cctp/sdk/outbound";
import { loadKey, walletFor, withArcLock } from "../../packages/cctp/scripts/lib";

const to = process.argv[2] as Address;
if (!isAddress(to)) throw new Error("usage: tsx scripts/live/fund-test-key.ts 0x<address> [source chains…]");
const sources = process.argv.slice(3) as SourceChainKey[];
for (const s of sources) if (!CCTP_CHAINS[s] || s === ("arc-testnet" as SourceChainKey)) throw new Error(`unknown source chain ${s}`);

const pk = loadKey();
const me = privateKeyToAccount(pk).address;
const arc = CCTP_CHAINS["arc-testnet"];
const pubArc = createPublicClient({ transport: http(arc.rpcUrl) });
const ARC_USDC = 1_000_000n;
/** Gas sent per source chain: approve + depositForBurn with headroom (Sepolia L1 costs the most). */
const GAS: Partial<Record<SourceChainKey, bigint>> = { "ethereum-sepolia": parseEther("0.004"), "robinhood-testnet": parseEther("0.003") };
const GAS_DEFAULT = parseEther("0.0015");
const SRC_USDC = 600_000n;
const log = (s: string) => console.log(s);

async function topUpArc() {
  const have = await pubArc.readContract({ address: arc.usdc, abi: erc20Abi, functionName: "balanceOf", args: [to] });
  if (have >= ARC_USDC) return log(`Arc testnet: ${to} already holds ${Number(have) / 1e6} USDC`);
  const h = await withArcLock(async () => {
    const w = walletFor("arc-testnet", pk);
    const hash = await w.writeContract({ address: arc.usdc, abi: erc20Abi, functionName: "transfer", args: [to, ARC_USDC - have], account: w.account!, chain: w.chain });
    if ((await pubArc.waitForTransactionReceipt({ hash })).status !== "success") throw new Error(`Arc USDC transfer reverted: ${hash}`);
    return hash;
  });
  log(`Arc testnet: ${Number(ARC_USDC - have) / 1e6} USDC -> ${to}  ${arc.explorer}/tx/${h}`);
}

async function topUpGas(k: SourceChainKey) {
  const c = CCTP_CHAINS[k], pub = createPublicClient({ transport: http(c.rpcUrl) });
  const want = GAS[k] ?? GAS_DEFAULT;
  const gas = await pub.getBalance({ address: to });
  if (gas >= want) return log(`${c.name}: ${to} already holds ${Number(gas) / 1e18} ${c.gas}`);
  const mine = await pub.getBalance({ address: me });
  if (mine < want - gas + parseEther("0.0005")) throw new Error(`BLOCKED: the deployer has ${Number(mine) / 1e18} ${c.gas} on ${c.name}; it needs ${Number(want - gas) / 1e18} ${c.gas} plus its own gas`);
  const hash = await withArcLock(async () => { const w = walletFor(k, pk); return w.sendTransaction({ to, value: want - gas, account: w.account!, chain: w.chain }); });
  if ((await pub.waitForTransactionReceipt({ hash })).status !== "success") throw new Error(`${c.name} gas transfer reverted: ${hash}`);
  log(`${c.name}: ${Number(want - gas) / 1e18} ${c.gas} -> ${to}  ${c.explorer}/tx/${hash}`);
}

async function topUpUsdc(k: SourceChainKey) {
  const c = CCTP_CHAINS[k], pub = createPublicClient({ transport: http(c.rpcUrl) });
  const have = await pub.readContract({ address: c.usdc, abi: erc20Abi, functionName: "balanceOf", args: [to] });
  if (have >= SRC_USDC) return log(`${c.name}: ${to} already holds ${Number(have) / 1e6} USDC`);
  const need = SRC_USDC - have;
  const mine = await pub.readContract({ address: c.usdc, abi: erc20Abi, functionName: "balanceOf", args: [me] });
  if (mine >= need) {
    const hash = await withArcLock(async () => { const w = walletFor(k, pk); return w.writeContract({ address: c.usdc, abi: erc20Abi, functionName: "transfer", args: [to, need], account: w.account!, chain: w.chain }); });
    if ((await pub.waitForTransactionReceipt({ hash })).status !== "success") throw new Error(`${c.name} USDC transfer reverted: ${hash}`);
    return log(`${c.name}: ${Number(need) / 1e6} USDC -> ${to}  ${c.explorer}/tx/${hash}`);
  }
  // Not enough USDC on this chain: bring it out of Arc over CCTP V2, minted straight to the test key.
  log(`${c.name}: the deployer holds ${Number(mine) / 1e6} USDC; bringing ${Number(need) / 1e6} USDC from Arc over CCTP V2`);
  const amount = (Number(need + 10_000n) / 1e6).toFixed(6); // + 0.01 USDC for Circle's fast fee
  const arcWallet = walletFor("arc-testnet", pk);
  const burn = await withArcLock(async () => {
    const nonce = await pubArc.getTransactionCount({ address: me, blockTag: "pending" });
    return burnFromArc({ toChain: k, amount, recipient: to, walletClient: arcWallet, nonce });
  });
  log(`  burn on Arc ${arc.explorer}/tx/${burn.burnTxHash}`);
  const a = await attestFromArc(k, burn.burnTxHash as Hex, {});
  const m = await withArcLock(() => mintFromArc(k, a, walletFor(k, pk)));
  log(`  minted ${Number(a.minted) / 1e6} USDC on ${c.name} to ${to}  ${m.mintUrl}`);
}

if (sources.length === 0) {
  await topUpArc();
  await topUpGas("robinhood-testnet");
} else {
  await topUpArc(); // the browser finishes the mint on Arc itself, so it needs a little USDC for Arc gas
  for (const k of sources) { await topUpGas(k); await topUpUsdc(k); }
}
