import { createPublicClient, http, parseUnits, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { erc20Abi, norenArcHookAbi, tokenMessengerAbi } from "./abi";
import { encodeAction, type ArcAction } from "./actions";
import {
  ARC,
  CCTP_CHAINS,
  FINALITY_FAST,
  FINALITY_STANDARD,
  NOREN_ARC_HOOK,
  NOREN_ARC_HOOK_DEPLOY_BLOCK,
  txUrl,
  type CctpChain,
  type SourceChainKey,
} from "./chains";
import { fetchAttestation, fetchFeeBps, maxFeeFor } from "./iris";
import { addressToBytes32, checkNorenMessage, mintedAmount, parseMessage, type CctpMessage } from "./message";

/**
 * Who completes the transfer on Arc. Every Noren burn names NorenArcHook as destinationCaller.
 * - "cre": Noren's Chainlink CRE workflow (log trigger on the source chain's MessageSent, Iris attestation with
 *   consensus, report through the CRE forwarder into NorenArcHook.onReport). The SDK only watches.
 * - "self": the SDK calls NorenArcHook.relay(message, attestation) on Arc with `arcWallet` (any relayer may).
 */
export type RelayMode = "cre" | "self";

export type BridgeStatus =
  | { step: "approving"; txHash: Hex; url: string }
  | { step: "burning"; fast: boolean; maxFee: bigint }
  | { step: "burned"; burnTxHash: Hex; url: string }
  | { step: "attestation-pending"; irisStatus: string; delayReason: string | null }
  | { step: "attestation-ready"; nonce: Hex; minted: bigint; feeExecuted: bigint; finalityThresholdExecuted: number }
  | { step: "minting"; via: RelayMode }
  | { step: "minted"; mintTxHash: Hex; url: string; minted: bigint; via: RelayMode | "other" };

export type BridgeToArcParams = {
  fromChain: SourceChainKey;
  /** USDC, either a decimal string ("1.25") or 6-dp base units. */
  amount: string | bigint;
  /** Who gets the USDC on Arc (and the default action beneficiary). */
  recipient: Address;
  /** NorenArcHook to name as destinationCaller (default: deployments.json). The privacy hook takes SHIELD. */
  hook?: Address;
  /** Optional Noren action run on Arc with the minted USDC (CCTP V2 hook). */
  action?: ArcAction;
  /** Signs on the source chain. */
  walletClient: WalletClient;
  /** Fast transfer (finality 1000, small Circle fee) or standard (2000, no fee). Default true. */
  fast?: boolean;
  relay?: RelayMode;
  /** Required for relay "self": signs NorenArcHook.relay on Arc. */
  arcWallet?: WalletClient;
  /** Wait for the attestation and the Arc mint (default true). */
  waitForMint?: boolean;
  onStatus?: (s: BridgeStatus) => void;
  irisBaseUrl?: string;
  pollMs?: number;
  timeoutMs?: number;
};

export type BridgeResult = {
  fromChain: SourceChainKey;
  amount: bigint;
  recipient: Address;
  hookData: Hex | null;
  maxFee: bigint;
  minFinalityThreshold: number;
  relay: RelayMode;
  approveTxHash: Hex | null;
  burnTxHash: Hex;
  burnUrl: string;
  nonce?: Hex;
  message?: Hex;
  attestation?: Hex;
  minted?: bigint;
  feeExecuted?: bigint;
  finalityThresholdExecuted?: number;
  mintTxHash?: Hex;
  mintUrl?: string;
};

export class BridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeError";
  }
}

const clientFor = (c: CctpChain): PublicClient => createPublicClient({ transport: http(c.rpcUrl) }) as PublicClient;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const requireHook = (override?: Address): Address => {
  if (override) return override;
  if (!NOREN_ARC_HOOK) throw new BridgeError("Setup required: NorenArcHook is not deployed on Arc Testnet (packages/cctp/deployments.json)");
  return NOREN_ARC_HOOK;
};

export const toUsdcUnits = (amount: string | bigint): bigint => {
  const v = typeof amount === "bigint" ? amount : parseUnits(amount, 6);
  if (v <= 0n) throw new BridgeError("amount must be positive");
  return v;
};

