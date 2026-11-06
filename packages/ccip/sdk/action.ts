import { decodeAbiParameters, encodeAbiParameters, keccak256, toHex, type Address, type Hex } from "viem";

/**
 * The Noren action ABI shared by every rail into Arc (CCIP via NorenCcipGateway, CCTP via NorenArcHook).
 * Mirrors src/libraries/NorenArcAction.sol: action = abi.encode(uint8 kind, address beneficiary, bytes32 ref, bytes params).
 */
export const ActionKind = {
  PAY_INVOICE: 1,
  EARN_DEPOSIT: 2,
  AQUA_ORDER: 3,
  CREDIT_LINE: 4,
  PAY_ON_CREDIT: 5,
  LINE_REPORT: 6,
} as const;
export type ActionKind = (typeof ActionKind)[keyof typeof ActionKind];

export const RAIL_CCIP = keccak256(toHex("CCIP"));
export const RAIL_CCTP = keccak256(toHex("CCTP"));

const ACTION = [{ type: "uint8" }, { type: "address" }, { type: "bytes32" }, { type: "bytes" }] as const;

export type Action = { kind: number; beneficiary: Address; ref: Hex; params: Hex };

export const encodeAction = (a: Action): Hex => encodeAbiParameters(ACTION, [a.kind, a.beneficiary, a.ref, a.params]);

export const decodeAction = (data: Hex): Action => {
  const [kind, beneficiary, ref, params] = decodeAbiParameters(ACTION, data);
  return { kind, beneficiary, ref, params };
};

/** Pays the delivered USDC to `merchant` (needs a rail that carries USDC, e.g. CCTP). */
export const payInvoice = (p: { payer: Address; merchant: Address; invoiceId: Hex }): Hex =>
  encodeAction({
    kind: ActionKind.PAY_INVOICE,
    beneficiary: p.payer,
    ref: p.invoiceId,
    params: encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [p.merchant, p.invoiceId]),
  });

/** ERC-4626 deposit of the delivered token into an allowlisted Earn vault for `beneficiary`. */
export const earnDeposit = (p: { beneficiary: Address; vault: Address; ref: Hex }): Hex =>
  encodeAction({ kind: ActionKind.EARN_DEPOSIT, beneficiary: p.beneficiary, ref: p.ref, params: encodeAbiParameters([{ type: "address" }], [p.vault]) });

/** Cross-chain Aqua order: `order` is the xchain-aqua order encoding; the router holds any funds under `ref`. */
export const aquaOrder = (p: { beneficiary: Address; ref: Hex; order: Hex }): Hex =>
  encodeAction({ kind: ActionKind.AQUA_ORDER, beneficiary: p.beneficiary, ref: p.ref, params: p.order });

/** Opens or updates a credit line on Arc (sender must be a credit authority for its chain). `asOf` orders updates. */
export const creditLine = (p: { borrower: Address; lineId: Hex; limitUsdc6: bigint; expiry: bigint; asOf: bigint }): Hex =>
  encodeAction({
    kind: ActionKind.CREDIT_LINE,
    beneficiary: p.borrower,
    ref: p.lineId,
    params: encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "uint64" }, { type: "uint64" }],
      [p.lineId, p.limitUsdc6, p.expiry, p.asOf],
    ),
  });

/** Pays `merchant` on Arc from Noren's Arc liquidity against the borrower's line. Only the borrower may send it. */
export const payOnCredit = (p: { borrower: Address; lineId: Hex; merchant: Address; invoiceId: Hex; amountUsdc6: bigint }): Hex =>
  encodeAction({
    kind: ActionKind.PAY_ON_CREDIT,
    beneficiary: p.borrower,
    ref: p.invoiceId,
    params: encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "bytes32" }, { type: "uint256" }],
      [p.lineId, p.merchant, p.invoiceId, p.amountUsdc6],
    ),
  });

export const decodeLineReport = (params: Hex) => {
  const [lineId, drawnUsdc6, repaidUsdc6, asOf] = decodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }, { type: "uint64" }],
    params,
  );
  return { lineId, drawnUsdc6, repaidUsdc6, asOf };
};

/** The envelope every hop carries (src/libraries/NorenCcipEnvelope.sol). */
const ENVELOPE = [
  {
    type: "tuple",
    components: [
      { name: "version", type: "uint8" },
      { name: "originChain", type: "uint64" },
      { name: "originSender", type: "address" },
      { name: "nonce", type: "uint64" },
      { name: "finalChain", type: "uint64" },
      { name: "finalReceiver", type: "address" },
      { name: "prevMessageId", type: "bytes32" },
      { name: "payload", type: "bytes" },
    ],
  },
] as const;

export type Envelope = {
  version: number;
  originChain: bigint;
  originSender: Address;
  nonce: bigint;
  finalChain: bigint;
  finalReceiver: Address;
  prevMessageId: Hex;
  payload: Hex;
};

export const encodeEnvelope = (e: Envelope): Hex => encodeAbiParameters(ENVELOPE, [e]);
export const decodeEnvelope = (data: Hex): Envelope => decodeAbiParameters(ENVELOPE, data)[0] as Envelope;
