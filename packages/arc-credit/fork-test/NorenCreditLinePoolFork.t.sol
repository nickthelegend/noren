// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from 'forge-std/Test.sol';
import {IERC20} from '@oz/token/ERC20/IERC20.sol';

import {NorenCreditLine} from '../src/NorenCreditLine.sol';
import {IPrivacyEntrypoint, IPrivacyPoolRagequit} from '../src/interfaces/IPrivacyPool.sol';

/// Fork-only stand-in for Arc's native USDC at 0x3600...: Arc implements it with chain precompiles that Foundry's
/// EVM does not have (the same approach as packages/ccip's NorenShieldSinkFork). Same ERC-20 surface plus
/// FiatToken's isBlacklisted view. Never deployed anywhere.
contract ForkArcUsdc {
  mapping(address => uint256) public balanceOf;
  mapping(address => mapping(address => uint256)) public allowance;
  mapping(address => bool) public isBlacklisted;

  function decimals() external pure returns (uint8) {
    return 6;
  }

  function mint(address to, uint256 amount) external {
    balanceOf[to] += amount;
  }

  function blacklist(address a) external {
    isBlacklisted[a] = true;
  }

  function approve(address s, uint256 amount) external returns (bool) {
    allowance[msg.sender][s] = amount;
    return true;
  }

  function transfer(address to, uint256 amount) external returns (bool) {
    _move(msg.sender, to, amount);
    return true;
  }

  function transferFrom(address from, address to, uint256 amount) external returns (bool) {
    uint256 a = allowance[from][msg.sender];
    require(a >= amount, 'allowance');
    if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
    _move(from, to, amount);
    return true;
  }

  function _move(address from, address to, uint256 amount) private {
    require(!isBlacklisted[from] && !isBlacklisted[to], 'blacklisted');
    require(balanceOf[from] >= amount, 'balance');
    balanceOf[from] -= amount;
    balanceOf[to] += amount;
  }
}

interface IEntrypointView {
  function usedPrecommitments(uint256 precommitment) external view returns (bool);
}

interface IPoolView {
  function depositors(uint256 label) external view returns (address);
}

