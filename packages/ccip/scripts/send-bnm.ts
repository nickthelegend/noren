// Live programmable token transfer: drips CCIP-BnM on Robinhood Chain testnet, then sends 1 BnM plus a Noren action
// to the Ethereum Sepolia gateway through the SDK's sendViaHub (Robinhood -> Sepolia is a direct lane listing BnM).
// Usage: NOREN_DEPLOYER_KEY from a gitignored env file; tsx scripts/send-bnm.ts
import { createPublicClient, createWalletClient, http, keccak256, parseAbi, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAINS, aquaOrder, sendViaHub, viemChain } from "../sdk/index.ts";

const BNM_ROBINHOOD = "0x2ad603bBe7DfffE7A50740F28d4fFf89a0Db7167" as const; // CCIP directory, CCIP-BnM on 46630
const key = process.env.NOREN_DEPLOYER_KEY as Hex | undefined;
if (!key) throw new Error("Setup required: NOREN_DEPLOYER_KEY");
const account = privateKeyToAccount(key);
const rh = CHAINS.robinhood;
const chain = viemChain(rh);
const pub = createPublicClient({ chain, transport: http(rh.rpcUrl) });
const wallet = createWalletClient({ account, chain, transport: http(rh.rpcUrl) });
const bnm = parseAbi(["function drip(address)", "function balanceOf(address) view returns (uint256)"]);

if ((await pub.readContract({ address: BNM_ROBINHOOD, abi: bnm, functionName: "balanceOf", args: [account.address] })) < 10n ** 18n) {
  const d = await wallet.writeContract({ address: BNM_ROBINHOOD, abi: bnm, functionName: "drip", args: [account.address] });
  console.log("drip", d, (await pub.waitForTransactionReceipt({ hash: d })).status);
}
const r = await sendViaHub({
  from: "robinhood",
  to: "sepolia",
  payload: aquaOrder({ beneficiary: account.address, ref: keccak256(toHex("noren-bnm-ptt-1")), order: toHex("noren ccip-bnm ptt") }),
  token: { address: BNM_ROBINHOOD, amount: 10n ** 18n },
  wallet,
});
console.log(JSON.stringify({ ...r, nonce: r.nonce.toString(), fee: r.fee.toString() }, null, 2));
