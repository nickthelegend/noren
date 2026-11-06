// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Addresses used by the cross-chain Aqua deployment. Every address here was checked with
/// `cast code` / `cast call` on Nov 6 2026 (see docs/XCHAIN.md).
library XC {
  // ---------------------------------------------------------------- chains
  uint64 internal constant ROBINHOOD = 4663; // Robinhood Chain mainnet (local fork)
  uint64 internal constant ARC = 5042002; // Arc Testnet (local fork)
  uint64 internal constant BASE_SEPOLIA = 84532; // Base Sepolia (local fork)
  uint64 internal constant ARC_MAINNET = 5042; // read-only source of the EUR/USD round

  // ---------------------------------------------------------------- 1inch (official, Arc mainnet + Robinhood)
  address internal constant AQUA = 0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a;
  address internal constant OFFICIAL_SWAPVM_ROUTER = 0x111111338c5091E8440b67B168bAe16a668AC0De;
  /// @dev keccak256 of the runtime code at AQUA on Arc mainnet and on Robinhood Chain (identical).
  bytes32 internal constant AQUA_CODEHASH = 0x720bc02d220db318164dc3bade86eec1f3655bdc00fc1174de7d816a95c341f8;
  /// @dev keccak256 of the official AquaSwapVMRouter runtime code on Arc mainnet ("1inch SwapVM v1.0", "1.0").
  bytes32 internal constant ARC_ROUTER_CODEHASH = 0x294d0117c44096acd4f3be344f03039ece923758a5bd5c77fac496df0edbcb3a;
  string internal constant NOREN_ROUTER_ARTIFACT = '../../aqua/swapvm-ext/out/NorenAquaSwapVMRouter.sol/NorenAquaSwapVMRouter.json';
  address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
  bytes32 internal constant ROUTER_SALT = keccak256('noren-xchain-router-v1');

  // ---------------------------------------------------------------- Robinhood Chain
  address internal constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
  address internal constant NVDA_USD = 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15;
  address internal constant TSLA = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d;
  address internal constant TSLA_USD = 0x4A1166a659A55625345e9515b32adECea5547C38;
  /// @dev CRE simulation forwarder of "robinhood-testnet"; copied onto the mainnet fork by the scripts.
  address internal constant RH_FORWARDER = 0x0b93082D9b3C7C97fAcd250082899BAcf3af3885;

  // ---------------------------------------------------------------- Base Sepolia
  address internal constant BASE_WETH = 0x4200000000000000000000000000000000000006;
  address internal constant BASE_ETH_USD = 0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1;
  /// @dev CRE simulation MockKeystoneForwarder on Base Sepolia (real contract on the forked chain).
  address internal constant BASE_FORWARDER = 0x82300bd7c3958625581cc2F77bC6464dcEcDF3e5;

  // ---------------------------------------------------------------- Arc
  address internal constant ARC_USDC = 0x3600000000000000000000000000000000000000;
  address internal constant ARC_EURC = 0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a;
  /// @dev Chainlink EUR/USD on Arc mainnet (read-only source; no feeds on Arc Testnet).
  address internal constant ARC_MAINNET_EUR_USD = 0xDd5B15443cd733D3966a50a3E48cB7DF9Fb5DE0D;
  /// @dev CRE simulation MockKeystoneForwarder on Arc Testnet (real contract on the forked chain).
  address internal constant ARC_FORWARDER = 0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1;
}
