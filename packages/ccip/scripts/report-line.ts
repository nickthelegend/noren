// Reverse path: NorenArcActionRouter.reportLine sends a credit line's Arc utilisation over CCIP
// (Arc -> Base Sepolia hub -> Robinhood NorenCcipInbox). Pays the first hop in Arc native USDC; excess is refunded.
// Usage: NOREN_DEPLOYER_KEY from a gitignored env file; tsx scripts/report-line.ts <lineId> [robinhood]
import { createPublicClient, createWalletClient, http, parseAbi, parseEventLogs, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAINS, ccipExplorerUrl, gatewayAbi, viemChain, type ChainKey } from "../sdk/index.ts";

const [lineId, toKey = "robinhood"] = process.argv.slice(2) as [Hex, ChainKey];
if (!lineId) throw new Error("usage: report-line.ts <lineId> [robinhood]");
const key = process.env.NOREN_DEPLOYER_KEY as Hex | undefined;
if (!key) throw new Error("Setup required: NOREN_DEPLOYER_KEY");
const arc = CHAINS.arc;
const chain = viemChain(arc);
const pub = createPublicClient({ chain, transport: http(arc.rpcUrl) });
const wallet = createWalletClient({ account: privateKeyToAccount(key), chain, transport: http(arc.rpcUrl) });
const routerAbi = parseAbi(["function reportLine(bytes32 lineId, uint64 finalChain) payable returns (bytes32)"]);
// Quote: the gateway's fee for a LINE_REPORT-sized payload (4 words of params), plus a 20% buffer.
const fee = await pub.readContract({
  address: arc.gateway!,
  abi: gatewayAbi,
  functionName: "quote",
  args: [CHAINS[toKey].selector, `0x${"00".repeat(320)}`, "0x0000000000000000000000000000000000000000", 0n, "0x0000000000000000000000000000000000000000"],
});
const tx = await wallet.writeContract({ address: arc.actionRouter!, abi: routerAbi, functionName: "reportLine", args: [lineId, CHAINS[toKey].selector], value: (fee * 12n) / 10n });
const r = await pub.waitForTransactionReceipt({ hash: tx });
const [sent] = parseEventLogs({ abi: gatewayAbi, eventName: "Sent", logs: r.logs });
console.log(JSON.stringify({ tx, status: r.status, messageId: sent?.args.messageId, explorer: sent && ccipExplorerUrl(sent.args.messageId), fee: sent?.args.fee.toString() }, null, 2));
