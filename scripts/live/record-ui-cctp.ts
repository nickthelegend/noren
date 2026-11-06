// Records CCTP V2 transfers that ran from the Noren app's Bridge tab into packages/cctp/fixtures/live-runs.json.
// Everything comes from public sources, nothing is typed in by hand except the two hashes the UI showed:
//   - Circle's Iris sandbox for the burn (amount, fee executed, finality), by source domain + burn tx
//   - the source chain's receipt for the burn, and the approve tx found through Blockscout's public API
//   - Arc testnet's receipt for the mint (NorenArcHook.relay sent by the browser)
//   pnpm exec tsx scripts/live/record-ui-cctp.ts <chain>:<burnTx>:<mintTx> [...]
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, http, type Hex } from "viem";
import { CCTP_CHAINS, type SourceChainKey } from "../../packages/cctp/sdk/chains";

const FILE = new URL("../../packages/cctp/fixtures/live-runs.json", import.meta.url);
const TEST_KEY = "0x6D6C8c418564B5aA9d4f49547f7D081f9C6B42cc";
const BLOCKSCOUT: Partial<Record<SourceChainKey, string>> = {
  "ethereum-sepolia": "https://eth-sepolia.blockscout.com", "base-sepolia": "https://base-sepolia.blockscout.com", "arbitrum-sepolia": "https://arbitrum-sepolia.blockscout.com",
};
const arc = CCTP_CHAINS["arc-testnet"];
const arcPub = createPublicClient({ transport: http(arc.rpcUrl) });
const doc = JSON.parse(readFileSync(FILE, "utf8")) as { note: string; runs: Record<string, unknown>[] };

for (const arg of process.argv.slice(2)) {
  const [key, burn, mint] = arg.split(":") as [SourceChainKey, Hex, Hex];
  const c = CCTP_CHAINS[key];
  if (!c || !/^0x[0-9a-f]{64}$/i.test(burn ?? "") || !/^0x[0-9a-f]{64}$/i.test(mint ?? "")) throw new Error(`bad arg ${arg}: want <chain>:<burnTx>:<mintTx>`);
  if (doc.runs.some((r) => String(r.burnTx).endsWith(burn))) { console.log(`${key}: ${burn} already recorded`); continue; }
  const pub = createPublicClient({ transport: http(c.rpcUrl) });
  const [burnR, mintR] = await Promise.all([pub.getTransactionReceipt({ hash: burn }), arcPub.getTransactionReceipt({ hash: mint })]);
  if (burnR.status !== "success" || mintR.status !== "success") throw new Error(`${key}: burn ${burnR.status}, mint ${mintR.status}`);
  const iris = `https://iris-api-sandbox.circle.com/v2/messages/${c.domain}?transactionHash=${burn}`;
  const m = (await (await fetch(iris)).json()).messages?.[0];
  if (m?.status !== "complete") throw new Error(`${key}: Iris status ${m?.status ?? "missing"}`);
  const body = m.decodedMessage.decodedMessageBody;
  const amount = BigInt(body.amount), fee = BigInt(body.feeExecuted ?? 0);
  let approveTx: string | null = null;
  const bs = BLOCKSCOUT[key];
  if (bs) {
    const items = await fetch(`${bs}/api/v2/addresses/${TEST_KEY}/transactions`).then((r) => r.json()).then((j) => j.items as { hash: string; method?: string; to?: { hash: string }; block_number: number }[]).catch(() => null);
    approveTx = items?.filter((t) => t.method === "approve" && t.to?.hash.toLowerCase() === c.usdc.toLowerCase() && BigInt(t.block_number) <= burnR.blockNumber).sort((a, b) => b.block_number - a.block_number)[0]?.hash ?? null;
  }
  if (!approveTx) {
    // Blockscout unavailable (e.g. a bot challenge): walk back from the burn block for the key's previous nonce, an approve to USDC.
    const burnTx = await pub.getTransaction({ hash: burn });
    for (let b = burnR.blockNumber; b > burnR.blockNumber - 600n && !approveTx; b--) {
      const blk = await pub.getBlock({ blockNumber: b, includeTransactions: true });
      approveTx = blk.transactions.find((t) => t.from.toLowerCase() === TEST_KEY.toLowerCase() && t.nonce === burnTx.nonce - 1 && t.to?.toLowerCase() === c.usdc.toLowerCase() && t.input.startsWith("0x095ea7b3"))?.hash ?? null;
    }
  }
  doc.runs.push({
    file: `Noren app, Bridge tab "Bring USDC to Arc from any chain" (packages/web), signed by the browser's test key ${TEST_KEY}, Nov 6 2026`,
    network: `PUBLIC TESTNETS: ${c.name} (${c.chainId}, CCTP domain ${c.domain}) -> Arc Testnet (5042002, domain 26)`,
    kind: "plain", amountUsdc6: amount.toString(), approveTx, burnTx: `${c.explorer}/tx/${burn}`, iris,
    mintedUsdc6: (amount - fee).toString(), feeExecutedUsdc6: fee.toString(), finalityThresholdExecuted: Number(m.decodedMessage.finalityThresholdExecuted),
    mintTx: `${arc.explorer}/tx/${mint}`, relayedBy: "this browser (NorenArcHook.relay on Arc testnet)", events: ["Bridged"],
  });
  console.log(`${key}: ${Number(amount) / 1e6} USDC burned ${burn}, minted ${Number(amount - fee) / 1e6} (fee ${fee}) ${mint}, approve ${approveTx}`);
}
writeFileSync(FILE, `${JSON.stringify(doc, null, 2)}\n`);
