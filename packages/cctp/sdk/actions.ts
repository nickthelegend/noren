import { decodeAbiParameters, encodeAbiParameters, isAddress, pad, stringToHex, type Address, type Hex } from "viem";

/**
 * Noren's shared Arc action (same ABI on the CCIP and CCTP rails):
 *   action = abi.encode(uint8 kind, address beneficiary, bytes32 ref, bytes params)
 * On the CCTP rail it travels as the burn's hookData; NorenArcHook hands it, with the minted USDC, to the
 * shared NorenArcActionRouter (packages/ccip, Arc Testnet 0x3D2ddF0C08ed3574c25f07E5113CaaB5Db6FA7A4). A failed action or unknown kind becomes a claimable balance for the beneficiary.
 */
export const ACTION_KIND = { PAY_INVOICE: 1, EARN_DEPOSIT: 2, AQUA_ORDER: 3, CREDIT_LINE: 4, PAY_ON_CREDIT: 5 } as const;

export type ArcAction =
  | { kind: "pay-invoice"; merchant: Address; invoiceId: Hex | string; beneficiary?: Address; ref?: Hex | string }
  | { kind: "earn-deposit"; vault: Address; beneficiary?: Address; ref?: Hex | string }
  | { kind: "aqua-order"; order: Hex; beneficiary?: Address; ref?: Hex | string }
  | { kind: "credit-line"; lineId: Hex; limitUsdc6: bigint; expiry: bigint | number; asOf: bigint | number; beneficiary?: Address; ref?: Hex | string }
  | { kind: "pay-on-credit"; lineId: Hex; merchant: Address; invoiceId: Hex | string; amountUsdc6: bigint; beneficiary?: Address; ref?: Hex | string };

const actionTuple = [{ type: "uint8" }, { type: "address" }, { type: "bytes32" }, { type: "bytes" }] as const;

/** bytes32 from a 0x 32-byte hex or a short label (<= 32 UTF-8 bytes, right-padded). */
export const toBytes32 = (v: Hex | string): Hex => {
  if (/^0x[0-9a-fA-F]{64}$/.test(v)) return v.toLowerCase() as Hex;
  const h = stringToHex(v);
  if ((h.length - 2) / 2 > 32) throw new Error(`"${v}" is longer than 32 bytes`);
  return pad(h, { size: 32, dir: "right" });
};

export const encodeAction = (a: ArcAction, defaultBeneficiary: Address): Hex => {
  const beneficiary = a.beneficiary ?? defaultBeneficiary;
  if (!isAddress(beneficiary) || /^0x0{40}$/i.test(beneficiary)) throw new Error("action beneficiary must be a non-zero address");
  const ref = toBytes32(a.ref ?? "noren");
  let kind: number;
  let params: Hex;
  switch (a.kind) {
    case "pay-invoice":
      if (!isAddress(a.merchant)) throw new Error("merchant must be an address");
      kind = ACTION_KIND.PAY_INVOICE;
      params = encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [a.merchant, toBytes32(a.invoiceId)]);
      break;
    case "earn-deposit":
      if (!isAddress(a.vault)) throw new Error("vault must be an address");
      kind = ACTION_KIND.EARN_DEPOSIT;
      params = encodeAbiParameters([{ type: "address" }], [a.vault]);
      break;
    case "aqua-order":
      if (!/^0x([0-9a-fA-F]{2})+$/.test(a.order)) throw new Error("aqua order must be non-empty hex bytes");
      kind = ACTION_KIND.AQUA_ORDER;
      params = a.order;
      break;
    case "credit-line":
      kind = ACTION_KIND.CREDIT_LINE;
      params = encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }, { type: "uint64" }, { type: "uint64" }], [toBytes32(a.lineId), a.limitUsdc6, BigInt(a.expiry), BigInt(a.asOf)]);
      break;
    case "pay-on-credit":
      if (!isAddress(a.merchant)) throw new Error("merchant must be an address");
      kind = ACTION_KIND.PAY_ON_CREDIT;
      params = encodeAbiParameters([{ type: "bytes32" }, { type: "address" }, { type: "bytes32" }, { type: "uint256" }], [toBytes32(a.lineId), a.merchant, toBytes32(a.invoiceId), a.amountUsdc6]);
      break;
  }
  return encodeAbiParameters(actionTuple, [kind, beneficiary, ref, params]);
};

export type DecodedAction = { kind: number; beneficiary: Address; ref: Hex; params: Hex };

/** Decodes and re-encodes; only canonical encodings are accepted (the same rule NorenArcHook.validateAction applies). */
export const decodeAction = (hookData: Hex): DecodedAction => {
  const [kind, beneficiary, ref, params] = decodeAbiParameters(actionTuple, hookData);
  if (encodeAbiParameters(actionTuple, [kind, beneficiary, ref, params]).toLowerCase() !== hookData.toLowerCase())
    throw new Error("hookData is not a canonical Noren action encoding");
  return { kind, beneficiary, ref, params };
};
