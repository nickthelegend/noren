// Chainlink CRE on the PUBLIC Arc testnet: real contracts, real `cre workflow simulate --broadcast` writes.
//
//   pnpm exec tsx scripts/live/cre-live.ts            # pricing, then credit
//   pnpm exec tsx scripts/live/cre-live.ts pricing    # NorenRateOracle only
//   pnpm exec tsx scripts/live/cre-live.ts credit     # NorenCreditLine only
//
// Pricing: deploys NorenRateOracle (packages/contracts) with Arc testnet's real MockKeystoneForwarder, runs
//   packages/cre-pricing once without --broadcast (nothing sent), then with --broadcast: the simulator reads the
//   live Chainlink feeds on Arc mainnet and delivers a report through the forwarder to onReport.
// Credit:  deploys NorenCreditLine (packages/arc-credit) with the same forwarder, runs packages/cre-bridge handler 3
//   (HTTP trigger, kind-2 starter report) with --broadcast, funds the pool with 1 USDC, the borrower pays 0.50 USDC
//   from the line, handler 2 reads that live Drawn log (no Robinhood write for a starter line), and the owner
//   withdraws the unused 0.50 USDC.
//   The starter request carries a labelled test nullifier, not a World ID proof: this run shows the CRE ->
//   forwarder -> NorenCreditLine path on the public chain, not World ID. config.robinhood.address is a
//   non-deployed sentinel only because validateConfig requires one; handlers 2 and 3 never write to Robinhood
//   for a starter line.
//
// CRE_ETH_PRIVATE_KEY comes from NOREN_DEPLOYER_KEY through a temporary 0600 env file (deleted afterwards), never on
// a command line; simulator output is scrubbed of the key before it is logged. Resumable via data/live-arc/cre.json.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { createPublicClient, createWalletClient, erc20Abi, http, keccak256, parseAbi, toBytes, zeroAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { localFork } from '@noren/core';
import { RPC, operatorKey, liveKeys, txLink } from './e2e-live.ts';

const FORWARDER = '0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1' as Address; // Arc testnet MockKeystoneForwarder (CRE forwarder directory)
const USDC = '0x3600000000000000000000000000000000000000' as Address;
/** Not deployed anywhere: handler 3 and starter-line draws never write to Robinhood; validateConfig needs a non-zero address. */
const ROBINHOOD_SENTINEL = '0x000000000000000000000000000000000000dEaD' as Address;
const STATE = resolve('data/live-arc/cre.json');
const say = (line: string) => console.log(line);

const chain = localFork(RPC);
const client: any = createPublicClient({ chain, transport: http(RPC, { retryCount: 5 }), cacheTime: 0 });
const key = operatorKey();
const operator = privateKeyToAccount(key);
const wallet: any = createWalletClient({ chain, account: operator, transport: http(RPC) });
const state: any = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
const save = () => { mkdirSync(resolve('data/live-arc'), { recursive: true }); writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n'); };

async function settle(label: string, hash: Hex) {
  const r = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (r.status !== 'success') throw new Error(`${label} reverted: ${txLink(hash)}`);
  say(`${label.padEnd(34)} ${txLink(hash)}`);
  return r;
}
async function deploy(label: string, artifactPath: string, args: unknown[]) {
  const a = JSON.parse(readFileSync(resolve(artifactPath), 'utf8'));
  const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args });
  const r = await settle(`deploy ${label}`, hash);
  if (!r.contractAddress || (await client.getCode({ address: r.contractAddress })) === undefined) throw new Error(`${label}: no code after deploy`);
  return { address: r.contractAddress as Address, tx: hash as Hex };
}

