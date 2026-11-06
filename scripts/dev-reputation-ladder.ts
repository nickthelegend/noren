// Walk an app wallet up NorenReputation's LTV ladder (66% → 70% → 75% → 80%) with REAL transactions on the local
// Robinhood fork, so the Credit and Borrow pages can show the stock LTV move. Fork only (127.0.0.1, Anvil).
//
// Nothing here writes storage. Each stage sends the same contract calls the app makes, from the wallet itself
// (Anvil impersonation, because the app's key lives in the browser), and prints every fork tx:
//   world   no transaction: World ID is the real thing. Verify in the app (Credit → Raise your limit → World ID, scan the
//           QR with World App); dev:all then records NorenReputation.verifyHuman on the fork. +50 points → 70%.
//   ontime  Pay in 3 paid on time: the underwriter's real EIP-712 attestation (POST /attest) applied on NorenCredit, a
//           30 USDG NorenGateway invoice from the fork's demo merchant, NorenCredit.openPlan with ETH collateral, then
//           NorenCredit.repay(planId, 3) before the first due date. +30 points → 75% once World ID is done.
//   loan    A NorenBorrow loan repaid: deposit 1 NVDA into the nNVDA Aqua vault, lock the shares, borrow, then repay in
//           full. dev:all sets the fork's milestone age to 15 minutes; this stage advances fork time by 16 minutes
//           (evm_increaseTime, printed) instead of waiting. +25 points → 80% at the top tier.
// Gas and test USDG/NVDA come from the same fork faucet the app's "Get test stock" button uses.
//   pnpm exec tsx scripts/dev-reputation-ladder.ts 0x<app wallet> [ontime|loan|all]
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, erc20Abi, http, isAddress, parseAbi, parseEventLogs, toHex, type Address, type Hex } from 'viem';
import { norenBorrowAbi, norenCreditAbi, norenDepositVaultAbi, norenGatewayAbi } from '../packages/robinhood/sdk/src/abi.ts';
import { robinhoodFaucet } from '../packages/server/src/credit.ts';

const RPC = process.env.NOREN_RH_RPC ?? 'http://127.0.0.1:8646';
const UNDERWRITER = process.env.NOREN_UNDERWRITER_URL ?? 'http://127.0.0.1:8791';
const who = process.argv[2] as Address;
const stage = (process.argv[3] ?? 'all') as 'ontime' | 'loan' | 'all';
if (!isAddress(who) || !['ontime', 'loan', 'all'].includes(stage)) throw new Error('usage: tsx scripts/dev-reputation-ladder.ts 0x<address> [ontime|loan|all]');
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(RPC)) throw new Error('Refusing: this script only targets a local fork');
const pc: any = createPublicClient({ transport: http(RPC), cacheTime: 0 });
// dev:all serves the mainnet snapshot as chain 46630 (the id CRE knows as robinhood-testnet); a plain fork keeps 4663.
if (![4663, 46630].includes(await pc.getChainId())) throw new Error('Setup required: the Robinhood fork is not on ' + RPC + ' (pnpm dev:all)');
const info = await pc.request({ method: 'anvil_nodeInfo' }).catch(() => null);
if (!info) throw new Error('Refusing: ' + RPC + ' is not an Anvil fork');
const d = JSON.parse(readFileSync(resolve('packages/robinhood/.fork/deployment.json'), 'utf8'));
const NVDA = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC' as Address;
const NATIVE_ETH = '0x0000000000000000000000000000000000000000' as Address;
const repAbi = parseAbi(['function breakdownOf(address) view returns ((uint32 onTime, uint32 late, uint32 repaidLoans, uint32 liquidations, uint64 firstSeenAt, uint64 ageDays, bool verifiedHuman, uint256 points, uint256 milestones, uint8 tier, uint16 ltvBps, uint16 limitMultiplierBps))']);
const minAbi = parseAbi(['function minMilestonePrincipal() view returns (uint256)', 'function minMilestoneAge() view returns (uint32)']);

const as = async (from: Address, to: Address, abi: any, functionName: string, args: unknown[], value?: bigint, label?: string): Promise<Hex> => {
  await pc.request({ method: 'anvil_impersonateAccount', params: [from] });
  try {
    const w = createWalletClient({ account: from, transport: http(RPC) });
    await pc.simulateContract({ account: from, address: to, abi, functionName, args, value });
    const hash = await w.writeContract({ address: to, abi, functionName, args, value, chain: null } as any);
    const r = await pc.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error(`${functionName} reverted: ${hash}`);
    console.log(`   fork tx ${hash}  ${label ?? functionName}`);
    return hash;
  } finally { await pc.request({ method: 'anvil_stopImpersonatingAccount', params: [from] }); }
};
const rep = async () => pc.readContract({ address: d.reputation, abi: repAbi, functionName: 'breakdownOf', args: [who] });
const show = async (label: string) => { const b = await rep(); console.log(`${label}: ${b.points} points, tier ${b.tier}, LTV ${b.ltvBps / 100}% (World ID ${b.verifiedHuman ? 'yes' : 'no'}, ${b.onTime} on time, ${b.repaidLoans} loans repaid)`); return b; };
const usdg = () => pc.readContract({ address: d.usdg, abi: erc20Abi, functionName: 'balanceOf', args: [who] }) as Promise<bigint>;
const fund = async (needUsdg: bigint, needNvda: bigint) => {
  const [u, n, e] = await Promise.all([usdg(), pc.readContract({ address: NVDA, abi: erc20Abi, functionName: 'balanceOf', args: [who] }), pc.getBalance({ address: who })]);
  if (u >= needUsdg && n >= needNvda && e >= 10n ** 17n) return;
  const out = await robinhoodFaucet(RPC, who);
  console.log(`   fork faucet (same as the app's "Get test stock"): NVDA ${out.NVDA}, USDG ${out.USDG}, gas 1 ETH`);
};

