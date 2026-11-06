/**
 * One CCTP V2 transfer into Arc from this browser's test key, on public testnets, with the SDK's live status steps.
 * The key is the same one the Noren app and checkout use (a test key kept in this browser, never sent anywhere).
 * It needs testnet USDC and gas on the source chain; without them the SDK stops with "Setup required: …".
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createWalletClient, defineChain, formatUnits, http, type Address, type Hex } from "viem";
import { bridgeToArc, fetchFeeBps, maxFeeFor, FINALITY_FAST, CCTP_CHAINS, type ArcAction, type BridgeStatus, type CctpChainKey, type RelayMode, type SourceChainKey } from "@noren/cctp";
import { customerAccount } from "./onchain";
import { balancesOn } from "./crosschain";

const chainOf = (k: CctpChainKey) => {
  const c = CCTP_CHAINS[k];
  return defineChain({ id: c.chainId, name: c.name, nativeCurrency: { name: c.gas, symbol: c.gas, decimals: 18 }, rpcUrls: { default: { http: [c.rpcUrl] } }, blockExplorers: { default: { name: "explorer", url: c.explorer } } });
};
const walletOn = (k: CctpChainKey) => createWalletClient({ account: customerAccount(), chain: chainOf(k), transport: http(CCTP_CHAINS[k].rpcUrl, { timeout: 30_000 }) });

export type Flow = {
  phase: "idle" | "running" | "done" | "error";
  from: SourceChainKey;
  amount: bigint;
  approveTx?: Hex; burnTx?: Hex; mintTx?: Hex;
  iris?: string; minted?: bigint; fee?: bigint; via?: string; startedAt?: number; seconds?: number;
  now?: BridgeStatus["step"];
  error?: string;
};

/** Live balances of the test key on a source chain and on Arc testnet (USDC as Arc's gas, 18-dp native). */
export function useSourceBalances(from: CctpChainKey, who: Address, tick = 0) {
  const [b, setB] = useState<{ usdc: bigint; gas: bigint } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let on = true; setB(null); setErr(null);
    balancesOn(from, who).then((x) => on && setB(x)).catch((e) => on && setErr(`${CCTP_CHAINS[from].name} RPC: ${String(e?.shortMessage ?? e?.message ?? e).slice(0, 140)}`));
    return () => { on = false; };
  }, [from, who, tick]);
  return { b, err };
}

/** Circle's fast-transfer fee for source → Arc (Iris sandbox), in bps. */
export function useFastFee(from: SourceChainKey) {
  const [bps, setBps] = useState<number | null>(null);
  useEffect(() => { let on = true; setBps(null); fetchFeeBps(CCTP_CHAINS[from].domain, 26, FINALITY_FAST).then((x) => on && setBps(x)).catch(() => on && setBps(null)); return () => { on = false; }; }, [from]);
  return bps;
}

/** The burn amount that lands at least `net` on Arc after the fast fee (Circle charges at most maxFee). */
export function grossFor(net: bigint, bps: number | null, fast: boolean) {
  if (!fast || !bps) return net;
  let g = net + maxFeeFor(net, bps);
  while (g - maxFeeFor(g, bps) < net) g += 1n;
  return g;
}

export function useCctpFlow() {
  const [f, setF] = useState<Flow | null>(null);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const run = useCallback(async (p: { from: SourceChainKey; amount: bigint; recipient: Address; action?: ArcAction; fast: boolean; relay: RelayMode }) => {
    const startedAt = Date.now();
    const base: Flow = { phase: "running", from: p.from, amount: p.amount, startedAt };
    setF(base);
    const put = (x: Partial<Flow>) => live.current && setF((o) => (o && o.startedAt === startedAt ? { ...o, ...x } : o));
    try {
      const r = await bridgeToArc({
        fromChain: p.from, amount: p.amount, recipient: p.recipient, action: p.action, fast: p.fast, relay: p.relay,
        walletClient: walletOn(p.from), arcWallet: p.relay === "self" ? walletOn("arc-testnet") : undefined,
        pollMs: 3000, timeoutMs: 40 * 60_000,
        onStatus: (s) => {
          if (s.step === "approving") put({ now: s.step, approveTx: s.txHash });
          else if (s.step === "burning") put({ now: s.step });
          else if (s.step === "burned") put({ now: s.step, burnTx: s.burnTxHash });
          else if (s.step === "attestation-pending") put({ now: s.step, iris: s.delayReason ? `${s.irisStatus} (${s.delayReason})` : s.irisStatus });
          else if (s.step === "attestation-ready") put({ now: s.step, iris: "complete", minted: s.minted, fee: s.feeExecuted });
          else if (s.step === "minting") put({ now: s.step, via: s.via });
          else if (s.step === "minted") put({ now: s.step, mintTx: s.mintTxHash, minted: s.minted, via: s.via });
        },
      });
      put({ phase: "done", mintTx: r.mintTxHash, minted: r.minted, fee: r.feeExecuted, seconds: (Date.now() - startedAt) / 1000 });
    } catch (e) {
      const m = e as { shortMessage?: string; message?: string };
      put({ phase: "error", error: (m.shortMessage ?? m.message ?? String(e)).replace(/\s+/g, " ").slice(0, 400) });
    }
  }, []);
  return { flow: f, run, reset: () => setF(null) };
}

export const fmt6 = (v: bigint, dp = 2) => Number(formatUnits(v, 6)).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: 6 });
export const fmtGas = (v: bigint) => Number(formatUnits(v, 18)).toLocaleString("en-US", { maximumFractionDigits: 5 });