/** Runs `cre workflow simulate` against the public Arc testnet. Returns scrubbed output; throws on a non-zero exit. */
function simulate(projectDir: string, workflow: string, configFile: string, logName: string, args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'noren-cre-live-'));
  const envFile = join(dir, 'cre.env');
  try {
    writeFileSync(envFile, `CRE_ETH_PRIVATE_KEY=${key}\n`, { mode: 0o600 });
    const run = spawnSync('cre', ['workflow', 'simulate', workflow, '--target', 'staging-settings', '--non-interactive', '--config', relative(resolve(projectDir, workflow), configFile), // relative to the workflow folder; CRE caps ConfigPath at 97 characters
      '-e', envFile, ...args],
      { cwd: resolve(projectDir), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 300_000 });
    const scrub = (s: string) => s.split(key.slice(2)).join('[redacted]').split(key.slice(2).toLowerCase()).join('[redacted]');
    const out = scrub(`${run.stdout ?? ''}${run.stderr ?? ''}`);
    writeFileSync(resolve('data/live-arc', `${logName}.log`), out);
    for (const line of out.split('\n')) if (/\[USER LOG\]|Simulation Result|^"\{/.test(line)) say(`   | ${line.trim()}`);
    if (run.status !== 0) throw new Error(`cre workflow simulate ${workflow} exited ${run.status}; see data/live-arc/${logName}.log`);
    return out;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
async function forwarded(label: string, tx: Hex) {
  const t = await client.getTransaction({ hash: tx });
  if (t.to?.toLowerCase() !== FORWARDER.toLowerCase()) throw new Error(`${label} ${tx} did not go through the MockKeystoneForwarder`);
  return settle(label, tx);
}

async function pricing() {
  say('== NorenRateOracle on Arc testnet (CRE pricing)');
  const cfgPath = resolve('packages/cre-pricing/rate-oracle/config.staging.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const p = state.pricing ??= {};
  if (!p.oracle) {
    const d = await deploy('NorenRateOracle', 'packages/contracts/out/NorenRateOracle.sol/NorenRateOracle.json', [
      FORWARDER, BigInt(cfg.sourceChainId), cfg.usdcUsdFeed, BigInt(cfg.maxAgeSeconds),
      cfg.currencies.map((c: any) => c.code), cfg.currencies.map((c: any) => c.feed ?? zeroAddress), cfg.currencies.map((c: any) => c.minorDecimals)]);
    Object.assign(p, { oracle: d.address, deployTx: d.tx, forwarder: FORWARDER }); save();
  }
  const oracleAbi = parseAbi(['function forwarder() view returns (address)', 'function lastSourceBlock() view returns (uint64)', 'function quote(string currency, uint256 fiatAmount) view returns (uint256, uint80, uint80, uint256)', 'function onReport(bytes metadata, bytes report)']);
  if ((await client.readContract({ address: p.oracle, abi: oracleAbi, functionName: 'forwarder' })).toLowerCase() !== FORWARDER.toLowerCase()) throw new Error('Oracle forwarder mismatch');
  const liveCfg = resolve('scripts/live/cre/rate-oracle.live.json');
  mkdirSync(resolve('scripts/live/cre'), { recursive: true });
  writeFileSync(liveCfg, JSON.stringify({ ...cfg, oracle: { ...cfg.oracle, address: p.oracle } }, null, 2) + '\n');
  if (!p.simulateTx) {
    if (!p.dryRun) {
      const before = await client.readContract({ address: p.oracle, abi: oracleAbi, functionName: 'lastSourceBlock' });
      simulate('packages/cre-pricing', 'rate-oracle', liveCfg, 'cre-pricing-dry', ['--trigger-index', '0']);
      const after = await client.readContract({ address: p.oracle, abi: oracleAbi, functionName: 'lastSourceBlock' });
      if (after !== before) throw new Error('Dry run changed the oracle');
      p.dryRun = 'no --broadcast: report signed, nothing sent, oracle unchanged'; save();
      say('   dry run: oracle unchanged');
    }
    const out = simulate('packages/cre-pricing', 'rate-oracle', liveCfg, 'cre-pricing-broadcast', ['--trigger-index', '0', '--broadcast']);
    const tx = /NorenRateOracle updated: .* tx (0x[0-9a-f]{64})/.exec(out)?.[1] as Hex | undefined;
    if (!tx) throw new Error('The broadcast run did not report a write; see data/live-arc/cre-pricing-broadcast.log');
    await forwarded('CRE report -> NorenRateOracle', tx);
    p.simulateTx = tx; save();
  }
  const lastSourceBlock = await client.readContract({ address: p.oracle, abi: oracleAbi, functionName: 'lastSourceBlock' });
  const [eur] = await client.readContract({ address: p.oracle, abi: oracleAbi, functionName: 'quote', args: ['EUR', 10_000n] });
  const [jpy] = await client.readContract({ address: p.oracle, abi: oracleAbi, functionName: 'quote', args: ['JPY', 10_000n] });
  let direct = 'not checked';
  try { await client.simulateContract({ account: operator.address, address: p.oracle, abi: oracleAbi, functionName: 'onReport', args: ['0x', '0x'] }); direct = 'UNEXPECTEDLY ACCEPTED'; }
  catch (e: any) { direct = /0xfa4c7361|UnauthorizedForwarder/.test(String(e?.message) + JSON.stringify(e?.cause?.data ?? '')) ? 'reverts UnauthorizedForwarder (eth_call, no tx)' : `reverts (${String(e?.shortMessage ?? e?.message).slice(0, 80)})`; }
  if (direct.startsWith('UNEXPECTEDLY')) throw new Error('Oracle accepted a direct onReport');
  Object.assign(p, { lastSourceBlock: lastSourceBlock.toString(), quoteEur100: eur.toString(), quoteJpy10000: jpy.toString(), directOnReport: direct }); save();
  say(`   lastSourceBlock ${lastSourceBlock} (Arc mainnet); quote(EUR 100.00) = ${Number(eur) / 1e6} USDC; quote(JPY 10,000) = ${Number(jpy) / 1e6} USDC; direct onReport ${direct}`);
}

async function credit() {
  say('== NorenCreditLine on Arc testnet (CRE bridge, kind-2 starter report)');
  const c = state.credit ??= {};
  const customer = privateKeyToAccount(liveKeys().customerKey), payout = privateKeyToAccount(liveKeys().payoutKey).address;
  const custWallet: any = createWalletClient({ chain, account: customer, transport: http(RPC) });
  if (!c.creditLine) {
    const d = await deploy('NorenCreditLine', 'packages/arc-credit/out/NorenCreditLine.sol/NorenCreditLine.json', [USDC, FORWARDER, operator.address]);
    Object.assign(c, { creditLine: d.address, deployTx: d.tx, forwarder: FORWARDER, owner: operator.address }); save();
  }
  const lineAbi = parseAbi(['function starterLineId(address) pure returns (bytes32)', 'function available(bytes32) view returns (uint256)', 'function fund(uint256 amount)', 'function withdraw(address to, uint256 amount)', 'function payInvoice(bytes32 lineId, address merchant, uint256 amount, bytes32 invoiceId)', 'function forwarder() view returns (address)']);
  if ((await client.readContract({ address: c.creditLine, abi: lineAbi, functionName: 'forwarder' })).toLowerCase() !== FORWARDER.toLowerCase()) throw new Error('Credit line forwarder mismatch');
  const base = JSON.parse(readFileSync(resolve('packages/cre-bridge/credit-bridge/config.staging.json'), 'utf8'));
  const liveCfg = resolve('scripts/live/cre/credit-bridge.live.json');
  mkdirSync(resolve('scripts/live/cre'), { recursive: true });
  writeFileSync(liveCfg, JSON.stringify({ ...base, robinhood: { ...base.robinhood, address: ROBINHOOD_SENTINEL }, arc: { ...base.arc, address: c.creditLine } }, null, 2) + '\n');
  const lineId = await client.readContract({ address: c.creditLine, abi: lineAbi, functionName: 'starterLineId', args: [customer.address] }) as Hex;
  if (!c.starterTx) {
    const now = Number((await client.getBlock()).timestamp);
    c.nullifierHash ??= keccak256(toBytes(`noren-live-arc test nullifier, not a World ID proof, ${now}`)); save();
    const payload = JSON.stringify({ kind: 'noren.human-starter.v1', borrower: customer.address, nullifierHash: c.nullifierHash, lineId, limitUsdc6: '1000000', expiry: now + 7 * 86400 });
    const out = simulate('packages/cre-bridge', 'credit-bridge', liveCfg, 'cre-bridge-starter', ['--trigger-index', '3', '--http-payload', payload, '--broadcast']);
    const tx = /updated on [a-z-]+: tx (0x[0-9a-f]{64})/.exec(out)?.[1] as Hex | undefined;
    if (!tx) throw new Error('Handler 3 did not write; see data/live-arc/cre-bridge-starter.log');
    await forwarded('CRE kind-2 report -> NorenCreditLine', tx);
    Object.assign(c, { starterTx: tx, borrower: customer.address, lineId, limitUsdc6: '1000000' }); save();
  }
  say(`   starter line ${lineId}: available ${Number(await client.readContract({ address: c.creditLine, abi: lineAbi, functionName: 'available', args: [lineId] })) / 1e6} USDC`);
  if (!c.fundTx) {
    if (!c.fundApproveTx) { const h = await wallet.writeContract({ address: USDC, abi: erc20Abi, functionName: 'approve', args: [c.creditLine, 1_000_000n] }); await settle('pool approve (USDC.approve)', h); c.fundApproveTx = h; save(); }
    const h = await wallet.writeContract({ address: c.creditLine, abi: lineAbi, functionName: 'fund', args: [1_000_000n] }); await settle('fund pool 1 USDC (fund)', h); c.fundTx = h; save();
  }
  if (!c.drawTx) {
    c.drawInvoiceId ??= keccak256(toBytes(`noren-live-arc credit draw ${Date.now()}`)); save();
    const h = await custWallet.writeContract({ address: c.creditLine, abi: lineAbi, functionName: 'payInvoice', args: [lineId, payout, 500_000n, c.drawInvoiceId] });
    await settle('borrower payInvoice 0.50 USDC', h); Object.assign(c, { drawTx: h, drawMerchant: payout, drawUsdc6: '500000' }); save();
  }
  if (!c.drawHandled) {
    const r = await client.getTransactionReceipt({ hash: c.drawTx });
    const index = r.logs.findIndex((l: any) => l.address.toLowerCase() === c.creditLine.toLowerCase());
    const out = simulate('packages/cre-bridge', 'credit-bridge', liveCfg, 'cre-bridge-drawn', ['--trigger-index', '2', '--evm-tx-hash', c.drawTx, '--evm-event-index', String(index), '--broadcast']);
    if (!/World ID starter line|nothing to report to Robinhood/.test(out)) throw new Error('Handler 2 did not skip the starter-line draw; see data/live-arc/cre-bridge-drawn.log');
    c.drawHandled = 'handler 2 read the live Drawn log and skipped: a starter line has no Robinhood collateral line'; save();
  }
  if (!c.withdrawTx) {
    const left = await client.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [c.creditLine] }) as bigint;
    if (left > 0n) { const h = await wallet.writeContract({ address: c.creditLine, abi: lineAbi, functionName: 'withdraw', args: [operator.address, left] }); await settle(`owner withdraw ${Number(left) / 1e6} USDC`, h); c.withdrawTx = h; c.withdrawUsdc6 = left.toString(); save(); }
  }
}

const which = process.argv[2];
(async () => { if (!which || which === 'pricing') await pricing(); if (!which || which === 'credit') await credit(); say(`state: ${STATE}`); })()
  .then(() => process.exit(0)).catch(e => { console.error(e?.shortMessage ?? e?.message ?? e); process.exit(1); });
