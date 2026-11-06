// Adds USDC liquidity to NorenArcActionRouter on Arc testnet (backs PAY_ON_CREDIT).
// Usage: NOREN_DEPLOYER_KEY from a gitignored env file; tsx scripts/add-liquidity.ts <amountUsdc6>
import { createPublicClient, createWalletClient, http, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import deployments from "../deployments.json" with { type: "json" };

const key = process.env.NOREN_DEPLOYER_KEY as Hex | undefined;
if (!key) throw new Error("Setup required: NOREN_DEPLOYER_KEY");
const amount = BigInt(process.argv[2] ?? "0");
if (amount <= 0n) throw new Error("usage: add-liquidity.ts <amountUsdc6>");
const arc = { id: 5042002, name: "Arc Testnet", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: ["https://rpc.testnet.arc.io"] } } } as const;
const router = deployments["5042002"].NorenArcActionRouter as Hex;
const usdc = "0x3600000000000000000000000000000000000000" as const;
const account = privateKeyToAccount(key);
const pub = createPublicClient({ chain: arc, transport: http() });
const wallet = createWalletClient({ account, chain: arc, transport: http() });
const erc20 = parseAbi(["function approve(address,uint256) returns (bool)"]);
const r = parseAbi(["function addLiquidity(uint256)", "function liquidity() view returns (uint256)"]);
const a = await wallet.writeContract({ address: usdc, abi: erc20, functionName: "approve", args: [router, amount] });
console.log("approve", a, (await pub.waitForTransactionReceipt({ hash: a })).status);
const l = await wallet.writeContract({ address: router, abi: r, functionName: "addLiquidity", args: [amount] });
console.log("addLiquidity", l, (await pub.waitForTransactionReceipt({ hash: l })).status);
console.log("liquidity", await pub.readContract({ address: router, abi: r, functionName: "liquidity" }));
