// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IReceiver, IERC165} from "./interfaces/IReceiver.sol";
import {IMessageTransmitterV2} from "./interfaces/IMessageTransmitterV2.sol";
import {INorenActionSink} from "./interfaces/INorenActionSink.sol";
import {IERC20Min} from "./interfaces/IERC20Min.sol";

/// @title NorenArcHook
/// @notice Noren's USDC on-ramp into Arc. Any CCTP V2 chain burns USDC with this contract as `destinationCaller`;
///         this contract completes the transfer on Arc by calling Circle's `MessageTransmitterV2.receiveMessage`.
///         - Plain transfer (`mintRecipient` is someone else): Circle mints to them; this contract emits `Bridged`.
///         - Hook transfer (`depositForBurnWithHook`, `mintRecipient` is this contract): the minted USDC and the
///           hookData `action` go to Noren's shared action router NorenArcActionRouter (pay an invoice, Earn
///           deposit, Aqua order, credit line, pay on credit, shield into the privacy pool). Malformed hookData never strands funds: they go to the beneficiary, or back to the
///           depositor's address on Arc when no beneficiary can be read.
///         A Chainlink CRE workflow is the relayer: a log trigger on the source chain's `MessageSent`, the Circle
///         Iris attestation fetched with DON consensus, and a report through the CRE forwarder into `onReport`.
///         Because the outcome is fixed by Circle's attested message, `relay` is open to any relayer as well.
/// @dev Unaudited. Each CCTP nonce is processed once (Circle's transmitter also rejects a reused nonce).
///      If the router reverts, the whole call reverts and the message stays unconsumed; the owner can then
///      clear the router so the next relay delivers straight to the beneficiary. On the public testnets the
///      CRE simulator's MockKeystoneForwarder does not verify DON signatures; a deployed workflow's
///      KeystoneForwarder does.
contract NorenArcHook is IReceiver {
  bytes32 public constant RAIL_CCTP = keccak256("CCTP");

  uint8 public constant PAY_INVOICE = 1;
  uint8 public constant EARN_DEPOSIT = 2;
  uint8 public constant AQUA_ORDER = 3;
  uint8 public constant CREDIT_LINE = 4;
  uint8 public constant PAY_ON_CREDIT = 5;
  /// @dev Arc -> other chains only (sent by the router); never accepted inbound.
  uint8 public constant LINE_REPORT = 6;
  /// @dev "Arrive private": params = abi.encode(uint256 precommitment); the router side (NorenShieldSink) deposits
  ///      the minted USDC into the Kohaku privacy pool under it.
  uint8 public constant SHIELD = 7;
  /// @dev BN254 scalar field: a precommitment is a Poseidon hash, so it must be a field element.
  uint256 private constant SNARK_SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
  uint256 public constant MAX_PARAMS = 2048;

  // CCTP V2 message header offsets (MessageV2.sol)
  uint256 private constant SOURCE_DOMAIN = 4;
  uint256 private constant DESTINATION_DOMAIN = 8;
  uint256 private constant NONCE = 12;
  uint256 private constant RECIPIENT = 76;
  uint256 private constant DESTINATION_CALLER = 108;
  uint256 private constant FINALITY_EXECUTED = 144;
  uint256 private constant BODY = 148;
  // BurnMessageV2 body offsets (BurnMessageV2.sol), relative to BODY
  uint256 private constant MINT_RECIPIENT = 36;
  uint256 private constant AMOUNT = 68;
  uint256 private constant MESSAGE_SENDER = 100;
  uint256 private constant FEE_EXECUTED = 164;
  uint256 private constant HOOK_DATA = 228;

  IMessageTransmitterV2 public immutable transmitter;
  IERC20Min public immutable usdc;
  /// @notice Circle's local TokenMessengerV2. Only messages addressed to it are accepted: TokenMessengerV2 itself
  ///         checks that the sender is the registered remote TokenMessenger, so the body is a real burn and its
  ///         `messageSender` (the depositor the router trusts as `sourceSender`) cannot be forged with a generic
  ///         `MessageTransmitterV2.sendMessage` message.
  address public immutable tokenMessenger;
  uint32 public immutable localDomain;
  address public forwarder;
  address public owner;
  INorenActionSink public router;
  mapping(bytes32 nonce => bool) public processed;

  /// @notice Every completed transfer. `recipient` is the mint recipient, or the hook beneficiary.
  event Bridged(
    bytes32 indexed nonce,
    uint32 indexed sourceDomain,
    address indexed recipient,
    uint256 minted,
    uint256 feeExecuted,
    address depositor,
    uint32 finalityThresholdExecuted,
    bool viaCre
  );
  /// @notice A hook transfer handed to the router (`routed`) or delivered to the beneficiary (no router set).
  event HookExecuted(bytes32 indexed nonce, uint8 indexed kind, address indexed beneficiary, uint256 amount, bool routed, bool ok);
  /// @notice hookData failed validation; `refundTo` received the minted USDC on Arc.
  event HookRejected(bytes32 indexed nonce, address indexed refundTo, uint256 amount, string reason);
  event ForwarderSet(address indexed forwarder);
  event OwnerSet(address indexed owner);
  event RouterSet(address indexed router);

  error ZeroAddress();
  error NotForwarder(address caller);
  error NotOwner(address caller);
  error MessageTooShort(uint256 length);
  error WrongDestinationDomain(uint32 domain);
  error WrongDestinationCaller(bytes32 caller);
  error NotBurnMessage(bytes32 recipient);
  error AlreadyProcessed(bytes32 nonce);
  error ReceiveFailed();
  error TransferFailed();

  modifier onlyOwner() {
    if (msg.sender != owner) revert NotOwner(msg.sender);
    _;
  }

  constructor(IMessageTransmitterV2 transmitter_, IERC20Min usdc_, address tokenMessenger_, address forwarder_, address owner_) {
    if (
      address(transmitter_) == address(0) || address(usdc_) == address(0) || tokenMessenger_ == address(0) || forwarder_ == address(0)
        || owner_ == address(0)
    ) {
      revert ZeroAddress();
    }
    transmitter = transmitter_;
    usdc = usdc_;
    tokenMessenger = tokenMessenger_;
    localDomain = transmitter_.localDomain();
    forwarder = forwarder_;
    owner = owner_;
    emit ForwarderSet(forwarder_);
    emit OwnerSet(owner_);
  }

  /// @inheritdoc IReceiver
  /// @dev report = abi.encode(bytes message, bytes attestation), written by Noren's CRE relay workflow.
  function onReport(bytes calldata, bytes calldata report) external override {
    if (msg.sender != forwarder) revert NotForwarder(msg.sender);
    (bytes memory message, bytes memory attestation) = abi.decode(report, (bytes, bytes));
    _receive(message, attestation, true);
  }

  /// @notice Completes a Noren transfer with Circle's attestation. Open to any relayer.
  function relay(bytes calldata message, bytes calldata attestation) external {
    _receive(message, attestation, false);
  }

  struct Transfer {
    bytes32 nonce;
    uint32 sourceDomain;
    uint32 finality;
    address mintRecipient;
    address depositor;
    uint256 fee;
    uint256 minted;
  }

  function _receive(bytes memory message, bytes memory attestation, bool viaCre) private {
    if (message.length < BODY + HOOK_DATA) revert MessageTooShort(message.length);
    uint32 destinationDomain = uint32(bytes4(_word(message, DESTINATION_DOMAIN)));
    if (destinationDomain != localDomain) revert WrongDestinationDomain(destinationDomain);
    bytes32 caller = _word(message, DESTINATION_CALLER);
    if (caller != bytes32(uint256(uint160(address(this))))) revert WrongDestinationCaller(caller);
    bytes32 recipientWord = _word(message, RECIPIENT);
    if (recipientWord != bytes32(uint256(uint160(tokenMessenger)))) revert NotBurnMessage(recipientWord);
    Transfer memory t;
    t.nonce = _word(message, NONCE);
    if (processed[t.nonce]) revert AlreadyProcessed(t.nonce);
    processed[t.nonce] = true;

    uint256 before = usdc.balanceOf(address(this));
    if (!transmitter.receiveMessage(message, attestation)) revert ReceiveFailed();

    t.sourceDomain = uint32(bytes4(_word(message, SOURCE_DOMAIN)));
    t.finality = uint32(bytes4(_word(message, FINALITY_EXECUTED)));
    t.mintRecipient = _addr(_word(message, BODY + MINT_RECIPIENT));
    t.depositor = _addr(_word(message, BODY + MESSAGE_SENDER));
    t.fee = uint256(_word(message, BODY + FEE_EXECUTED));
    t.minted = uint256(_word(message, BODY + AMOUNT)) - t.fee;

    address recipient = t.mintRecipient;
    if (t.mintRecipient == address(this)) {
      // Route exactly what Circle minted here (amount - feeExecuted).
      t.minted = usdc.balanceOf(address(this)) - before;
      recipient = _runHook(t, _slice(message, BODY + HOOK_DATA));
    }
    emit Bridged(t.nonce, t.sourceDomain, recipient, t.minted, t.fee, t.depositor, t.finality, viaCre);
  }

  /// @return beneficiary who the USDC was delivered or routed for
  function _runHook(Transfer memory t, bytes memory hookData) private returns (address beneficiary) {
    bytes32 nonce = t.nonce;
    uint256 amount = t.minted;
    address depositor = t.depositor;
    (bool valid, uint8 kind, address who, string memory reason) = validateAction(hookData);
    if (who == address(0)) {
      // No readable beneficiary: return the funds to the depositor's address on Arc.
      _send(depositor, amount);
      emit HookRejected(nonce, depositor, amount, reason);
      return depositor;
    }
    if (!valid) {
      _send(who, amount);
      emit HookRejected(nonce, who, amount, reason);
      return who;
    }
    INorenActionSink r = router;
    if (address(r) == address(0)) {
      _send(who, amount);
      emit HookExecuted(nonce, kind, who, amount, false, true);
      return who;
    }
    _send(address(r), amount);
    bool ok = r.execute(RAIL_CCTP, nonce, uint64(t.sourceDomain), depositor, address(usdc), amount, hookData);
    emit HookExecuted(nonce, kind, who, amount, true, ok);
    return who;
  }

  /// @notice Strict check of `abi.encode(uint8 kind, address beneficiary, bytes32 ref, bytes params)`.
  /// @return valid    true when the encoding is canonical and the params fit a known kind
  /// @return kind     the action kind (0 when unreadable)
  /// @return beneficiary  non-zero whenever a canonical beneficiary word could be read, even if invalid otherwise
  /// @return reason   why it is invalid ("" when valid)
  function validateAction(bytes memory a)
    public
    pure
    returns (bool valid, uint8 kind, address beneficiary, string memory reason)
  {
    if (a.length < 160) return (false, 0, address(0), "action shorter than 160 bytes");
    uint256 kindWord = uint256(_word(a, 0));
    uint256 benWord = uint256(_word(a, 32));
    if (benWord >> 160 != 0 || benWord == 0) return (false, 0, address(0), "beneficiary is not an address");
    beneficiary = address(uint160(benWord));
    if (kindWord > type(uint8).max) return (false, 0, beneficiary, "kind is not a uint8");
    kind = uint8(kindWord);
    if (uint256(_word(a, 96)) != 128) return (false, kind, beneficiary, "params offset is not 128");
    uint256 len = uint256(_word(a, 128));
    if (len == 0 || len > MAX_PARAMS) return (false, kind, beneficiary, "params length out of range");
    if (a.length != 160 + ((len + 31) / 32) * 32) return (false, kind, beneficiary, "action length does not match params");
    if (kind == PAY_INVOICE) {
      if (len != 64) return (false, kind, beneficiary, "PAY_INVOICE params must be (address,bytes32)");
      if (!_isAddressWord(_word(a, 160)) || _word(a, 160) == 0) return (false, kind, beneficiary, "merchant is not an address");
    } else if (kind == EARN_DEPOSIT) {
      if (len != 32) return (false, kind, beneficiary, "EARN_DEPOSIT params must be (address)");
      if (!_isAddressWord(_word(a, 160)) || _word(a, 160) == 0) return (false, kind, beneficiary, "vault is not an address");
    } else if (kind == CREDIT_LINE) {
      if (len != 128) return (false, kind, beneficiary, "CREDIT_LINE params must be (bytes32,uint256,uint64,uint64)");
      if (uint256(_word(a, 224)) > type(uint64).max || uint256(_word(a, 256)) > type(uint64).max) {
        return (false, kind, beneficiary, "expiry or asOf is not a uint64");
      }
    } else if (kind == PAY_ON_CREDIT) {
      if (len != 128) return (false, kind, beneficiary, "PAY_ON_CREDIT params must be (bytes32,address,bytes32,uint256)");
      if (!_isAddressWord(_word(a, 192)) || _word(a, 192) == 0) return (false, kind, beneficiary, "merchant is not an address");
    } else if (kind == SHIELD) {
      if (len != 32) return (false, kind, beneficiary, "SHIELD params must be (uint256 precommitment)");
      uint256 pre = uint256(_word(a, 160));
      if (pre == 0 || pre >= SNARK_SCALAR_FIELD) return (false, kind, beneficiary, "precommitment is not a field element");
    } else if (kind == LINE_REPORT) {
      return (false, kind, beneficiary, "LINE_REPORT is outbound only");
    }
    // AQUA_ORDER params are opaque here. Unknown kinds also go to the router, which books them as a
    // claimable balance for the beneficiary.
    return (true, kind, beneficiary, "");
  }

  function _send(address to, uint256 amount) private {
    if (!usdc.transfer(to, amount)) revert TransferFailed();
  }

  function _isAddressWord(bytes32 w) private pure returns (bool) {
    return uint256(w) >> 160 == 0;
  }

  function _addr(bytes32 w) private pure returns (address) {
    return address(uint160(uint256(w)));
  }

  /// @dev 32 bytes of `b` at `offset`; bytes past the end read as whatever follows in memory, so callers check length.
  function _word(bytes memory b, uint256 offset) private pure returns (bytes32 w) {
    assembly ("memory-safe") {
      w := mload(add(add(b, 32), offset))
    }
  }

  function _slice(bytes memory b, uint256 start) private pure returns (bytes memory out) {
    uint256 n = b.length - start;
    out = new bytes(n);
    assembly ("memory-safe") {
      mcopy(add(out, 32), add(add(b, 32), start), n)
    }
  }

  function setForwarder(address forwarder_) external onlyOwner {
    if (forwarder_ == address(0)) revert ZeroAddress();
    forwarder = forwarder_;
    emit ForwarderSet(forwarder_);
  }

  /// @notice Noren's shared action router; zero delivers hook transfers straight to the beneficiary.
  function setRouter(INorenActionSink router_) external onlyOwner {
    router = router_;
    emit RouterSet(address(router_));
  }

  function setOwner(address owner_) external onlyOwner {
    if (owner_ == address(0)) revert ZeroAddress();
    owner = owner_;
    emit OwnerSet(owner_);
  }

  function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
    return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
  }
}
