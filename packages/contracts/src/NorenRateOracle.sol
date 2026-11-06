// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IERC165 {
  function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

/// @notice Chainlink CRE receiver interface (KeystoneForwarder calls onReport).
interface IReceiver is IERC165 {
  function onReport(bytes calldata metadata, bytes calldata report) external;
}

/// @title NorenRateOracle
/// @notice Stores Chainlink fiat/USD and USDC/USD rounds (read from Arc mainnet Data Feeds) that a
///         Chainlink CRE workflow delivers through the CRE forwarder on Arc Testnet, and quotes
///         fiat amounts in USDC on-chain from them.
/// @dev Unaudited. Only the configured forwarder may call onReport. With the CRE simulation
///      MockKeystoneForwarder no DON signature is checked, so a mock-forwarder deployment is for
///      simulation only; point `forwarder` at the production KeystoneForwarder for real use.
contract NorenRateOracle is IReceiver {
  /// @notice One currency in a CRE report. Field order matches the workflow's REPORT_ABI.
  struct RateUpdate {
    string currency;
    uint8 fiatMinorDecimals;
    address fiatUsdFeed;
    int256 fiatUsdAnswer;
    uint8 fiatUsdDecimals;
    uint80 fiatUsdRoundId;
    uint64 fiatUsdUpdatedAt;
    int256 usdcUsdAnswer;
    uint8 usdcUsdDecimals;
    uint80 usdcUsdRoundId;
    uint64 usdcUsdUpdatedAt;
    uint256 rateE18;
  }

  /// @notice A stored rate: both Chainlink rounds plus the Arc mainnet block they were read at.
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

  struct Feed {
    address proxy;
    uint8 minorDecimals;
    bool enabled;
  }

  uint256 public constant MAX_FUTURE_SKEW = 120;

  uint64 public immutable sourceChainId;
  address public immutable usdcUsdFeed;
  address public owner;
  address public forwarder;
  /// @notice Optional CRE workflow owner check (zero = disabled; the simulation mock forwarder sends no metadata).
  address public expectedWorkflowOwner;
  uint256 public maxAge;
  uint64 public lastSourceBlock;

  mapping(bytes3 => Feed) public feeds;
  bytes3[] private currencyList;
  mapping(bytes3 => Rate) private latest;
  mapping(bytes3 => mapping(uint80 => mapping(uint80 => Rate))) private recorded;

  event RateUpdated(
    bytes3 indexed currency,
    uint80 fiatUsdRoundId,
    uint80 usdcUsdRoundId,
    uint256 rateE18,
    uint64 fiatUsdUpdatedAt,
    uint64 usdcUsdUpdatedAt,
    uint64 sourceBlock
  );
  event RateUnchanged(bytes3 indexed currency, uint80 fiatUsdRoundId, uint80 usdcUsdRoundId, uint64 sourceBlock);
  event FeedSet(bytes3 indexed currency, address proxy, uint8 minorDecimals);
  event ForwarderSet(address indexed previous, address indexed next);
  event ExpectedWorkflowOwnerSet(address indexed previous, address indexed next);
  event MaxAgeSet(uint256 maxAge);
  event OwnershipTransferred(address indexed previous, address indexed next);

  error NotOwner();
  error ZeroAddress();
  error UnauthorizedForwarder(address caller, address expected);
  error InvalidWorkflowOwner(address received, address expected);
  error WrongSourceChain(uint64 received, uint64 expected);
  error WrongUsdcFeed(address received, address expected);
  error OlderReport(uint64 sourceBlock, uint64 lastSourceBlock);
  error InvalidCurrency(string currency);
  error UnknownCurrency(bytes3 currency);
  error FeedMismatch(bytes3 currency, address received, address expected);
  error MinorDecimalsMismatch(bytes3 currency, uint8 received, uint8 expected);
  error InvalidPrice(bytes3 currency, int256 fiatUsdAnswer, int256 usdcUsdAnswer);
  error InvalidDecimals(bytes3 currency);
  error InvalidSyntheticUsd();
  error IncompleteRound(bytes3 currency);
  error FutureRound(bytes3 currency, uint64 updatedAt);
  error StalePrice(bytes3 currency, uint256 updatedAt, uint256 maxAge);
  error OlderRound(bytes3 currency, uint64 updatedAt, uint64 storedUpdatedAt);
  error RateMismatch(bytes3 currency, uint256 received, uint256 computed);
  error NoRate(bytes3 currency);
  error UnknownRounds(bytes3 currency, uint80 fiatUsdRoundId, uint80 usdcUsdRoundId);
  error ZeroAmount();
  error EmptyReport();

  modifier onlyOwner() {
    if (msg.sender != owner) revert NotOwner();
    _;
  }

  /// @param forwarder_ CRE forwarder on this chain (Arc Testnet MockKeystoneForwarder
  ///        0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1 for simulation, KeystoneForwarder
  ///        0x76c9cf548b4179F8901cda1f8623568b58215E62 for deployed workflows).
  /// @param sourceChainId_ Chain the feeds are read from (Arc mainnet, 5042).
  /// @param usdcUsdFeed_ USDC/USD proxy on the source chain.
  /// @param codes ISO 4217 codes; "USD" must use the zero address (synthetic USD/USD = 1).
  constructor(
    address forwarder_,
    uint64 sourceChainId_,
    address usdcUsdFeed_,
    uint256 maxAge_,
    string[] memory codes,
    address[] memory proxies,
    uint8[] memory minorDecimals
  ) {
    if (forwarder_ == address(0) || usdcUsdFeed_ == address(0)) revert ZeroAddress();
    owner = msg.sender;
    forwarder = forwarder_;
    sourceChainId = sourceChainId_;
    usdcUsdFeed = usdcUsdFeed_;
    maxAge = maxAge_;
    emit OwnershipTransferred(address(0), msg.sender);
    emit ForwarderSet(address(0), forwarder_);
    emit MaxAgeSet(maxAge_);
    require(codes.length == proxies.length && codes.length == minorDecimals.length, 'length');
    for (uint256 i; i < codes.length; ++i) {
      _setFeed(_code(codes[i]), proxies[i], minorDecimals[i]);
    }
  }

  // ---------------------------------------------------------------- CRE receiver

  /// @inheritdoc IReceiver
  function onReport(bytes calldata metadata, bytes calldata report) external override {
    if (msg.sender != forwarder) revert UnauthorizedForwarder(msg.sender, forwarder);
    if (expectedWorkflowOwner != address(0)) {
      // metadata = abi.encodePacked(bytes32 workflowId, bytes10 workflowName, address workflowOwner) [+ bytes2 reportId]
      address workflowOwner = metadata.length >= 62 ? address(bytes20(metadata[42:62])) : address(0);
      if (workflowOwner != expectedWorkflowOwner) revert InvalidWorkflowOwner(workflowOwner, expectedWorkflowOwner);
    }
    (uint64 chainId, uint64 sourceBlock, address usdcFeed, RateUpdate[] memory updates) =
      abi.decode(report, (uint64, uint64, address, RateUpdate[]));
    if (chainId != sourceChainId) revert WrongSourceChain(chainId, sourceChainId);
    if (usdcFeed != usdcUsdFeed) revert WrongUsdcFeed(usdcFeed, usdcUsdFeed);
    if (sourceBlock < lastSourceBlock) revert OlderReport(sourceBlock, lastSourceBlock);
    if (updates.length == 0) revert EmptyReport();
    lastSourceBlock = sourceBlock;
    for (uint256 i; i < updates.length; ++i) {
      _apply(updates[i], sourceBlock);
    }
  }

  function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
    return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
  }

  function _apply(RateUpdate memory u, uint64 sourceBlock) private {
    bytes3 code = _code(u.currency);
    Feed memory feed = feeds[code];
    if (!feed.enabled) revert UnknownCurrency(code);
    if (u.fiatUsdFeed != feed.proxy) revert FeedMismatch(code, u.fiatUsdFeed, feed.proxy);
    if (u.fiatMinorDecimals != feed.minorDecimals) revert MinorDecimalsMismatch(code, u.fiatMinorDecimals, feed.minorDecimals);
    if (u.fiatUsdAnswer <= 0 || u.usdcUsdAnswer <= 0 || u.fiatUsdAnswer > int256(uint256(type(uint128).max)) || u.usdcUsdAnswer > int256(uint256(type(uint128).max))) {
      revert InvalidPrice(code, u.fiatUsdAnswer, u.usdcUsdAnswer);
    }
    if (u.fiatUsdDecimals > 18 || u.usdcUsdDecimals > 18) revert InvalidDecimals(code);
    if (feed.proxy == address(0)) {
      // Synthetic USD/USD: exactly 1, no round, timestamped with the USDC/USD round.
      if (u.fiatUsdAnswer != 1 || u.fiatUsdDecimals != 0 || u.fiatUsdRoundId != 0 || u.fiatUsdUpdatedAt != u.usdcUsdUpdatedAt) {
        revert InvalidSyntheticUsd();
      }
    }
    _checkFresh(code, u.fiatUsdUpdatedAt);
    _checkFresh(code, u.usdcUsdUpdatedAt);

    uint256 computed = _rateE18(uint256(u.fiatUsdAnswer), u.fiatUsdDecimals, uint256(u.usdcUsdAnswer), u.usdcUsdDecimals);
    if (computed != u.rateE18) revert RateMismatch(code, u.rateE18, computed);

    Rate storage prev = latest[code];
    if (prev.recordedAt != 0) {
      if (u.fiatUsdUpdatedAt < prev.fiatUsdUpdatedAt) revert OlderRound(code, u.fiatUsdUpdatedAt, prev.fiatUsdUpdatedAt);
      if (u.usdcUsdUpdatedAt < prev.usdcUsdUpdatedAt) revert OlderRound(code, u.usdcUsdUpdatedAt, prev.usdcUsdUpdatedAt);
      if (u.fiatUsdRoundId == prev.fiatUsdRoundId && u.usdcUsdRoundId == prev.usdcUsdRoundId) {
        emit RateUnchanged(code, u.fiatUsdRoundId, u.usdcUsdRoundId, sourceBlock);
        return;
      }
    }

    Rate memory r = Rate({
      fiatUsdAnswer: uint128(uint256(u.fiatUsdAnswer)),
      usdcUsdAnswer: uint128(uint256(u.usdcUsdAnswer)),
      fiatUsdRoundId: u.fiatUsdRoundId,
      usdcUsdRoundId: u.usdcUsdRoundId,
      fiatUsdUpdatedAt: u.fiatUsdUpdatedAt,
      fiatUsdDecimals: u.fiatUsdDecimals,
      usdcUsdDecimals: u.usdcUsdDecimals,
      fiatMinorDecimals: u.fiatMinorDecimals,
      usdcUsdUpdatedAt: u.usdcUsdUpdatedAt,
      sourceBlock: sourceBlock,
      recordedAt: uint64(block.timestamp)
    });
    latest[code] = r;
    recorded[code][u.fiatUsdRoundId][u.usdcUsdRoundId] = r;
    emit RateUpdated(code, u.fiatUsdRoundId, u.usdcUsdRoundId, computed, u.fiatUsdUpdatedAt, u.usdcUsdUpdatedAt, sourceBlock);
  }

  function _checkFresh(bytes3 code, uint64 updatedAt) private view {
    if (updatedAt == 0) revert IncompleteRound(code);
    if (updatedAt > block.timestamp + MAX_FUTURE_SKEW) revert FutureRound(code, updatedAt);
    if (updatedAt + maxAge < block.timestamp) revert StalePrice(code, updatedAt, maxAge);
  }

  // ---------------------------------------------------------------- quotes

  /// @notice Quote fiat minor units in USDC base units (6 decimals) from the latest stored rounds,
  ///         rounding up. Same formula as packages/core/src/pricing.ts quoteUsdc.
  /// @dev Reverts StalePrice if either stored round is older than maxAge at the current block.
  function quote(string calldata currency, uint256 fiatAmount)
    external
    view
    returns (uint256 usdcAmount, uint80 fiatUsdRoundId, uint80 usdcUsdRoundId, uint256 oldestUpdatedAt)
  {
    bytes3 code = _code(currency);
    Rate memory r = latest[code];
    if (r.recordedAt == 0) revert NoRate(code);
    oldestUpdatedAt = r.fiatUsdUpdatedAt < r.usdcUsdUpdatedAt ? r.fiatUsdUpdatedAt : r.usdcUsdUpdatedAt;
    if (oldestUpdatedAt + maxAge < block.timestamp) revert StalePrice(code, oldestUpdatedAt, maxAge);
    usdcAmount = _usdc(r, fiatAmount);
    fiatUsdRoundId = r.fiatUsdRoundId;
    usdcUsdRoundId = r.usdcUsdRoundId;
  }

  /// @notice Quote at a specific recorded round pair (a rate lock). No freshness check: the caller
  ///         decides how long a locked quote is valid (for example invoice expiry).
  function quoteAtRounds(string calldata currency, uint256 fiatAmount, uint80 fiatUsdRoundId, uint80 usdcUsdRoundId)
    public
    view
    returns (uint256 usdcAmount)
  {
    bytes3 code = _code(currency);
    Rate memory r = recorded[code][fiatUsdRoundId][usdcUsdRoundId];
    if (r.recordedAt == 0) revert UnknownRounds(code, fiatUsdRoundId, usdcUsdRoundId);
    usdcAmount = _usdc(r, fiatAmount);
  }

  /// @notice True when `usdcAmount` is exactly what the recorded rounds give for `fiatAmount`.
  function verifyQuote(
    string calldata currency,
    uint256 fiatAmount,
    uint80 fiatUsdRoundId,
    uint80 usdcUsdRoundId,
    uint256 usdcAmount
  ) external view returns (bool) {
    return quoteAtRounds(currency, fiatAmount, fiatUsdRoundId, usdcUsdRoundId) == usdcAmount;
  }

  /// @notice Latest stored rate for a currency: USDC per one fiat major unit, 18 decimals (rounded down).
  function rateE18(string calldata currency) external view returns (uint256) {
    bytes3 code = _code(currency);
    Rate memory r = latest[code];
    if (r.recordedAt == 0) revert NoRate(code);
    return _rateE18(r.fiatUsdAnswer, r.fiatUsdDecimals, r.usdcUsdAnswer, r.usdcUsdDecimals);
  }

  function latestRate(string calldata currency) external view returns (Rate memory) {
    return latest[_code(currency)];
  }

  function recordedRate(string calldata currency, uint80 fiatUsdRoundId, uint80 usdcUsdRoundId) external view returns (Rate memory) {
    return recorded[_code(currency)][fiatUsdRoundId][usdcUsdRoundId];
  }

  /// @notice Stored round IDs per currency (0, 0 when never written). The CRE workflow reads this to skip no-op writes.
  function roundsFor(string[] calldata codes)
    external
    view
    returns (uint80[] memory fiatUsdRoundIds, uint80[] memory usdcUsdRoundIds)
  {
    fiatUsdRoundIds = new uint80[](codes.length);
    usdcUsdRoundIds = new uint80[](codes.length);
    for (uint256 i; i < codes.length; ++i) {
      Rate storage r = latest[_code(codes[i])];
      fiatUsdRoundIds[i] = r.fiatUsdRoundId;
      usdcUsdRoundIds[i] = r.usdcUsdRoundId;
    }
  }

  function currencies() external view returns (bytes3[] memory) {
    return currencyList;
  }

  function _usdc(Rate memory r, uint256 fiatAmount) private pure returns (uint256) {
    if (fiatAmount == 0) revert ZeroAmount();
    uint256 numerator = fiatAmount * r.fiatUsdAnswer * 1_000_000 * 10 ** uint256(r.usdcUsdDecimals);
    uint256 denominator = uint256(r.usdcUsdAnswer) * 10 ** (uint256(r.fiatMinorDecimals) + r.fiatUsdDecimals);
    return numerator / denominator + (numerator % denominator == 0 ? 0 : 1);
  }

  function _rateE18(uint256 fiatAnswer, uint8 fiatDecimals, uint256 usdcAnswer, uint8 usdcDecimals) private pure returns (uint256) {
    return fiatAnswer * 10 ** uint256(usdcDecimals) * 1e18 / (usdcAnswer * 10 ** uint256(fiatDecimals));
  }

  function _code(string memory currency) private pure returns (bytes3 code) {
    bytes memory b = bytes(currency);
    if (b.length != 3) revert InvalidCurrency(currency);
    for (uint256 i; i < 3; ++i) {
      if (b[i] < 0x41 || b[i] > 0x5A) revert InvalidCurrency(currency);
    }
    code = bytes3(b);
  }

  // ---------------------------------------------------------------- admin

  function setFeed(string calldata currency, address proxy, uint8 minorDecimals) external onlyOwner {
    _setFeed(_code(currency), proxy, minorDecimals);
  }

  function _setFeed(bytes3 code, address proxy, uint8 minorDecimals) private {
    if (minorDecimals > 4) revert InvalidDecimals(code);
    if ((code == bytes3('USD')) != (proxy == address(0))) revert FeedMismatch(code, proxy, address(0));
    if (!feeds[code].enabled) currencyList.push(code);
    feeds[code] = Feed({proxy: proxy, minorDecimals: minorDecimals, enabled: true});
    emit FeedSet(code, proxy, minorDecimals);
  }

  function setForwarder(address next) external onlyOwner {
    if (next == address(0)) revert ZeroAddress();
    emit ForwarderSet(forwarder, next);
    forwarder = next;
  }

  function setExpectedWorkflowOwner(address next) external onlyOwner {
    emit ExpectedWorkflowOwnerSet(expectedWorkflowOwner, next);
    expectedWorkflowOwner = next;
  }

  function setMaxAge(uint256 next) external onlyOwner {
    maxAge = next;
    emit MaxAgeSet(next);
  }

  function transferOwnership(address next) external onlyOwner {
    if (next == address(0)) revert ZeroAddress();
    emit OwnershipTransferred(owner, next);
    owner = next;
  }
}
