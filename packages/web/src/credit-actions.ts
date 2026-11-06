/**
 * The credit-line calls behind the Noren app:
 * - the history underwriter (packages/robinhood): factor scores and an EIP-712 attestation NorenCredit verifies
 * - the AI credit check on 0G Private Computer (packages/ai-underwriter): decision, rationale, request ID, TEE status
 * - NorenCredit + NorenAssetOracle on the Robinhood fork: terms, collateral value, applyAttestation, openCreditLine
 * - NorenCreditLine on Arc: the bridged line
 * Anything not running fails with "Setup required"; nothing here invents a number.
 */
import { erc20Abi, parseAbi, parseUnits, type Address, type Hex } from "viem";
import type { Config } from "./api";
import type { Holding, Line, Onchain } from "./onchain";

export type Factor = { label: string; value: string; note?: string; points?: number; max?: number; missing?: boolean };
/** What a verified Reclaim proof does to the history score ("reclaim" on the underwriter's /score). */
export type ReclaimBoost = { verified: boolean; provider?: string; points: number; maxPoints: number; decidedBy: string; ifVerified: { score: number; tier: number; limitUsdg: bigint; collateralRatioBps: number } };
export type Underwriting = { score: number; tier: string; tierIndex: number; tiers: { name: string }[]; ltvBps: number; limitUsdg: bigint; factors: Factor[]; signer: string; onchainTier?: number; expires?: number; reclaim?: ReclaimBoost };
export type AiCheck = { status: "approved" | "declined" | "refused"; tier?: number; limitUsdg?: number; collateralRatioBps?: number; rationale?: string; riskFlags?: string[]; requestId?: string; teeVerified?: boolean | null; independent?: string; verifiability?: string; provider?: string; model?: string; reason?: string; setupRequired?: boolean };
export type Quote = { collateral8: bigint; ltvBps: number; limitUsdc6: bigint; termDays: number; liquidation8?: bigint; tier: number; needsAttestation: boolean; repLtvBps?: number };
/** Something NorenCredit takes as line collateral: a Stock Token, or Earn deposit-vault shares (nNVDA, nETH…) that keep earning Aqua fees. */
export type Collateral = { sym: string; token: Address; decimals: number; balance: bigint; kind: "stock" | "shares"; price8?: bigint; underlying?: Address };
export type LineYield = { pendingUsdg: bigint; paidUsdc6: bigint; paidUsdg: bigint; outstandingUsdc6: bigint; shares: bigint; sym: string };
export type Position = { live: boolean; closed: boolean; limit: bigint; expiry: number; drawn: bigint; repaid: bigint; updatedAt: number; available: bigint };

const creditAbi = parseAbi([
  "function creditTerms(address) view returns (uint8 tier, uint256 limitUsdg, uint16 ratioBps, uint256 availableUsdg)",
  "function params() view returns (uint32 installmentInterval, uint32 gracePeriod, uint16 liquidationThresholdBps, uint16 liquidationBonusBps, uint16 merchantFeeBps, uint32 maxLineDuration, uint32 reportSkew)",
  "function applyAttestation((address borrower,uint8 tier,uint256 limitUsdg,uint16 collateralRatioBps,uint256 nonce,uint64 expiry) a, bytes signature)",
  "function openCreditLine(address collateral, uint256 collateralAmount, uint256 limitUsdc6, uint64 expiry) payable returns (bytes32)",
  "function shareVaultStatus(address) view returns (uint8)",
  "function line(bytes32) view returns ((address borrower, address collateral, uint64 expiry, uint64 asOf, uint64 closeRequestedAt, uint8 status, uint256 collateralAmount, uint256 limitUsdc, uint256 drawn, uint256 repaid))",
  "function lineOutstanding(bytes32) view returns (uint256)",
  "function harvestLineToRepay(bytes32 lineId) returns (uint256 shares)",
  "function claimLineYield(bytes32 lineId) returns (uint256 shares)",
]);
const lensAbi = parseAbi([
  "function maxCreditLimit(address borrower, address collateral, uint256 amount) view returns (uint256 limitUsdc6, uint256 valueUsd8, uint16 ltvBps)",
  "function lineYield(bytes32 lineId) view returns (uint256 pendingUsdg, uint256 paidUsdc6, uint256 paidUsdg)",
]);
const repLtvAbi = parseAbi(["function ltvOf(address) view returns (uint16)"]);
const TIERS = ["Declined", "Tier 1", "Tier 2", "Tier 3", "Tier 4"].map((name) => ({ name }));
const setup = (what: string) => new Error(`Setup required: ${what}`);
const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