/** Burns USDC on a source chain with Circle CCTP V2 into Arc and (by default) waits for the mint on Arc. */
export const bridgeToArc = async (p: BridgeToArcParams): Promise<BridgeResult> => {
  const src = CCTP_CHAINS[p.fromChain];
  if (!src || p.fromChain === ("arc-testnet" as SourceChainKey)) throw new BridgeError(`${p.fromChain} is not a Noren source chain`);
  const hook = requireHook(p.hook);
  const relay = p.relay ?? "cre";
  if (relay === "self" && !p.arcWallet) throw new BridgeError("relay 'self' needs arcWallet");
  const account = p.walletClient.account;
  if (!account) throw new BridgeError("walletClient has no account");
  const walletChain = await p.walletClient.getChainId();
  if (walletChain !== src.chainId) throw new BridgeError(`wallet is on chain ${walletChain}; ${src.name} is ${src.chainId}`);
  const amount = toUsdcUnits(p.amount);
  const pub = clientFor(src);

  const gas = await pub.getBalance({ address: account.address });
  if (gas === 0n) throw new BridgeError(`Setup required: ${account.address} has no ${src.gas} for gas on ${src.name}`);
  const balance = await pub.readContract({ address: src.usdc, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
  if (balance < amount) throw new BridgeError(`Setup required: ${account.address} holds ${balance} USDC units on ${src.name}; needs ${amount} (faucet.circle.com)`);

  const hookData = p.action ? encodeAction(p.action, p.recipient) : null;

  let minFinalityThreshold = FINALITY_STANDARD;
  let maxFee = 0n;
  if (p.fast ?? true) {
    const bps = await fetchFeeBps(src.domain, ARC.domain, FINALITY_FAST, { baseUrl: p.irisBaseUrl });
    minFinalityThreshold = FINALITY_FAST;
    maxFee = bps === 0 ? 0n : maxFeeFor(amount, bps);
  }

  let approveTxHash: Hex | null = null;
  const allowance = await pub.readContract({ address: src.usdc, abi: erc20Abi, functionName: "allowance", args: [account.address, src.tokenMessenger] });
  if (allowance < amount) {
    const approveTx = await p.walletClient.writeContract({ address: src.usdc, abi: erc20Abi, functionName: "approve", args: [src.tokenMessenger, amount], account, chain: null });
    p.onStatus?.({ step: "approving", txHash: approveTx, url: txUrl(p.fromChain, approveTx) });
    const r = await pub.waitForTransactionReceipt({ hash: approveTx });
    if (r.status !== "success") throw new BridgeError(`approve reverted: ${txUrl(p.fromChain, approveTx)}`);
    approveTxHash = approveTx;
  }

  p.onStatus?.({ step: "burning", fast: minFinalityThreshold === FINALITY_FAST, maxFee });
  const caller = addressToBytes32(hook);
  const burnTxHash = hookData
    ? await p.walletClient.writeContract({
        address: src.tokenMessenger, abi: tokenMessengerAbi, functionName: "depositForBurnWithHook",
        // With a hook the USDC is minted to NorenArcHook, which hands it and the action to the router.
        args: [amount, ARC.domain, caller, src.usdc, caller, maxFee, minFinalityThreshold, hookData], account, chain: null,
      })
    : await p.walletClient.writeContract({
        address: src.tokenMessenger, abi: tokenMessengerAbi, functionName: "depositForBurn",
        args: [amount, ARC.domain, addressToBytes32(p.recipient), src.usdc, caller, maxFee, minFinalityThreshold], account, chain: null,
      });
  const receipt = await pub.waitForTransactionReceipt({ hash: burnTxHash });
  if (receipt.status !== "success") throw new BridgeError(`burn reverted: ${txUrl(p.fromChain, burnTxHash)}`);
  p.onStatus?.({ step: "burned", burnTxHash, url: txUrl(p.fromChain, burnTxHash) });

  const result: BridgeResult = {
    fromChain: p.fromChain, amount, recipient: p.recipient, hookData, maxFee, minFinalityThreshold, relay,
    approveTxHash, burnTxHash, burnUrl: txUrl(p.fromChain, burnTxHash),
  };
  if (p.waitForMint === false) return result;
  return { ...result, ...(await trackToArc({ ...p, burnTxHash, relay, expectedAmount: amount, hasHook: hookData !== null })) };
};

export type TrackParams = {
  fromChain: SourceChainKey;
  burnTxHash: Hex;
  relay?: RelayMode;
  arcWallet?: WalletClient;
  expectedAmount?: bigint;
  recipient?: Address;
  hasHook?: boolean;
  /** NorenArcHook named as destinationCaller (default: deployments.json). */
  hook?: Address;
  onStatus?: (s: BridgeStatus) => void;
  irisBaseUrl?: string;
  pollMs?: number;
  timeoutMs?: number;
};

export type TrackResult = Pick<BridgeResult, "nonce" | "message" | "attestation" | "minted" | "feeExecuted" | "finalityThresholdExecuted" | "mintTxHash" | "mintUrl">;

/** Polls Iris until Circle attests the burn, then relays (self) or waits for the CRE relay (cre) on Arc. */
export const trackToArc = async (p: TrackParams): Promise<TrackResult> => {
  const src = CCTP_CHAINS[p.fromChain];
  const hook = requireHook(p.hook);
  const relay = p.relay ?? "cre";
  const pollMs = p.pollMs ?? 4000;
  const deadline = Date.now() + (p.timeoutMs ?? 30 * 60_000);

  const att = await waitForAttestation(src, p.burnTxHash, deadline, pollMs, p.onStatus, p.irisBaseUrl);
  const m: CctpMessage = parseMessage(att.message);
  checkNorenMessage(m, {
    sourceDomain: src.domain, destinationDomain: ARC.domain, receiver: hook,
    mintRecipient: p.hasHook ? hook : p.recipient, amount: p.expectedAmount,
  });
  const minted = mintedAmount(m);
  p.onStatus?.({ step: "attestation-ready", nonce: m.nonce, minted, feeExecuted: m.body.feeExecuted, finalityThresholdExecuted: m.finalityThresholdExecuted });
  const base = { nonce: m.nonce, message: att.message, attestation: att.attestation, minted, feeExecuted: m.body.feeExecuted, finalityThresholdExecuted: m.finalityThresholdExecuted };

  const arc = clientFor(ARC);
  if (relay === "self") {
    const w = p.arcWallet;
    if (!w?.account) throw new BridgeError("relay 'self' needs arcWallet with an account");
    if (!(await arc.readContract({ address: hook, abi: norenArcHookAbi, functionName: "processed", args: [m.nonce] }))) {
      p.onStatus?.({ step: "minting", via: "self" });
      const mintTxHash = await w.writeContract({ address: hook, abi: norenArcHookAbi, functionName: "relay", args: [att.message, att.attestation], account: w.account, chain: null });
      const r = await arc.waitForTransactionReceipt({ hash: mintTxHash });
      if (r.status !== "success") throw new BridgeError(`NorenArcHook.relay reverted: ${txUrl("arc-testnet", mintTxHash)}`);
      p.onStatus?.({ step: "minted", mintTxHash, url: txUrl("arc-testnet", mintTxHash), minted, via: "self" });
      return { ...base, mintTxHash, mintUrl: txUrl("arc-testnet", mintTxHash) };
    }
  } else {
    p.onStatus?.({ step: "minting", via: "cre" });
  }

  for (;;) {
    if (Date.now() > deadline) throw new BridgeError(`timed out waiting for nonce ${m.nonce} to be minted on Arc`);
    if (await arc.readContract({ address: hook, abi: norenArcHookAbi, functionName: "processed", args: [m.nonce] })) {
      const found = await findBridged(arc, hook, m.nonce);
      if (!found) throw new BridgeError(`NorenArcHook marks nonce ${m.nonce} processed but no Bridged event was found`);
      p.onStatus?.({ step: "minted", mintTxHash: found.tx, url: txUrl("arc-testnet", found.tx), minted, via: found.viaCre ? "cre" : "other" });
      return { ...base, mintTxHash: found.tx, mintUrl: txUrl("arc-testnet", found.tx) };
    }
    await sleep(pollMs);
  }
};

export const waitForAttestation = async (
  src: CctpChain, burnTxHash: Hex, deadline: number, pollMs: number, onStatus?: (s: BridgeStatus) => void, irisBaseUrl?: string,
): Promise<{ message: Hex; attestation: Hex }> => {
  let last = "";
  for (;;) {
    if (Date.now() > deadline) throw new BridgeError(`timed out waiting for Circle's attestation of ${src.explorer}/tx/${burnTxHash}`);
    const s = await fetchAttestation(src.domain, burnTxHash, { baseUrl: irisBaseUrl });
    if (s.state === "complete") return s;
    const key = s.state === "pending" ? `${s.status}/${s.delayReason}` : "not-found";
    if (key !== last) {
      onStatus?.({ step: "attestation-pending", irisStatus: s.state === "pending" ? s.status : "not indexed yet", delayReason: s.state === "pending" ? s.delayReason : null });
      last = key;
    }
    await sleep(pollMs);
  }
};

/** NorenArcHook's Bridged(nonce), searched newest-first in 10k-block windows down to the hook's deploy block. */
export const findBridged = async (arc: PublicClient, hook: Address, nonce: Hex): Promise<{ tx: Hex; viaCre: boolean } | null> => {
  const step = 10_000n;
  const floor = NOREN_ARC_HOOK_DEPLOY_BLOCK;
  for (let hi = await arc.getBlockNumber(); hi >= floor; hi -= step) {
    const lo = hi - step + 1n > floor ? hi - step + 1n : floor;
    const logs = await arc.getContractEvents({ address: hook, abi: norenArcHookAbi, eventName: "Bridged", args: { nonce }, fromBlock: lo, toBlock: hi });
    if (logs.length > 0) return { tx: logs[0].transactionHash, viaCre: Boolean(logs[0].args.viaCre) };
    if (lo === floor) break;
  }
  return null;
};
