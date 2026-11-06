import {
  createPublicClient,
  http,
  parseEventLogs,
  zeroAddress,
  type Account,
  type Address,
  type Hex,
  type WalletClient,
} from "viem";
import { gatewayAbi, erc20Abi } from "./abi.ts";
import { CHAINS, ccipExplorerUrl, routeOf, viemChain, type ChainKey } from "./chains.ts";

export class NorenCcipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NorenCcipError";
  }
}

export type SendViaHubArgs = {
  from: ChainKey;
  to: ChainKey;
  /** App payload, e.g. an encoded Noren action (see action.ts). */
  payload: Hex;
  /** Optional token to move with the message (only on lanes that list it; see docs/CCIP.md). */
  token?: { address: Address; amount: bigint };
  /** Fee token; omit for native gas. For LINK pass its address (the gateway pulls the exact fee). */
  feeToken?: Address;
  /** A viem wallet client with an account, connected to any transport for `from` (the chain is set here). */
  wallet: WalletClient & { account: Account };
  /** Extra native sent on top of the quote to absorb fee movement between quote and inclusion; refunded. */
  feeBufferBps?: number;
};

export type SendResult = {
  messageId: Hex;
  txHash: Hex;
  nonce: bigint;
  fee: bigint;
  route: ChainKey[];
  explorer: string;
  txExplorer: string;
};

/**
 * Sends a Noren message from `from` to `to` through NorenCcipGateway. Uses a direct CCIP lane when one exists and
 * the Base Sepolia hub otherwise (Robinhood <-> Arc). Returns the first hop's CCIP messageId; follow the whole
 * journey with `trackJourney`.
 */
export async function sendViaHub(args: SendViaHubArgs): Promise<SendResult> {
  const src = CHAINS[args.from];
  const dst = CHAINS[args.to];
  if (!src.gateway) throw new NorenCcipError(`Setup required: no NorenCcipGateway deployed on ${src.name}`);
  if (!dst.gateway) throw new NorenCcipError(`Setup required: no NorenCcipGateway deployed on ${dst.name}`);
  const route = routeOf(args.from, args.to);
  const chain = viemChain(src);
  const pub = createPublicClient({ chain, transport: http(src.rpcUrl) });
  const account = args.wallet.account;
  const token = args.token?.address ?? zeroAddress;
  const amount = args.token?.amount ?? 0n;
  const feeToken = args.feeToken ?? zeroAddress;

  const fee = await pub.readContract({
    address: src.gateway,
    abi: gatewayAbi,
    functionName: "quote",
    args: [dst.selector, args.payload, token, amount, feeToken],
    account,
  });

  const approve = async (erc20: Address, need: bigint) => {
    const have = await pub.readContract({ address: erc20, abi: erc20Abi, functionName: "allowance", args: [account.address, src.gateway!] });
    if (have >= need) return;
    const h = await args.wallet.writeContract({ chain, account, address: erc20, abi: erc20Abi, functionName: "approve", args: [src.gateway!, need] });
    const r = await pub.waitForTransactionReceipt({ hash: h });
    if (r.status !== "success") throw new NorenCcipError(`approve ${erc20} failed in ${h}`);
  };
  if (amount > 0n) await approve(token, amount);
  if (feeToken !== zeroAddress) await approve(feeToken, fee);

  const bps = BigInt(args.feeBufferBps ?? 1000);
  const value = feeToken === zeroAddress ? fee + (fee * bps) / 10_000n : 0n;
  const txHash = await args.wallet.writeContract({
    chain,
    account,
    address: src.gateway,
    abi: gatewayAbi,
    functionName: "send",
    args: [dst.selector, args.payload, token, amount, feeToken],
    value,
  });
  const receipt = await pub.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new NorenCcipError(`send reverted in ${txHash} on ${src.name}`);
  const [sent] = parseEventLogs({ abi: gatewayAbi, eventName: "Sent", logs: receipt.logs });
  if (!sent) throw new NorenCcipError(`no Sent event in ${txHash}`);
  return {
    messageId: sent.args.messageId,
    txHash,
    nonce: sent.args.nonce,
    fee: sent.args.fee,
    route,
    explorer: ccipExplorerUrl(sent.args.messageId),
    txExplorer: `${src.explorer}/tx/${txHash}`,
  };
}
