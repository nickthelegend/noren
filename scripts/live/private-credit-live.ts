// Pay later, privately: a credit line draws into the Kohaku privacy pool, then the borrower pays a Noren invoice
// from the pool, so the merchant never learns which customer paid. The lender (the credit line) still knows its
// borrower.
//
//   pnpm exec tsx scripts/live/private-credit-live.ts --fork   # Anvil fork of Arc testnet on 127.0.0.1:8870
//   pnpm exec tsx scripts/live/private-credit-live.ts          # PUBLIC Arc testnet (real txs, real testnet USDC)
//
//   1. Deploy NorenCreditLine (with drawToPool) and setPrivacyPool(live Entrypoint, live USDC pool). The live
//      Entrypoint, pool, NorenCheckout, NorenShieldSink, hooks, routers and CCIP gateways are not touched.
//   2. Open a 1.50 USDC line for a fresh borrower through Chainlink CRE: packages/cre-bridge handler 3 (HTTP
//      trigger, kind-2 starter report) in `cre workflow simulate --broadcast`, delivered by Arc testnet's
//      MockKeystoneForwarder. The nullifier is a labelled test value, not a World ID proof.
//   3. The operator funds the line's pool with 1.00 USDC (fund).
//   4. The borrower's Kohaku account computes its next precommitment client-side, and the borrower calls
//      drawToPool(lineId, 1.00 USDC, precommitment). 1.00 USDC is the live pool's minimum deposit.
//   5. The ASP postman screens and approves the deposit's label (updateRoot).
//   6. The merchant server drafts a 0.40 USDC invoice; the borrower binds it, proves in Node, and the merchant
//      relays NorenCheckout.pay. The run checks the borrower's address is in neither the payment tx's sender, input
//      nor logs, and that the payout gained exactly 0.40 USDC. 0.60 USDC stays private (change note).
//
// Fork mode: Arc's precompile-backed USDC is replaced by packages/contracts' ForkUSDC (Anvil has no Arc
// precompiles), USDC is minted by the shim, the borrower and Kohaku seed are fresh random keys per run, and the CRE
// broadcast key is Anvil's published dev account 9. Nothing leaves the machine.
// Live mode: the operator key is NOREN_DEPLOYER_KEY (main checkout .env.arc-deployer), every operator tx runs under
// /private/tmp/noren-arc-deployer.lock, the borrower key and Kohaku seed are made once in the main checkout's
// gitignored .keys-live-privcredit.json (0600), no key is printed, and the run stops if the operator would spend
// more than 2 USDC. Resumable: data/privcredit-live/state.json; public record scripts/live/private-credit-runs.json.
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { concatHex, createPublicClient, createWalletClient, decodeEventLog, encodeFunctionData, erc20Abi, formatUnits, http, keccak256, parseAbi, parseEther, toBytes, toHex, type Address, type Hex } from 'viem';
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import { checkoutAbi, entrypointAbi, jsonBigints, localFork, poolAbi, type Invoice } from '@noren/core';
import { createCustomer } from '@noren/core/customer';
import { createNoren } from '@noren/core/merchant';
import { readDeployment } from '@noren/core/node';
import { createMerchantServer } from '../../packages/server/src/server.ts';
import { createPostman } from '../../packages/postman/src/postman.ts';
import { withArcLock } from '../../packages/cctp/scripts/lib.ts';
import { mainCheckout, operatorKey } from './e2e-live.ts';

const FORK = process.argv.includes('--fork');
const PORTS = { anvil: 8870, asp: 8871, server: 8872 };
const RPC = FORK ? `http://127.0.0.1:${PORTS.anvil}` : (process.env.NOREN_RPC_URL ?? 'https://rpc.testnet.arc.io');
const EXPLORER = 'https://explorer.testnet.arc.io';
const CRE_TARGET = FORK ? 'local-fork' : 'staging-settings'; // targets in packages/cre-bridge/credit-bridge/workflow.yaml
const FORWARDER: Address = '0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1'; // Arc testnet MockKeystoneForwarder
const OPERATOR = '0x4b2acf80bc6e07bbf5690f0710e25c528cb63f80';
const ROBINHOOD_SENTINEL: Address = '0x000000000000000000000000000000000000dEaD'; // handler 3 never writes to Robinhood
const LIMIT = 1_500_000n, FUND = 1_000_000n, DRAW = 1_000_000n, INVOICE = 400_000n, BORROWER_GAS = 50_000n;
const MAX_OPERATOR_SPEND = 2_000_000n;
const DIR = resolve(FORK ? 'data/privcredit-fork' : 'data/privcredit-live');
const t0 = performance.now();
const say = (line: string) => console.log(`[${((performance.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${line}`);
const link = (hash: string) => FORK ? `fork:${hash}` : `${EXPLORER}/tx/${hash}`;

