// CCIP 2.0 manual execution: re-executes a FAILED message on its destination OffRamp with a higher receiver gas
// limit, using the encoded message and the verifier results that Chainlink's CCIP API publishes.
// OffRamp.execute is permissionless (see OffRamp 2.0.0). The CCIP explorer's "manual execution" button does the same.
// Usage: NOREN_DEPLOYER_KEY (any funded key) from a gitignored env file; tsx scripts/manual-execute.ts <messageId> <gasLimitOverride>
import { createPublicClient, createWalletClient, http, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CCIP_API, chainBySelector, viemChain } from "../sdk/index.ts";

const [messageId, gasArg] = process.argv.slice(2) as [Hex, string];
if (!messageId || !gasArg) throw new Error("usage: manual-execute.ts <messageId> <gasLimitOverride>");
const key = process.env.NOREN_DEPLOYER_KEY as Hex | undefined;
if (!key) throw new Error("Setup required: NOREN_DEPLOYER_KEY");

const res = await fetch(`${CCIP_API}/messages/${messageId}`);
if (!res.ok) throw new Error(`CCIP API ${res.status} for ${messageId}`);
const m = (await res.json()) as any;
if (!m.readyForManualExecution) throw new Error(`message ${messageId} is ${m.status}; not ready for manual execution`);
const dst = chainBySelector(BigInt(m.destNetworkInfo.chainSelector));
if (!dst) throw new Error(`unknown destination selector ${m.destNetworkInfo.chainSelector}`);
const ccvs: Address[] = m.verifiers.items.map((v: any) => v.destAddress);
const results: Hex[] = m.verifiers.items.map((v: any) => v.verification.data);
const offRamp = m.offramp as Address;

const abi = parseAbi(["function execute(bytes encodedMessage, address[] ccvs, bytes[] verifierResults, uint32 gasLimitOverride)"]);
const chain = viemChain(dst);
const account = privateKeyToAccount(key);
const pub = createPublicClient({ chain, transport: http(dst.rpcUrl) });
const wallet = createWalletClient({ account, chain, transport: http(dst.rpcUrl) });
const args = [m.encodedMessage as Hex, ccvs, results, Number(gasArg)] as const;
await pub.simulateContract({ account, address: offRamp, abi, functionName: "execute", args });
const gas = await pub.estimateContractGas({ account, address: offRamp, abi, functionName: "execute", args });
const tx = await wallet.writeContract({ address: offRamp, abi, functionName: "execute", args, gas: (gas * 13n) / 10n });
const r = await pub.waitForTransactionReceipt({ hash: tx });
console.log(JSON.stringify({ tx, status: r.status, offRamp, chain: dst.name, txExplorer: `${dst.explorer}/tx/${tx}` }, null, 2));
