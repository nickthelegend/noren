import { createPublicClient, http, zeroHash, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { erc20Abi, messageTransmitterAbi, tokenMessengerAbi } from "./abi";
import { BridgeError, toUsdcUnits, waitForAttestation, type BridgeStatus } from "./bridge";
import { ARC, CCTP_CHAINS, FINALITY_FAST, FINALITY_STANDARD, txUrl, type SourceChainKey } from "./chains";
import { fetchFeeBps, maxFeeFor } from "./iris";
import { addressToBytes32, mintedAmount, parseMessage } from "./message";

/**
 * The reverse direction: USDC out of Arc to another CCTP chain. The burn leaves destinationCaller zero, so any
 * wallet on the destination can complete it with Circle's MessageTransmitterV2.receiveMessage (the SDK does,
 * with `destinationWallet`). Noren's CRE relay only handles the inbound direction.
 */
export type BridgeFromArcParams = {
  toChain: SourceChainKey;
  amount: string | bigint;
  recipient: Address;
  /** Signs on Arc. */
  walletClient: WalletClient;
  fast?: boolean;
  /** Optional explicit nonce for the Arc transactions (shared deployers use the pending nonce under a lock). */
  nonce?: number;
  onStatus?: (s: BridgeStatus) => void;
  irisBaseUrl?: string;
};

export type OutboundBurn = {
  toChain: SourceChainKey;
  amount: bigint;
  recipient: Address;
  maxFee: bigint;
  minFinalityThreshold: number;
  approveTxHash: Hex | null;
  burnTxHash: Hex;
  burnUrl: string;
};

const arcClient = (): PublicClient => createPublicClient({ transport: http(ARC.rpcUrl) }) as PublicClient;

export const burnFromArc = async (p: BridgeFromArcParams): Promise<OutboundBurn> => {
  const dst = CCTP_CHAINS[p.toChain];
  if (!dst || dst.key === "arc-testnet") throw new BridgeError(`${p.toChain} is not a CCTP destination for Arc`);
  const account = p.walletClient.account;
  if (!account) throw new BridgeError("walletClient has no account");
  if ((await p.walletClient.getChainId()) !== ARC.chainId) throw new BridgeError("walletClient is not on Arc Testnet");
  const amount = toUsdcUnits(p.amount);
  const pub = arcClient();
  const balance = await pub.readContract({ address: ARC.usdc, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
  if (balance < amount) throw new BridgeError(`${account.address} holds ${balance} USDC units on Arc; needs ${amount}`);

  let minFinalityThreshold = FINALITY_STANDARD;
  let maxFee = 0n;
  if (p.fast ?? true) {
    const bps = await fetchFeeBps(ARC.domain, dst.domain, FINALITY_FAST, { baseUrl: p.irisBaseUrl });
    minFinalityThreshold = FINALITY_FAST;
    maxFee = bps === 0 ? 0n : maxFeeFor(amount, bps);
  }

  let nonce = p.nonce;
  let approveTxHash: Hex | null = null;
  const allowance = await pub.readContract({ address: ARC.usdc, abi: erc20Abi, functionName: "allowance", args: [account.address, ARC.tokenMessenger] });
  if (allowance < amount) {
    approveTxHash = await p.walletClient.writeContract({ address: ARC.usdc, abi: erc20Abi, functionName: "approve", args: [ARC.tokenMessenger, amount], account, chain: null, nonce });
    p.onStatus?.({ step: "approving", txHash: approveTxHash, url: txUrl("arc-testnet", approveTxHash) });
    const r = await pub.waitForTransactionReceipt({ hash: approveTxHash });
    if (r.status !== "success") throw new BridgeError(`approve reverted: ${txUrl("arc-testnet", approveTxHash)}`);
    if (nonce !== undefined) nonce += 1;
  }
  p.onStatus?.({ step: "burning", fast: minFinalityThreshold === FINALITY_FAST, maxFee });
  const burnTxHash = await p.walletClient.writeContract({
    address: ARC.tokenMessenger, abi: tokenMessengerAbi, functionName: "depositForBurn",
    args: [amount, dst.domain, addressToBytes32(p.recipient), ARC.usdc, zeroHash, maxFee, minFinalityThreshold],
    account, chain: null, nonce,
  });
  const r = await pub.waitForTransactionReceipt({ hash: burnTxHash });
  if (r.status !== "success") throw new BridgeError(`depositForBurn reverted: ${txUrl("arc-testnet", burnTxHash)}`);
  p.onStatus?.({ step: "burned", burnTxHash, url: txUrl("arc-testnet", burnTxHash) });
  return { toChain: p.toChain, amount, recipient: p.recipient, maxFee, minFinalityThreshold, approveTxHash, burnTxHash, burnUrl: txUrl("arc-testnet", burnTxHash) };
};

export type OutboundAttestation = { nonce: Hex; message: Hex; attestation: Hex; minted: bigint; feeExecuted: bigint; finalityThresholdExecuted: number };

/** Waits for Circle's attestation of an Arc burn. */
export const attestFromArc = async (toChain: SourceChainKey, burnTxHash: Hex, opts: { timeoutMs?: number; pollMs?: number; onStatus?: (s: BridgeStatus) => void; irisBaseUrl?: string } = {}): Promise<OutboundAttestation> => {
  const att = await waitForAttestation(ARC, burnTxHash, Date.now() + (opts.timeoutMs ?? 30 * 60_000), opts.pollMs ?? 4000, opts.onStatus, opts.irisBaseUrl);
  const m = parseMessage(att.message);
  if (m.sourceDomain !== ARC.domain || m.destinationDomain !== CCTP_CHAINS[toChain].domain) throw new BridgeError(`attested message routes ${m.sourceDomain} -> ${m.destinationDomain}`);
  const out = { nonce: m.nonce, message: att.message, attestation: att.attestation, minted: mintedAmount(m), feeExecuted: m.body.feeExecuted, finalityThresholdExecuted: m.finalityThresholdExecuted };
  opts.onStatus?.({ step: "attestation-ready", nonce: m.nonce, minted: out.minted, feeExecuted: out.feeExecuted, finalityThresholdExecuted: out.finalityThresholdExecuted });
  return out;
};

/** Completes an Arc burn on the destination with MessageTransmitterV2.receiveMessage (needs gas there). */
export const mintFromArc = async (toChain: SourceChainKey, a: Pick<OutboundAttestation, "nonce" | "message" | "attestation" | "minted">, destinationWallet: WalletClient, onStatus?: (s: BridgeStatus) => void): Promise<{ mintTxHash: Hex; mintUrl: string }> => {
  const dst = CCTP_CHAINS[toChain];
  const account = destinationWallet.account;
  if (!account) throw new BridgeError("destinationWallet has no account");
  const pub = createPublicClient({ transport: http(dst.rpcUrl) }) as PublicClient;
  if ((await pub.readContract({ address: dst.messageTransmitter, abi: messageTransmitterAbi, functionName: "usedNonces", args: [a.nonce] })) !== 0n)
    throw new BridgeError(`nonce ${a.nonce} is already used on ${dst.name}`);
  if ((await pub.getBalance({ address: account.address })) === 0n) throw new BridgeError(`Setup required: ${account.address} has no ${dst.gas} for gas on ${dst.name}`);
  onStatus?.({ step: "minting", via: "self" });
  const mintTxHash = await destinationWallet.writeContract({ address: dst.messageTransmitter, abi: messageTransmitterAbi, functionName: "receiveMessage", args: [a.message, a.attestation], account, chain: null });
  const r = await pub.waitForTransactionReceipt({ hash: mintTxHash });
  if (r.status !== "success") throw new BridgeError(`receiveMessage reverted: ${txUrl(toChain, mintTxHash)}`);
  onStatus?.({ step: "minted", mintTxHash, url: txUrl(toChain, mintTxHash), minted: a.minted, via: "self" });
  return { mintTxHash, mintUrl: txUrl(toChain, mintTxHash) };
};
