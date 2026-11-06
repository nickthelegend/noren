// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The two Circle CCTP V2 MessageTransmitterV2 functions Noren's relay uses.
///         Deployed at 0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275 on Arc Testnet and Robinhood Chain Testnet.
interface IMessageTransmitterV2 {
  function receiveMessage(bytes calldata message, bytes calldata attestation) external returns (bool success);
  function localDomain() external view returns (uint32);
  function usedNonces(bytes32 nonce) external view returns (uint256);
}