const lineAbi = parseAbi([
  'function setPrivacyPool(address entrypoint, address pool)', 'function privacyEntrypoint() view returns (address)', 'function forwarder() view returns (address)',
  'function starterLineId(address) pure returns (bytes32)', 'function available(bytes32) view returns (uint256)', 'function outstanding(bytes32) view returns (uint256)',
  'function fund(uint256 amount)', 'function drawToPool(bytes32 lineId, uint256 amount, uint256 precommitment) returns (uint256)',
  'function lineOfCommitment(uint256) view returns (bytes32)', 'function totalOutstandingUsdc6() view returns (uint256)',
  'event Drawn(bytes32 indexed lineId, uint256 amount, bytes32 invoiceId, address merchant)',
  'event DrawnToPool(bytes32 indexed lineId, uint256 amount, uint256 precommitment, uint256 commitment)',
]);

type Step = { step: string; tx: Hex; url: string; from: Address; to: Address | null; gasUsed: string; block: string; note?: string };
type State = { steps: Step[]; done: Record<string, any> };
const stateFile = join(DIR, 'state.json');
const loadState = (): State => { if (FORK) return { steps: [], done: {} }; try { return JSON.parse(readFileSync(stateFile, 'utf8')); } catch { return { steps: [], done: {} }; } };
const saveState = (s: State) => { mkdirSync(DIR, { recursive: true }); writeFileSync(stateFile, jsonBigints(s) + '\n'); };
function fileStorage(name: string) {
  const path = join(DIR, `${name}.json`);
  const read = (): Record<string, string> => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; } };
  return { get: async (k: string) => read()[k] ?? null, set: async (k: string, v: string) => { const all = read(); all[k] = v; mkdirSync(DIR, { recursive: true }); writeFileSync(path, JSON.stringify(all), { mode: 0o600 }); } };
}
type Keys = { borrowerKey: Hex; borrowerSeed: Hex };
function keys(): Keys {
  if (FORK) return { borrowerKey: generatePrivateKey(), borrowerSeed: generatePrivateKey() };
  const file = resolve(mainCheckout(), '.keys-live-privcredit.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const k: Keys = { borrowerKey: generatePrivateKey(), borrowerSeed: generatePrivateKey() };
  writeFileSync(file, JSON.stringify(k, null, 2) + '\n', { mode: 0o600 }); chmodSync(file, 0o600);
  say(`generated a fresh borrower key and Kohaku seed in ${file} (gitignored, 0600)`);
  return k;
}
/** True when `who` appears anywhere in the tx (sender, input) or its logs (topics, data). */
async function appearsIn(client: any, hash: Hex, who: Address) {
  const needle = who.slice(2).toLowerCase();
  const [tx, r] = await Promise.all([client.getTransaction({ hash }), client.getTransactionReceipt({ hash })]);
  return { inSender: tx.from.toLowerCase() === who.toLowerCase(), inInput: tx.input.toLowerCase().includes(needle), inLogs: r.logs.some((l: any) => l.data.toLowerCase().includes(needle) || l.topics.some((t: string) => t.toLowerCase().includes(needle))) };
}
function decodeAll(logs: any[], abi: any, address: string) {
  return logs.filter(l => l.address.toLowerCase() === address.toLowerCase()).flatMap(l => { try { const e: any = decodeEventLog({ abi, data: l.data, topics: l.topics }); return [{ event: e.eventName, args: e.args }]; } catch { return []; } });
}

/** `cre workflow simulate --broadcast` for packages/cre-bridge handler 3, with a throwaway project root whose
 *  project.yaml points arc-testnet at RPC (target staging-settings live, local-fork on the fork). The broadcast key goes in a 0600 env file only. */
function creStarter(key: Hex, config: unknown, payload: unknown): string {
  const src = resolve('packages/cre-bridge/credit-bridge');
  if (!existsSync(join(src, 'node_modules'))) execFileSync('bun', ['install', '--frozen-lockfile'], { cwd: src, stdio: 'inherit' });
  const root = mkdtempSync(join(tmpdir(), 'noren-privcredit-cre-'));
  try {
    writeFileSync(join(root, 'project.yaml'), `${CRE_TARGET}:\n  rpcs:\n    - chain-name: arc-testnet\n      url: ${RPC}\n    - chain-name: robinhood-testnet\n      url: https://rpc.testnet.chain.robinhood.com\n`);
    writeFileSync(join(root, 'config.json'), JSON.stringify(config, null, 2));
    const dst = join(root, 'workflow');
    cpSync(src, dst, { recursive: true, filter: f => !/node_modules|\.cre_build_tmp/.test(f.slice(src.length)) });
    symlinkSync(join(src, 'node_modules'), join(dst, 'node_modules'));
    writeFileSync(join(root, 'cre.env'), `CRE_ETH_PRIVATE_KEY=${key.slice(2)}\n`, { mode: 0o600 });
    const run = spawnSync('cre', ['workflow', 'simulate', 'workflow', '-R', root, '-T', CRE_TARGET, '--config', join(root, 'config.json'), '-e', join(root, 'cre.env'),
      '--non-interactive', '--trigger-index', '3', '--http-payload', JSON.stringify(payload), '--broadcast'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 24, timeout: 300_000 });
    const scrub = (s: string) => s.split(key.slice(2)).join('[redacted]').split(key.slice(2).toLowerCase()).join('[redacted]');
    const out = scrub(`${run.stdout ?? ''}${run.stderr ?? ''}`);
    mkdirSync(DIR, { recursive: true }); writeFileSync(join(DIR, 'cre-starter.log'), out);
    for (const l of out.split('\n')) if (/\[USER LOG\]/.test(l)) say(`cre | ${l.trim()}`);
    if (run.status !== 0) throw new Error(`cre workflow simulate exited ${run.status}; see ${join(DIR, 'cre-starter.log')}`);
    return out;
  } finally { rmSync(root, { recursive: true, force: true }); }
}

async function startAnvil(): Promise<ChildProcess> {
  const p = spawn('anvil', ['--silent', '--fork-url', 'https://rpc.testnet.arc.io', '--chain-id', '5042002', '--port', String(PORTS.anvil)], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }); if (r.ok) return p; } catch { /* starting */ }
    await new Promise(r => setTimeout(r, 500));
  }
  p.kill(); throw new Error(`anvil did not start on ${PORTS.anvil}`);
}

