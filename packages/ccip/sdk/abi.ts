import { parseAbi } from "viem";

export const gatewayAbi = parseAbi([
  "function send(uint64 finalChain, bytes payload, address token, uint256 amount, address feeToken) payable returns (bytes32)",
  "function quote(uint64 finalChain, bytes payload, address token, uint256 amount, address feeToken) view returns (uint256)",
  "function statusOf(bytes32 messageId) view returns (uint8)",
  "function deliveredMessage(uint64 originChain, uint64 originNonce) view returns (bytes32)",
  "function retryFailed(bytes32 messageId)",
  "event Sent(bytes32 indexed messageId, uint64 indexed nonce, uint64 indexed finalChain, uint64 nextChain, address originSender, address token, uint256 amount, address feeToken, uint256 fee, bytes32 payloadHash)",
  "event Delivered(bytes32 indexed messageId, uint64 indexed originChain, uint64 indexed nonce, bytes32 prevMessageId, address originSender, address token, uint256 amount, bytes32 payloadHash, bool appOk)",
  "event MessageFailed(bytes32 indexed messageId, bytes reason)",
]);

export const hubAbi = parseAbi([
  "function forwardStatus(bytes32 inboundId) view returns (uint8)",
  "function forwardedAs(bytes32 inboundId) view returns (bytes32)",
  "function retryForward(bytes32 inboundId, bytes envelope) payable returns (bytes32)",
  "event Forwarded(bytes32 indexed inboundId, bytes32 indexed outboundId, uint64 indexed finalChain, uint64 originChain, uint64 nonce, address feeToken, uint256 fee)",
  "event ForwardPending(bytes32 indexed inboundId, uint64 indexed finalChain, bytes envelope, bytes reason)",
]);

export const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

export const GatewayStatus = ["NONE", "DELIVERED", "FAILED", "RECOVERED"] as const;
export const ForwardStatus = ["NONE", "FORWARDED", "PENDING"] as const;
