// Live USDC transfer INTO Arc Testnet: burn on a source testnet with Circle CCTP V2 (destinationCaller = NorenArcHook),
// then Noren's Chainlink CRE relay workflow runs with `cre workflow simulate --broadcast` on the real burn log:
// MessageSent trigger -> Iris attestation (consensus) -> report -> Arc MockKeystoneForwarder -> NorenArcHook.onReport.
// Usage: tsx scripts/live-to-arc.ts <fromChain> <amountUsdc> [plain|pay-invoice|earn-deposit|aqua-order|credit-line] [label]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPublicClient, decodeEventLog, http, keccak256, toHex, type Address, type Hex } from "viem";
import { norenArcHookAbi } from "../sdk/abi";
import { toBytes32, type ArcAction } from "../sdk/actions";
import { bridgeToArc, waitForAttestation } from "../sdk/bridge";
import { ARC, CCTP_CHAINS, NOREN_ARC_HOOK, txUrl, type SourceChainKey } from "../sdk/chains";
import { json, loadKey, walletFor, withArcLock } from "./lib";

const [from, amount = "0.5", kind = "plain", label = `${Date.now()}`] = process.argv.slice(2) as [SourceChainKey, string?, string?, string?];
const src = CCTP_CHAINS[from];
if (!src || from === ("arc-testnet" as SourceChainKey)) throw new Error("usage: live-to-arc.ts <fromChain> <amount> [kind] [label]");
if (!NOREN_ARC_HOOK) throw new Error("Setup required: NorenArcHook in deployments.json");
const log = (s: string) => console.log(`${new Date().toISOString()} ${s}`);

const pk = loadKey();
const wallet = walletFor(from, pk);
const me = wallet.account!.address as Address;
const demoMerchant: Address = "0x000000000000000000000000000000000000dEaD";
const actions: Record<string, ArcAction | undefined> = {
  plain: undefined,
  "pay-invoice": { kind: "pay-invoice", merchant: demoMerchant, invoiceId: `inv-${label}`.slice(0, 32), ref: "noren-cctp" },
  "earn-deposit": { kind: "earn-deposit", vault: demoMerchant, ref: "noren-cctp" },
  "aqua-order": { kind: "aqua-order", order: toHex(`aqua-order-${label}`), ref: "noren-cctp" },
  "credit-line": { kind: "credit-line", lineId: toBytes32(`line-${label}`.slice(0, 32)), limitUsdc6: 1_000_000n, expiry: Math.floor(Date.now() / 1000) + 86400, ref: "noren-cctp" },
};
if (!(kind in actions)) throw new Error(`unknown kind ${kind}`);

// Resumable: a burn already recorded for this (chain, kind) without an Arc tx is relayed, never burned again.
const OUT = new URL(`../fixtures/live-${from}-to-arc-${kind}.json`, import.meta.url);
const prior = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : null;
const burn = prior?.burnTxHash && !prior.arcTxHash
  ? { ...prior, amount: BigInt(prior.amount), maxFee: BigInt(prior.maxFee) }
  : await bridgeToArc({ fromChain: from, amount, recipient: me, action: actions[kind], walletClient: wallet, waitForMint: false, onStatus: (s) => log(`status ${json(s)}`) });
if (prior?.arcTxHash) throw new Error(`${fileURLToPath(OUT)} is already complete; pass a new kind or move it`);
if (!prior?.burnTxHash) writeFileSync(OUT, `${json({ ...burn, pending: "burned; CRE relay not run yet" })}\n`);
log(`burn ${burn.burnUrl}`);

const pub = createPublicClient({ transport: http(src.rpcUrl) });
const receipt = await pub.getTransactionReceipt({ hash: burn.burnTxHash });
const MESSAGE_SENT = keccak256(toHex("MessageSent(bytes)"));
const eventIndex = receipt.logs.findIndex((l) => l.address.toLowerCase() === src.messageTransmitter.toLowerCase() && l.topics[0] === MESSAGE_SENT);
if (eventIndex < 0) throw new Error("no MessageSent in the burn receipt");