async function getJson(url: string, init?: RequestInit) {
  let r: Response;
  try { r = await fetch(url, init); } catch { throw setup(`can't reach ${new URL(url).origin}`); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok && !j.status) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
}

export function creditActions(_cfg: Config, oc: Onchain) {
  const c = oc.credit;
  const contract = () => { if (!c?.creditContract) throw setup("NorenCredit isn't deployed on the Robinhood fork (packages/robinhood)"); return c.creditContract; };
  const terms = async () => { const { pub } = oc.robinhood(); return pub.readContract({ address: contract(), abi: creditAbi, functionName: "creditTerms", args: [oc.address] }); };

  return {
    /** History score from the underwriter, plus the terms NorenCredit holds on-chain for this wallet. */
    async underwrite(): Promise<Underwriting> {
      if (!c?.underwriterUrl) throw setup("the history underwriter isn't running (packages/robinhood)");
      const { score, reclaim } = await getJson(`${c.underwriterUrl}/score/${oc.address}`);
      const onchain = c.creditContract ? await terms().catch(() => null) : null;
      const factors: Factor[] = (score.factors ?? []).map((f: { label: string; value: number | string; points: number; maxPoints: number; status: string; note: string; id: string }) => ({
        label: f.label, points: f.points, max: f.maxPoints, missing: f.status !== "available",
        value: typeof f.value === "number" ? (/holdings/i.test(f.id) ? usd(f.value) : f.value.toLocaleString("en-US", { maximumFractionDigits: 0 })) : f.value,
        note: f.status === "available" ? `${f.points.toFixed(1)} of ${f.maxPoints} points` : `Unavailable: ${f.note}`,
      }));
      return { score: score.score, tier: TIERS[score.tier]?.name ?? `Tier ${score.tier}`, tierIndex: score.tier - 1, tiers: TIERS.slice(1), ltvBps: score.collateralRatioBps, limitUsdg: BigInt(score.limitUsdg), factors, signer: "", onchainTier: onchain ? Number(onchain[0]) : undefined,
        ...(reclaim ? { reclaim: { verified: !!reclaim.verified, provider: reclaim.provider, points: Number(reclaim.points), maxPoints: Number(reclaim.maxPoints ?? 20), decidedBy: String(reclaim.decidedBy ?? ""), ifVerified: { score: Number(reclaim.ifVerified.score), tier: Number(reclaim.ifVerified.tier), limitUsdg: BigInt(reclaim.ifVerified.limitUsdg), collateralRatioBps: Number(reclaim.ifVerified.collateralRatioBps ?? 0) } } } : {}) };
    },
    /** The sealed AI credit check on 0G Private Computer. Refusals (including "Setup required") come back as data. */
    async aiCheck(): Promise<AiCheck> {
      if (!c?.aiUnderwriterUrl) throw setup("the 0G credit check isn't running (packages/ai-underwriter)");
      const r = await getJson(`${c.aiUnderwriterUrl}/v1/credit-check/wallet`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: oc.address }) });
      if (r.error) throw new Error(r.error);
      const e = r.evidence ?? {};
      return { status: r.status, tier: r.decision?.tier, limitUsdg: r.decision?.limitUsdg, collateralRatioBps: r.decision?.collateralRatioBps, rationale: r.decision?.rationale, riskFlags: r.decision?.riskFlags, requestId: e.requestId, teeVerified: e.teeVerified, independent: e.independent?.status, verifiability: e.independent?.service?.verifiability, provider: e.provider, model: e.model, reason: r.reason, setupRequired: r.setupRequired };
    },
    /** The last stored 0G decision for this wallet (the server keeps every result; no new 0G call). */
    async lastAiDecision(): Promise<(AiCheck & { at?: number }) | null> {
      if (!c?.aiUnderwriterUrl) return null;
      const r = await getJson(`${c.aiUnderwriterUrl}/v1/decisions?limit=200`);
      const d = (r.decisions ?? []).find((x: any) => typeof x.subject === "string" && x.subject.toLowerCase() === oc.address.toLowerCase() && (x.status === "approved" || x.status === "declined"));
      if (!d) return null;
      const e = d.evidence ?? {};
      return { status: d.status, tier: d.decision?.tier, limitUsdg: d.decision?.limitUsdg, collateralRatioBps: d.decision?.collateralRatioBps, rationale: d.decision?.rationale, riskFlags: d.decision?.riskFlags, requestId: e.requestId, teeVerified: e.teeVerified, independent: e.independent?.status, verifiability: e.independent?.service?.verifiability, provider: e.provider, model: e.model, at: d.decidedAt ?? d.at };
    },
    /** Every collateral this wallet can lock on NorenCredit: Stock Tokens it holds and Earn deposit-vault shares (nNVDA…). */
    async collaterals(): Promise<Collateral[]> {
      const { pub } = oc.robinhood();
      const stocks: Collateral[] = (oc.credit ? (await oc.holdings()).stocks : []).map((s) => ({ sym: s.sym, token: s.token, decimals: 18, balance: s.balance, kind: "stock" as const, price8: s.price8 }));
      const vaults = (c?.depositVaults as { asset: Address; vault: Address }[] | undefined) ?? [];
      const shares = await Promise.all(vaults.map(async (v) => {
        const [sym, dec, bal, status] = await Promise.all([
          pub.readContract({ address: v.vault, abi: erc20Abi, functionName: "symbol" }),
          pub.readContract({ address: v.vault, abi: erc20Abi, functionName: "decimals" }),
          pub.readContract({ address: v.vault, abi: erc20Abi, functionName: "balanceOf", args: [oc.address] }),
          pub.readContract({ address: contract(), abi: creditAbi, functionName: "shareVaultStatus", args: [v.vault] }).catch(() => 0),
        ]);
        return { sym, token: v.vault, decimals: Number(dec), balance: bal, kind: "shares" as const, underlying: v.asset, accepted: Number(status) === 1 };
      }));
      return [...shares.filter((s) => s.accepted), ...stocks];
    },
    /**
     * What locking `amount` of a collateral gives: NorenCreditLens.maxCreditLimit (its risk value x the tier LTV, capped by
     * the on-chain reputation tier and the available credit), the same arithmetic NorenCredit.openCreditLine checks. When
     * no attestation is applied yet, or the reputation tier now allows more than the applied one, it says so and estimates.
     */
    async quote(s: Collateral, amount: string): Promise<Quote> {
      const { pub } = oc.robinhood();
      if (!c?.creditLens) throw setup("NorenCreditLens isn't in this stack's config (rebuild the Robinhood snapshot: sh packages/robinhood/scripts/fork-snapshot.sh)");
      const raw = parseUnits(amount, s.decimals);
      const [[limitUsdc6, value8, lensLtv], t, p, repLtv] = await Promise.all([
        pub.readContract({ address: c.creditLens as Address, abi: lensAbi, functionName: "maxCreditLimit", args: [oc.address, s.token, raw] }),
        terms(),
        pub.readContract({ address: contract(), abi: creditAbi, functionName: "params" }),
        c.reputation ? pub.readContract({ address: c.reputation as Address, abi: repLtvAbi, functionName: "ltvOf", args: [oc.address] }) : Promise.resolve(0),
      ]);
      const appliedLtv = Number(t[2]) ? Math.floor(1e8 / Number(t[2])) : 0;
      // Re-attest when there are no terms yet, or the on-chain reputation tier lends more than the applied terms do.
      const needsAttestation = Number(t[2]) === 0 || (Number(repLtv) > 0 && appliedLtv + 1 < Math.min(Number(repLtv), 8000));
      let ltvBps = Number(lensLtv), limit = limitUsdc6;
      if (needsAttestation) {
        // Estimate: the reputation tier's LTV on the risk value (the underwriter signs it for secured lines; see attest.ts).
        ltvBps = Math.min(Number(repLtv) || 6600, 8000);
        limit = (value8 / 100n) * BigInt(ltvBps) / 10_000n;
      }
      const liquidation8 = s.kind === "stock" && raw > 0n ? (limit * 100n * BigInt(p[2]) / 10_000n) * 10n ** 18n / raw : undefined;
      return { collateral8: value8, ltvBps, limitUsdc6: limit, termDays: 30, liquidation8, tier: Number(t[0]), needsAttestation, repLtvBps: Number(repLtv) };
    },
    /** Attest if needed, then lock the collateral and open the line on Robinhood. The CRE bridge takes it to Arc. */
    async open(s: Collateral, amount: string, say: (step: string) => void = () => {}): Promise<{ text: string; hash: Hex }> {
      const { pub, wallet, chain } = oc.robinhood();
      const q = await this.quote(s, amount);
      const send = async (req: Parameters<typeof wallet.writeContract>[0]) => { const h = await wallet.writeContract(req); const r = await pub.waitForTransactionReceipt({ hash: h }); if (r.status !== "success") throw new Error(`${req.functionName} reverted: ${h}`); return h; };
      if (q.needsAttestation) {
        say("Asking the underwriter: it reads this wallet's history and on-chain reputation (about 30 s)…");
        const a = await getJson(`${c!.underwriterUrl}/attest`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ borrower: oc.address }) });
        if (a.declined) throw new Error(`Declined by the underwriter: ${a.reason}`);
        say(`Signed: tier ${a.attestation.tier}, ${(1e4 / a.attestation.collateralRatioBps * 100).toFixed(0)}% LTV (${a.decisionSource ?? "underwriter"}). Applying the EIP-712 attestation on NorenCredit…`);
        const att = a.attestation;
        await send({ address: contract(), abi: creditAbi, functionName: "applyAttestation", args: [{ borrower: att.borrower as Address, tier: att.tier, limitUsdg: BigInt(att.limitUsdg), collateralRatioBps: att.collateralRatioBps, nonce: BigInt(att.nonce), expiry: BigInt(att.expiry) }, a.signature as Hex], chain });
      }
      // The line is sized from NorenCreditLens.maxCreditLimit after the terms are on-chain, never from an estimate.
      const raw = parseUnits(amount, s.decimals);
      const [max] = await pub.readContract({ address: c!.creditLens as Address, abi: lensAbi, functionName: "maxCreditLimit", args: [oc.address, s.token, raw] });
      const limit = (max / 10_000n) * 10_000n; // whole cents
      if (limit === 0n) throw new Error("NorenCreditLens.maxCreditLimit allows no line for this collateral yet");
      say(`Locking ${amount} ${s.sym} and opening a ${(Number(limit) / 1e6).toFixed(2)} USDC line on Robinhood…`);
      await send({ address: s.token, abi: erc20Abi, functionName: "approve", args: [contract(), raw], chain });
      const expiry = BigInt(Math.floor(Date.now() / 1000) + 30 * 86400);
      const h = await send({ address: contract(), abi: creditAbi, functionName: "openCreditLine", args: [s.token, raw, limit, expiry], chain });
      return { text: `Locked ${amount} ${s.sym} and opened a ${(Number(limit) / 1e6).toFixed(2)} USDC line on Robinhood`, hash: h };
    },
    /** A share-backed line's yield (NorenCreditLens.lineYield) and what NorenCredit still counts as owed on Robinhood. */
    async lineYield(lineId: Hex): Promise<LineYield | null> {
      const { pub } = oc.robinhood();
      if (!c?.creditLens) return null;
      const l = await pub.readContract({ address: contract(), abi: creditAbi, functionName: "line", args: [lineId] });
      const isShares = Number(await pub.readContract({ address: contract(), abi: creditAbi, functionName: "shareVaultStatus", args: [l.collateral] }).catch(() => 0)) !== 0;
      if (!isShares) return null;
      const [[pendingUsdg, paidUsdc6, paidUsdg], outstanding, sym] = await Promise.all([
        pub.readContract({ address: c.creditLens as Address, abi: lensAbi, functionName: "lineYield", args: [lineId] }),
        pub.readContract({ address: contract(), abi: creditAbi, functionName: "lineOutstanding", args: [lineId] }),
        pub.readContract({ address: l.collateral, abi: erc20Abi, functionName: "symbol" }),
      ]);
      return { pendingUsdg, paidUsdc6, paidUsdg, outstandingUsdc6: outstanding, shares: l.collateralAmount, sym };
    },
    /** Anyone: put a share-backed line's yield toward what it owes (NorenCredit.harvestLineToRepay). */
    async harvest(lineId: Hex): Promise<Hex> {
      const { pub, wallet, chain } = oc.robinhood();
      await pub.simulateContract({ account: wallet.account!, address: contract(), abi: creditAbi, functionName: "harvestLineToRepay", args: [lineId] });
      const h = await wallet.writeContract({ address: contract(), abi: creditAbi, functionName: "harvestLineToRepay", args: [lineId], chain, account: wallet.account! });
      if ((await pub.waitForTransactionReceipt({ hash: h })).status !== "success") throw new Error(`harvestLineToRepay reverted: ${h}`);
      return h;
    },
    /** Borrower, nothing owed: take the yield (NorenCredit.claimLineYield). */
    async claim(lineId: Hex): Promise<Hex> {
      const { pub, wallet, chain } = oc.robinhood();
      await pub.simulateContract({ account: wallet.account!, address: contract(), abi: creditAbi, functionName: "claimLineYield", args: [lineId] });
      const h = await wallet.writeContract({ address: contract(), abi: creditAbi, functionName: "claimLineYield", args: [lineId], chain, account: wallet.account! });
      if ((await pub.waitForTransactionReceipt({ hash: h })).status !== "success") throw new Error(`claimLineYield reverted: ${h}`);
      return h;
    },
    arcLine: (lineId: Hex): Promise<Position> => oc.arcLine(lineId),
    /**
     * A suggested repayment plan: the amount drawn, in four equal parts spread over the line's term. The contract itself
     * only requires that nothing is owed after the line expires (plus a grace period); this is guidance, not a rule.
     */
    /** Installment count from NorenCredit (public INSTALLMENTS). null when the contract doesn't expose it. */
    async installments(): Promise<number | null> {
      try { const { pub } = oc.robinhood(); return Number(await pub.readContract({ address: contract(), abi: parseAbi(["function INSTALLMENTS() view returns (uint256)"]), functionName: "INSTALLMENTS" })); }
      catch { return null; }
    },
    async schedule(line: Line): Promise<{ due: number; amount: bigint; paid: boolean }[]> {
      if (line.drawn === 0n) return [];
      const n = await this.installments();
      if (!n) return [];
      // Lines from the Noren app run 30 days, so the plan spans the line's own term (stable across reloads).
      const span = 30 * 86400, start = line.expiry - span;
      const part = line.drawn / BigInt(n), parts = Array.from({ length: n }, (_, i) => (i === n - 1 ? line.drawn - part * BigInt(n - 1) : part));
      let covered = line.repaid;
      return parts.map((amount, i) => { const paid = covered >= amount; covered = paid ? covered - amount : 0n; return { due: start + Math.round((span * (i + 1)) / n), amount, paid }; });
    },
  };
}
