// Merges the live Arc testnet runs into deployments/5042002.json (public addresses and tx hashes only).
//
//   pnpm exec tsx scripts/live/record.ts
//
// Reads data/live-arc/state.json (scripts/live/e2e-live.ts) and data/live-arc/cre.json (scripts/live/cre-live.sh),
// re-checks every recorded transaction's receipt on https://rpc.testnet.arc.io, and refuses to record one that
// is missing or reverted.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, http, type Hex } from 'viem';

const RPC = 'https://rpc.testnet.arc.io', EXPLORER = 'https://explorer.testnet.arc.io';
const client: any = createPublicClient({ transport: http(RPC, { retryCount: 5 }), cacheTime: 0 });
const file = 'deployments/5042002.json';
const record = JSON.parse(readFileSync(file, 'utf8'));
if (record.chainId !== 5042002 || record.rpcUrl !== RPC) throw new Error(`${file} is not the live Arc testnet record`);

async function confirm(tx: Hex) {
  const r = await client.getTransactionReceipt({ hash: tx });
  if (r.status !== 'success') throw new Error(`Transaction ${tx} did not succeed on Arc testnet`);
  const block = await client.getBlock({ blockNumber: r.blockNumber });
  return { block: r.blockNumber.toString(), timestamp: new Date(Number(block.timestamp) * 1000).toISOString(), from: r.from, to: r.to, gasUsed: r.gasUsed.toString(), explorer: `${EXPLORER}/tx/${tx}` };
}

const live: any = record.live ?? {};
if (existsSync('data/live-arc/state.json')) {
  const s = JSON.parse(readFileSync('data/live-arc/state.json', 'utf8'));
  if (!s.done?.finishedAt) throw new Error('data/live-arc/state.json: the e2e run has not finished');
  const keysAddress = (step: string) => s.steps.find((x: any) => x.step === step);
  live.e2e = {
    note: 'scripts/live/e2e-live.ts on the public Arc testnet. Merchant = the Noren operator; payout and customer are fresh testnet keys. The ASP tree was served on 127.0.0.1:8801 for the run, so the on-chain CID is a loopback URL.',
    finishedAt: s.done.finishedAt,
    merchant: record.deployer,
    payout: keysAddress('registerMerchant(payout)')?.note?.replace('payout ', ''),
    customer: keysAddress('customer approve Entrypoint')?.from,
    invoice: { invoiceId: s.done.invoice.invoiceId, amountUsdc6: s.done.invoice.amount, receiptCommitment: s.done.invoice.receiptCommitment },
    proofSeconds: s.done.paid.proveSeconds,
    balancesUsdc6: { start: s.done.startBalances, end: s.done.endBalances, shieldedRemaining: s.done.shieldedRemaining },
    steps: [] as any[],
  };
  for (const step of s.steps) live.e2e.steps.push({ step: step.step, tx: step.tx, ...(step.note ? { note: step.note } : {}), ...(await confirm(step.tx)) });
}
if (existsSync('data/live-arc/cre.json')) {
  const c = JSON.parse(readFileSync('data/live-arc/cre.json', 'utf8'));
  for (const section of Object.keys(c)) {
    const out: any = { ...c[section] };
    for (const key of Object.keys(out)) if (/tx$/i.test(key) && typeof out[key] === 'string' && /^0x[0-9a-f]{64}$/i.test(out[key])) out[`${key}Receipt`] = await confirm(out[key]);
    live[section] = out;
  }
}
record.live = live;
writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
console.log(`${file}: ${Object.keys(live).join(', ')} recorded; ${live.e2e?.steps.length ?? 0} e2e transactions re-checked on ${RPC}`);
