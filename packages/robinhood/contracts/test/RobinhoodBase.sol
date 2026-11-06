// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from 'forge-std/Test.sol';
import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {NorenAssetOracle} from '../src/NorenAssetOracle.sol';
import {NorenVault} from '../src/NorenVault.sol';
import {NorenGateway} from '../src/NorenGateway.sol';
import {NorenCredit} from '../src/NorenCredit.sol';
import {NorenLiquidity} from '../src/NorenLiquidity.sol';
import {IAqua, ISwapVMRouter} from '../src/interfaces/IAquaSwapVM.sol';
import {INorenVault} from '../src/interfaces/INorenVault.sol';
import {IWETH} from '../src/interfaces/IWETH.sol';
import {RobinhoodMainnet as RH} from '../script/RobinhoodMainnet.sol';

interface IStockAdmin {
  function updateMultiplier(uint256 newMultiplier) external;
  function pause() external;
  function unpause() external;
  function balanceOfUI(address) external view returns (uint256);
}

interface IRegistryAdmin {
  function blockAccounts(address[] calldata accounts) external;
  function unblockAccounts(address[] calldata accounts) external;
  function isBlocked(address) external view returns (bool);
}

interface IPermitToken {
  function nonces(address) external view returns (uint256);
  function DOMAIN_SEPARATOR() external view returns (bytes32);
  function permit(address, address, uint256, uint256, uint8, bytes32, bytes32) external;
}

