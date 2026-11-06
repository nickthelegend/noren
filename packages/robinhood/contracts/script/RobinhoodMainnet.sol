// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {NorenAssetOracle} from '../src/NorenAssetOracle.sol';

/// @notice Robinhood Chain mainnet (chain 4663) addresses, verified over RPC on 2026-11-06.
library RobinhoodMainnet {
  address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
  address internal constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
  address internal constant TSLA = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d;
  address internal constant AAPL = 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9;
  address internal constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
  address internal constant SPY = 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C;
  address internal constant AMZN = 0x12f190a9F9d7D37a250758b26824B97CE941bF54;
  address internal constant MSFT = 0xe93237C50D904957Cf27E7B1133b510C669c2e74;
  address internal constant GOOGL = 0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3;
  address internal constant META = 0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35;

  address internal constant FEED_TSLA = 0x4A1166a659A55625345e9515b32adECea5547C38;
  address internal constant FEED_AAPL = 0x6B22A786bAa607d76728168703a39Ea9C99f2cD0;
  address internal constant FEED_NVDA = 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15;
  address internal constant FEED_SPY = 0x319724394D3A0e3669269846abE664Cd621f9f6A;
  address internal constant FEED_MSFT = 0x45C3C877C15E6BA2EBB19eA114Ea508d14C1Af2E;
  address internal constant FEED_GOOGL = 0xF6f373a037c30F0e5010d854385cA89185AE638b;
  address internal constant FEED_AMZN = 0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C;
  address internal constant FEED_META = 0x7C38C00C30BEe9378381E7B6135d7283356D71b1;
  address internal constant FEED_ETH = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9;
  address internal constant FEED_USDG = 0x61B7e5650328764B076A108EFF5fa7282a1B9aD2;

  /// @dev Stock Token beacon and access-controlled registry (isBlocked / blockAccounts / pause).
  address internal constant STOCK_REGISTRY = 0xe10b6f6B275de231345c20D14Ab812db62151b00;
  /// @dev Real role holders found from RoleGranted logs and eth_call simulation; impersonated on forks only.
  address internal constant BLOCKLIST_ADMIN = 0x913cA87347391218e5De2C17c5A0AEba8B0b28fD;
  address internal constant MULTIPLIER_ADMIN = 0x92905e8d0e2301BA143215B8D86D63fFD4188143;
  address internal constant STOCK_PAUSER = 0xFCcF56B674113d9C4eb0F9B3370930ceD9E6Ab23;
  /// @dev Uniswap v4 PoolManager: the largest real holder of USDG, WETH and Stock Tokens; fork funding source.
  address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
  /// @dev Uniswap v4 V4Quoter on Robinhood Chain (used only to compare quotes against Aqua makers).
  address internal constant V4_QUOTER = 0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94;

  /// @dev Official 1inch deployments on Robinhood Chain (github.com/1inch/aqua deployments.md).
  /// The router is AquaSwapVMRouter v1.0.2 (eip712Domain "1inch SwapVM v1.0" / "1.0.2").
  address internal constant AQUA = 0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a;
  address internal constant SWAPVM_ROUTER = 0x111111338c5091E8440b67B168bAe16a668AC0De;
  /// @dev Build artifact of the modified router (packages/aqua/swapvm-ext, LicenseRef-Degensoft-SwapVM-1.1),
  /// deployed from bytecode so Noren's MIT contracts never compile SwapVM source.
  string internal constant NOREN_ROUTER_ARTIFACT =
    '../../aqua/swapvm-ext/out/NorenAquaSwapVMRouter.sol/NorenAquaSwapVMRouter.json';
  string internal constant NOREN_ROUTER_NAME = 'Noren SwapVM';
  string internal constant NOREN_ROUTER_VERSION = '1.0.2-noren.1';

  /// @dev Chainlink heartbeat is 86 400 s; allow one extra hour. Stock feeds pause while US
  /// markets are closed, so they get three days inside the weekend/holiday window.
  uint32 internal constant MAX_AGE_OPEN = 86_400 + 3_600;
  uint32 internal constant MAX_AGE_CLOSED_STOCK = 3 days;

  function configureOracle(NorenAssetOracle o) internal {
    o.setAsset(USDG, FEED_USDG, MAX_AGE_OPEN, MAX_AGE_OPEN, false, false);
    o.setAsset(WETH, FEED_ETH, MAX_AGE_OPEN, MAX_AGE_OPEN, false, false);
    o.setAsset(TSLA, FEED_TSLA, MAX_AGE_OPEN, MAX_AGE_CLOSED_STOCK, true, true);
    o.setAsset(AAPL, FEED_AAPL, MAX_AGE_OPEN, MAX_AGE_CLOSED_STOCK, true, true);
    o.setAsset(NVDA, FEED_NVDA, MAX_AGE_OPEN, MAX_AGE_CLOSED_STOCK, true, true);
    o.setAsset(SPY, FEED_SPY, MAX_AGE_OPEN, MAX_AGE_CLOSED_STOCK, true, true);
    o.setAsset(AMZN, FEED_AMZN, MAX_AGE_OPEN, MAX_AGE_CLOSED_STOCK, true, true);
    o.setAsset(MSFT, FEED_MSFT, MAX_AGE_OPEN, MAX_AGE_CLOSED_STOCK, true, true);
    o.setAsset(GOOGL, FEED_GOOGL, MAX_AGE_OPEN, MAX_AGE_CLOSED_STOCK, true, true);
    o.setAsset(META, FEED_META, MAX_AGE_OPEN, MAX_AGE_CLOSED_STOCK, true, true);
  }
}
