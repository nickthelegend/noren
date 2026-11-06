// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CrossChainOrder} from './XChainOrder.sol';

/// @notice A Chainlink price round read on the source chain, carried unchanged.
struct PriceRound {
  uint80 roundId;
  int256 answer;
  uint256 startedAt;
  uint256 updatedAt;
  uint80 answeredInRound;
  uint8 decimals;
  uint256 uiMultiplier; // Robinhood Stock Token shares per raw token (1e18 = 1), 1e18 otherwise
  address sourceFeed; // the Chainlink feed it was read from
}

/// @title XChainMessages
/// @notice The four transport-independent payloads of Noren cross-chain Aqua. The same bytes travel
/// as a CRE report (DON-signed, delivered by the KeystoneForwarder) or through a transport adapter
/// (CCIP, a CCTP hook). The first word is the kind.
///
///   ORDER            escrow   -> settler   abi.encode(1, CrossChainOrder, PriceRound)
///   ORDER_DELIVERED  adapter  -> settler   abi.encode(2, CrossChainOrder, PriceRound)  tokenIn arrives with it
///   FILLED / EXPIRED settler  -> escrow    abi.encode(kind, Settlement fields)
///   PRICE            CRE      -> settler   abi.encode(5, address relayedFeed, PriceRound)
///   ROUTER_ORDER     CRE      -> settler   abi.encode(6, address actionRouter, bytes32 ref)  fill an order the Arc action router holds
library XChainMessages {
  uint8 internal constant ORDER = 1;
  uint8 internal constant ORDER_DELIVERED = 2;
  uint8 internal constant FILLED = 3;
  uint8 internal constant EXPIRED = 4;
  uint8 internal constant PRICE = 5;
  uint8 internal constant ROUTER_ORDER = 6;

  struct Settlement {
    uint8 kind; // FILLED or EXPIRED
    bytes32 orderId;
    uint64 dstChainId; // the settler's chain
    address dstSettler; // the settler that filled or expired the order
    address maker;
    address payout; // maker's address on the source chain (FILLED)
    uint256 amountIn;
    uint256 amountOut;
  }

  error BadPayload();

  function kindOf(bytes calldata payload) internal pure returns (uint8 kind) {
    if (payload.length < 32) revert BadPayload();
    kind = uint8(uint256(bytes32(payload[0:32])));
  }

  function encodeOrder(CrossChainOrder memory o, PriceRound memory p) internal pure returns (bytes memory) {
    return abi.encode(ORDER, o, p);
  }

  function encodeDeliveredOrder(CrossChainOrder memory o, PriceRound memory p) internal pure returns (bytes memory) {
    return abi.encode(ORDER_DELIVERED, o, p);
  }

  function decodeOrder(bytes calldata payload) internal pure returns (uint8 kind, CrossChainOrder memory o, PriceRound memory p) {
    (kind, o, p) = abi.decode(payload, (uint8, CrossChainOrder, PriceRound));
  }

  function encodeSettlement(Settlement memory s) internal pure returns (bytes memory) {
    return abi.encode(s.kind, s.orderId, s.dstChainId, s.dstSettler, s.maker, s.payout, s.amountIn, s.amountOut);
  }

  function decodeSettlement(bytes calldata payload) internal pure returns (Settlement memory s) {
    if (payload.length != 256) revert BadPayload();
    (s.kind, s.orderId, s.dstChainId, s.dstSettler, s.maker, s.payout, s.amountIn, s.amountOut) =
      abi.decode(payload, (uint8, bytes32, uint64, address, address, address, uint256, uint256));
  }

  function decodePrice(bytes calldata payload) internal pure returns (address feed, PriceRound memory p) {
    uint8 kind;
    (kind, feed, p) = abi.decode(payload, (uint8, address, PriceRound));
  }
}
