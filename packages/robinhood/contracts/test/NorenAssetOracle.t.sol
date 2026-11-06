// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {RobinhoodBase} from './RobinhoodBase.sol';
import {NorenAssetOracle} from '../src/NorenAssetOracle.sol';
import {IAggregatorV3} from '../src/interfaces/IAggregatorV3.sol';
import {IRobinhoodStockToken} from '../src/interfaces/IRobinhoodStockToken.sol';
import {RobinhoodMainnet as RH} from '../script/RobinhoodMainnet.sol';

contract NorenAssetOracleTest is RobinhoodBase {
  function test_liveFeedsPriceEveryConfiguredAsset() public view {
    address[] memory list = oracle.assets();
    assertEq(list.length, 10);
    for (uint256 i; i < list.length; ++i) {
      (address feed,,,,,) = oracle.assetConfig(list[i]);
      (, int256 answer,, uint256 updatedAt,) = IAggregatorV3(feed).latestRoundData();
      uint8 dec = IAggregatorV3(feed).decimals();
      NorenAssetOracle.Price memory p = oracle.price(list[i]);
      assertEq(p.usd8, uint256(answer) * 1e8 / 10 ** dec, 'normalised to 8 decimals from live decimals()');
      assertEq(p.updatedAt, updatedAt);
      assertGt(p.usd8, 0);
    }
  }

  function test_usdgPriceWithinPegBand() public view {
    uint256 p = oracle.usdgPrice();
    assertGt(p, 0.98e8);
    assertLt(p, 1.02e8);
  }

  function test_stockValueAppliesLiveUiMultiplier() public view {
    uint256 m = IRobinhoodStockToken(RH.NVDA).uiMultiplier();
    uint256 price8 = oracle.price(RH.NVDA).usd8;
    uint256 v = oracle.valueUsd8(RH.NVDA, 10e18);
    assertEq(v, 10e18 * m / 1e18 * price8 / 1e18, 'value = raw * uiMultiplier * price');
    assertGt(v, 10 * price8, 'dividend-adjusted multiplier > 1 raises value');
  }

  function test_splitChangesCollateralValue() public {
    uint256 before = oracle.valueUsd8(RH.NVDA, 1e18);
    uint256 m = IRobinhoodStockToken(RH.NVDA).uiMultiplier();
    _setMultiplier(RH.NVDA, m / 2);
    assertApproxEqAbs(oracle.valueUsd8(RH.NVDA, 1e18), before / 2, 1);
  }

  function test_assetForUsd8RoundsUpWithSpread() public view {
    uint256 usd8 = 100e8;
    (uint256 amt, NorenAssetOracle.Price memory p) = oracle.assetForUsd8(RH.WETH, usd8, 30);
    assertGe(oracle.valueUsd8(RH.WETH, amt), usd8 * 10_030 / 10_000 - 1);
    assertEq(p.marketClosed, false, 'ETH trades 24/7');
  }

  function test_staleEthPriceReverts() public {
    (,,, uint256 updatedAt,) = IAggregatorV3(RH.FEED_ETH).latestRoundData();
    vm.warp(updatedAt + RH.MAX_AGE_OPEN + 1);
    vm.expectRevert(abi.encodeWithSelector(NorenAssetOracle.StalePrice.selector, RH.WETH, updatedAt, uint256(RH.MAX_AGE_OPEN)));
    oracle.price(RH.WETH);
  }

  function test_weekendAllowsStaleStockButNotEth() public {
    // A Sunday 12:00 UTC (inside the closed window) chosen from the TSLA round itself, not from the fork's wall clock:
    // the first Sunday noon that is past the open-market limit, so the case holds whatever the feed's age at fork time.
    (,,, uint256 tslaUpdated,) = IAggregatorV3(RH.FEED_TSLA).latestRoundData();
    uint256 ts = _nextAt(0, 12);
    while (ts - tslaUpdated <= RH.MAX_AGE_OPEN) ts += 7 days;
    vm.warp(ts);
    assertTrue(oracle.marketClosed(block.timestamp));
    NorenAssetOracle.Price memory p = oracle.price(RH.TSLA);
    assertTrue(p.marketClosed);
    assertGt(block.timestamp - p.updatedAt, RH.MAX_AGE_OPEN, 'older than the open-market limit');
    (,,, uint256 ethUpdated,) = IAggregatorV3(RH.FEED_ETH).latestRoundData();
    if (block.timestamp - ethUpdated > RH.MAX_AGE_OPEN) {
      vm.expectRevert(abi.encodeWithSelector(NorenAssetOracle.StalePrice.selector, RH.WETH, ethUpdated, uint256(RH.MAX_AGE_OPEN)));
      oracle.price(RH.WETH);
    }
  }

  function test_stockStaleOnceMarketReopens() public {
    // Monday 07:00 UTC: market open again, a Friday price is too old.
    vm.warp(_nextAt(1, 7));
    assertFalse(oracle.marketClosed(block.timestamp));
    (,,, uint256 updatedAt,) = IAggregatorV3(RH.FEED_TSLA).latestRoundData();
    vm.expectRevert(abi.encodeWithSelector(NorenAssetOracle.StalePrice.selector, RH.TSLA, updatedAt, uint256(RH.MAX_AGE_OPEN)));
    oracle.price(RH.TSLA);
  }

  function test_closedWindowCalendar() public view {
    // 2026-11-07 Saturday, 2026-11-08 Sunday, 2026-11-09 Monday, 2026-11-06 Friday (UTC)
    assertTrue(oracle.marketClosed(1794052800)); // Sat 12:00
    assertTrue(oracle.marketClosed(1794139200)); // Sun 12:00
    assertTrue(oracle.marketClosed(1794189600)); // Mon 02:00
    assertFalse(oracle.marketClosed(1794211200)); // Mon 08:00
    assertFalse(oracle.marketClosed(1793966400)); // Fri 12:00
  }

  function test_holidayClosesMarket() public {
    uint256 today = block.timestamp / 1 days;
    vm.prank(owner);
    oracle.setHoliday(today, true);
    assertTrue(oracle.marketClosed(block.timestamp));
    assertTrue(oracle.price(RH.NVDA).marketClosed);
  }

  function test_closedMarketHaircutOnNewRisk() public {
    vm.warp(_nextAt(6, 1)); // Saturday 01:00 UTC
    uint256 v = oracle.valueUsd8(RH.NVDA, 1e18);
    assertEq(oracle.riskValueUsd8(RH.NVDA, 1e18), v * (10_000 - oracle.closedHaircutBps()) / 10_000);
    assertEq(oracle.riskValueUsd8(RH.WETH, 1e18), oracle.valueUsd8(RH.WETH, 1e18), 'no haircut for 24/7 assets');
  }

  function test_usdgDepegGuard() public {
    vm.prank(owner);
    oracle.setRiskParams(0, 500); // zero tolerance: the live 0.9999x USDG price is outside the band
    uint256 live = oracle.price(RH.USDG).usd8;
    if (live != 1e8) {
      vm.expectRevert(abi.encodeWithSelector(NorenAssetOracle.UsdgDepeg.selector, live));
      oracle.usdgPrice();
    }
  }

  function test_unsupportedAssetReverts() public {
    vm.expectRevert(abi.encodeWithSelector(NorenAssetOracle.AssetNotSupported.selector, address(0xBEEF)));
    oracle.price(address(0xBEEF));
  }

  /// @notice Audit RH-C-4: disabling an asset stops new risk (isSupported) but keeps it priced, so
  /// positions already holding it can still be valued and liquidated.
  function test_Audit_RHC4_disabledAssetStillPricedButNotAccepted() public {
    uint256 before = oracle.price(RH.SPY).usd8;
    vm.prank(owner);
    oracle.disableAsset(RH.SPY);
    assertFalse(oracle.isSupported(RH.SPY), 'no new risk in a disabled asset');
    assertEq(oracle.price(RH.SPY).usd8, before, 'still priced for existing positions');
  }

  /// @notice Audit RH-C-5: with an L2 Sequencer Uptime feed set, prices are refused while it reports
  /// down. Robinhood Chain has no Chainlink uptime feed yet, so the real ETH/USD feed stands in for a
  /// "down" reading (any non-zero answer = down); the up/grace-period branch needs a real uptime feed.
  function test_Audit_RHC5_sequencerDownBlocksPrices() public {
    vm.expectRevert();
    oracle.setSequencerUptimeFeed(RH.FEED_ETH, 1 hours); // owner only
    vm.prank(owner);
    oracle.setSequencerUptimeFeed(RH.FEED_ETH, 1 hours);
    vm.expectRevert(NorenAssetOracle.SequencerDown.selector);
    oracle.price(RH.NVDA);
    vm.expectRevert(NorenAssetOracle.SequencerDown.selector);
    oracle.usdgPrice();
    vm.prank(owner);
    oracle.setSequencerUptimeFeed(address(0), 0);
    assertGt(oracle.price(RH.USDG).usd8, 0, 'unset = not checked');
  }

  function test_badConfigRejected() public {
    vm.startPrank(owner);
    vm.expectRevert(NorenAssetOracle.BadConfig.selector);
    oracle.setAsset(RH.TSLA, RH.FEED_TSLA, 2 days, 1 days, true, true); // closed < open
    vm.expectRevert(); // not a feed
    oracle.setAsset(RH.TSLA, RH.USDG, 1 days, 1 days, true, true);
    vm.stopPrank();
    vm.expectRevert();
    oracle.setAsset(RH.TSLA, RH.FEED_TSLA, 1 days, 3 days, true, true); // not owner
  }

  function test_checkTransferableReportsBlocklistAndPause() public {
    _block(customer);
    vm.expectRevert(abi.encodeWithSelector(NorenAssetOracle.AccountBlocked.selector, RH.NVDA, customer));
    oracle.checkTransferable(RH.NVDA, customer, address(vault));
    vm.prank(RH.STOCK_PAUSER);
    (bool ok,) = RH.NVDA.call(abi.encodeWithSignature('pause()'));
    assertTrue(ok);
    vm.expectRevert(abi.encodeWithSelector(NorenAssetOracle.AssetPaused.selector, RH.NVDA));
    oracle.checkTransferable(RH.NVDA, merchant, address(vault));
  }
}
