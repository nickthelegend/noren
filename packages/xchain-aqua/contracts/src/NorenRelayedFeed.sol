// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title NorenRelayedFeed
/// @notice A Chainlink Data Feed from another chain, read through the AggregatorV3 interface.
/// For example, Chainlink NVDA/USD on Robinhood Chain (0x379E…9F15, chain 4663) made readable on Arc,
/// where no stock feeds exist.
///
/// Rounds are written only by the Noren settler, from DON-signed CRE reports. The CRE workflow reads
/// the source feed's latestRoundData() on Robinhood Chain, and the report carries the round
/// unchanged: roundId, answer, startedAt, updatedAt and answeredInRound. Because `updatedAt` is the
/// source feed's own timestamp, the consumer's staleness check (NorenOraclePeg's max age) measures
/// the real age of the Chainlink price, not the age of the relay.
///
/// Rounds only move forward: an older or equal round is ignored, so a delayed or replayed report
/// can never roll the price back.
contract NorenRelayedFeed {
  struct Round {
    uint80 roundId;
    int256 answer;
    uint256 startedAt;
    uint256 updatedAt;
    uint80 answeredInRound;
  }

  address public immutable writer;
  uint8 public immutable decimals;
  uint64 public immutable sourceChainId;
  address public immutable sourceFeed;
  string public description;

  Round internal _latest;

  event RoundRelayed(uint80 indexed roundId, int256 answer, uint256 updatedAt);
  event RoundIgnored(uint80 indexed roundId, uint256 updatedAt, uint80 latestRoundId, uint256 latestUpdatedAt);

  error OnlyWriter(address caller);
  error BadRound();
  error NoRound();

  constructor(address writer_, uint8 decimals_, uint64 sourceChainId_, address sourceFeed_, string memory description_) {
    writer = writer_;
    decimals = decimals_;
    sourceChainId = sourceChainId_;
    sourceFeed = sourceFeed_;
    description = description_;
  }

  /// @notice Store a source round if it is newer than the latest. Returns true when stored.
  function relay(Round calldata r) external returns (bool stored) {
    if (msg.sender != writer) revert OnlyWriter(msg.sender);
    if (r.answer <= 0 || r.updatedAt == 0 || r.answeredInRound < r.roundId) revert BadRound();
    Round storage l = _latest;
    if (r.roundId <= l.roundId || r.updatedAt < l.updatedAt) {
      emit RoundIgnored(r.roundId, r.updatedAt, l.roundId, l.updatedAt);
      return false;
    }
    _latest = r;
    emit RoundRelayed(r.roundId, r.answer, r.updatedAt);
    return true;
  }

  function latestRoundData()
    external
    view
    returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
  {
    Round memory l = _latest;
    if (l.updatedAt == 0) revert NoRound();
    return (l.roundId, l.answer, l.startedAt, l.updatedAt, l.answeredInRound);
  }

  function latestRound() external view returns (Round memory) {
    return _latest;
  }

  function version() external pure returns (uint256) {
    return 4;
  }
}
