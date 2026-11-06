// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface INorenPriceFeed {
  function decimals() external view returns (uint8);
  function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// @title NorenQuoter
/// @notice Reads fiat/USD and USDC/USD Chainlink proxies to quote six-decimal USDC.
/// @dev Unaudited example consumer. Call this on Arc mainnet for pricing; settlement remains on Arc testnet.
contract NorenQuoter {
  error ZeroAmount();
  error InvalidPrice(address feed);
  error IncompleteRound(address feed);
  error StalePrice(address feed, uint256 updatedAt, uint256 maxAge);

  /// @notice Quote fiat minor units in USDC base units, rounding upward.
  /// @param fiatUsdFeed Fiat/USD proxy on Arc mainnet.
  /// @param usdcUsdFeed USDC/USD proxy on Arc mainnet.
  /// @param fiatAmount Amount in fiat minor units.
  /// @param fiatDecimals Fiat minor-unit decimal places (for example EUR 2, JPY 0).
  /// @param maxAge Maximum allowed age of either feed round, in seconds.
  /// @return usdcAmount USDC base units (6 decimals).
  /// @return fiatRound Fiat/USD proxy round ID for audit.
  /// @return usdcRound USDC/USD proxy round ID for audit.
  /// @return oldestUpdatedAt Earlier update timestamp of the two rounds.
  function quote(address fiatUsdFeed, address usdcUsdFeed, uint256 fiatAmount, uint8 fiatDecimals, uint256 maxAge)
    external view returns (uint256 usdcAmount, uint80 fiatRound, uint80 usdcRound, uint256 oldestUpdatedAt)
  {
    if (fiatAmount == 0) revert ZeroAmount();
    uint256 fiatAnswer;
    uint256 usdcAnswer;
    uint256 fiatUpdatedAt;
    uint256 usdcUpdatedAt;
    (fiatAnswer, fiatRound, fiatUpdatedAt) = _read(fiatUsdFeed, maxAge);
    (usdcAnswer, usdcRound, usdcUpdatedAt) = _read(usdcUsdFeed, maxAge);
    uint8 feedDecimals = INorenPriceFeed(fiatUsdFeed).decimals();
    uint8 usdcDecimals = INorenPriceFeed(usdcUsdFeed).decimals();
    uint256 numerator = fiatAmount * fiatAnswer * 1_000_000 * 10 ** uint256(usdcDecimals);
    uint256 denominator = usdcAnswer * 10 ** uint256(fiatDecimals + feedDecimals);
    usdcAmount = numerator / denominator + (numerator % denominator == 0 ? 0 : 1);
    oldestUpdatedAt = fiatUpdatedAt < usdcUpdatedAt ? fiatUpdatedAt : usdcUpdatedAt;
  }

  function _read(address feed, uint256 maxAge) private view returns (uint256 answer, uint80 roundId, uint256 updatedAt) {
    int256 raw;
    (roundId, raw,, updatedAt,) = INorenPriceFeed(feed).latestRoundData();
    if (raw <= 0) revert InvalidPrice(feed);
    if (updatedAt == 0) revert IncompleteRound(feed);
    if (updatedAt > block.timestamp || block.timestamp - updatedAt > maxAge) revert StalePrice(feed, updatedAt, maxAge);
    answer = uint256(raw);
  }
}
