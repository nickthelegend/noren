/** Reads for NorenReputation (points, milestones, LTV tiers). Addresses come from /config; nothing is assumed. */
import { parseAbi, type Address } from "viem";
import type { Wallet } from "./NorenApp";

export type Milestone = { id: string; title: string; detail: string; done: boolean; boost?: string };

export const reputationAbi = parseAbi([
  "function breakdownOf(address account) view returns ((uint32 onTime, uint32 late, uint32 repaidLoans, uint32 liquidations, uint64 firstSeenAt, uint64 ageDays, bool verifiedHuman, uint256 points, uint256 milestones, uint8 tier, uint16 ltvBps, uint16 limitMultiplierBps))",
  "function creditLimitOf(address account) view returns (uint256 totalUsd6, uint256 securedUsdg, uint256 starterUsdc)",
  "function tierTable(uint8 t) pure returns ((uint16 ltvBps, uint16 limitMultiplierBps, uint16 minPoints, bool needsHuman, bool needsRepayment))",
]);

const M = [
  { bit: 0, id: "human", title: "Verified human", detail: "World ID, one account per person", boost: "+50 pts" },
  { bit: 3, id: "ontime3", title: "Three on-time installments", detail: "Pay in 3 on NorenCredit", boost: "+30 pts" },
  { bit: 4, id: "loan1", title: "First loan repaid", detail: "A NorenBorrow loan repaid in full", boost: "+25 pts" },
  { bit: 5, id: "loan3", title: "Three loans repaid", detail: "NorenBorrow", boost: "+75 pts" },
  { bit: 6, id: "clean", title: "Clean record", detail: "No late payments or liquidations" },
  { bit: 1, id: "age30", title: "Account 30 days old", detail: "Signed by the underwriter from Robinhood Chain history", boost: "+20 pts" },
  { bit: 2, id: "age180", title: "Account 180 days old", detail: "Signed by the underwriter", boost: "+20 pts" },
];

export async function readReputation(w: Wallet, reputation: Address): Promise<Milestone[]> {
  const { pub } = w.oc.robinhood();
  const b = await pub.readContract({ address: reputation, abi: reputationAbi, functionName: "breakdownOf", args: [w.oc.address] });
  return M.map((m) => ({ id: m.id, title: m.title, detail: m.id === "human" && b.verifiedHuman ? "Verified with World ID" : m.id === "ontime3" ? `${b.onTime} of 3 on time` : m.id === "loan1" || m.id === "loan3" ? `${b.repaidLoans} repaid` : m.detail, done: (b.milestones & (1n << BigInt(m.bit))) !== 0n, boost: m.boost }));
}

export async function readTier(w: Wallet, reputation: Address) {
  const { pub } = w.oc.robinhood();
  const [b, limit] = await Promise.all([
    pub.readContract({ address: reputation, abi: reputationAbi, functionName: "breakdownOf", args: [w.oc.address] }),
    pub.readContract({ address: reputation, abi: reputationAbi, functionName: "creditLimitOf", args: [w.oc.address] }),
  ]);
  return { points: b.points, tier: b.tier, ltvBps: b.ltvBps, multiplierBps: b.limitMultiplierBps, verifiedHuman: b.verifiedHuman, totalUsd6: limit[0], securedUsdg: limit[1], starterUsdc: limit[2] };
}
