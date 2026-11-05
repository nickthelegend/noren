// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Anvil-only replacement for Arc's unsupported native USDC bridge.
/// @dev Never deploy this contract to Arc or use it to infer Arc USDC transfer gas.
contract ForkUSDC {
  mapping(address => uint256) public balanceOf; // slot 0, funded with anvil_setStorageAt
  mapping(address => mapping(address => uint256)) public allowance;
  mapping(address => bool) public isBlacklisted;

  event Transfer(address indexed from, address indexed to, uint256 value);
  event Approval(address indexed owner, address indexed spender, uint256 value);

  function decimals() external pure returns (uint8) { return 6; }
  function symbol() external pure returns (string memory) { return 'USDC'; }
  function name() external pure returns (string memory) { return 'USD Coin'; }

  /// @dev Local fork control for ASP regression tests; Arc's real USDC has this view.
  function setBlacklisted(address account, bool value) external { isBlacklisted[account] = value; }

  /// @dev Fork-only faucet; this bytecode replaces Arc USDC only in Anvil.
  function mint(address to, uint256 value) external {
    balanceOf[to] += value;
    emit Transfer(address(0), to, value);
  }

  function approve(address spender, uint256 value) external returns (bool) {
    allowance[msg.sender][spender] = value;
    emit Approval(msg.sender, spender, value);
    return true;
  }

  function transfer(address to, uint256 value) external returns (bool) {
    _transfer(msg.sender, to, value);
    return true;
  }

  function transferFrom(address from, address to, uint256 value) external returns (bool) {
    uint256 allowed = allowance[from][msg.sender];
    require(allowed >= value, 'allowance');
    if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - value;
    _transfer(from, to, value);
    return true;
  }

  function _transfer(address from, address to, uint256 value) private {
    require(balanceOf[from] >= value, 'balance');
    balanceOf[from] -= value;
    balanceOf[to] += value;
    emit Transfer(from, to, value);
  }
}
