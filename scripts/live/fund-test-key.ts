// Funds a browser test key from the Noren deployer for one live Robinhood ⇄ Arc CCTP run from the app's UI.
// Small, capped amounts on public testnets only: at most 1 USDC on Arc testnet and 0.003 ETH (gas) on Robinhood
// Chain testnet. The deployer key is read from the gitignored env file (packages/cctp/scripts/lib.ts) and never
// printed; Arc transactions run under the shared nonce lock.
//   pnpm exec tsx scripts/live/fund-test-key.ts 0x<test key address>
import { createPublicClient, erc20Abi, http, isAddress, parseEther, type Address } from "viem";
import { CCTP_CHAINS } from "../../packages/cctp/sdk/chains";
import { loadKey, walletFor, withArcLock } from "../../packages/cctp/scripts/lib";

const to = process.argv[2] as Address;
if (!isAddress(to)) throw new Error("usage: tsx scripts/live/fund-test-key.ts 0x<address>");
const ARC_USDC = 1_000_000n, RH_ETH = parseEther("0.003");
const pk = loadKey();
const arc = CCTP_CHAINS["arc-testnet"], rh = CCTP_CHAINS["robinhood-testnet"];
const pubArc = createPublicClient({ transport: http(arc.rpcUrl) }), pubRh = createPublicClient({ transport: http(rh.rpcUrl) });

const have = await pubArc.readContract({ address: arc.usdc, abi: erc20Abi, functionName: "balanceOf", args: [to] });
if (have < ARC_USDC) {
  const h = await withArcLock(async () => {
    const w = walletFor("arc-testnet", pk);
    const hash = await w.writeContract({ address: arc.usdc, abi: erc20Abi, functionName: "transfer", args: [to, ARC_USDC - have], account: w.account!, chain: w.chain });
    if ((await pubArc.waitForTransactionReceipt({ hash })).status !== "success") throw new Error(`Arc USDC transfer reverted: ${hash}`);
    return hash;
  });
  console.log(`Arc testnet: ${Number(ARC_USDC - have) / 1e6} USDC -> ${to}  ${arc.explorer}/tx/${h}`);
} else console.log(`Arc testnet: ${to} already holds ${Number(have) / 1e6} USDC`);

const gas = await pubRh.getBalance({ address: to });
if (gas < RH_ETH) {
  const w = walletFor("robinhood-testnet", pk);
  const hash = await w.sendTransaction({ to, value: RH_ETH - gas, account: w.account!, chain: w.chain });
  if ((await pubRh.waitForTransactionReceipt({ hash })).status !== "success") throw new Error(`Robinhood ETH transfer reverted: ${hash}`);
  console.log(`Robinhood testnet: ${Number(RH_ETH - gas) / 1e18} ETH -> ${to}  ${rh.explorer}/tx/${hash}`);
} else console.log(`Robinhood testnet: ${to} already holds ${Number(gas) / 1e18} ETH`);
