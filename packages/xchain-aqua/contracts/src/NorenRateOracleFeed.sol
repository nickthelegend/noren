// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The parts of NorenRateOracle (packages/contracts, live on Arc Testnet) this adapter reads.
interface INorenRateOracle {
  struct Rate {
    uint128 fiatUsdAnswer;
    uint128 usdcUsdAnswer;
    uint80 fiatUsdRoundId;
    uint80 usdcUsdRoundId;
    uint64 fiatUsdUpdatedAt;
    uint8 fiatUsdDecimals;
    uint8 usdcUsdDecimals;
    uint8 fiatMinorDecimals;
    uint64 usdcUsdUpdatedAt;
    uint64 sourceBlock;
    uint64 recordedAt;
  }

  function latestRate(string calldata currency) external view returns (Rate memory);
}

/// @title NorenRateOracleFeed
/// @notice AggregatorV3-compatible view of one leg of a NorenRateOracle rate, so a SwapVM
/// NorenOraclePeg strategy on Arc Testnet can price against it. NorenRateOracle stores the Chainlink
/// rounds (fiat/USD and USDC/USD, read from Chainlink Data Feeds on Arc mainnet) that a Chainlink CRE
/// workflow writes through the CRE forwarder. This adapter returns those rounds unchanged: the round
/// id, answer, decimals and `updatedAt` are Chainlink's own, so the instruction's staleness check
/// measures the real Chainlink age, not the time of the CRE write.
/// @dev Two instances price EURC in USDC: leg FIAT_USD for "EUR" (the base feed, EUR/USD) and leg
/// USDC_USD for "EUR" (the quote feed, USDC/USD from the same report). NorenOraclePeg then quotes
/// EUR/USD ÷ USDC/USD, which is exactly NorenRateOracle.quote("EUR", …). Read-only, no owner.
/// Unaudited hackathon code.
contract NorenRateOracleFeed {
  enum Leg {
    FIAT_USD,
    USDC_USD
  }

  INorenRateOracle public immutable oracle;
  Leg public immutable leg;
  bytes3 internal immutable _code;

  error NoRate(string currency);
  error UnknownRound(uint80 roundId);

  constructor(INorenRateOracle oracle_, string memory currency_, Leg leg_) {
    bytes memory b = bytes(currency_);
    require(address(oracle_) != address(0) && b.length == 3, 'bad config');
    oracle = oracle_;
    leg = leg_;
    _code = bytes3(b);
    // Fails loudly at deploy time if the oracle has no rate for this currency yet.
    _rate();
  }

  function currency() public view returns (string memory) {
    return string(abi.encodePacked(_code));
  }

  function version() external pure returns (uint256) {
    return 1;
  }

  function description() external view returns (string memory) {
    return leg == Leg.FIAT_USD
      ? string.concat(currency(), ' / USD (Chainlink, via NorenRateOracle CRE report)')
      : string.concat('USDC / USD (Chainlink, via NorenRateOracle CRE report for ', currency(), ')');
  }

  function decimals() external view returns (uint8) {
    INorenRateOracle.Rate memory r = _rate();
    return leg == Leg.FIAT_USD ? r.fiatUsdDecimals : r.usdcUsdDecimals;
  }

  function latestRoundData()
    public
    view
    returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
  {
    INorenRateOracle.Rate memory r = _rate();
    if (leg == Leg.FIAT_USD) {
      roundId = r.fiatUsdRoundId;
      answer = int256(uint256(r.fiatUsdAnswer));
      updatedAt = r.fiatUsdUpdatedAt;
    } else {
      roundId = r.usdcUsdRoundId;
      answer = int256(uint256(r.usdcUsdAnswer));
      updatedAt = r.usdcUsdUpdatedAt;
    }
    // NorenRateOracle keeps updatedAt only; Chainlink sets startedAt == updatedAt for OCR rounds.
    startedAt = updatedAt;
    answeredInRound = roundId;
  }

  /// @notice Only the latest stored round is available (NorenRateOracle keeps history keyed by round pairs).
  function getRoundData(uint80 id)
    external
    view
    returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
  {
    (roundId, answer, startedAt, updatedAt, answeredInRound) = latestRoundData();
    if (id != roundId) revert UnknownRound(id);
  }

  function _rate() internal view returns (INorenRateOracle.Rate memory r) {
    r = oracle.latestRate(currency());
    if (r.recordedAt == 0) revert NoRate(currency());
  }
}