/// @notice Shared fixture. Runs only against a fork of Robinhood Chain mainnet (chain 4663):
/// real USDG, WETH, Stock Tokens and Chainlink feeds. Balances come from impersonating a real
/// holder (the Uniswap v4 PoolManager), never from deal() on a token.
abstract contract RobinhoodBase is Test {
  bytes32 internal constant PERMIT_TYPEHASH =
    keccak256('Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)');

  NorenAssetOracle internal oracle;
  NorenVault internal vault;
  NorenGateway internal gateway;
  NorenCredit internal credit;
  /// @dev NorenAquaSwapVMRouter (modified SwapVM) redeployed on the fork against the official Aqua.
  ISwapVMRouter internal swapRouter;
  NorenLiquidity internal liquidity;
  IAqua internal aqua = IAqua(RH.AQUA);

  IERC20 internal usdg = IERC20(RH.USDG);
  IWETH internal weth = IWETH(RH.WETH);
  IERC20 internal nvda = IERC20(RH.NVDA);
  IERC20 internal tsla = IERC20(RH.TSLA);

  address internal owner = makeAddr('owner');
  address internal lp = makeAddr('lp');
  address internal merchant = makeAddr('merchant');
  address internal liquidator = makeAddr('liquidator');
  address internal forwarder = makeAddr('creForwarder');
  address internal customer;
  uint256 internal customerKey;
  address internal underwriter;
  uint256 internal underwriterKey;

  uint32 internal constant INTERVAL = 15 minutes; // production deploy uses 14 days
  uint32 internal constant GRACE = 15 minutes; // production deploy uses 3 days

  function setUp() public virtual {
    require(block.chainid == 4663, 'Run against the Robinhood mainnet fork: sh scripts/test-fork.sh');
    (customer, customerKey) = makeAddrAndKey('customer');
    (underwriter, underwriterKey) = makeAddrAndKey('underwriter');

    oracle = new NorenAssetOracle(owner, RH.USDG);
    vault = new NorenVault(owner, usdg, oracle);
    gateway = new NorenGateway(owner, usdg, weth, oracle, INorenVault(address(vault)));
    credit = new NorenCredit(
      owner, usdg, weth, oracle, INorenVault(address(vault)), gateway, underwriter, forwarder, _params(INTERVAL, GRACE)
    );

    require(RH.AQUA.code.length > 0, 'official Aqua registry missing on this fork');
    swapRouter = ISwapVMRouter(
      deployCode(RH.NOREN_ROUTER_ARTIFACT, abi.encode(RH.AQUA, RH.WETH, owner, RH.NOREN_ROUTER_NAME, RH.NOREN_ROUTER_VERSION))
    );
    vm.startPrank(owner);
    RH.configureOracle(oracle);
    liquidity = new NorenLiquidity(owner, aqua, swapRouter, oracle);
    gateway.setLiquidity(liquidity, true);
    credit.setLiquidity(liquidity);
    vault.setModule(address(gateway), true);
    vault.setModule(address(credit), true);
    vault.setCredit(credit);
    gateway.setCredit(address(credit));
    gateway.setSpread(RH.WETH, 30);
    gateway.setSpread(RH.NVDA, 50);
    gateway.setSpread(RH.TSLA, 50);
    gateway.setSpread(RH.AAPL, 50);
    vm.stopPrank();

    _fund(RH.USDG, lp, 200_000e6);
    vm.startPrank(lp);
    usdg.approve(address(vault), type(uint256).max);
    vault.deposit(100_000e6, lp);
    vm.stopPrank();
  }

  /// @dev A maker funds its own wallet with real USDG, approves Aqua once, ships a NorenOraclePeg
  /// strategy to the router and registers it with NorenLiquidity.
  function _shipMaker(address maker, address asset, uint256 usdgAmount, uint16 bidBps, uint16 askBps, uint64 salt)
    internal
    returns (bytes32 strategyHash)
  {
    NorenLiquidity.PegTerms memory t = NorenLiquidity.PegTerms({
      bidSpreadBps: bidBps,
      askSpreadBps: askBps,
      closedExtraBps: 300,
      minPriceUsd8: 0,
      maxPriceUsd8: 0,
      salt: salt
    });
    if (usdg.balanceOf(maker) < usdgAmount) _fund(RH.USDG, maker, usdgAmount - usdg.balanceOf(maker));
    (ISwapVMRouter.Order memory o,) = liquidity.buildOrder(maker, asset, t);
    address[] memory tokens = new address[](2);
    tokens[0] = RH.USDG;
    tokens[1] = asset;
    uint256[] memory amounts = new uint256[](2);
    amounts[0] = usdgAmount;
    vm.startPrank(maker);
    usdg.approve(RH.AQUA, type(uint256).max);
    aqua.ship(address(swapRouter), abi.encode(o), tokens, amounts);
    strategyHash = liquidity.register(asset, t);
    vm.stopPrank();
  }

  function _params(uint32 interval, uint32 grace) internal pure returns (NorenCredit.Params memory) {
    return NorenCredit.Params({
      installmentInterval: interval,
      gracePeriod: grace,
      liquidationThresholdBps: 11_000,
      liquidationBonusBps: 500,
      merchantFeeBps: 300,
      maxLineDuration: 90 days,
      reportSkew: 300
    });
  }

  /// @dev Move real tokens from a real holder on the fork.
  function _fund(address token, address to, uint256 amount) internal {
    vm.prank(RH.POOL_MANAGER);
    IERC20(token).transfer(to, amount);
  }

  function _invoice(bytes32 id, uint128 amount) internal {
    vm.prank(merchant);
    gateway.createInvoice(id, amount, uint64(block.timestamp + 1 days));
  }

  function _attest(address borrower, uint8 tier, uint256 limit, uint16 ratio) internal {
    NorenCredit.Attestation memory a = NorenCredit.Attestation({
      borrower: borrower,
      tier: tier,
      limitUsdg: limit,
      collateralRatioBps: ratio,
      nonce: credit.attestationNonce(borrower),
      expiry: uint64(block.timestamp + 30 days)
    });
    credit.applyAttestation(a, _sign(underwriterKey, a));
  }

  function _sign(uint256 key, NorenCredit.Attestation memory a) internal view returns (bytes memory) {
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, credit.hashAttestation(a));
    return abi.encodePacked(r, s, v);
  }

  function _permitSig(uint256 key, address token, address spender, uint256 value, uint256 deadline)
    internal
    view
    returns (uint8 v, bytes32 r, bytes32 s)
  {
    address holder = vm.addr(key);
    bytes32 structHash =
      keccak256(abi.encode(PERMIT_TYPEHASH, holder, spender, value, IPermitToken(token).nonces(holder), deadline));
    bytes32 digest = keccak256(abi.encodePacked('\x19\x01', IPermitToken(token).DOMAIN_SEPARATOR(), structHash));
    return vm.sign(key, digest);
  }

  function _block(address account) internal {
    address[] memory list = new address[](1);
    list[0] = account;
    vm.prank(RH.BLOCKLIST_ADMIN);
    IRegistryAdmin(RH.STOCK_REGISTRY).blockAccounts(list);
  }

  function _unblock(address account) internal {
    address[] memory list = new address[](1);
    list[0] = account;
    vm.prank(RH.BLOCKLIST_ADMIN);
    IRegistryAdmin(RH.STOCK_REGISTRY).unblockAccounts(list);
  }

  /// @dev Real Stock Token corporate-action path: the multiplier updater role changes uiMultiplier.
  function _setMultiplier(address token, uint256 m) internal {
    vm.prank(RH.MULTIPLIER_ADMIN);
    IStockAdmin(token).updateMultiplier(m);
  }

  /// @dev Next timestamp at `hourUtc` on weekday `dow` (0 = Sunday) strictly after now.
  function _nextAt(uint256 dow, uint256 hourUtc) internal view returns (uint256 ts) {
    uint256 day = block.timestamp / 1 days;
    for (uint256 i; i < 8; ++i) {
      uint256 d = day + i;
      ts = d * 1 days + hourUtc * 1 hours;
      if ((d + 4) % 7 == dow && ts > block.timestamp) return ts;
    }
    revert('no slot');
  }

  /// @dev A fork freezes every feed at the fork block, so a test that jumps days ahead cannot see
  /// the next USDG/ETH heartbeat. Widen only the 24/7 assets' max age (an owner config call on the
  /// real feeds) for tests that exercise the stock-market calendar.
  function _allowFrozen247Feeds() internal {
    vm.startPrank(owner);
    oracle.setAsset(RH.USDG, RH.FEED_USDG, 60 days, 60 days, false, false);
    oracle.setAsset(RH.WETH, RH.FEED_ETH, 60 days, 60 days, false, false);
    vm.stopPrank();
  }

  /// @dev Keep a weekday test inside the open-market window; skip when the fork itself was cut inside the closed window.
  function _requireMarketOpen() internal {
    if (oracle.marketClosed(block.timestamp)) {
      vm.skip(true);
    }
  }
}
