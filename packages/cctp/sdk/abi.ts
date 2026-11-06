import { parseAbi } from "viem";

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

/** Circle TokenMessengerV2. */
export const tokenMessengerAbi = parseAbi([
  "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)",
  "function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)",
  "event DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)",
]);

/** Circle MessageTransmitterV2. */
export const messageTransmitterAbi = parseAbi([
  "function receiveMessage(bytes message, bytes attestation) returns (bool)",
  "function usedNonces(bytes32 nonce) view returns (uint256)",
  "function localDomain() view returns (uint32)",
  "event MessageSent(bytes message)",
]);

/** Noren's NorenArcHook on Arc. */
export const norenArcHookAbi = parseAbi([
  "function relay(bytes message, bytes attestation)",
  "function processed(bytes32 nonce) view returns (bool)",
  "function router() view returns (address)",
  "function forwarder() view returns (address)",
  "function localDomain() view returns (uint32)",
  "function validateAction(bytes a) pure returns (bool valid, uint8 kind, address beneficiary, string reason)",
  "event Bridged(bytes32 indexed nonce, uint32 indexed sourceDomain, address indexed recipient, uint256 minted, uint256 feeExecuted, address depositor, uint32 finalityThresholdExecuted, bool viaCre)",
  "event HookExecuted(bytes32 indexed nonce, uint8 indexed kind, address indexed beneficiary, uint256 amount, bool routed, bool ok)",
  "event HookRejected(bytes32 indexed nonce, address indexed refundTo, uint256 amount, string reason)",
]);

/** Events of Noren's shared NorenArcActionRouter (packages/ccip) that a CCTP hook transfer can emit. */
export const norenArcActionRouterAbi = parseAbi([
  "event ActionExecuted(bytes32 indexed rail, bytes32 indexed msgId, uint8 indexed kind, address beneficiary, bytes32 ref, address token, uint256 amount, bool ok)",
  "event ActionFailed(bytes32 indexed rail, bytes32 indexed msgId, address creditedTo, address token, uint256 amount, bytes reason)",
  "event DuplicateIgnored(bytes32 indexed rail, bytes32 indexed msgId)",
  "event InvoicePaid(bytes32 indexed invoiceId, address indexed merchant, address indexed payer, uint256 amount, bytes32 rail, uint64 source, bool onCredit)",
  "event EarnDeposited(address indexed vault, address indexed beneficiary, uint256 assets, uint256 shares)",
  "event AquaOrderOpened(bytes32 indexed ref, address indexed beneficiary, address token, uint256 amount, bytes32 rail, uint64 source, bytes params)",
  "event CreditLineUpdated(bytes32 indexed lineId, address indexed borrower, uint256 limit, uint64 expiry, uint64 asOf, uint64 source)",
  "event Drawn(bytes32 indexed lineId, uint256 amount, bytes32 invoiceId, address merchant)",
  "function claimable(address account, address token) view returns (uint256)",
]);
