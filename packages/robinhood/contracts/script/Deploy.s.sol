// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from 'forge-std/Script.sol';
import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {NorenAssetOracle} from '../src/NorenAssetOracle.sol';
import {NorenVault} from '../src/NorenVault.sol';
import {NorenGateway} from '../src/NorenGateway.sol';
import {NorenCredit} from '../src/NorenCredit.sol';
import {NorenLiquidity} from '../src/NorenLiquidity.sol';
import {NorenDepositVault} from '../src/NorenDepositVault.sol';
import {NorenReputation, INorenCreditHistory} from '../src/NorenReputation.sol';
import {NorenBorrow} from '../src/NorenBorrow.sol';
import {NorenDutchAuction} from '../src/NorenDutchAuction.sol';
import {INorenReceivables} from '../src/interfaces/INorenVault.sol';
import {IAqua, ISwapVMRouter} from '../src/interfaces/IAquaSwapVM.sol';
import {INorenVault} from '../src/interfaces/INorenVault.sol';
import {IWETH} from '../src/interfaces/IWETH.sol';
import {RobinhoodMainnet as RH} from './RobinhoodMainnet.sol';

/// @notice Deploys Noren with CREATE2 (salt "noren-robinhood-v1") so a fork deployment lands on the same
/// addresses every time for the same code and constructor arguments. Also deploys the modified SwapVM
/// router (packages/aqua/swapvm-ext build artifact, LicenseRef-Degensoft-SwapVM-1.1) against the
/// official Aqua registry, NorenLiquidity and NorenDutchAuction, and points the gateway and credit at them.
/// Earn and borrow: NorenReputation, NorenBorrow (a lender-pool module and its receivables source) and
/// one NorenDepositVault per asset (nETH, nNVDA, nTSLA, nAAPL), each with its own Aqua strategy.
/// Env: NOREN_RH_OWNER, NOREN_RH_UNDERWRITER, NOREN_RH_FORWARDER, NOREN_RH_WORLD_ID_SIGNER,
/// NOREN_RH_INSTALLMENT_INTERVAL (s), NOREN_RH_GRACE (s).
contract Deploy is Script {
  bytes32 internal constant SALT = keccak256('noren-robinhood-v1');
  /// @dev Foundry's deterministic CREATE2 deployer (the one `new X{salt: ...}` uses in scripts).
  address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
  address internal constant FORK_WORLD_ID_SIGNER = 0x14dC79964da2C08b23698B3D3cc7Ca32193d9955;

  function run() external {
    // 46630 = a local mainnet fork re-tagged as Robinhood testnet for the CRE simulator.
    require(block.chainid == 4663 || block.chainid == 46630, 'Robinhood Chain (4663) or a local fork (4663/46630) only');
    address owner = vm.envAddress('NOREN_RH_OWNER');
    address underwriter = vm.envAddress('NOREN_RH_UNDERWRITER');
    address forwarder = vm.envAddress('NOREN_RH_FORWARDER');
    uint32 interval = uint32(vm.envOr('NOREN_RH_INSTALLMENT_INTERVAL', uint256(14 days)));
    uint32 grace = uint32(vm.envOr('NOREN_RH_GRACE', uint256(3 days)));

    vm.startBroadcast();
    NorenAssetOracle oracle = new NorenAssetOracle{salt: SALT}(owner, RH.USDG);
    NorenVault vault = new NorenVault{salt: SALT}(owner, IERC20(RH.USDG), oracle);
    NorenGateway gateway =
      new NorenGateway{salt: SALT}(owner, IERC20(RH.USDG), IWETH(RH.WETH), oracle, INorenVault(address(vault)));
    NorenCredit credit = new NorenCredit{salt: SALT}(
      owner,
      IERC20(RH.USDG),
      IWETH(RH.WETH),
      oracle,
      INorenVault(address(vault)),
      gateway,
      underwriter,
      forwarder,
      NorenCredit.Params({
        installmentInterval: interval,
        gracePeriod: grace,
        liquidationThresholdBps: 11_000,
        liquidationBonusBps: 500,
        merchantFeeBps: 300,
        maxLineDuration: 90 days,
        reportSkew: 300
      })
    );
    RH.configureOracle(oracle);
    vault.setModule(address(gateway), true);
    vault.setModule(address(credit), true);
    vault.setCredit(credit);
    gateway.setCredit(address(credit));
    gateway.setSpread(RH.WETH, 30);
    require(RH.AQUA.code.length > 0, 'official Aqua registry missing on this chain');
    ISwapVMRouter router = _deployRouter(owner);
    NorenLiquidity liquidity = new NorenLiquidity{salt: SALT}(owner, IAqua(RH.AQUA), router, oracle);
    gateway.setLiquidity(liquidity, true);
    credit.setLiquidity(liquidity);
    // Partial Dutch-auction liquidations: 0.5% start discount rising to 8% over an hour, keeper takes 25% of the
    // discount, each fill restores health to 1.10 (docs/AQUA.md).
    NorenDutchAuction dutch = new NorenDutchAuction{salt: SALT}(owner, credit, router, 50, 800, 3600, 2500, 11000);
    credit.setDutchAuction(address(dutch));
    address[8] memory stocks = [RH.TSLA, RH.AAPL, RH.NVDA, RH.SPY, RH.AMZN, RH.MSFT, RH.GOOGL, RH.META];
    for (uint256 i; i < stocks.length; ++i) gateway.setSpread(stocks[i], 50);
    (NorenReputation reputation, NorenBorrow borrow) = _deployEarn(owner, oracle, vault, credit, liquidity);
    vm.stopBroadcast();

    console2.log('NOREN_RH_ORACLE', address(oracle));
    console2.log('NOREN_RH_VAULT', address(vault));
    console2.log('NOREN_RH_GATEWAY', address(gateway));
    console2.log('NOREN_RH_CREDIT', address(credit));
    console2.log('NOREN_RH_SWAPVM_ROUTER', address(router));
    console2.log('NOREN_RH_LIQUIDITY', address(liquidity));
    console2.log('NOREN_RH_DUTCH_AUCTION', address(dutch));
    console2.log('NOREN_RH_REPUTATION', address(reputation));
    console2.log('NOREN_RH_BORROW', address(borrow));
    NorenDepositVault[] memory vs = borrow.vaults();
    for (uint256 i; i < vs.length; ++i) console2.log('NOREN_RH_DEPOSIT_VAULT', vs[i].asset(), address(vs[i]));
  }

  function _deployEarn(address owner, NorenAssetOracle oracle, NorenVault vault, NorenCredit credit, NorenLiquidity liquidity)
    internal
    returns (NorenReputation reputation, NorenBorrow borrow)
  {
    // Unset: Anvil's published account #7, the fork stand-in for the World ID server key (owner can
    // change it with setWorldIdSigner). Set NOREN_RH_WORLD_ID_SIGNER to the address of NOREN_WORLD_ATTESTER_KEY.
    address worldSigner = vm.envOr('NOREN_RH_WORLD_ID_SIGNER', FORK_WORLD_ID_SIGNER);
    if (worldSigner == FORK_WORLD_ID_SIGNER) console2.log('NOREN_RH_WORLD_ID_SIGNER fork default (Anvil #7)', worldSigner);
    reputation = new NorenReputation{salt: SALT}(owner, INorenCreditHistory(address(credit)), worldSigner);
    borrow = new NorenBorrow{salt: SALT}(
      owner, IERC20(RH.USDG), oracle, INorenVault(address(vault)), INorenReceivables(address(credit)), reputation, liquidity
    );
    reputation.setBorrow(borrow);
    vault.setModule(address(borrow), true);
    vault.setCredit(borrow); // lender-pool NAV = Pay-in-3 receivables + loans
    address[4] memory assets = [RH.WETH, RH.NVDA, RH.TSLA, RH.AAPL];
    string[4] memory sym = ['ETH', 'NVDA', 'TSLA', 'AAPL'];
    for (uint256 i; i < assets.length; ++i) {
      NorenDepositVault v = new NorenDepositVault{salt: SALT}(
        owner,
        IERC20(assets[i]),
        oracle,
        liquidity,
        assets[i] == RH.WETH,
        string.concat('Noren ', sym[i], ' deposit'),
        string.concat('n', sym[i])
      );
      // WETH: bid 25 / ask 40 bps; stocks: bid 40 / ask 60 bps, +300 bps while US markets are closed.
      bool eth = assets[i] == RH.WETH;
      v.shipStrategy(NorenLiquidity.PegTerms(eth ? 25 : 40, eth ? 40 : 60, eth ? 0 : 300, 0, 0, 0));
      borrow.addVault(v);
    }
  }

  /// @dev CREATE2 from the build artifact, so this MIT script never compiles SwapVM source.
  function _deployRouter(address owner) internal returns (ISwapVMRouter router) {
    bytes memory initcode = abi.encodePacked(
      vm.getCode(RH.NOREN_ROUTER_ARTIFACT),
      abi.encode(RH.AQUA, RH.WETH, owner, RH.NOREN_ROUTER_NAME, RH.NOREN_ROUTER_VERSION)
    );
    address predicted = vm.computeCreate2Address(SALT, keccak256(initcode), CREATE2_DEPLOYER);
    if (predicted.code.length == 0) {
      (bool ok,) = CREATE2_DEPLOYER.call(abi.encodePacked(SALT, initcode));
      require(ok && predicted.code.length > 0, 'router deploy failed');
    }
    router = ISwapVMRouter(predicted);
  }
}