// Wait for Circle's attestation before triggering the relay (a deployed DON's log trigger fires at chain finality).
const attested = await waitForAttestation(src, burn.burnTxHash, Date.now() + 30 * 60_000, 4000, (s) => log(`status ${json(s)}`));
log("Circle attestation complete");

const config = JSON.parse(readFileSync(new URL("../cre/cctp-relay/config.staging.json", import.meta.url), "utf8"));
const triggerIndex = config.sources.findIndex((s: { key: string }) => s.key === from);
if (triggerIndex < 0) throw new Error(`${from} is not a source in the CRE relay config`);

const simLog = await withArcLock(async () => {
  try {
    return execFileSync("cre", ["workflow", "simulate", "cctp-relay", "--target", "staging-settings", "--non-interactive",
      "--trigger-index", String(triggerIndex), "--evm-tx-hash", burn.burnTxHash, "--evm-event-index", String(eventIndex), "--broadcast"], {
      cwd: fileURLToPath(new URL("../cre", import.meta.url)), encoding: "utf8", env: { ...process.env, CRE_ETH_PRIVATE_KEY: pk.slice(2) }, maxBuffer: 1 << 24,
    });
  } catch (e) {
    const out = `${(e as { stdout?: string }).stdout ?? ""}${(e as { stderr?: string }).stderr ?? ""}`;
    throw new Error(`cre workflow simulate failed:\n${out.split("\n").filter((l) => /USER LOG|✗|rror/.test(l)).join("\n")}`);
  }
});
const userLines = simLog.split("\n").filter((l) => /\[USER LOG\]|Workflow Simulation Result/.test(l));
const result = simLog.split("\n")[simLog.split("\n").findIndex((l) => l.includes("Workflow Simulation Result")) + 1] ?? "";
for (const l of userLines) log(`cre | ${l.trim()}`);
const arcTx = (simLog.match(/through NorenArcHook: tx (0x[0-9a-f]{64})/) ?? [])[1] as Hex | undefined;
if (!arcTx) throw new Error(`the CRE relay did not write on Arc:\n${userLines.join("\n")}`);

const arc = createPublicClient({ transport: http(ARC.rpcUrl) });
const r = await arc.waitForTransactionReceipt({ hash: arcTx });
const events = r.logs.filter((l) => l.address.toLowerCase() === NOREN_ARC_HOOK!.toLowerCase()).map((l) => {
  const d = decodeEventLog({ abi: norenArcHookAbi, data: l.data, topics: l.topics });
  return { event: d.eventName, args: d.args };
});
const bridged = events.find((e) => e.event === "Bridged");
if (r.status !== "success" || !bridged) throw new Error(`Arc tx ${txUrl("arc-testnet", arcTx)} has no Bridged event`);
log(`Arc mint via CRE ${txUrl("arc-testnet", arcTx)}`);

const rec = {
  network: `PUBLIC TESTNETS: ${src.name} (${src.chainId}, CCTP domain ${src.domain}) -> Arc Testnet (5042002, domain 26)`,
  relayedBy: "Chainlink CRE workflow packages/cctp/cre/cctp-relay, cre workflow simulate --broadcast (CRE CLI v1.39), arc-testnet MockKeystoneForwarder",
  kind, ...burn, burnEventIndex: eventIndex, irisUrl: `https://iris-api-sandbox.circle.com/v2/messages/${src.domain}?transactionHash=${burn.burnTxHash}`,
  message: attested.message, attestation: attested.attestation, creTriggerIndex: triggerIndex, creLog: userLines.map((l) => l.trim()), creResult: result.trim(),
  arcTxHash: arcTx, arcTxUrl: txUrl("arc-testnet", arcTx), arcForwarder: r.to, arcEvents: events, completedAt: new Date().toISOString(),
};
writeFileSync(OUT, `${json(rec)}\n`);
