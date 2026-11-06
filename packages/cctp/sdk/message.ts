import { getAddress, hexToBigInt, isHex, pad, sliceHex, type Address, type Hex } from "viem";

/** CCTP V2 message header (MessageV2.sol). */
export type CctpMessage = {
  version: number;
  sourceDomain: number;
  destinationDomain: number;
  /** bytes32; Iris fills it in (the MessageSent event carries zero). */
  nonce: Hex;
  sender: Hex;
  recipient: Hex;
  destinationCaller: Hex;
  minFinalityThreshold: number;
  finalityThresholdExecuted: number;
  body: BurnMessage;
};

/** CCTP V2 burn message body (BurnMessageV2.sol). */
export type BurnMessage = {
  version: number;
  burnToken: Hex;
  mintRecipient: Hex;
  amount: bigint;
  messageSender: Hex;
  maxFee: bigint;
  feeExecuted: bigint;
  expirationBlock: bigint;
  hookData: Hex;
};

export const HEADER_BYTES = 148;
export const BURN_BODY_MIN_BYTES = 228;

export class CctpMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CctpMessageError";
  }
}

export const addressToBytes32 = (a: Address): Hex => pad(getAddress(a), { size: 32 }).toLowerCase() as Hex;

export const bytes32ToAddress = (b: Hex): Address => {
  if (!isHex(b) || b.length !== 66) throw new CctpMessageError(`not a bytes32: ${b}`);
  if (BigInt(b) >> 160n !== 0n) throw new CctpMessageError(`bytes32 ${b} is not a left-padded address`);
  return getAddress(`0x${b.slice(26)}`);
};

const u32 = (h: Hex, start: number) => Number(hexToBigInt(sliceHex(h, start, start + 4, { strict: true })));
const b32 = (h: Hex, start: number) => sliceHex(h, start, start + 32, { strict: true }).toLowerCase() as Hex;
const u256 = (h: Hex, start: number) => hexToBigInt(sliceHex(h, start, start + 32, { strict: true }));

/** Decodes a CCTP V2 burn message. Throws CctpMessageError on anything that is not one. */
export const parseMessage = (message: Hex): CctpMessage => {
  if (!isHex(message, { strict: true }) || message.length % 2 !== 0) throw new CctpMessageError("message is not 0x-prefixed hex");
  const size = (message.length - 2) / 2;
  if (size < HEADER_BYTES + BURN_BODY_MIN_BYTES) throw new CctpMessageError(`message is ${size} bytes; a V2 burn message is at least ${HEADER_BYTES + BURN_BODY_MIN_BYTES}`);
  const version = u32(message, 0);
  if (version !== 1) throw new CctpMessageError(`message version ${version}; CCTP V2 messages are version 1`);
  const body = sliceHex(message, HEADER_BYTES) as Hex;
  const bodyVersion = u32(body, 0);
  if (bodyVersion !== 1) throw new CctpMessageError(`burn message version ${bodyVersion}; CCTP V2 burn messages are version 1`);
  return {
    version,
    sourceDomain: u32(message, 4),
    destinationDomain: u32(message, 8),
    nonce: b32(message, 12),
    sender: b32(message, 44),
    recipient: b32(message, 76),
    destinationCaller: b32(message, 108),
    minFinalityThreshold: u32(message, 140),
    finalityThresholdExecuted: u32(message, 144),
    body: {
      version: bodyVersion,
      burnToken: b32(body, 4),
      mintRecipient: b32(body, 36),
      amount: u256(body, 68),
      messageSender: b32(body, 100),
      maxFee: u256(body, 132),
      feeExecuted: u256(body, 164),
      expirationBlock: u256(body, 196),
      hookData: (size > HEADER_BYTES + BURN_BODY_MIN_BYTES ? sliceHex(body, BURN_BODY_MIN_BYTES) : "0x") as Hex,
    },
  };
};

/** USDC (6 dp) the recipient receives: amount minus the fast-transfer fee Circle executed. */
export const mintedAmount = (m: CctpMessage): bigint => m.body.amount - m.body.feeExecuted;

/**
 * Checks an attested message against what the burn asked for. The relay calls this before writing,
 * so a wrong message (other route, other recipient, not routed to Noren's receiver) is never submitted.
 */
export const checkNorenMessage = (
  m: CctpMessage,
  want: { sourceDomain: number; destinationDomain: number; receiver: Address; mintRecipient?: Address; amount?: bigint },
): void => {
  if (m.sourceDomain !== want.sourceDomain) throw new CctpMessageError(`source domain ${m.sourceDomain}, expected ${want.sourceDomain}`);
  if (m.destinationDomain !== want.destinationDomain) throw new CctpMessageError(`destination domain ${m.destinationDomain}, expected ${want.destinationDomain}`);
  if (m.destinationCaller !== addressToBytes32(want.receiver))
    throw new CctpMessageError(`destinationCaller ${m.destinationCaller} is not NorenCctpReceiver ${want.receiver}`);
  if (want.mintRecipient && m.body.mintRecipient !== addressToBytes32(want.mintRecipient))
    throw new CctpMessageError(`mintRecipient ${m.body.mintRecipient} is not ${want.mintRecipient}`);
  if (want.amount !== undefined && m.body.amount !== want.amount) throw new CctpMessageError(`amount ${m.body.amount}, expected ${want.amount}`);
};
