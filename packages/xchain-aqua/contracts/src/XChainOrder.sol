// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice A cross-chain swap order: `taker` locks `amountIn` of `tokenIn` in the Noren escrow on
/// the source chain, and `maker`'s 1inch Aqua strategy on the destination chain pays at least
/// `minAmountOut` of `tokenOut` to `recipient`. A Chainlink CRE workflow carries the order to the
/// destination settler and the fill (or expiry) back to the escrow. All-or-nothing: no partial fills.
struct CrossChainOrder {
  uint64 srcChainId; // chain holding the escrow (e.g. Robinhood Chain 4663)
  address srcEscrow; // NorenCrossChainEscrow on the source chain
  uint64 dstChainId; // chain where the maker fills (e.g. Arc Testnet 5042002)
  address dstSettler; // NorenCrossChainSettler on the destination chain
  address taker; // locked tokenIn; receives the refund
  address tokenIn; // token escrowed on the source chain
  uint256 amountIn; // exact amount escrowed and sold (all-or-nothing)
  address tokenOut; // token the maker pays on the destination chain
  uint256 minAmountOut; // taker's limit
  address recipient; // taker's address on the destination chain
  address maker; // the maker the taker chose (its strategy must belong to this maker)
  bytes32 strategyHash; // the maker's Aqua strategy hash on the destination chain
  uint64 fillDeadline; // destination-chain time: no fill after this
  uint64 refundAfter; // source-chain time: refund without a destination report after this
  uint256 nonce; // taker-chosen, makes otherwise equal orders distinct
}

library XChainOrderLib {
  /// @notice The order id used on both chains: keccak256(abi.encode(order)). It commits to both
  /// chain ids, the escrow and the settler, so a report for one deployment can't be replayed on another.
  function id(CrossChainOrder memory o) internal pure returns (bytes32) {
    return keccak256(abi.encode(o));
  }
}
