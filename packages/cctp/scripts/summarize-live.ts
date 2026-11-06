// Collects every live record in fixtures/live-*.json into fixtures/live-runs.json (the table in docs/CCTP.md).
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
const dir = new URL("../fixtures/", import.meta.url);
const runs = readdirSync(dir).filter((f) => /^live-.*\.json$/.test(f) && f !== "live-runs.json").sort().map((f) => {
  const r = JSON.parse(readFileSync(new URL(f, dir), "utf8"));
  const ev = (r.arcEvents ?? []) as Array<{ event: string; args: Record<string, unknown> }>;
  const bridged = ev.find((e) => e.event === "Bridged")?.args;
  return {
    file: `packages/cctp/fixtures/${f}`, network: r.network, kind: r.kind ?? "plain",
    amountUsdc6: r.amount, approveTx: r.approveTxHash ?? null, burnTx: r.burnUrl, iris: r.irisUrl,
    nonce: r.nonce ?? bridged?.nonce ?? null, mintedUsdc6: r.minted ?? bridged?.minted ?? null, feeExecutedUsdc6: r.feeExecuted ?? bridged?.feeExecuted ?? null,
    mintTx: r.arcTxUrl ?? r.mintUrl ?? null, relayedBy: r.relayedBy ?? (r.mintUrl ? "SDK mintFromArc (receiveMessage)" : null),
    events: ev.map((e) => `${e.event}`),
  };
});
writeFileSync(new URL("live-runs.json", dir), `${JSON.stringify({ note: "PUBLIC TESTNETS ONLY (no forks). Circle CCTP V2 + Iris sandbox; inbound relays by Noren's CRE workflow with cre workflow simulate --broadcast.", runs }, null, 2)}\n`);
for (const r of runs) console.log(`${r.kind.padEnd(12)} ${r.burnTx}\n             -> ${r.mintTx}`);
