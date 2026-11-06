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
export type Quote = { collateral8: bigint; ltvBps: number; limitUsdc6: bigint; termDays: number; liquidation8?: bigint; tier: number; needsAttestation: boolean };
export type Position = { live: boolean; closed: boolean; limit: bigint; expiry: number; drawn: bigint; repaid: bigint; updatedAt: number; available: bigint };

const creditAbi = parseAbi([
  "function creditTerms(address) view returns (uint8 tier, uint256 limitUsdg, uint16 ratioBps, uint256 availableUsdg)",
  "function params() view returns (uint32 installmentInterval, uint32 gracePeriod, uint16 liquidationThresholdBps, uint16 liquidationBonusBps, uint16 merchantFeeBps, uint32 maxLineDuration, uint32 reportSkew)",
  "function applyAttestation((address borrower,uint8 tier,uint256 limitUsdg,uint16 collateralRatioBps,uint256 nonce,uint64 expiry) a, bytes signature)",
  "function openCreditLine(address collateral, uint256 collateralAmount, uint256 limitUsdc6, uint64 expiry) payable returns (bytes32)",
]);
const oracleAbi = parseAbi(["function riskValueUsd8(address asset, uint256 amount) view returns (uint256)"]);
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
    /** What locking `amount` of a Stock Token would give, from NorenCredit's own terms and NorenAssetOracle's risk value. */
    async quote(s: Holding, amount: string): Promise<Quote> {
      const { pub } = oc.robinhood();
      if (!c?.stockOracle) throw setup("NorenAssetOracle isn't deployed on the Robinhood fork (packages/robinhood)");
      const raw = parseUnits(amount, 18);
      const [t, p, value8] = await Promise.all([terms(), pub.readContract({ address: contract(), abi: creditAbi, functionName: "params" }), pub.readContract({ address: c.stockOracle, abi: oracleAbi, functionName: "riskValueUsd8", args: [s.token, raw] })]);
      let ratio = Number(t[2]), available = t[3], tier = Number(t[0]);
      const needsAttestation = ratio === 0;
      if (needsAttestation) {
        const u = await this.underwrite();
        if (u.tierIndex < 0) throw new Error(`Declined by the underwriter (score ${u.score} of 100). See the factors under "Reputation".`);
        ratio = u.ltvBps; available = u.limitUsdg; tier = u.tierIndex + 1;
      }
      const byCollateral = (value8 / 100n) * 10_000n / BigInt(ratio); // usd8 → usdc6 at $1, divided by the ratio
      const limitUsdc6 = byCollateral < available ? byCollateral : available;
      const liquidation8 = raw > 0n ? (limitUsdc6 * 100n * BigInt(p[2]) / 10_000n) * 10n ** 18n / raw : undefined;
      return { collateral8: value8, ltvBps: Math.round(1e8 / ratio), limitUsdc6, termDays: 30, liquidation8, tier, needsAttestation };
    },
    /** Attest if needed, then lock the shares and open the line on Robinhood. The CRE bridge takes it to Arc. */
    async open(s: Holding, amount: string, say: (step: string) => void = () => {}): Promise<{ text: string; hash: Hex }> {
      const { pub, wallet, chain } = oc.robinhood();
      const q = await this.quote(s, amount);
      const send = async (req: Parameters<typeof wallet.writeContract>[0]) => { const h = await wallet.writeContract(req); const r = await pub.waitForTransactionReceipt({ hash: h }); if (r.status !== "success") throw new Error(`${req.functionName} reverted: ${h}`); return h; };
      if (q.needsAttestation) {
        say("Asking the underwriter: it reads this wallet's Robinhood Chain history (about 30 s)…");
        const a = await getJson(`${c!.underwriterUrl}/attest`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ borrower: oc.address }) });
        if (a.declined) throw new Error(`Declined by the underwriter: ${a.reason}`);
        say(`Signed: tier ${a.attestation.tier} (${a.decisionSource ?? "underwriter"}). Applying the EIP-712 attestation on NorenCredit…`);
        const att = a.attestation;
        await send({ address: contract(), abi: creditAbi, functionName: "applyAttestation", args: [{ borrower: att.borrower as Address, tier: att.tier, limitUsdg: BigInt(att.limitUsdg), collateralRatioBps: att.collateralRatioBps, nonce: BigInt(att.nonce), expiry: BigInt(att.expiry) }, a.signature as Hex], chain });
      }
      // The signed attestation, not the score, sets the terms (the 0G check or the reputation multiplier can change them),
      // so price the line again from NorenCredit's on-chain terms before opening it.
      const final = q.needsAttestation ? await this.quote(s, amount) : q;
      if (final.limitUsdc6 !== q.limitUsdc6) say(`The signed terms lend ${final.ltvBps / 100}% of value: opening a ${(Number(final.limitUsdc6) / 1e6).toFixed(2)} USDC line.`);
      q.limitUsdc6 = final.limitUsdc6;
      const raw = parseUnits(amount, 18);
      say(`Locking ${amount} ${s.sym} and opening the line on Robinhood…`);
      await send({ address: s.token, abi: erc20Abi, functionName: "approve", args: [contract(), raw], chain });
      const expiry = BigInt(Math.floor(Date.now() / 1000) + 30 * 86400);
      const h = await send({ address: contract(), abi: creditAbi, functionName: "openCreditLine", args: [s.token, raw, q.limitUsdc6, expiry], chain });
      return { text: `Locked ${amount} ${s.sym} and opened a ${(Number(q.limitUsdc6) / 1e6).toFixed(2)} USDC line on Robinhood`, hash: h };
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