/// FORK TESTS on Arc Testnet against the LIVE Kohaku Entrypoint (ERC1967 proxy) and PrivacyPoolComplex (USDC) with
/// their Poseidon libraries. Only Arc's precompile-backed USDC is swapped for ForkArcUsdc. The test contract plays
/// the CRE forwarder that opens lines, exactly as Arc's MockKeystoneForwarder does on the live deployment.
contract NorenCreditLinePoolForkTest is Test {
  address constant ARC_USDC = 0x3600000000000000000000000000000000000000;
  address constant ENTRYPOINT = 0xa22F3200Ecb4319B48DCA49677c2F73Cd7260Ad5;
  address constant POOL = 0x393D8D46e1DFF8a719820E36d70BA509896Ea57d;
  uint256 constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

  // Pool.Deposited(address indexed depositor, uint256 commitment, uint256 label, uint256 value, uint256 precommitmentHash)
  bytes32 constant POOL_DEPOSITED = keccak256('Deposited(address,uint256,uint256,uint256,uint256)');
  bytes32 constant DRAWN = keccak256('Drawn(bytes32,uint256,bytes32,address)');

  NorenCreditLine line;
  ForkArcUsdc usdc;
  address owner = makeAddr('owner');
  address borrower = makeAddr('borrower');
  address stranger = makeAddr('stranger');
  address merchant = makeAddr('merchant');
  bytes32 constant LINE = keccak256('fork line 1');
  bytes32 constant LINE2 = keccak256('fork line 2');
  uint64 expiry;
  uint256 pre = uint256(keccak256('borrower precommitment 0')) % FIELD;

  function setUp() public {
    vm.createSelectFork(vm.envOr('ARC_TESTNET_RPC', string('https://rpc.testnet.arc.io')));
    vm.etch(ARC_USDC, address(new ForkArcUsdc()).code);
    usdc = ForkArcUsdc(ARC_USDC);
    // registerPool gave the pool an unlimited allowance in the real USDC storage, which the shim does not share.
    vm.prank(ENTRYPOINT);
    usdc.approve(POOL, type(uint256).max);

    line = new NorenCreditLine(IERC20(ARC_USDC), address(this), owner);
    vm.prank(owner);
    line.setPrivacyPool(IPrivacyEntrypoint(ENTRYPOINT), IPrivacyPoolRagequit(POOL));
    usdc.mint(address(line), 100e6);
    expiry = uint64(block.timestamp + 7 days);
    line.onReport('', abi.encode(borrower, LINE, uint256(5e6), expiry));
  }

  function _draw(uint256 amount, uint256 precommitment) internal returns (uint256) {
    vm.prank(borrower);
    return line.drawToPool(LINE, amount, precommitment);
  }

  function test_DrawLandsInTheLivePoolUnderTheBorrowersPrecommitment() public {
    uint256 poolBefore = usdc.balanceOf(POOL);
    vm.recordLogs();
    uint256 commitment = _draw(1e6, pre);

    assertEq(usdc.balanceOf(POOL) - poolBefore, 1e6, 'the pool holds the draw');
    assertEq(usdc.balanceOf(borrower), 0, 'the borrower never holds public USDC');
    assertEq(usdc.balanceOf(address(line)), 99e6, 'the credit pool paid it');
    assertTrue(IEntrypointView(ENTRYPOINT).usedPrecommitments(pre));
    assertEq(line.lineOfCommitment(commitment), LINE);

    Vm.Log[] memory logs = vm.getRecordedLogs();
    bool deposited;
    for (uint256 i; i < logs.length; i++) {
      if (logs[i].emitter == POOL && logs[i].topics[0] == POOL_DEPOSITED) {
        (uint256 c, uint256 label, uint256 value, uint256 preHash) = abi.decode(logs[i].data, (uint256, uint256, uint256, uint256));
        assertEq(address(uint160(uint256(logs[i].topics[1]))), address(line), 'the pool records the credit line as depositor');
        assertEq(c, commitment);
        assertEq(value, 1e6);
        assertEq(preHash, pre, 'deposited under the borrower precommitment');
        assertEq(IPoolView(POOL).depositors(label), address(line));
        deposited = true;
      }
    }
    assertTrue(deposited, 'no Deposited log from the live pool');
  }

  function test_DebtIsRecordedExactlyAsAPayInvoiceDraw() public {
    line.onReport('', abi.encode(borrower, LINE2, uint256(5e6), expiry));
    vm.recordLogs();
    _draw(2e6, pre);
    vm.prank(borrower);
    line.payInvoice(LINE2, merchant, 2e6, keccak256('inv'));

    NorenCreditLine.Line memory a = line.lines(LINE);
    NorenCreditLine.Line memory b = line.lines(LINE2);
    assertEq(a.drawnUsdc6, 2e6);
    assertEq(a.drawnUsdc6, b.drawnUsdc6, 'same debt as a merchant draw');
    assertEq(a.repaidUsdc6, 0);
    assertEq(line.outstanding(LINE), 2e6);
    assertEq(line.available(LINE), 3e6);
    assertEq(line.totalOutstandingUsdc6(), 4e6);
    (uint256 drawn,, uint64 asOf) = line.utilisation(LINE);
    assertEq(drawn, 2e6);
    assertEq(asOf, a.updatedAt, 'the bridge snapshot moved');

    // The CRE bridge's Drawn trigger sees the private draw too: merchant = the Entrypoint, no invoice id.
    Vm.Log[] memory logs = vm.getRecordedLogs();
    bool drawnSeen;
    for (uint256 i; i < logs.length; i++) {
      if (logs[i].emitter == address(line) && logs[i].topics[0] == DRAWN && logs[i].topics[1] == LINE) {
        (uint256 amount, bytes32 invoiceId, address to) = abi.decode(logs[i].data, (uint256, bytes32, address));
        assertEq(amount, 2e6);
        assertEq(invoiceId, bytes32(0), 'no invoice id: the draw names no merchant invoice');
        assertEq(to, ENTRYPOINT);
        drawnSeen = true;
      }
    }
    assertTrue(drawnSeen);

    // Repay is unchanged and public.
    usdc.mint(borrower, 2e6);
    vm.startPrank(borrower);
    usdc.approve(address(line), 2e6);
    line.repay(LINE, 2e6);
    vm.stopPrank();
    assertEq(line.outstanding(LINE), 0);
    assertEq(line.available(LINE), 5e6);
  }

  function test_LimitIsEnforced() public {
    vm.prank(borrower);
    vm.expectRevert(abi.encodeWithSelector(NorenCreditLine.LimitExceeded.selector, 5e6, 5e6 + 1));
    line.drawToPool(LINE, 5e6 + 1, pre);

    _draw(4e6, pre);
    uint256 pre2 = uint256(keccak256('borrower precommitment 1')) % FIELD;
    vm.prank(borrower);
    vm.expectRevert(abi.encodeWithSelector(NorenCreditLine.LimitExceeded.selector, 1e6, 2e6));
    line.drawToPool(LINE, 2e6, pre2);
    assertEq(line.outstanding(LINE), 4e6);
  }

  function test_NonBorrowerReverts() public {
    vm.prank(stranger);
    vm.expectRevert(NorenCreditLine.NotBorrower.selector);
    line.drawToPool(LINE, 1e6, pre);
    vm.expectRevert(NorenCreditLine.NotBorrower.selector);
    line.drawToPool(LINE, 1e6, pre); // not even the forwarder
    assertFalse(IEntrypointView(ENTRYPOINT).usedPrecommitments(pre));
  }

  function test_ExpiredLineReverts() public {
    vm.warp(expiry);
    vm.prank(borrower);
    vm.expectRevert(abi.encodeWithSelector(NorenCreditLine.LineExpired.selector, LINE, expiry));
    line.drawToPool(LINE, 1e6, pre);
  }

  function test_FrozenLineReverts() public {
    line.onReport('', abi.encode(borrower, LINE, uint256(0), expiry));
    vm.prank(borrower);
    vm.expectRevert(abi.encodeWithSelector(NorenCreditLine.LineClosed.selector, LINE));
    line.drawToPool(LINE, 1e6, pre);
  }

  function test_PausedReverts() public {
    vm.prank(owner);
    line.setPaused(true);
    vm.prank(borrower);
    vm.expectRevert(NorenCreditLine.IsPaused.selector);
    line.drawToPool(LINE, 1e6, pre);
  }

  function test_UnknownLineReverts() public {
    vm.prank(borrower);
    vm.expectRevert(abi.encodeWithSelector(NorenCreditLine.UnknownLine.selector, bytes32(uint256(7))));
    line.drawToPool(bytes32(uint256(7)), 1e6, pre);
  }

  function test_BlocklistedBorrowerReverts() public {
    usdc.blacklist(borrower);
    vm.prank(borrower);
    vm.expectRevert(abi.encodeWithSelector(NorenCreditLine.Blocklisted.selector, borrower));
    line.drawToPool(LINE, 1e6, pre);
  }

  function test_PrecommitmentOutsideTheFieldReverts() public {
    vm.startPrank(borrower);
    vm.expectRevert(NorenCreditLine.BadPrecommitment.selector);
    line.drawToPool(LINE, 1e6, 0);
    vm.expectRevert(NorenCreditLine.BadPrecommitment.selector);
    line.drawToPool(LINE, 1e6, FIELD);
    vm.stopPrank();
  }

  function test_ReusedPrecommitmentRevertsAndBooksNoDebt() public {
    _draw(1e6, pre);
    vm.prank(borrower);
    vm.expectRevert(); // the live Entrypoint's PrecommitmentAlreadyUsed
    line.drawToPool(LINE, 1e6, pre);
    assertEq(line.outstanding(LINE), 1e6);
  }

  /// The live pool's minimum deposit is 1 USDC, so a smaller draw reverts in the Entrypoint and books nothing.
  function test_BelowThePoolMinimumRevertsAndBooksNoDebt() public {
    (, uint256 minimum,,) = IPrivacyEntrypoint(ENTRYPOINT).assetConfig(IERC20(ARC_USDC));
    assertEq(minimum, 1e6);
    vm.prank(borrower);
    vm.expectRevert();
    line.drawToPool(LINE, 0.5e6, pre);
    assertEq(line.outstanding(LINE), 0);
    assertEq(usdc.balanceOf(address(line)), 100e6);
  }

  function test_PoolInsufficientReverts() public {
    NorenCreditLine dry = new NorenCreditLine(IERC20(ARC_USDC), address(this), owner);
    vm.prank(owner);
    dry.setPrivacyPool(IPrivacyEntrypoint(ENTRYPOINT), IPrivacyPoolRagequit(POOL));
    dry.onReport('', abi.encode(borrower, LINE, uint256(5e6), expiry));
    vm.prank(borrower);
    vm.expectRevert(abi.encodeWithSelector(NorenCreditLine.PoolInsufficient.selector, 0, 1e6));
    dry.drawToPool(LINE, 1e6, pre);
  }

  function test_OffUntilTheOwnerSetsThePool() public {
    NorenCreditLine fresh = new NorenCreditLine(IERC20(ARC_USDC), address(this), owner);
    fresh.onReport('', abi.encode(borrower, LINE, uint256(5e6), expiry));
    vm.prank(borrower);
    vm.expectRevert(NorenCreditLine.PrivacyPoolNotSet.selector);
    fresh.drawToPool(LINE, 1e6, pre);

    vm.expectRevert(NorenCreditLine.NotOwner.selector);
    fresh.setPrivacyPool(IPrivacyEntrypoint(ENTRYPOINT), IPrivacyPoolRagequit(POOL));
    vm.prank(owner);
    vm.expectRevert(abi.encodeWithSelector(NorenCreditLine.PoolMismatch.selector, POOL, stranger));
    fresh.setPrivacyPool(IPrivacyEntrypoint(ENTRYPOINT), IPrivacyPoolRagequit(stranger));
  }

  function test_RagequitOnlyForTheBorrowersOwnPoolDraws() public {
    uint256 commitment = _draw(1e6, pre);
    IPrivacyPoolRagequit.RagequitProof memory p;
    p.pubSignals[0] = 12345;
    vm.prank(borrower);
    vm.expectRevert(abi.encodeWithSelector(NorenCreditLine.UnknownCommitment.selector, uint256(12345)));
    line.ragequitPoolDraw(p);

    p.pubSignals[0] = commitment;
    vm.prank(stranger);
    vm.expectRevert(NorenCreditLine.NotBorrower.selector);
    line.ragequitPoolDraw(p);

    // The borrower reaches the live pool, which rejects a proof that isn't real.
    vm.prank(borrower);
    vm.expectRevert();
    line.ragequitPoolDraw(p);
    assertEq(line.lineOfCommitment(commitment), LINE, 'a failed ragequit changes nothing');
  }
}
