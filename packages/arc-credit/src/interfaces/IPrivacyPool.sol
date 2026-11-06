// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from '@oz/token/ERC20/IERC20.sol';

/// @notice The Kohaku (0xbow Privacy Pools) Entrypoint calls NorenCreditLine makes; the same deposit entry
///         NorenShieldSink uses (packages/ccip).
interface IPrivacyEntrypoint {
  function deposit(IERC20 asset, uint256 value, uint256 precommitment) external returns (uint256 commitment);
  function assetConfig(IERC20 asset)
    external
    view
    returns (address pool, uint256 minimumDepositAmount, uint256 vettingFeeBPS, uint256 maxRelayFeeBPS);
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
