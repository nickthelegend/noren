// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from 'forge-std/Script.sol';
import {Vm} from 'forge-std/Vm.sol';
import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {Math} from '@oz/utils/math/Math.sol';
import {NorenAssetOracle} from '../src/NorenAssetOracle.sol';
import {NorenVault} from '../src/NorenVault.sol';
import {NorenGateway} from '../src/NorenGateway.sol';
import {NorenCredit} from '../src/NorenCredit.sol';
import {NorenLiquidity} from '../src/NorenLiquidity.sol';
import {NorenDepositVault} from '../src/NorenDepositVault.sol';
import {NorenReputation} from '../src/NorenReputation.sol';
import {NorenBorrow} from '../src/NorenBorrow.sol';
import {RobinhoodMainnet as RH} from './RobinhoodMainnet.sol';

interface IStockMultiplier {
  function updateMultiplier(uint256) external;
}

interface IV4QuoterWarm {
  struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
  }

  struct QuoteExactSingleParams {
    PoolKey poolKey;
    bool zeroForOne;
    uint128 exactAmount;
    bytes hookData;
  }

  function quoteExactInputSingle(QuoteExactSingleParams memory params) external returns (uint256, uint256);
}

interface IPermit {
  function nonces(address) external view returns (uint256);
  function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/// @notice Simulation only (never run with --broadcast). Walks every demo flow from the demo
/// accounts with state-diff recording on, then prints every account and storage slot those flows
/// read together with its real pre-state value ("WARM_SLOT account slot value", "WARM_ACCOUNT
/// account"). Robinhood's public RPC keeps state for only ~10 minutes of blocks and Anvil's state
/// dump only contains state its own transactions touched, so scripts/fork-snapshot.sh writes these
/// real values into the temporary fork (anvil_setStorageAt / anvil_setCode) before dumping it.
contract Warm is Script {
  // Anvil published dev keys (#1 customer, #9 underwriter): fork use only.
  uint256 internal constant CUSTOMER_KEY = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
  uint256 internal constant UNDERWRITER_KEY = 0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6;
  // Anvil #7: fork stand-in for the World ID server key (NorenReputation.worldIdSigner).
  uint256 internal constant WORLD_ID_KEY = 0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356;
  bytes32 internal constant PERMIT_TYPEHASH =
    keccak256('Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)');

  NorenAssetOracle oracle;
  NorenVault vault;
  NorenGateway gateway;
  NorenCredit credit;
  address customer;
  address merchant;
  address forwarder;
  address owner;

  function run() external {
    vm.startStateDiffRecording();
    _flows();
    _print(vm.stopAndReturnStateDiff());
    // recorded separately: one diff for every flow runs out of script memory
    vm.startStateDiffRecording();
    _earn();
    _print(vm.stopAndReturnStateDiff());
  }

  function _print(Vm.AccountAccess[] memory acc) internal pure {
    for (uint256 i; i < acc.length; ++i) {
      console2.log(string.concat('WARM_ACCOUNT ', vm.toString(acc[i].account)));
      for (uint256 j; j < acc[i].storageAccesses.length; ++j) {
        Vm.StorageAccess memory sa = acc[i].storageAccesses[j];
        console2.log(
          string.concat('WARM_SLOT ', vm.toString(sa.account), ' ', vm.toString(sa.slot), ' ', vm.toString(sa.previousValue))
        );
      }
    }
  }

  function _flows() internal {
    oracle = NorenAssetOracle(vm.envAddress('NOREN_RH_ORACLE'));
    vault = NorenVault(vm.envAddress('NOREN_RH_VAULT'));
    gateway = NorenGateway(payable(vm.envAddress('NOREN_RH_GATEWAY')));
    credit = NorenCredit(payable(vm.envAddress('NOREN_RH_CREDIT')));
    customer = vm.addr(CUSTOMER_KEY);
    merchant = vm.envAddress('NOREN_RH_MERCHANT');
    forwarder = credit.forwarder();
    owner = credit.owner();

    address[10] memory all = [RH.USDG, RH.WETH, RH.TSLA, RH.AAPL, RH.NVDA, RH.SPY, RH.AMZN, RH.MSFT, RH.GOOGL, RH.META];
    address[4] memory spenders = [address(gateway), address(credit), address(vault), merchant];
    address[4] memory people = [customer, merchant, owner, forwarder];
    for (uint256 i; i < all.length; ++i) {
      oracle.price(all[i]);
      for (uint256 p; p < people.length; ++p) {
        IERC20(all[i]).balanceOf(people[p]);
        oracle.checkTransferable(all[i], people[p], address(vault));
        oracle.checkTransferable(all[i], people[p], address(credit));
        for (uint256 s; s < spenders.length; ++s) IERC20(all[i]).allowance(people[p], spenders[s]);
      }
      IERC20(all[i]).balanceOf(address(vault));
      IERC20(all[i]).balanceOf(address(credit));
      IERC20(all[i]).balanceOf(address(gateway));
      if (i != 1) IPermit(all[i]).nonces(customer);
    }

    // Underwriting
    NorenCredit.Attestation memory a = NorenCredit.Attestation(
      customer, 3, 2_500e6, 13_000, credit.attestationNonce(customer), uint64(block.timestamp + 30 days)
    );
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(UNDERWRITER_KEY, credit.hashAttestation(a));
    credit.applyAttestation(a, abi.encodePacked(r, s, v));

    // Payments: USDG (approve and permit), Stock Tokens (approve and permit), ETH
    _pay('warm-usdg', RH.USDG, false);
    _pay('warm-usdg-permit', RH.USDG, true);
    _pay('warm-nvda', RH.NVDA, false);
    _pay('warm-tsla-permit', RH.TSLA, true);
    _pay('warm-aapl', RH.AAPL, false);
    // vault fallback route (no maker liquidity) so vault inventory exists for buyInventory below
    address liq = address(gateway.liquidity());
    vm.prank(owner);
    gateway.setLiquidity(NorenLiquidity(address(0)), true);
    _pay('warm-nvda-vault', RH.NVDA, false);
    vm.prank(owner);
    gateway.setLiquidity(NorenLiquidity(liq), true);
    vm.prank(merchant);
    gateway.createInvoice(keccak256('warm-eth'), 25e6, uint64(block.timestamp + 1 days));
    (uint256 q,,) = gateway.quote(merchant, keccak256('warm-eth'), address(0));
    vm.prank(customer);
    gateway.pay{value: q}(keccak256('warm-eth'), merchant, address(0), q);

    // Pay in 3 with NVDA and with ETH, repay, liquidation views
    uint256 planId = _plan('warm-plan-nvda', RH.NVDA);
    vm.startPrank(customer);
    IERC20(RH.USDG).approve(address(credit), type(uint256).max);
    credit.repay(planId, 1);
    vm.stopPrank();
    credit.planLiquidatable(planId);
    credit.missedInstallments(planId);
    for (uint8 k = 1; k <= 3; ++k) (credit.dueAt(planId, k), credit.installmentAmount(planId, k));
    credit.params();
    _planEth('warm-plan-eth');
    _aqua();

    // Arc credit line with TSLA: open, report, close, settle
    (uint256 col,) = oracle.assetForUsd8(RH.TSLA, 300e8, 0);
    vm.startPrank(customer);
    IERC20(RH.TSLA).approve(address(credit), col);
    // 195 USDC on $300 of TSLA (65%): within the 66% reputation LTV cap a wallet without attestations has.
    bytes32 lineId = credit.openCreditLine(RH.TSLA, col, 195e6, uint64(block.timestamp + 30 days));
    vm.stopPrank();
    vm.prank(forwarder);
    credit.onReport('', abi.encode(lineId, uint256(50e6), uint256(0), uint64(block.timestamp)));
    credit.lineLiquidatable(lineId);
    vm.prank(customer);
    credit.closeCreditLine(lineId);
    vm.warp(vm.getBlockTimestamp() + 1);
    vm.prank(forwarder);
    credit.onReport('', abi.encode(lineId, uint256(50e6), uint256(50e6), uint64(vm.getBlockTimestamp())));

    // Vault: LP deposit/redeem by the customer, inventory purchase
    vm.startPrank(customer);
    IERC20(RH.USDG).approve(address(vault), type(uint256).max);
    vault.deposit(100e6, customer);
    vault.redeem(vault.balanceOf(customer), customer, customer);
    vault.buyInventory(RH.NVDA, 1e15, type(uint256).max);
    vm.stopPrank();
    vault.totalAssets();
    credit.creditTerms(customer);
    credit.history(customer);
    console2.log('warmed demo flows for', customer);
  }

  /// @dev Deposit and earn, borrow, reputation (NorenDepositVault, NorenBorrow, NorenReputation).
  function _earn() internal {
    address b = vm.envOr('NOREN_RH_BORROW', address(0));
    if (b == address(0)) return;
    NorenBorrow borrow = NorenBorrow(b);
    NorenReputation rep = borrow.reputation();
    NorenDepositVault[] memory vs = borrow.vaults();
    NorenLiquidity liquidity = NorenLiquidity(address(gateway.liquidity()));
    address keeper = vm.addr(0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a); // Anvil #4
    for (uint256 i; i < vs.length; ++i) {
      address a = vs[i].asset();
      vs[i].stats();
      oracle.checkTransferable(a, customer, address(vs[i]));
      oracle.checkTransferable(a, address(vs[i]), customer);
      oracle.checkTransferable(a, address(vs[i]), keeper);
      IERC20(a).balanceOf(keeper);
      IERC20(a).allowance(customer, address(vs[i]));
      liquidity.bestAskForAsset(a, 1e15);
      liquidity.bestQuoteForUsdg(a, 10e6);
    }
    vm.startPrank(customer);
    vs[0].depositETH{value: 1 ether}(customer);
    for (uint256 i = 1; i < vs.length; ++i) {
      IERC20(vs[i].asset()).approve(address(vs[i]), 1e18);
      vs[i].deposit(1e18, customer);
    }
    IERC20(RH.USDG).approve(address(liquidity), type(uint256).max);
    liquidity.buyFromMakers(RH.WETH, 0.1 ether, type(uint256).max, customer);
    liquidity.buyFromMakers(vs[1].asset(), 1e17, type(uint256).max, customer);
    uint256 sh = vs[0].balanceOf(customer);
    IERC20(address(vs[0])).approve(address(borrow), type(uint256).max);
    IERC20(address(vs[1])).approve(address(borrow), type(uint256).max);
    borrow.lock(vs[0], sh / 2);
    borrow.lock(vs[1], vs[1].balanceOf(customer));
    borrow.borrow(100e6, customer);
    borrow.healthFactor(customer);
    borrow.liquidationPriceUsd8(customer, vs[0]);
    IERC20(RH.USDG).approve(address(borrow), type(uint256).max);
    borrow.repay(customer, type(uint256).max);
    borrow.unlock(vs[0], sh / 4, customer);
    vs[0].redeemETH(sh / 8, payable(customer), customer);
    vs[0].redeemInKind(sh / 8, customer, customer);
    vs[2].redeem(vs[2].maxRedeem(customer), customer, customer);
    borrow.unlock(vs[0], borrow.lockedShares(customer, address(vs[0])), customer);
    borrow.borrow(borrow.borrowLimitUsdg(customer), customer);
    // loans that pay themselves down: a fill on the locked nNVDA strategy, then a keeper harvest
    liquidity.buyFromMakers(vs[1].asset(), 1e16, type(uint256).max, customer);
    vm.stopPrank();
    borrow.previewYieldRepay(customer);
    vm.prank(keeper);
    try borrow.harvestToRepay(customer) {} catch {}
    rep.creditLimitOf(customer);
    uint64 exp = uint64(block.timestamp + 1 hours);
    bytes32 nullifier = keccak256('warm-nullifier');
    // simulation only: the configured attester key is not available to this script, so point the
    // registry at Anvil #7 for the warm run (nothing here is broadcast)
    vm.prank(rep.owner());
    rep.setWorldIdSigner(vm.addr(WORLD_ID_KEY));
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(WORLD_ID_KEY, rep.hashVerifiedHuman(customer, nullifier, exp));
    rep.verifyHuman(customer, nullifier, exp, abi.encodePacked(r, s, v));
    uint64 first = uint64(block.timestamp - 200 days);
    (v, r, s) = vm.sign(UNDERWRITER_KEY, rep.hashAccountAge(customer, first, exp));
    rep.recordAccountAge(customer, first, exp, abi.encodePacked(r, s, v));
    rep.breakdownOf(customer);
    // liquidation of the nNVDA position through Aqua makers after a real multiplier cut (simulation only)
    address nvdaAsset = vs[1].asset();
    uint256 m = oracle.multiplier(nvdaAsset);
    vm.prank(RH.MULTIPLIER_ADMIN);
    IStockMultiplier(nvdaAsset).updateMultiplier(m * 40 / 100);
    vm.prank(keeper);
    borrow.liquidateViaAqua(customer, vs[1]);
    vm.prank(RH.MULTIPLIER_ADMIN);
    IStockMultiplier(nvdaAsset).updateMultiplier(m);
  }

  /// @dev Aqua maker reads (positions, best execution vs Uniswap v4) and a liquidation through SwapVM.
  function _aqua() internal {
    NorenLiquidity liquidity = NorenLiquidity(address(gateway.liquidity()));
    if (address(liquidity) == address(0)) return;
    address[4] memory assets = [RH.NVDA, RH.TSLA, RH.AAPL, RH.WETH];
    address maker;
    for (uint256 i; i < assets.length; ++i) {
      bytes32[] memory hs = liquidity.strategiesFor(assets[i]);
      for (uint256 j; j < hs.length; ++j) {
        NorenLiquidity.Strategy memory st = liquidity.strategy(hs[j]);
        maker = st.maker;
        liquidity.balances(hs[j]);
        IERC20(assets[i]).balanceOf(st.maker);
        oracle.valueUsd8(assets[i], 1e18);
      }
      liquidity.bestQuoteForAsset(assets[i], 1e18);
      (address c0, address c1) = RH.USDG < assets[i] ? (RH.USDG, assets[i]) : (assets[i], RH.USDG);
      try IV4QuoterWarm(RH.V4_QUOTER).quoteExactInputSingle(
        IV4QuoterWarm.QuoteExactSingleParams(IV4QuoterWarm.PoolKey(c0, c1, 3000, 60, address(0)), c0 == assets[i], 1e18, '')
      ) {} catch {}
    }
    if (maker == address(0)) return;
    liquidity.strategiesOf(maker);
    liquidity.makerFeesUsdg(maker);
    IERC20(RH.USDG).balanceOf(maker);
    // Pay in 3 plan liquidated through makers after a real Stock Token multiplier cut (simulation only)
    uint256 planId = _plan('warm-plan-aqua-liq', RH.NVDA);
    uint256 m = oracle.multiplier(RH.NVDA);
    vm.prank(RH.MULTIPLIER_ADMIN);
    IStockMultiplier(RH.NVDA).updateMultiplier(m * 60 / 100);
    credit.liquidatePlanViaAqua(planId);
    vm.prank(RH.MULTIPLIER_ADMIN);
    IStockMultiplier(RH.NVDA).updateMultiplier(m);
  }

  function _pay(string memory tag, address asset, bool permit) internal {
    bytes32 id = keccak256(bytes(tag));
    vm.prank(merchant);
    gateway.createInvoice(id, 25e6, uint64(block.timestamp + 1 days));
    (uint256 q,,) = gateway.quote(merchant, id, asset);
    if (permit) {
      uint256 deadline = block.timestamp + 1 hours;
      bytes32 digest = keccak256(
        abi.encodePacked(
          '\x19\x01',
          IPermit(asset).DOMAIN_SEPARATOR(),
          keccak256(abi.encode(PERMIT_TYPEHASH, customer, address(gateway), q, IPermit(asset).nonces(customer), deadline))
        )
      );
      (uint8 v, bytes32 r, bytes32 s) = vm.sign(CUSTOMER_KEY, digest);
      vm.prank(customer);
      gateway.payWithPermit(id, merchant, asset, q, deadline, v, r, s);
    } else {
      vm.startPrank(customer);
      IERC20(asset).approve(address(gateway), q);
      gateway.pay(id, merchant, asset, q);
      vm.stopPrank();
    }
  }

  function _plan(string memory tag, address asset) internal returns (uint256 planId) {
    bytes32 id = keccak256(bytes(tag));
    vm.prank(merchant);
    gateway.createInvoice(id, 100e6, uint64(block.timestamp + 1 days));
    (uint256 col,) = oracle.assetForUsd8(asset, oracle.usdgToUsd8(100e6, Math.Rounding.Ceil) * 15_000 / 10_000, 0);
    vm.startPrank(customer);
    IERC20(asset).approve(address(credit), col);
    planId = credit.openPlan(id, merchant, asset, col);
    vm.stopPrank();
  }

  function _planEth(string memory tag) internal {
    bytes32 id = keccak256(bytes(tag));
    vm.prank(merchant);
    gateway.createInvoice(id, 50e6, uint64(block.timestamp + 1 days));
    (uint256 col,) = oracle.assetForUsd8(RH.WETH, oracle.usdgToUsd8(50e6, Math.Rounding.Ceil) * 15_000 / 10_000, 0);
    vm.prank(customer);
    credit.openPlan{value: col}(id, merchant, address(0), col);
  }
}
