// Prints every hop of a Noren CCIP message: CCIP API status, explorer link, tx hashes, hub forward, final delivery.
// Usage: tsx scripts/journey.ts <firstMessageId> <from> <to>   (from/to: arc | robinhood | baseSepolia | sepolia)
import type { Hex } from "viem";
import { trackJourney, type ChainKey } from "../sdk/index.ts";

const [id, from, to] = process.argv.slice(2) as [Hex, ChainKey, ChainKey];
if (!id || !from || !to) throw new Error("usage: journey.ts <firstMessageId> <from> <to>");
const j = await trackJourney(id, from, to);
for (const h of j.hops) {
  console.log(`${h.from} -> ${h.to}: ${h.ccipStatus}${h.hubForward ? ` (hub ${h.hubForward})` : ""}`);
  if (h.messageId) console.log(`  ${h.explorer}`);
  if (h.sendTx) console.log(`  send    ${h.sendTx}`);
  if (h.receiptTx) console.log(`  receipt ${h.receiptTx}`);
  if (h.readyForManualExecution) console.log("  ready for manual execution in the CCIP explorer");
}
console.log(`final: ${j.final}`);