async function main() {
  let anvil: ChildProcess | undefined;
  if (FORK) anvil = await startAnvil();
  try { await run(); } finally { if (anvil) { anvil.kill(); say('stopped the fork'); } }
}

async function run() {
  execFileSync('forge', ['build'], { cwd: resolve('packages/arc-credit'), stdio: ['ignore', 'ignore', 'inherit'] });
  const art = JSON.parse(readFileSync(resolve('packages/arc-credit/out/NorenCreditLine.sol/NorenCreditLine.json'), 'utf8'));
  const d = await readDeployment(5042002);
  const chain = localFork(RPC);
  const arc: any = createPublicClient({ chain, transport: http(RPC, { retryCount: 5, retryDelay: 800 }), cacheTime: 0 });
  if (await arc.getChainId() !== 5042002) throw new Error(`${RPC} is not Arc testnet (5042002)`);
  const opKey = operatorKey();
  const operator = privateKeyToAccount(opKey);
  if (operator.address.toLowerCase() !== OPERATOR) throw new Error('NOREN_DEPLOYER_KEY is not the Noren operator');
  const k = keys();
  const borrower = privateKeyToAccount(k.borrowerKey);
  const opWallet: any = createWalletClient({ chain, account: operator, transport: http(RPC) });
  const bWallet: any = createWalletClient({ chain, account: borrower, transport: http(RPC) });
  const lock = <T>(fn: () => Promise<T>) => FORK ? fn() : withArcLock(fn);
  const usdcOf = (a: Address) => arc.readContract({ address: d.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [a] }) as Promise<bigint>;
  const rpc = (method: string, params: unknown[]) => arc.request({ method, params });
  const state = loadState();
  say(`${FORK ? 'FORK of Arc testnet (local, nothing leaves this machine)' : 'PUBLIC Arc testnet'}  borrower ${borrower.address}`);

  if (FORK) {
    // Arc's USDC is a precompile-backed system contract; Anvil runs the repo's ForkUSDC shim in its place.
    const shim = JSON.parse(readFileSync(resolve('packages/contracts/out/ForkUSDC.sol/ForkUSDC.json'), 'utf8'));
    await rpc('anvil_setCode', [d.usdc, shim.deployedBytecode.object]);
    // registerPool gave the pool an unlimited allowance in the real USDC storage, which the shim does not share.
    await rpc('anvil_impersonateAccount', [d.entrypoint]); await rpc('anvil_setBalance', [d.entrypoint, toHex(parseEther('1'))]);
    const h = await rpc('eth_sendTransaction', [{ from: d.entrypoint, to: d.usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [d.pool, 2n ** 256n - 1n] }) }]);
    await arc.waitForTransactionReceipt({ hash: h }); await rpc('anvil_stopImpersonatingAccount', [d.entrypoint]);
    const mint = await rpc('eth_sendTransaction', [{ from: mnemonicToAccount('test test test test test test test test test test test junk').address, to: d.usdc, data: encodeFunctionData({ abi: parseAbi(['function mint(address to, uint256 value)']), functionName: 'mint', args: [operator.address, 10_000_000n] }) }]);
    await arc.waitForTransactionReceipt({ hash: mint });
  }
  state.done.start ??= { operatorUsdc: (await usdcOf(operator.address)).toString(), at: new Date().toISOString() }; saveState(state);
  const spent = async () => BigInt(state.done.start.operatorUsdc) - (await usdcOf(operator.address));
  const guard = async () => { const s = await spent(); if (!FORK && s > MAX_OPERATOR_SPEND) throw new Error(`budget: the operator has spent ${formatUnits(s, 6)} USDC (cap 2.00); stopping`); };

  async function settle(step: string, hash: Hex, note?: string) {
    const r = await arc.waitForTransactionReceipt({ hash, timeout: 300_000 });
    if (r.status !== 'success') throw new Error(`${step} reverted: ${link(hash)}`);
    state.steps.push({ step, tx: hash, url: link(hash), from: r.from, to: r.to, gasUsed: r.gasUsed.toString(), block: r.blockNumber.toString(), ...(note ? { note } : {}) }); saveState(state);
    say(`${step.padEnd(52)} ${link(hash)}`);
    return r;
  }

  // 1. NorenCreditLine with drawToPool, wired to the live Entrypoint and USDC pool.
  if (!state.done.line) {
    const r = await lock(async () => settle('deploy NorenCreditLine (with drawToPool)', await opWallet.deployContract({ abi: art.abi, bytecode: art.bytecode.object, args: [d.usdc, FORWARDER, operator.address] })));
    state.done.line = r.contractAddress; saveState(state);
  }
  const line = state.done.line as Address;
  if (!state.done.wired) {
    await lock(async () => settle('setPrivacyPool(Entrypoint, USDC pool)', await opWallet.writeContract({ address: line, abi: lineAbi, functionName: 'setPrivacyPool', args: [d.entrypoint, d.pool] })));
    state.done.wired = true; saveState(state);
  }
  if ((await arc.readContract({ address: line, abi: lineAbi, functionName: 'privacyEntrypoint' }) as string).toLowerCase() !== d.entrypoint.toLowerCase()) throw new Error('privacy entrypoint not set');
  await guard();

  // 2. Open the borrower's line through Chainlink CRE (handler 3, kind-2 starter report via the MockKeystoneForwarder).
  const lineId = await arc.readContract({ address: line, abi: lineAbi, functionName: 'starterLineId', args: [borrower.address] }) as Hex;
  if (!state.done.opened) {
    const now = Number((await arc.getBlock()).timestamp);
    state.done.nullifierHash ??= keccak256(toBytes(`noren private-credit test nullifier, not a World ID proof, ${now}`)); saveState(state);
    const base = JSON.parse(readFileSync(resolve('packages/cre-bridge/credit-bridge/config.staging.json'), 'utf8'));
    const config = { ...base, robinhood: { ...base.robinhood, address: ROBINHOOD_SENTINEL }, arc: { ...base.arc, address: line } };
    if (!FORK) writeFileSync(resolve('scripts/live/cre/credit-bridge.privcredit.live.json'), JSON.stringify(config, null, 2) + '\n');
    const payload = { kind: 'noren.human-starter.v1', borrower: borrower.address, nullifierHash: state.done.nullifierHash, lineId, limitUsdc6: LIMIT.toString(), expiry: now + 7 * 86400 };
    const creKey = FORK ? toHex(mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex: 9 }).getHdKey().privateKey!) : opKey;
    const out = await lock(async () => creStarter(creKey, config, payload));
    const tx = /updated on [a-z-]+: tx (0x[0-9a-f]{64})/.exec(out)?.[1] as Hex | undefined;
    if (!tx) throw new Error(`CRE handler 3 did not write; see ${join(DIR, 'cre-starter.log')}`);
    const t = await arc.getTransaction({ hash: tx });
    if (t.to?.toLowerCase() !== FORWARDER.toLowerCase()) throw new Error(`${tx} did not go through the MockKeystoneForwarder`);
    await settle('CRE kind-2 report -> forwarder -> onReport (1.50 USDC line)', tx, 'cre workflow simulate --broadcast, packages/cre-bridge handler 3; test nullifier, not a World ID proof');
    state.done.opened = { tx, lineId, limitUsdc6: LIMIT.toString() }; saveState(state);
  }
  say(`line ${lineId.slice(0, 10)}…: available ${formatUnits(await arc.readContract({ address: line, abi: lineAbi, functionName: 'available', args: [lineId] }), 6)} USDC`);

  // 3. Fund the line's pool, and give the borrower gas (Arc's gas token is USDC).
  if (!state.done.funded) {
    await lock(async () => {
      await settle('operator approves the credit pool', await opWallet.writeContract({ address: d.usdc, abi: erc20Abi, functionName: 'approve', args: [line, FUND] }));
      await settle('operator funds the credit pool 1.00 USDC (fund)', await opWallet.writeContract({ address: line, abi: lineAbi, functionName: 'fund', args: [FUND] }));
      if (FORK) await rpc('anvil_setBalance', [borrower.address, toHex(parseEther('0.05'))]);
      else await settle('operator sends the borrower 0.05 USDC for gas', await opWallet.writeContract({ address: d.usdc, abi: erc20Abi, functionName: 'transfer', args: [borrower.address, BORROWER_GAS] }), 'gas only: Arc pays gas in USDC');
    });
    state.done.funded = true; saveState(state);
  }
  await guard();

  // The ASP postman serves its tree on loopback and posts roots with the operator key.
  const postman = createPostman({ deployment: d, rpcUrl: RPC, delayMs: 0, batchMs: 60_000, treeUrl: `http://127.0.0.1:${PORTS.asp}/asp/tree?v=1`,
    sendRoot: (root, cid) => lock(() => opWallet.writeContract({ address: d.entrypoint, abi: entrypointAbi, functionName: 'updateRoot', args: [root, cid] })),
    onTx: h => void settle('ASP updateRoot', h).catch(e => console.error(e.message)) });
  const aspServer = postman.serve(PORTS.asp);
  const merchantToken = randomBytes(24).toString('hex');
  const server = createMerchantServer({ deployment: d, rpcUrl: RPC, merchantKey: opKey, merchantToken, dataFile: join(DIR, 'invoices.json') });
  try {
    await new Promise<void>(ok => server.listen(PORTS.server, '127.0.0.1', ok));
    if (!state.done.drawn) await postman.tick(true);
    const customer = createCustomer({ deployment: d, rpcUrl: RPC, aspUrl: `http://127.0.0.1:${PORTS.asp}`, storage: fileStorage('kohaku'),
      deriveAt: async path => keccak256(concatHex([k.borrowerSeed, keccak256(toBytes(path))])) }); // same derivation as packages/web/src/wallet.ts

    // 4. The precommitment, computed in the borrower's Kohaku account; then the line draws into the pool under it.
    if (!state.done.precommitment) { state.done.precommitment = (await customer.nextPrecommitment()).toString(); saveState(state); }
    const precommitment = BigInt(state.done.precommitment);
    if (!state.done.drawn) {
      const outBefore = await arc.readContract({ address: line, abi: lineAbi, functionName: 'outstanding', args: [lineId] }) as bigint;
      await arc.simulateContract({ account: borrower, address: line, abi: lineAbi, functionName: 'drawToPool', args: [lineId, DRAW, precommitment] });
      const r = await settle('borrower drawToPool 1.00 USDC (credit line -> Kohaku pool)', await bWallet.writeContract({ address: line, abi: lineAbi, functionName: 'drawToPool', args: [lineId, DRAW, precommitment] }));
      const lineEv = decodeAll(r.logs, lineAbi, line), poolEv = decodeAll(r.logs, poolAbi, d.pool);
      const drawnToPool = lineEv.find(e => e.event === 'DrawnToPool'), drawn = lineEv.find(e => e.event === 'Drawn'), deposited = poolEv.find(e => e.event === 'Deposited');
      if (!drawnToPool || !drawn || !deposited) throw new Error(`missing DrawnToPool/Drawn/Deposited in ${link(r.transactionHash)}`);
      if (BigInt(deposited.args.precommitment) !== precommitment) throw new Error('deposited under a different precommitment');
      const outAfter = await arc.readContract({ address: line, abi: lineAbi, functionName: 'outstanding', args: [lineId] }) as bigint;
      if (outAfter - outBefore !== DRAW) throw new Error(`debt moved by ${outAfter - outBefore}, expected ${DRAW}`);
      state.done.drawn = { tx: r.transactionHash, commitment: drawnToPool.args.commitment.toString(), label: deposited.args.label.toString(), poolDepositor: deposited.args.depositor, debtUsdc6: outAfter.toString(), drawnEvent: { invoiceId: drawn.args.invoiceId, merchant: drawn.args.merchant }, borrowerPublicUsdcAfter: (await usdcOf(borrower.address)).toString() };
      saveState(state);
      say(`draw landed in the pool: depositor ${state.done.drawn.poolDepositor} (the credit line), debt ${formatUnits(outAfter, 6)} USDC`);
    }

    // 5. Compliance: the borrower is not on USDC's blocklist (the line checked it on-chain too); the ASP approves the label.
    state.done.screening ??= { borrowerIsBlacklisted: await arc.readContract({ address: d.usdc, abi: parseAbi(['function isBlacklisted(address) view returns (bool)']), functionName: 'isBlacklisted', args: [borrower.address] }), depositorScreenedByAsp: state.done.drawn.poolDepositor };
    saveState(state);
    if (state.done.screening.borrowerIsBlacklisted) throw new Error('borrower is on USDC\'s blocklist: the ASP must not approve');
    const spendable = async () => (await customer.balance() as any[]).filter(x => !x.tag).reduce((s, x) => s + BigInt(x.amount), 0n);
    for (let i = 0; ; i++) {
      await postman.tick(true);
      const bal = await spendable();
      if (bal > 0n) { say(`ASP approved the draw; spendable private balance ${formatUnits(bal, 6)} USDC`); state.done.aspApproved ??= { spendable: bal.toString() }; saveState(state); break; }
      if (i === 30) throw new Error('draw not approved after 30 ASP ticks');
      await new Promise(r => setTimeout(r, 3000));
    }
    await guard();

    // 6. Pay a 0.40 USDC Noren invoice privately from the drawn balance.
    if (!state.done.paid) {
      const base = `http://127.0.0.1:${PORTS.server}`;
      const post = async (path: string, value: unknown) => { const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: jsonBigints(value) }); const j = await r.json(); if (!r.ok) throw new Error(`${path}: ${j.error}`); return j; };
      const noren = createNoren({ server: base, token: merchantToken, merchant: operator.address });
      const payout = await arc.readContract({ address: d.checkout, abi: checkoutAbi, functionName: 'merchantPayout', args: [operator.address] }) as Address;
      if (/^0x0{40}$/.test(payout)) throw new Error('Setup required: the operator is not a registered merchant (run scripts/live/e2e-live.ts)');
      const created = await noren.invoices.create({ amount: INVOICE, expiresIn: 3600, description: 'Pay later, privately: paid from a credit draw into the pool' });
      const refund = await customer.refundInbox();
      const opening = customer.createReceipt();
      const bound = await post(`/invoices/${created.invoice.invoiceId}/bind`, { refundPrecommitment: refund.nextPrecommitment, receiptCommitment: opening.commitment });
      const invoice = { ...bound.invoice, amount: BigInt(bound.invoice.amount), expiry: BigInt(bound.invoice.expiry), refundPrecommitment: BigInt(bound.invoice.refundPrecommitment) } as Invoice;
      await customer.rememberReceipt(invoice, opening);
      const p0 = performance.now(); const proof = await customer.proveInvoicePayment(invoice); const secs = (performance.now() - p0) / 1000;
      say(`invoice ${invoice.invoiceId.slice(0, 10)}… bound; payment proof in ${secs.toFixed(2)} s`);
      const before = await usdcOf(payout);
      const paid = await lock(() => post(`/invoices/${invoice.invoiceId}/pay`, proof)); // the merchant server signs with the operator key
      const r = await settle('pay 0.40 USDC invoice privately (NorenCheckout.pay)', paid.paymentTx, `relayed by the merchant server; proof ${secs.toFixed(2)} s`);
      const gained = (await usdcOf(payout)) - before;
      if (gained !== INVOICE) throw new Error(`payout gained ${formatUnits(gained, 6)}, expected 0.40`);
      if (!decodeAll(r.logs, checkoutAbi, d.checkout).some(e => e.event === 'Paid')) throw new Error('no Paid event');
      const visible = await appearsIn(arc, paid.paymentTx, borrower.address);
      const lineVisible = await appearsIn(arc, paid.paymentTx, line);
      state.done.paid = { tx: paid.paymentTx, invoiceId: invoice.invoiceId, payout, payoutGained: gained.toString(), proveSeconds: Number(secs.toFixed(2)), borrowerVisible: visible, creditLineVisible: lineVisible };
      saveState(state);
      if (visible.inSender || visible.inInput || visible.inLogs) throw new Error(`the borrower's address appears in the payment tx: ${jsonBigints(visible)}`);
    }
    const left = await spendable();
    state.done.end = { privateBalanceLeft: left.toString(), lineOutstanding: (await arc.readContract({ address: line, abi: lineAbi, functionName: 'outstanding', args: [lineId] })).toString(), borrowerPublicUsdc: (await usdcOf(borrower.address)).toString(), operatorSpentUsdc: (await spent()).toString(), at: new Date().toISOString() };
    saveState(state);
    say(`borrower visible in the payment tx: ${jsonBigints(state.done.paid.borrowerVisible)}; credit line visible: ${jsonBigints(state.done.paid.creditLineVisible)}`);
    say(`private balance left ${formatUnits(left, 6)} USDC; line debt ${formatUnits(BigInt(state.done.end.lineOutstanding), 6)} USDC; operator spent ${formatUnits(BigInt(state.done.end.operatorSpentUsdc), 6)} USDC`);
    const record = { network: FORK ? 'LOCAL ANVIL FORK of Arc Testnet (5042002): nothing was broadcast' : 'Arc Testnet (5042002), PUBLIC', creditLine: line, entrypoint: d.entrypoint, pool: d.pool, checkout: d.checkout, borrower: borrower.address, lineId, steps: state.steps, ...state.done };
    const out = FORK ? join(DIR, 'result.json') : resolve('scripts/live/private-credit-runs.json');
    writeFileSync(out, jsonBigints(record) + '\n');
    say(`done: ${state.steps.length} transactions; record in ${out}`);
  } finally {
    await new Promise<void>(r => server.close(() => r()));
    await new Promise<void>(r => aspServer.close(() => r()));
  }
}
if (process.argv[1]?.endsWith('private-credit-live.ts')) main().then(() => process.exit(0)).catch(e => { console.error(e?.shortMessage ?? e?.message ?? e); console.error(String(e?.stack ?? '').split('\n').slice(1, 6).join('\n')); process.exit(1); });
