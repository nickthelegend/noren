// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC165} from '@oz/utils/introspection/IERC165.sol';

/// @notice Chainlink CRE consumer interface. The KeystoneForwarder calls onReport
/// after verifying the DON signatures on a report and checks ERC-165 support first.
interface IReceiver is IERC165 {
  function onReport(bytes calldata metadata, bytes calldata report) external;
}
