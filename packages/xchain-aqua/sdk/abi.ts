// ABIs of the Noren cross-chain Aqua contracts (packages/xchain-aqua/contracts), the parts the SDK uses.
import { parseAbi, parseAbiParameters } from "viem";

const ORDER =
  "(uint64 srcChainId, address srcEscrow, uint64 dstChainId, address dstSettler, address taker, address tokenIn, uint256 amountIn, address tokenOut, uint256 minAmountOut, address recipient, address maker, bytes32 strategyHash, uint64 fillDeadline, uint64 refundAfter, uint256 nonce)";
const PRICE =
  "(uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound, uint8 decimals, uint256 uiMultiplier, address sourceFeed)";

export const escrowAbi = parseAbi([
  `function open(${ORDER} o) returns (bytes32)`,
  "function refund(bytes32 orderId)",
  `function idOf(${ORDER} o) pure returns (bytes32)`,
  "function orderStatus(bytes32 orderId) view returns (uint8)",
  "function order(bytes32 orderId) view returns ((address taker, address tokenIn, uint256 amountIn, address maker, uint64 dstChainId, address dstSettler, uint64 refundAfter, uint8 status))",
  `function currentPrice(address token) view returns (${PRICE})`,
  "function tokens(address token) view returns (address feed, bool uiMultiplier, bool enabled)",
  "function settlers(uint64 chainId) view returns (address)",
  "function minReleaseWindow() view returns (uint64)",
  "function maxFillWindow() view returns (uint64)",
  `event OrderOpened(bytes32 indexed orderId, address indexed taker, address indexed maker, ${ORDER} order, ${PRICE} price)`,
  "event Released(bytes32 indexed orderId, address indexed maker, address indexed payout, uint256 amountIn, uint256 amountOut)",
  "event RefundUnlocked(bytes32 indexed orderId)",
  "event Refunded(bytes32 indexed orderId, address indexed taker, uint256 amountIn, bool viaTimeout)",
]);

export const settlerAbi = parseAbi([
  "struct Route { address inToken; address outToken; bool delivered; bool takerSellsBase; address baseFeed; bool relayed; address quoteFeed; uint32 baseMaxAgeOpen; uint32 baseMaxAgeClosed; uint32 quoteMaxAge; uint16 quoteMaxDepegBps; uint8 flags; bool enabled; }",
  "struct Strategy { address maker; bytes32 routeKey; address payout; bool active; uint32 fills; uint256 volumeIn; uint256 volumeOut; bytes data; }",
  "struct Fill { address maker; address payout; uint256 amountIn; uint256 amountOut; uint64 filledAt; }",
  "function routeKey(uint64 srcChainId, address srcToken, address outToken) pure returns (bytes32)",
  "function route(bytes32 key) view returns (Route)",
  "function strategy(bytes32 strategyHash) view returns (Strategy)",
  "function strategiesOf(address maker) view returns (bytes32[])",
  "function orderStatus(bytes32 orderId) view returns (uint8)",
  "function fillOf(bytes32 orderId) view returns (Fill)",
  `function expire(${ORDER} o)`,
  "function escrows(uint64 chainId) view returns (address)",
  "function router() view returns (address)",
  "event StrategyRegistered(bytes32 indexed strategyHash, address indexed maker, bytes32 indexed routeKey, address payout, uint16 bidSpreadBps, uint16 askSpreadBps)",
  "event OrderFilled(bytes32 indexed orderId, bytes32 indexed strategyHash, address indexed maker, uint64 srcChainId, address recipient, address tokenOut, uint256 amountIn, uint256 amountOut, bool delivered)",
  "event FillRejected(bytes32 indexed orderId, bytes reason)",
]);

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
]);

export const aquaAbi = parseAbi([
  "function rawBalances(address maker, address app, bytes32 strategyHash, address token) view returns (uint248 balance, uint8 tokensCount)",
]);

/** NorenCrossChainSettler.AquaOrderParams: the order bytes of Arc action-router kind 3 (AQUA_ORDER). */
export const AQUA_ORDER_PARAMS = parseAbiParameters(
  "(uint64 srcChainId, address tokenOut, uint256 minAmountOut, address recipient, address maker, bytes32 strategyHash, uint64 fillDeadline, uint256 nonce)",
);
export const ORDER_PARAMS = parseAbiParameters(ORDER);

export const ESCROW_STATUS = ["None", "Open", "Released", "Refundable", "Refunded"] as const;
export const SETTLER_STATUS = ["None", "Filled", "Expired"] as const;
