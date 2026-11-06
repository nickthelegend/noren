// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from '@oz/token/ERC20/ERC20.sol';

/// @title NorenEscrowReceipt
/// @notice Settlement token for one source-chain asset held in a Noren cross-chain escrow, e.g. NVDA
/// locked on Robinhood Chain, used on Arc as the `tokenIn` of a maker's Aqua strategy.
///
/// A receipt exists only inside a fill transaction. The settler mints exactly the escrowed amount
/// to itself, SwapVM moves it to the maker (Aqua push), and the settler burns it from the maker in
/// the same call. The maker's real payment is the escrowed asset, released on the source chain when
/// CRE reports the fill. Transfers are locked outside the settler's fill, so nobody can hold,
/// trade or swap a receipt against a maker's strategy.
///
/// For a Stock Token, `uiMultiplier()` mirrors the source token's live value (shares per raw token),
/// relayed by CRE with each fill, so SwapVM's NorenOraclePeg instruction prices it exactly like the
/// Stock Token itself.
contract NorenEscrowReceipt is ERC20 {
  address public immutable settler;
  uint64 public immutable sourceChainId;
  address public immutable sourceToken;
  uint8 private immutable _dec;

  uint256 public uiMultiplier = 1e18;
  bool public unlocked;

  event UiMultiplierRelayed(uint256 uiMultiplier);

  error OnlySettler(address caller);
  error ReceiptLocked();
  error BadMultiplier();

  modifier onlySettler() {
    if (msg.sender != settler) revert OnlySettler(msg.sender);
    _;
  }

  constructor(string memory name_, string memory symbol_, uint8 decimals_, uint64 sourceChainId_, address sourceToken_, address settler_)
    ERC20(name_, symbol_)
  {
    settler = settler_;
    sourceChainId = sourceChainId_;
    sourceToken = sourceToken_;
    _dec = decimals_;
  }

  function decimals() public view override returns (uint8) {
    return _dec;
  }

  function mint(address to, uint256 amount) external onlySettler {
    _mint(to, amount);
  }

  function burn(address from, uint256 amount) external onlySettler {
    _burn(from, amount);
  }

  function setUnlocked(bool value) external onlySettler {
    unlocked = value;
  }

  function setUiMultiplier(uint256 value) external onlySettler {
    // Stock Token multipliers sit near 1e18 (dividends, splits); refuse zero and absurd values.
    if (value == 0 || value > 1e24) revert BadMultiplier();
    if (value != uiMultiplier) {
      uiMultiplier = value;
      emit UiMultiplierRelayed(value);
    }
  }

  function _update(address from, address to, uint256 value) internal override {
    // Mint and burn are settler-only; any transfer must happen inside the settler's fill.
    if (from != address(0) && to != address(0) && !unlocked) revert ReceiptLocked();
    super._update(from, to, value);
  }
}
