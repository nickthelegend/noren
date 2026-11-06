// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {INorenActionSink} from "./interfaces/INorenActionSink.sol";
import {NorenArcAction} from "./libraries/NorenArcAction.sol";

/// @notice The two Privacy Pools (0xbow / Kohaku) calls the sink makes.
interface IPrivacyEntrypoint {
  function deposit(IERC20 asset, uint256 value, uint256 precommitment) external returns (uint256 commitment);
}

interface IPrivacyPoolRagequit {
  struct RagequitProof {
    uint256[2] pA;
    uint256[2][2] pB;
    uint256[2] pC;
    uint256[4] pubSignals; // [commitmentHash, nullifierHash, value, label]
  }

  function ragequit(RagequitProof memory proof) external;
}

/// @notice Circle's FiatToken blocklist view (Arc's native USDC exposes it at 0x3600...).
interface IUsdcBlocklist {
  function isBlacklisted(address account) external view returns (bool);
}

/// @title NorenShieldSink
/// @notice "Arrive private": USDC that lands on Arc through a Noren rail (CCTP NorenArcHook or the CCIP gateway) with
///         action kind SHIELD is deposited straight into the Kohaku privacy pool under the user's precommitment,
///         which the user's wallet computed client-side and carried in the action. The money arrives as a private
///         balance; no public USDC balance on Arc ever holds it.
///         Every other action kind is forwarded unchanged to NorenArcActionRouter, so a rail can point at this sink
///         without losing any existing action. The router is not upgradeable; this sink is the additive upgrade.
/// @dev One sink speaks for one rail id on the router (the router allowlists `railOf[sink]`), so CCTP and CCIP each
///      get their own instance.
///      Compliance: the pool's ASP screens the on-chain depositor, which here is this sink. So the sink screens the
///      people behind the transfer itself: the source-chain sender and the beneficiary are checked against USDC's
///      blocklist before the deposit. A hit freezes the funds in a compliance hold that only the owner can release.
///      Exit: Privacy Pools only lets the original depositor ragequit. The sink records who each commitment is for
///      and exposes `ragequit`, so a deposit the ASP never approves can still leave the pool, publicly, to the
///      beneficiary recorded at deposit time.
///      Like the router, `execute` never reverts for a well-formed call from an allowlisted rail: a failed SHIELD
///      becomes a claimable balance for the beneficiary. Unaudited hackathon code.
contract NorenShieldSink is INorenActionSink, Ownable2Step, ReentrancyGuard {
  using SafeERC20 for IERC20;

  /// @dev BN254 scalar field; a precommitment is a Poseidon hash, so it must be a field element.
  uint256 internal constant SNARK_SCALAR_FIELD =
    21888242871839275222246405745257275088548364400416034343981259425135106482881 + 1736;

  IERC20 public immutable usdc;
  IPrivacyEntrypoint public immutable entrypoint;
  IPrivacyPoolRagequit public immutable pool;
  INorenActionSink public immutable router;
  /// @notice The rail id this sink speaks for (keccak256("CCTP") or keccak256("CCIP")).
  bytes32 public immutable railId;

  /// @notice Contracts allowed to deliver (NorenArcHook for CCTP, NorenCcipGateway for CCIP).
  mapping(address caller => bool) public isRail;
  /// @notice SHIELD messages already handled (rail-local id: CCTP nonce or CCIP messageId).
  mapping(bytes32 msgId => bool) public shielded;
  /// @notice Who a pool commitment made by this sink belongs to (receives a ragequit).
  mapping(uint256 commitment => address) public beneficiaryOf;
  mapping(address account => mapping(address token => uint256)) public claimable;

  struct Hold {
    address beneficiary;
    address sourceSender;
    uint256 amount;
  }

  mapping(bytes32 msgId => Hold) public holds;

  event RailAllowed(address indexed caller, bool allowed);
  event Shielded(
    bytes32 indexed msgId,
    uint64 indexed source,
    address indexed beneficiary,
    address sourceSender,
    uint256 amount,
    uint256 precommitment,
    uint256 commitment
  );
  event ShieldFailed(bytes32 indexed msgId, address indexed creditedTo, uint256 amount, bytes reason);
  event ComplianceHold(bytes32 indexed msgId, address indexed sourceSender, address indexed beneficiary, uint256 amount);
  event HoldReleased(bytes32 indexed msgId, address indexed to, uint256 amount);
  event Forwarded(bytes32 indexed msgId, uint8 indexed kind, bool ok);
  event DuplicateIgnored(bytes32 indexed msgId, address creditedTo, uint256 amount);
  event Ragequit(uint256 indexed commitment, address indexed to, uint256 amount);
  event Claimed(address indexed account, address indexed token, uint256 amount);

  error NotRail(address caller, bytes32 rail);
  error OnlySelf();
  error WrongToken(address token);
  error ZeroAmount();
  error BadPrecommitment();
  error Blocklisted(address account);
  error UnknownCommitment(uint256 commitment);
  error NoHold(bytes32 msgId);
  error NothingToClaim();

  constructor(
    IERC20 usdc_,
    IPrivacyEntrypoint entrypoint_,
    IPrivacyPoolRagequit pool_,
    INorenActionSink router_,
    bytes32 railId_,
    address owner_
  ) Ownable(owner_) {
    usdc = usdc_;
    entrypoint = entrypoint_;
    pool = pool_;
    router = router_;
    railId = railId_;
  }

  function setRail(address caller, bool allowed) external onlyOwner {
    isRail[caller] = allowed;
    emit RailAllowed(caller, allowed);
  }

  /// @inheritdoc INorenActionSink
  function execute(
    bytes32 rail,
    bytes32 msgId,
    uint64 source,
    address sourceSender,
    address token,
    uint256 amount,
    bytes calldata action
  ) external nonReentrant returns (bool ok) {
    if (rail != railId || !isRail[msg.sender]) revert NotRail(msg.sender, rail);

    uint8 kind = _kindOf(action);
    if (kind != NorenArcAction.SHIELD) {
      // Every other action: hand the tokens and the call to the shared router, unchanged.
      if (amount != 0) IERC20(token).safeTransfer(address(router), amount);
      ok = router.execute(rail, msgId, source, sourceSender, token, amount, action);
      emit Forwarded(msgId, kind, ok);
      return ok;
    }

    if (shielded[msgId]) {
      if (amount != 0) _credit(sourceSender, token, amount);
      emit DuplicateIgnored(msgId, sourceSender, amount);
      return false;
    }
    shielded[msgId] = true;

    try this.shield(msgId, source, sourceSender, token, amount, action) {
      return true;
    } catch (bytes memory reason) {
      if (amount == 0) {
        // Nothing arrived: leave it retryable on the rail.
        shielded[msgId] = false;
        emit ShieldFailed(msgId, address(0), 0, reason);
        return false;
      }
      address who = _beneficiaryOr(action, sourceSender);
      if (bytes4(reason) == Blocklisted.selector) {
        // Compliance hold: neither the beneficiary nor the sender can take these funds without the owner.
        holds[msgId] = Hold({beneficiary: who, sourceSender: sourceSender, amount: amount});
        emit ComplianceHold(msgId, sourceSender, who, amount);
        return false;
      }
      _credit(who, token, amount);
      emit ShieldFailed(msgId, who, amount, reason);
      return false;
    }
  }

  /// @dev Self-call so a failing deposit rolls back cleanly and `execute` can book the funds instead.
  function shield(bytes32 msgId, uint64 source, address sourceSender, address token, uint256 amount, bytes calldata action)
    external
  {
    if (msg.sender != address(this)) revert OnlySelf();
    NorenArcAction.Action memory a = NorenArcAction.decode(action);
    if (token != address(usdc)) revert WrongToken(token);
    if (amount == 0) revert ZeroAmount();
    if (a.params.length != 32) revert BadPrecommitment();
    uint256 precommitment = abi.decode(a.params, (uint256));
    if (precommitment == 0 || precommitment >= SNARK_SCALAR_FIELD) revert BadPrecommitment();

    // The ASP sees this sink as the depositor, so screen the people behind the transfer here.
    IUsdcBlocklist list = IUsdcBlocklist(address(usdc));
    if (list.isBlacklisted(sourceSender)) revert Blocklisted(sourceSender);
    if (list.isBlacklisted(a.beneficiary)) revert Blocklisted(a.beneficiary);

    usdc.forceApprove(address(entrypoint), amount);
    uint256 commitment = entrypoint.deposit(usdc, amount, precommitment);
    beneficiaryOf[commitment] = a.beneficiary;
    emit Shielded(msgId, source, a.beneficiary, sourceSender, amount, precommitment, commitment);
  }

  /// @notice Public exit for a deposit this sink made (for example one the ASP never approves). Only the holder of
  ///         the deposit's secrets can make the proof; the funds always go to the beneficiary recorded at deposit.
  function ragequit(IPrivacyPoolRagequit.RagequitProof calldata proof) external nonReentrant {
    uint256 commitment = proof.pubSignals[0];
    address to = beneficiaryOf[commitment];
    if (to == address(0)) revert UnknownCommitment(commitment);
    uint256 before = usdc.balanceOf(address(this));
    pool.ragequit(proof);
    uint256 received = usdc.balanceOf(address(this)) - before;
    usdc.safeTransfer(to, received);
    emit Ragequit(commitment, to, received);
  }

  /// @notice Owner decision on a compliance hold: return the funds (normally to the source sender) after review.
  function releaseHold(bytes32 msgId, address to) external onlyOwner nonReentrant {
    Hold memory h = holds[msgId];
    if (h.amount == 0) revert NoHold(msgId);
    delete holds[msgId];
    usdc.safeTransfer(to, h.amount);
    emit HoldReleased(msgId, to, h.amount);
  }

  function claim(address token) external nonReentrant {
    uint256 amt = claimable[msg.sender][token];
    if (amt == 0) revert NothingToClaim();
    claimable[msg.sender][token] = 0;
    IERC20(token).safeTransfer(msg.sender, amt);
    emit Claimed(msg.sender, token, amt);
  }

  // ---------------------------------------------------------------- internals

  function _credit(address to, address token, uint256 amount) private {
    claimable[to][token] += amount;
  }

  /// @dev The action's kind word, or 0 (forwarded; the router books malformed actions) when unreadable.
  function _kindOf(bytes calldata action) private pure returns (uint8) {
    if (action.length < 32) return 0;
    uint256 w = uint256(bytes32(action[0:32]));
    return w > type(uint8).max ? 0 : uint8(w);
  }

  function _beneficiaryOr(bytes calldata action, address fallback_) private view returns (address) {
    try this.beneficiaryOfAction(action) returns (address b) {
      return b == address(0) ? fallback_ : b;
    } catch {
      return fallback_;
    }
  }

  function beneficiaryOfAction(bytes calldata action) external pure returns (address) {
    return NorenArcAction.decode(action).beneficiary;
  }
}