console.log(`Reputation ladder for ${who} on the Robinhood fork ${RPC} (fork transactions only)`);
const start = await show('Now');
if (!start.verifiedHuman) console.log('World ID: not verified yet. Verify for real in the app: Credit → Raise your limit → "Verify you\'re human with World ID" (scan the QR with World App). Without it the ladder stops at 70%.');

if (stage === 'ontime' || stage === 'all') {
  if (start.onTime >= 3) console.log('Pay in 3: already 3 on-time installments');
  else {
    await fund(40_000_000n, 0n);
    const [tier] = await pc.readContract({ address: d.credit, abi: norenCreditAbi, functionName: 'creditTerms', args: [who] }) as [number];
    if (Number(tier) === 0) {
      const r = await fetch(`${UNDERWRITER}/attest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ borrower: who }) }).catch(() => { throw new Error(`Setup required: the history underwriter isn't reachable at ${UNDERWRITER} (pnpm dev:all)`); });
      const a = await r.json();
      if (!r.ok || a.declined) throw new Error(`The underwriter did not sign terms: ${a.error ?? a.reason ?? a.decision?.note ?? r.status}. Hold some NVDA (fork faucet) for the collateral floor and retry.`);
      await as(who, d.credit, norenCreditAbi, 'applyAttestation', [a.attestation, a.signature], undefined, `NorenCredit.applyAttestation (tier ${a.attestation.tier}, ${a.decisionSource})`);
    }
    const invoiceId = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const block = await pc.getBlock();
    await as(d.demoMerchant, d.gateway, norenGatewayAbi, 'createInvoice', [invoiceId, 30_000_000n, block.timestamp + 86_400n], undefined, 'NorenGateway.createInvoice 30 USDG (fork demo merchant)');
    const open = await as(who, d.credit, norenCreditAbi, 'openPlan', [invoiceId, d.demoMerchant, NATIVE_ETH, 3n * 10n ** 16n], 3n * 10n ** 16n, 'NorenCredit.openPlan (Pay in 3, 0.03 ETH collateral)');
    const ev = parseEventLogs({ abi: norenCreditAbi as any, eventName: 'PlanOpened', logs: (await pc.getTransactionReceipt({ hash: open })).logs }) as any[];
    const planId = ev[0].args.planId as bigint;
    let due = 0n;
    for (let n = 1; n <= 3; n++) due += await pc.readContract({ address: d.credit, abi: norenCreditAbi, functionName: 'installmentAmount', args: [planId, n] }) as bigint;
    await as(who, d.usdg, erc20Abi, 'approve', [d.credit, due], undefined, 'USDG.approve NorenCredit');
    await as(who, d.credit, norenCreditAbi, 'repay', [planId, 3], undefined, `NorenCredit.repay(plan ${planId}, 3 installments, ${Number(due) / 1e6} USDG) before the first due date`);
    await show('After on-time Pay in 3');
  }
}

if (stage === 'loan' || stage === 'all') {
  if (start.repaidLoans >= 1) console.log('NorenBorrow: a loan is already repaid');
  else {
    await fund(0n, 10n ** 18n);
    const vault = (d.depositVaults as { asset: Address; vault: Address }[]).find((v) => v.asset.toLowerCase() === NVDA.toLowerCase())!.vault;
    await as(who, NVDA, erc20Abi, 'approve', [vault, 10n ** 18n], undefined, 'NVDA.approve nNVDA vault');
    const dep = await as(who, vault, norenDepositVaultAbi, 'deposit', [10n ** 18n, who], undefined, 'nNVDA.deposit 1 NVDA (an Aqua maker vault)');
    const shares = (parseEventLogs({ abi: norenDepositVaultAbi as any, eventName: 'Deposit', logs: (await pc.getTransactionReceipt({ hash: dep })).logs }) as any[])[0].args.shares as bigint;
    await as(who, vault, erc20Abi, 'approve', [d.borrow, shares], undefined, 'nNVDA.approve NorenBorrow');
    await as(who, d.borrow, norenBorrowAbi, 'lock', [vault, shares], undefined, 'NorenBorrow.lock nNVDA shares');
    const [minP, minAge] = await Promise.all([pc.readContract({ address: d.borrow, abi: minAbi, functionName: 'minMilestonePrincipal' }), pc.readContract({ address: d.borrow, abi: minAbi, functionName: 'minMilestoneAge' })]) as [bigint, number];
    const amt = minP > 25_000_000n ? minP : 25_000_000n;
    await as(who, d.borrow, norenBorrowAbi, 'borrow', [amt, who], undefined, `NorenBorrow.borrow ${Number(amt) / 1e6} USDG`);
    await pc.request({ method: 'evm_increaseTime', params: [Number(minAge) + 60] });
    await pc.request({ method: 'evm_mine', params: [] });
    console.log(`   fork time advanced ${Math.round((Number(minAge) + 60) / 60)} min (evm_increaseTime): the milestone counts loans open at least ${Number(minAge) / 60} min on this fork`);
    await fund(amt + 2_000_000n, 0n);
    await as(who, d.usdg, erc20Abi, 'approve', [d.borrow, amt + 2_000_000n], undefined, 'USDG.approve NorenBorrow');
    await as(who, d.borrow, norenBorrowAbi, 'repay', [who, 2n ** 256n - 1n], undefined, 'NorenBorrow.repay in full');
    await show('After a repaid loan');
  }
}
