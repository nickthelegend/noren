// Re-runs a Noren message the destination gateway stored as FAILED (anyone may call retryFailed).
// Usage: NOREN_DEPLOYER_KEY (any funded key) from a gitignored env file; tsx scripts/retry.ts <chain> <messageId>
import { createPublicClient, createWalletClient, http, parseEventLogs, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAINS, GatewayStatus, gatewayAbi, viemChain, type ChainKey } from "../sdk/index.ts";

const [chainKey, messageId] = process.argv.slice(2) as [ChainKey, Hex];
const c = CHAINS[chainKey];
if (!c?.gateway || !messageId) throw new Error("usage: retry.ts <arc|robinhood|baseSepolia|sepolia> <messageId>");
const key = process.env.NOREN_DEPLOYER_KEY as Hex | undefined;
if (!key) throw new Error("Setup required: NOREN_DEPLOYER_KEY");
const chain = viemChain(c);
const pub = createPublicClient({ chain, transport: http(c.rpcUrl) });
const wallet = createWalletClient({ account: privateKeyToAccount(key), chain, transport: http(c.rpcUrl) });
const before = GatewayStatus[await pub.readContract({ address: c.gateway, abi: gatewayAbi, functionName: "statusOf", args: [messageId] })];
if (before !== "FAILED") throw new Error(`message ${messageId} is ${before} on ${c.name}, not FAILED`);
const tx = await wallet.writeContract({ address: c.gateway, abi: gatewayAbi, functionName: "retryFailed", args: [messageId] });
const r = await pub.waitForTransactionReceipt({ hash: tx });
const delivered = parseEventLogs({ abi: gatewayAbi, eventName: "Delivered", logs: r.logs });
const after = GatewayStatus[await pub.readContract({ address: c.gateway, abi: gatewayAbi, functionName: "statusOf", args: [messageId] })];
console.log(JSON.stringify({ tx, status: r.status, txExplorer: `${c.explorer}/tx/${tx}`, before, after, appOk: delivered[0]?.args.appOk }, null, 2));
