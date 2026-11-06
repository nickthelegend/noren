// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {NorenQuoter, INorenPriceFeed} from '../src/NorenQuoter.sol';

interface VmQuoter {
  function createSelectFork(string calldata) external returns (uint256);
  function envOr(string calldata, string calldata) external returns (string memory);
  function warp(uint256) external;
  function expectRevert(bytes4) external;
  function expectRevert(bytes calldata) external;
}

interface IDescribedFeed is INorenPriceFeed {
  function description() external view returns (string memory);
}

contract NorenQuoterTest {
  VmQuoter private constant vm = VmQuoter(address(uint160(uint256(keccak256('hevm cheat code')))));
  address private constant EUR = 0xDd5B15443cd733D3966a50a3E48cB7DF9Fb5DE0D;
  address private constant JPY = 0xF9Fc1C20C82d774A3787845E73E41BCbF7F38F25;
  address private constant USDC = 0x84EA90AC252Dc437031461836DB5164219147905;
  uint256 private constant MAX_AGE = 86400 + 3600;
  NorenQuoter private quoter;

  function setUp() public {
    try vm.createSelectFork(vm.envOr('ARC_MAINNET_RPC', 'https://arc-rpc.publicnode.com')) returns (uint256) {}
    catch { revert('network required: Arc mainnet RPC for Chainlink fork tests'); }
    quoter = new NorenQuoter();
  }

  function testAllFeedDescriptions() public view {
    address[10] memory feeds = [
      EUR, 0x3E0a1296e6CBF0a8fa54F2b4909643214EfCeE4D, JPY,
      0x5024DF70A748e5f1E720AAe8EEfc590430d71573,
      0xaF452c2EA72b6E08AB64a67133a13C4ED35343eb,
      0x302eaa6cd6f7AdDdc973fAC2Bb8fa32e9Ce19f21,
      0x3406DB72AC5136b89eba6808CFcaD83aF523B3C2,
      0x07040A33A0204596e927595D0994C5D841d7d61D,
      0x361b95c10b76Ca3f35C686d423e43A951755Bf23, USDC
    ];
    for (uint256 i; i < feeds.length; i++) require(bytes(IDescribedFeed(feeds[i]).description()).length > 0, 'feed description unavailable');
  }

  function testLiveEUR() public view { _assertQuote(EUR, 690, 2); }
  function testLiveJPY() public view { _assertQuote(JPY, 1000, 0); }

  function testStalePrice() public {
    (,,,uint256 fiatUpdated,) = INorenPriceFeed(EUR).latestRoundData();
    vm.warp(block.timestamp + MAX_AGE + 1);
    vm.expectRevert(abi.encodeWithSelector(NorenQuoter.StalePrice.selector, EUR, fiatUpdated, MAX_AGE));
    quoter.quote(EUR, USDC, 690, 2, MAX_AGE);
  }

  function testZeroAmount() public {
    vm.expectRevert(NorenQuoter.ZeroAmount.selector);
    quoter.quote(EUR, USDC, 0, 2, MAX_AGE);
  }

  function _assertQuote(address fiatFeed, uint256 amount, uint8 minorDecimals) private view {
    (uint80 fiatRound, int256 fiatAnswer,, uint256 fiatUpdated,) = INorenPriceFeed(fiatFeed).latestRoundData();
    (uint80 usdcRound, int256 usdcAnswer,, uint256 usdcUpdated,) = INorenPriceFeed(USDC).latestRoundData();
    uint256 numerator = amount * uint256(fiatAnswer) * 1_000_000 * 10 ** INorenPriceFeed(USDC).decimals();
    uint256 denominator = uint256(usdcAnswer) * 10 ** (uint256(minorDecimals) + INorenPriceFeed(fiatFeed).decimals());
    uint256 expected = numerator / denominator + (numerator % denominator == 0 ? 0 : 1);
    (uint256 quoted, uint80 returnedFiatRound, uint80 returnedUsdcRound, uint256 oldest) = quoter.quote(fiatFeed, USDC, amount, minorDecimals, MAX_AGE);
    require(quoted == expected, 'wrong amount');
    require(returnedFiatRound == fiatRound && returnedUsdcRound == usdcRound, 'wrong rounds');
    require(oldest == (fiatUpdated < usdcUpdated ? fiatUpdated : usdcUpdated), 'wrong timestamp');
  }
}
