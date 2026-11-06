import { defineChain, encodeAbiParameters, decodeAbiParameters, keccak256, parseAbi, toBytes, type Address, type Hex } from 'viem';

export const ARC_CHAIN_ID = 5042002;
export const ARC_USDC = '0x3600000000000000000000000000000000000000' as Address;
export const arcTestnet = defineChain({ id: ARC_CHAIN_ID, name: 'Arc Testnet', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.testnet.arc.io'] } }, blockExplorers: { default: { name: 'Arc Explorer', url: 'https://explorer.testnet.arc.io' } }, testnet: true });
export const localFork = (url = 'http://127.0.0.1:8645') => defineChain({ ...arcTestnet, name: 'Arc local fork', rpcUrls: { default: { http: [url] } } });
export type Deployment = { chainId: number; deploymentBlock: string; usdc: Address; entrypoint: Address; pool: Address; checkout: Address; withdrawalVerifier?: Address; commitmentVerifier?: Address };

export type Invoice = { invoiceId: Hex; merchant: Address; amount: bigint; expiry: bigint; refundPrecommitment: bigint; receiptCommitment: Hex };
export const invoiceParameters = [{ type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }] as const;
export function encodeInvoiceData(i: Invoice): Hex {
  return encodeAbiParameters(invoiceParameters, [i.invoiceId, i.merchant, i.amount, i.expiry, i.refundPrecommitment, i.receiptCommitment]);
}
export function decodeInvoiceData(data: Hex): Invoice {
  const [invoiceId, merchant, amount, expiry, refundPrecommitment, receiptCommitment] = decodeAbiParameters(invoiceParameters, data);
  return { invoiceId, merchant, amount, expiry, refundPrecommitment, receiptCommitment };
}
export function invoiceMatches(expected: Invoice, data: Hex): boolean { return encodeInvoiceData(expected).toLowerCase() === data.toLowerCase(); }
export function jsonBigints(value: unknown): string { return JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v); }
export function parseInvoice(value: any): Invoice {
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value.invoiceId) || !/^0x[0-9a-fA-F]{40}$/.test(value.merchant) || !/^0x[0-9a-fA-F]{64}$/.test(value.receiptCommitment)) throw new Error('Invalid invoice fields');
  const amount = BigInt(value.amount), expiry = BigInt(value.expiry), refundPrecommitment = BigInt(value.refundPrecommitment);
  if (amount <= 0n || expiry <= 0n || refundPrecommitment <= 0n) throw new Error('Invalid invoice amount, expiry or refund precommitment');
  return { invoiceId: value.invoiceId, merchant: value.merchant, amount, expiry, refundPrecommitment, receiptCommitment: value.receiptCommitment };
}
export function createReceiptOpening(secret: Hex = keccak256(toBytes(crypto.randomUUID()))) {
  return { secret, commitment: keccak256(secret) };
}
export const checkoutAbi = parseAbi([
  'function registerMerchant(address payout)',
  'function merchantPayout(address merchant) view returns (address)',
  'function paid(bytes32 invoiceId) view returns (bool)',
  'function pay((address processooor,bytes data) withdrawal,(uint256[2] pA,uint256[2][2] pB,uint256[2] pC,uint256[8] pubSignals) proof)',
  'function refund(bytes32 invoiceId,uint256 amount)',
  'event Paid(bytes32 indexed invoiceId,address indexed merchant,uint256 amount,bytes32 receiptCommitment)',
  'event Refunded(bytes32 indexed invoiceId,address indexed merchant,uint256 amount,uint256 refundPrecommitment)',
  'error AlreadyPaid()', 'error Expired()', 'error NotMerchant()', 'error AmountMismatch()', 'error UnknownMerchant()', 'error AlreadyRefunded()', 'error RefundTooLarge()'
]);
export const entrypointAbi = parseAbi(['function updateRoot(uint256 root,string cid) returns (uint256)', 'function latestRoot() view returns (uint256)', 'function registerPool(address asset,address pool,uint256 minimumDeposit,uint256 vettingFeeBPS,uint256 maxRelayFeeBPS)', 'event RootUpdated(uint256 root,string ipfsCID,uint256 timestamp)']);
/** Kohaku/0xbow relayed withdrawal: Entrypoint.relay pays `recipient` (minus the relay fee) from the pool. */
export const relayAbi = parseAbi([
  'struct Withdrawal { address processooor; bytes data; }',
  'struct WithdrawProof { uint256[2] pA; uint256[2][2] pB; uint256[2] pC; uint256[8] pubSignals; }',
  'function relay(Withdrawal withdrawal, WithdrawProof proof, uint256 scope)',
  'function assetConfig(address asset) view returns (address pool, uint256 minimumDepositAmount, uint256 vettingFeeBPS, uint256 maxRelayFeeBPS)',
  'function usedPrecommitments(uint256 precommitment) view returns (bool)',
  'event WithdrawalRelayed(address indexed relayer, address indexed recipient, address indexed asset, uint256 amount, uint256 feeAmount)',
  'error RelayFeeGreaterThanMax()', 'error InvalidProcessooor()', 'error PoolNotFound()', 'error InvalidWithdrawalAmount()',
]);
export const poolScopeAbi = parseAbi(['function SCOPE() view returns (uint256)', 'error InvalidProof()', 'error NullifierAlreadySpent()', 'error UnknownStateRoot()', 'error InvalidTreeDepth()']);
export const relayDataParameters = [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }] as const;
export type RelayData = { recipient: Address; feeRecipient: Address; relayFeeBps: bigint };
/** abi.encode(IEntrypoint.RelayData): the `data` of a withdrawal whose processooor is the Entrypoint. */
export function encodeRelayData(r: RelayData): Hex { return encodeAbiParameters(relayDataParameters, [r.recipient, r.feeRecipient, r.relayFeeBps]); }
export function decodeRelayData(data: Hex): RelayData { const [recipient, feeRecipient, relayFeeBps] = decodeAbiParameters(relayDataParameters, data); return { recipient, feeRecipient, relayFeeBps }; }
/** Amount the recipient of a relayed withdrawal receives (Entrypoint._deductFee: value - value * bps / 10000). */
export function afterRelayFee(amount: bigint, bps: bigint): bigint { return amount - (amount * bps) / 10_000n; }
export const poolAbi = parseAbi(['event Deposited(address indexed depositor,uint256 commitment,uint256 label,uint256 value,uint256 precommitment)', 'error ContextMismatch()', 'error IncorrectASPRoot()']);
export const usdcAbi = parseAbi(['function approve(address spender,uint256 value) returns (bool)', 'function isBlacklisted(address account) view returns (bool)', 'function balanceOf(address owner) view returns (uint256)']);
