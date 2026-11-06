// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from '@oz/access/Ownable2Step.sol';
import {ECDSA} from '@oz/utils/cryptography/ECDSA.sol';
import {EIP712} from '@oz/utils/cryptography/EIP712.sol';

/// @notice What NorenReputation reads from NorenCredit (Pay in 3 history and the underwriter key).
interface INorenCreditHistory {
  function history(address borrower)
    external
    view
    returns (uint32 onTime, uint32 late, uint32 completed, uint32 clean, uint32 defaults);
  function underwriter() external view returns (address);
}

/// @notice What NorenReputation reads from NorenBorrow.
interface INorenBorrowRecord {
  function record(address account) external view returns (uint32 repaidLoans, uint32 liquidations);
  function securedCapacityUsdg(address account, uint16 ltvBps) external view returns (uint256);
}

/// @title NorenReputation
/// @notice On-chain reputation for Noren customers on Robinhood Chain. Points and milestones come from:
/// - on-time Pay-in-3 installments (NorenCredit.history),
/// - fully repaid deposit-backed loans (NorenBorrow.record),
/// - account age, from an EIP-712 `AccountAge` attestation signed by the Noren underwriter key
///   (NorenCredit.underwriter(), the same key that signs credit attestations),
/// - World ID: an EIP-712 `VerifiedHuman(account, nullifierHash, expiry)` attestation signed by the
///   World ID server key after it verified the proof off-chain. One nullifier per account and one
///   account per nullifier.
/// Late installments and liquidations (Pay in 3, Arc lines and loans) subtract points.
///
/// Milestones unlock tiers: borrow LTV 66 -> 70 -> 75 -> 80% (never above 80%), a credit-limit
/// multiplier the underwriter applies to the Pay-in-3 / Arc line limit it attests, and the World ID
/// starter line (unsecured, on Arc, opened by the World ID server through the CRE bridge).
contract NorenReputation is Ownable2Step, EIP712 {
  bytes32 public constant VERIFIED_HUMAN_TYPEHASH =
    keccak256('VerifiedHuman(address account,bytes32 nullifierHash,uint64 expiry)');
  bytes32 public constant ACCOUNT_AGE_TYPEHASH = keccak256('AccountAge(address account,uint64 firstSeenAt,uint64 expiry)');

  uint256 public constant M_VERIFIED_HUMAN = 1 << 0;
  uint256 public constant M_ACCOUNT_30D = 1 << 1;
  uint256 public constant M_ACCOUNT_180D = 1 << 2;
  uint256 public constant M_ON_TIME_3 = 1 << 3;
  uint256 public constant M_FIRST_LOAN_REPAID = 1 << 4;
  uint256 public constant M_LOANS_REPAID_3 = 1 << 5;
  uint256 public constant M_CLEAN_RECORD = 1 << 6;

  uint256 public constant POINTS_ON_TIME = 10; // per installment, first 12 count
  uint256 public constant MAX_ON_TIME_COUNTED = 12;
  uint256 public constant POINTS_LOAN_REPAID = 25; // per loan, first 4 count
  uint256 public constant MAX_LOANS_COUNTED = 4;
  uint256 public constant POINTS_AGE_30D = 20;
  uint256 public constant POINTS_AGE_180D = 20; // on top of the 30-day points
  uint256 public constant POINTS_VERIFIED_HUMAN = 50;
  uint256 public constant PENALTY_LATE = 15;
  uint256 public constant PENALTY_LIQUIDATION = 60;

  uint16 public constant BASE_LTV_BPS = 6_600;
  uint16 public constant MAX_LTV_BPS = 8_000;
  uint256 public constant MAX_STARTER_USDC6 = 100e6;

  struct Tier {
    uint16 ltvBps;
    uint16 limitMultiplierBps;
    uint16 minPoints;
    bool needsHuman;
    bool needsRepayment; // a repaid loan or three on-time installments
  }

  struct Breakdown {
    uint32 onTime;
    uint32 late;
    uint32 repaidLoans;
    uint32 liquidations; // Pay in 3 / Arc line defaults + loan liquidations
    uint64 firstSeenAt;
    uint64 ageDays;
    bool verifiedHuman;
    uint256 points;
    uint256 milestones;
    uint8 tier;
    uint16 ltvBps;
    uint16 limitMultiplierBps;
  }

  INorenCreditHistory public immutable credit;
  INorenBorrowRecord public borrow;
  address public worldIdSigner;
  /// @notice Unsecured World ID starter line on Arc (USDC, 6 decimals), included in creditLimitOf.
  uint256 public starterUsdc6 = 25e6;

  mapping(bytes32 nullifierHash => address) public humanOf;
  mapping(address account => bytes32) public nullifierOf;
  mapping(address account => uint64) public verifiedAt;
  mapping(address account => uint64) public firstSeenAt;

  event BorrowSet(address indexed borrow);
  event WorldIdSignerSet(address indexed signer);
  event StarterSet(uint256 starterUsdc6);
  event HumanVerified(address indexed account, bytes32 indexed nullifierHash);
  event AccountAgeRecorded(address indexed account, uint64 firstSeenAt);

  error BadSignature();
  error AttestationExpired(uint64 expiry);
  error NullifierUsed(bytes32 nullifierHash, address account);
  error AlreadyVerified(address account, bytes32 nullifierHash);
  error BadAttestation();
  error NotOlder(uint64 firstSeenAt, uint64 recorded);
  error BadConfig();

  constructor(address owner_, INorenCreditHistory credit_, address worldIdSigner_)
    Ownable(owner_)
    EIP712('NorenReputation', '1')
  {
    if (address(credit_) == address(0) || worldIdSigner_ == address(0)) revert BadConfig();
    credit = credit_;
    worldIdSigner = worldIdSigner_;
  }

  // ---------------------------------------------------------------- admin

  function setBorrow(INorenBorrowRecord b) external onlyOwner {
    borrow = b;
    emit BorrowSet(address(b));
  }

  function setWorldIdSigner(address s) external onlyOwner {
    if (s == address(0)) revert BadConfig();
    worldIdSigner = s;
    emit WorldIdSignerSet(s);
  }

  function setStarter(uint256 usdc6) external onlyOwner {
    if (usdc6 > MAX_STARTER_USDC6) revert BadConfig();
    starterUsdc6 = usdc6;
    emit StarterSet(usdc6);
  }

  // ---------------------------------------------------------------- attestations

  function domainSeparator() external view returns (bytes32) {
    return _domainSeparatorV4();
  }

  function hashVerifiedHuman(address account, bytes32 nullifierHash, uint64 expiry) public view returns (bytes32) {
    return _hashTypedDataV4(keccak256(abi.encode(VERIFIED_HUMAN_TYPEHASH, account, nullifierHash, expiry)));
  }

  function hashAccountAge(address account, uint64 firstSeen, uint64 expiry) public view returns (bytes32) {
    return _hashTypedDataV4(keccak256(abi.encode(ACCOUNT_AGE_TYPEHASH, account, firstSeen, expiry)));
  }

  /// @notice Record a World ID verified human. Anyone may relay the server's signature.
  function verifyHuman(address account, bytes32 nullifierHash, uint64 expiry, bytes calldata signature) external {
    if (expiry <= block.timestamp) revert AttestationExpired(expiry);
    if (account == address(0) || nullifierHash == bytes32(0)) revert BadAttestation();
    _requireSigner(hashVerifiedHuman(account, nullifierHash, expiry), signature, worldIdSigner);
    address prior = humanOf[nullifierHash];
    if (prior != address(0)) revert NullifierUsed(nullifierHash, prior);
    bytes32 had = nullifierOf[account];
    if (had != bytes32(0)) revert AlreadyVerified(account, had);
    humanOf[nullifierHash] = account;
    nullifierOf[account] = nullifierHash;
    verifiedAt[account] = uint64(block.timestamp);
    emit HumanVerified(account, nullifierHash);
  }

  /// @notice Record the account's first-seen time from the underwriter's history scan. Age can only
  /// grow: a later attestation must show an earlier (or the first) first-seen time.
  function recordAccountAge(address account, uint64 firstSeen, uint64 expiry, bytes calldata signature) external {
    if (expiry <= block.timestamp) revert AttestationExpired(expiry);
    if (account == address(0) || firstSeen == 0 || firstSeen > block.timestamp) revert BadAttestation();
    _requireSigner(hashAccountAge(account, firstSeen, expiry), signature, credit.underwriter());
    uint64 recorded = firstSeenAt[account];
    if (recorded != 0 && firstSeen >= recorded) revert NotOlder(firstSeen, recorded);
    firstSeenAt[account] = firstSeen;
    emit AccountAgeRecorded(account, firstSeen);
  }

  // ---------------------------------------------------------------- views

  /// @notice Tier table: 0 base, 1-3 unlocked by points and milestones.
  function tierTable(uint8 t) public pure returns (Tier memory) {
    if (t == 0) return Tier(BASE_LTV_BPS, 10_000, 0, false, false);
    if (t == 1) return Tier(7_000, 12_500, 40, false, false);
    if (t == 2) return Tier(7_500, 15_000, 75, true, false);
    return Tier(MAX_LTV_BPS, 20_000, 120, true, true);
  }

  function breakdownOf(address account) public view returns (Breakdown memory b) {
    (uint32 onTime, uint32 late,,, uint32 defaults) = credit.history(account);
    b.onTime = onTime;
    b.late = late;
    b.liquidations = defaults;
    INorenBorrowRecord br = borrow;
    if (address(br) != address(0)) {
      (uint32 repaid, uint32 liq) = br.record(account);
      b.repaidLoans = repaid;
      b.liquidations += liq;
    }
    b.firstSeenAt = firstSeenAt[account];
    if (b.firstSeenAt != 0 && b.firstSeenAt <= block.timestamp) b.ageDays = uint64((block.timestamp - b.firstSeenAt) / 1 days);
    b.verifiedHuman = nullifierOf[account] != bytes32(0);

    uint256 m;
    if (b.verifiedHuman) m |= M_VERIFIED_HUMAN;
    if (b.ageDays >= 30) m |= M_ACCOUNT_30D;
    if (b.ageDays >= 180) m |= M_ACCOUNT_180D;
    if (b.onTime >= 3) m |= M_ON_TIME_3;
    if (b.repaidLoans >= 1) m |= M_FIRST_LOAN_REPAID;
    if (b.repaidLoans >= 3) m |= M_LOANS_REPAID_3;
    if (b.late == 0 && b.liquidations == 0 && (b.onTime != 0 || b.repaidLoans != 0)) m |= M_CLEAN_RECORD;
    b.milestones = m;

    uint256 plus = _min(b.onTime, MAX_ON_TIME_COUNTED) * POINTS_ON_TIME + _min(b.repaidLoans, MAX_LOANS_COUNTED) * POINTS_LOAN_REPAID;
    if (m & M_ACCOUNT_30D != 0) plus += POINTS_AGE_30D;
    if (m & M_ACCOUNT_180D != 0) plus += POINTS_AGE_180D;
    if (b.verifiedHuman) plus += POINTS_VERIFIED_HUMAN;
    uint256 minus = uint256(b.late) * PENALTY_LATE + uint256(b.liquidations) * PENALTY_LIQUIDATION;
    b.points = plus > minus ? plus - minus : 0;

    for (uint8 t = 3; t > 0; --t) {
      Tier memory tt = tierTable(t);
      if (b.points < tt.minPoints) continue;
      if (tt.needsHuman && !b.verifiedHuman) continue;
      if (tt.needsRepayment && m & (M_FIRST_LOAN_REPAID | M_ON_TIME_3) == 0) continue;
      b.tier = t;
      break;
    }
    Tier memory cur = tierTable(b.tier);
    b.ltvBps = cur.ltvBps;
    b.limitMultiplierBps = cur.limitMultiplierBps;
  }

  /// @notice (points, tier, borrow LTV in bps, credit-limit multiplier in bps).
  function reputationOf(address account)
    external
    view
    returns (uint256 points, uint8 tier, uint16 ltvBps, uint16 limitMultiplierBps)
  {
    Breakdown memory b = breakdownOf(account);
    return (b.points, b.tier, b.ltvBps, b.limitMultiplierBps);
  }

  /// @notice Milestone bitmask (M_* constants).
  function milestonesOf(address account) external view returns (uint256) {
    return breakdownOf(account).milestones;
  }

  /// @notice Borrow LTV for `account`: 66% base, up to 80% at the top tier.
  function ltvOf(address account) external view returns (uint16) {
    return breakdownOf(account).ltvBps;
  }

  function limitMultiplierOf(address account) external view returns (uint16) {
    return breakdownOf(account).limitMultiplierBps;
  }

  /// @notice Total credit = sum over deposits of Chainlink value x tier LTV (USDG, borrowable from the
  /// lender pool) + the unsecured World ID starter line (USDC on Arc, valued at $1, opened by the
  /// World ID server through the CRE bridge; this contract does not open it).
  function creditLimitOf(address account) external view returns (uint256 totalUsd6, uint256 securedUsdg, uint256 starterUsdc) {
    Breakdown memory b = breakdownOf(account);
    INorenBorrowRecord br = borrow;
    if (address(br) != address(0)) securedUsdg = br.securedCapacityUsdg(account, b.ltvBps);
    starterUsdc = b.verifiedHuman ? starterUsdc6 : 0;
    totalUsd6 = securedUsdg + starterUsdc;
  }

  function _requireSigner(bytes32 digest, bytes calldata signature, address expected) internal pure {
    (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
    if (err != ECDSA.RecoverError.NoError || signer != expected || expected == address(0)) revert BadSignature();
  }

  function _min(uint256 a, uint256 b) internal pure returns (uint256) {
    return a < b ? a : b;
  }
}
