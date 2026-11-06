// Execute an approved settlement:
//   NOREN_KEEPER_PRIVATE_KEY=<key> tsx keeper/execute.ts --rpc <url> --desk <addr> --id <bytes32> --route relay|across
// Prints one JSON line. Refuses non-loopback RPCs unless NOREN_KEEPER_ALLOW_REMOTE=1, so a fork run
// can never send to a public chain by mistake.
import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { acrossDeposit, deskAbi, meetsMinimum, relayDeposit, type Approved } from "./lib";

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (!v) throw new Error(`missing --${name}`);
  return v;
}

async function main() {
  const rpc = arg("rpc"), desk = arg("desk") as Address, id = arg("id") as Hex, route = arg("route");
  if (route !== "relay" && route !== "across") throw new Error("--route must be relay or across");
  const host = new URL(rpc).hostname;
  if (!["127.0.0.1", "localhost", "[::1]"].includes(host) && process.env.NOREN_KEEPER_ALLOW_REMOTE !== "1") {
    throw new Error(`refusing non-local RPC ${host}; set NOREN_KEEPER_ALLOW_REMOTE=1 for a real testnet`);
  }
  const key = process.env.NOREN_KEEPER_PRIVATE_KEY as Hex | undefined;
  if (!key) throw new Error("Setup required: NOREN_KEEPER_PRIVATE_KEY (the desk's keeper account)");
  const account = privateKeyToAccount(key);
  const pub = createPublicClient({ transport: http(rpc) });
  const wallet = createWalletClient({ account, transport: http(rpc) });

  const s = await pub.readContract({ address: desk, abi: deskAbi, functionName: "settlement", args: [id] });
  if (s.status !== 2) throw new Error(`settlement ${id} status ${s.status}, not Approved`);
  const approved: Approved = { desk, arcRecipient: s.arcRecipient, amountUsdg6: s.amountUsdg6, minOutUsdc6: s.minOutUsdc6 };
  const deposit = route === "relay" ? await relayDeposit(approved) : await acrossDeposit(approved);
  meetsMinimum(deposit, approved);

  const hash = await wallet.writeContract({
    address: desk, abi: deskAbi, functionName: "executeSettlement", args: [id, route === "relay" ? 1 : 2, deposit.data], chain: null,
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`executeSettlement reverted: ${hash}`);
  console.log(JSON.stringify({
    route, txHash: hash, target: deposit.to, quotedOutUsdc6: deposit.quotedOutUsdc6.toString(), minOutUsdc6: approved.minOutUsdc6.toString(),
    amountUsdg6: approved.amountUsdg6.toString(), fillSeconds: deposit.seconds, relayRequestId: deposit.ref || undefined, feeUsd: deposit.feeUsd,
    gasUsed: receipt.gasUsed.toString(),
  }));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
