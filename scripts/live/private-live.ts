// "Arrive private" + "Send privately" on PUBLIC testnets: Arbitrum Sepolia -> Arc testnet with Circle CCTP V2.
//
//   pnpm exec tsx scripts/live/private-live.ts            (CRE relay; add --relay self to call hook.relay instead)
//
//   1. A fresh traveller key gets a little ETH and 2.00 USDC on Arbitrum Sepolia from the operator.
//   2. The traveller's Kohaku account (@noren/core/customer) computes its next deposit's precommitment client-side.
//   3. The traveller burns 2.00 USDC on Arbitrum Sepolia with depositForBurnWithHook: destinationCaller and
//      mintRecipient = the SHIELD-aware NorenArcHook, hookData = SHIELD(precommitment).
//   4. Noren's Chainlink CRE relay workflow (cre workflow simulate --broadcast, target privacy-settings) relays it:
//      Circle mints on Arc, the hook hands the USDC to NorenShieldSink, which screens the sender and beneficiary
//      against USDC's blocklist and deposits it into the Kohaku pool under the traveller's precommitment.
//   5. Compliance: the traveller is also screened against USDC's blocklist on the source chain. Then the ASP postman
//      approves the deposit's label (it screens the on-chain depositor, the sink) and posts a root.
//   6. The traveller pays a 0.75 USDC Noren invoice privately from that balance (NorenCheckout.pay via the merchant).
//   7. The traveller sends 0.50 USDC privately to a friend's fresh address: Noren's server relays Entrypoint.relay.
//   Both payments are checked for the traveller's address: it must appear in neither the tx input nor its logs.
//
// Keys: the operator key is NOREN_DEPLOYER_KEY (main checkout .env.arc-deployer); every operator tx runs under the
// shared nonce lock. Fresh traveller, Kohaku seed and friend keys are made once in the main checkout's gitignored
// .keys-live-private.json (0600) and never printed. Resumable: data/live-private/state.json; the public record is
// scripts/live/private-runs.json.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { concatHex, createPublicClient, createWalletClient, decodeEventLog, erc20Abi, formatUnits, http, keccak256, parseAbi, parseEther, toBytes, toHex, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { checkoutAbi, entrypointAbi, jsonBigints, localFork, poolAbi, relayAbi, usdcAbi, type Invoice } from '@noren/core';
import { createCustomer } from '@noren/core/customer';
import { createNoren } from '@noren/core/merchant';
import { readDeployment } from '@noren/core/node';
import { createMerchantServer } from '../../packages/server/src/server.ts';
import { createPostman } from '../../packages/postman/src/postman.ts';
import { bridgeToArc, waitForAttestation } from '../../packages/cctp/sdk/bridge.ts';
import { CCTP_CHAINS, txUrl } from '../../packages/cctp/sdk/chains.ts';
import { walletFor, withArcLock } from '../../packages/cctp/scripts/lib.ts';
import { mainCheckout, operatorKey, RPC, txLink } from './e2e-live.ts';
import { readRecord } from './private-deploy.ts';

const FROM = 'arbitrum-sepolia' as const;
const src = CCTP_CHAINS[FROM];
const PORTS = { server: 8850, asp: 8851 };
const BRIDGE = 2_000_000n, INVOICE = 750_000n, P2P = 500_000n, RELAY_FEE_BPS = 50n, SRC_GAS = parseEther('0.002');
const relayMode = process.argv.includes('--relay') ? process.argv[process.argv.indexOf('--relay') + 1] : 'cre';
const t0 = performance.now();
const say = (line: string) => console.log(`[${((performance.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${line}`);

type Keys = { travellerKey: Hex; travellerSeed: Hex; friendKey: Hex };
function keys(): Keys {
  const file = resolve(mainCheckout(), '.keys-live-private.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const k: Keys = { travellerKey: generatePrivateKey(), travellerSeed: generatePrivateKey(), friendKey: generatePrivateKey() };
  writeFileSync(file, JSON.stringify(k, null, 2) + '\n', { mode: 0o600 }); chmodSync(file, 0o600);
  say(`generated fresh traveller, Kohaku seed and friend keys in ${file} (gitignored, 0600)`);
  return k;
}
type Step = { step: string; chain: string; tx: Hex; url: string; from: Address; gasUsed: string; block: string; note?: string };
type State = { steps: Step[]; done: Record<string, any> };
const stateFile = resolve('data/live-private/state.json');
const loadState = (): State => { try { return JSON.parse(readFileSync(stateFile, 'utf8')); } catch { return { steps: [], done: {} }; } };
const saveState = (s: State) => { mkdirSync(dirname(stateFile), { recursive: true }); writeFileSync(stateFile, jsonBigints(s) + '\n'); };
function fileStorage(name: string) {
  const path = resolve('data/live-private', `${name}.json`);
  const read = (): Record<string, string> => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; } };
  return { get: async (k: string) => read()[k] ?? null, set: async (k: string, v: string) => { const all = read(); all[k] = v; mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(all), { mode: 0o600 }); } };
}
const sinkAbi = parseAbi([
  'event Shielded(bytes32 indexed msgId, uint64 indexed source, address indexed beneficiary, address sourceSender, uint256 amount, uint256 precommitment, uint256 commitment)',
  'event ShieldFailed(bytes32 indexed msgId, address indexed creditedTo, uint256 amount, bytes reason)',
  'event ComplianceHold(bytes32 indexed msgId, address indexed sourceSender, address indexed beneficiary, uint256 amount)',
]);
const hookAbi = parseAbi([
  'event Bridged(bytes32 indexed nonce, uint32 indexed sourceDomain, address indexed recipient, uint256 minted, uint256 feeExecuted, address depositor, uint32 finalityThresholdExecuted, bool viaCre)',
  'event HookExecuted(bytes32 indexed nonce, uint8 indexed kind, address indexed beneficiary, uint256 amount, bool routed, bool ok)',
  'event HookRejected(bytes32 indexed nonce, address indexed refundTo, uint256 amount, string reason)',
  'function relay(bytes message, bytes attestation)', 'function processed(bytes32) view returns (bool)',
]);
function decodeAll(logs: any[], abi: any, address: string) {
  return logs.filter(l => l.address.toLowerCase() === address.toLowerCase()).flatMap(l => { try { const e: any = decodeEventLog({ abi, data: l.data, topics: l.topics }); return [{ event: e.eventName, args: e.args }]; } catch { return []; } });
}
/** True when `who` appears anywhere in the tx (sender, input) or its logs (topics, data). */
async function appearsIn(client: any, hash: Hex, who: Address) {
  const needle = who.slice(2).toLowerCase();
  const [tx, r] = await Promise.all([client.getTransaction({ hash }), client.getTransactionReceipt({ hash })]);
  return { inSender: tx.from.toLowerCase() === who.toLowerCase(), inInput: tx.input.toLowerCase().includes(needle), inLogs: r.logs.some((l: any) => l.data.toLowerCase().includes(needle) || l.topics.some((t: string) => t.toLowerCase().includes(needle))) };
}

async function main() {
  const dep = readRecord();
  if (!dep.NorenShieldSink || !dep.NorenArcHook) throw new Error('Setup required: run scripts/live/private-deploy.ts first');
  const d = await readDeployment(5042002);
  const chain = localFork(RPC);
  const arc: any = createPublicClient({ chain, transport: http(RPC, { retryCount: 5, retryDelay: 800 }), cacheTime: 0 });
  const srcClient: any = createPublicClient({ transport: http(src.rpcUrl, { retryCount: 5, retryDelay: 800 }), cacheTime: 0 });
  const opKey = operatorKey();
  const operator = privateKeyToAccount(opKey);
  if (operator.address.toLowerCase() !== '0x4b2acf80bc6e07bbf5690f0710e25c528cb63f80') throw new Error('NOREN_DEPLOYER_KEY is not the Noren operator');
  const k = keys();
  const traveller = privateKeyToAccount(k.travellerKey), friend = privateKeyToAccount(k.friendKey).address;
  const opArc: any = createWalletClient({ chain, account: operator, transport: http(RPC) });
  const opSrc: any = walletFor(FROM, opKey), travSrc: any = walletFor(FROM, k.travellerKey);
  const state = loadState();
  const arcUsdc = (a: Address) => arc.readContract({ address: d.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [a] }) as Promise<bigint>;
  const srcUsdc = (a: Address) => srcClient.readContract({ address: src.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [a] }) as Promise<bigint>;
  say(`traveller ${traveller.address} (same address on ${src.name} and Arc)  friend ${friend}`);
  say(`privacy hook ${dep.NorenArcHook}  shield sink ${dep.NorenShieldSink}`);
  state.done.start ??= { operatorArc: (await arcUsdc(operator.address)).toString(), operatorSrc: (await srcUsdc(operator.address)).toString(), at: new Date().toISOString() };

  async function settle(step: string, chainKey: 'arc-testnet' | typeof FROM, hash: Hex, note?: string) {
    const c = chainKey === 'arc-testnet' ? arc : srcClient;
    const r = await c.waitForTransactionReceipt({ hash, timeout: 300_000 });
    if (r.status !== 'success') throw new Error(`${step} reverted: ${txUrl(chainKey, hash)}`);
    state.steps.push({ step, chain: chainKey, tx: hash, url: txUrl(chainKey, hash), from: r.from, gasUsed: r.gasUsed.toString(), block: r.blockNumber.toString(), ...(note ? { note } : {}) }); saveState(state);
    say(`${step.padEnd(46)} ${txUrl(chainKey, hash)}`);
    return r;
  }

  // 1. Fund the traveller on the source chain (operator key, under the shared lock).
  if (!state.done.funded) {
    await withArcLock(async () => {
      if (await srcClient.getBalance({ address: traveller.address }) < SRC_GAS / 2n) await settle(`fund traveller ${formatUnits(SRC_GAS, 18)} ETH`, FROM, await opSrc.sendTransaction({ to: traveller.address, value: SRC_GAS, chain: null }));
      if (await srcUsdc(traveller.address) < BRIDGE) await settle('fund traveller 2.00 USDC', FROM, await opSrc.writeContract({ address: src.usdc, abi: erc20Abi, functionName: 'transfer', args: [traveller.address, BRIDGE], chain: null }));
    });
    state.done.funded = true; saveState(state);
  }

  // The ASP postman serves the tree on loopback; Kohaku's sync reads the tree named by the latest on-chain root, so
  // the postman posts a fresh root first (an earlier run's loopback CID is no longer reachable).
  const postman = createPostman({ deployment: d, rpcUrl: RPC, delayMs: 0, batchMs: 60_000, treeUrl: `http://127.0.0.1:${PORTS.asp}/asp/tree?v=1`,
    sendRoot: (root, cid) => withArcLock(() => opArc.writeContract({ address: d.entrypoint, abi: entrypointAbi, functionName: 'updateRoot', args: [root, cid] })),
    onTx: h => void settle('ASP updateRoot', 'arc-testnet', h).catch(e => console.error(e.message)) });
  const aspServer = postman.serve(PORTS.asp);
  const merchantToken = randomBytes(24).toString('hex');
  const relayed: any[] = [];
  const server = createMerchantServer({ deployment: d, rpcUrl: RPC, merchantKey: opKey, merchantToken, dataFile: 'data/live-private/invoices.json', privateRelay: { relayerKey: opKey, feeBps: RELAY_FEE_BPS, onRelayed: r => relayed.push(r) } });
  try {
    await new Promise<void>(ok => server.listen(PORTS.server, '127.0.0.1', ok));
    if (!state.done.arrived) await postman.tick(true);
  // 2. The precommitment, computed client-side by the traveller's Kohaku account.
  const customer = createCustomer({ deployment: d, rpcUrl: RPC, aspUrl: `http://127.0.0.1:${PORTS.asp}`, storage: fileStorage('kohaku'),
    deriveAt: async path => keccak256(concatHex([k.travellerSeed, keccak256(toBytes(path))])) }); // same derivation as packages/web/src/wallet.ts
  if (!state.done.precommitment) { state.done.precommitment = (await customer.nextPrecommitment()).toString(); saveState(state); }
  const precommitment = BigInt(state.done.precommitment);
  say(`precommitment for the traveller's next deposit (client-side): ${precommitment.toString().slice(0, 12)}…`);

  // 3. Burn on the source chain with a SHIELD hook.
  if (!state.done.burn) {
    const b = await bridgeToArc({ fromChain: FROM, amount: BRIDGE, recipient: traveller.address, hook: dep.NorenArcHook, walletClient: travSrc, waitForMint: false,
      action: { kind: 'shield', precommitment, ref: 'noren-arrive-private' }, onStatus: s => s.step === 'approving' || s.step === 'burned' ? say(`${s.step} ${(s as any).url}`) : undefined });
    if (b.approveTxHash) state.steps.push({ step: 'traveller approves TokenMessengerV2', chain: FROM, tx: b.approveTxHash, url: txUrl(FROM, b.approveTxHash), from: traveller.address, gasUsed: '', block: '' });
    const r = await settle('burn 2.00 USDC with SHIELD hook (depositForBurnWithHook)', FROM, b.burnTxHash, `fast transfer, maxFee ${b.maxFee} USDC units`);
    state.done.burn = { tx: b.burnTxHash, hookData: b.hookData, maxFee: b.maxFee.toString(), block: r.blockNumber.toString() }; saveState(state);
  }

  // 4. Circle's attestation, then the relay into the privacy hook on Arc.
  if (!state.done.arrived) {
    const burnTx = state.done.burn.tx as Hex;
    const att = await waitForAttestation(src, burnTx, Date.now() + 40 * 60_000, 4000, s => say(`iris ${jsonBigints(s)}`));
    say('Circle attestation complete');
    let arcTx: Hex | undefined;
    if (relayMode === 'cre') {
      const receipt = await srcClient.getTransactionReceipt({ hash: burnTx });
      const MESSAGE_SENT = keccak256(toHex('MessageSent(bytes)'));
      const eventIndex = receipt.logs.findIndex((l: any) => l.address.toLowerCase() === src.messageTransmitter.toLowerCase() && l.topics[0] === MESSAGE_SENT);
      const cfg = JSON.parse(readFileSync(resolve('packages/cctp/cre/cctp-relay/config.privacy.json'), 'utf8'));
      const triggerIndex = cfg.sources.findIndex((s: any) => s.key === FROM);
      const log = await withArcLock(async () => {
        try {
          return execFileSync('cre', ['workflow', 'simulate', 'cctp-relay', '--target', 'privacy-settings', '--non-interactive', '--trigger-index', String(triggerIndex), '--evm-tx-hash', burnTx, '--evm-event-index', String(eventIndex), '--broadcast'],
            { cwd: resolve('packages/cctp/cre'), encoding: 'utf8', env: { ...process.env, CRE_ETH_PRIVATE_KEY: opKey.slice(2) }, maxBuffer: 1 << 24 });
        } catch (e: any) {
          const out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
          throw new Error(`cre workflow simulate failed:\n${out.split('\n').filter(l => /USER LOG|✗|rror/.test(l)).join('\n')}`);
        }
      });
      const lines = log.split('\n').filter(l => /\[USER LOG\]/.test(l)).map(l => l.trim());
      for (const l of lines) say(`cre | ${l}`);
      state.done.creLog = lines;
      arcTx = (log.match(/through NorenArcHook: tx (0x[0-9a-f]{64})/) ?? [])[1] as Hex | undefined;
      if (!arcTx) throw new Error('the CRE relay did not write on Arc');
    } else {
      arcTx = await withArcLock(async () => opArc.writeContract({ address: dep.NorenArcHook, abi: hookAbi, functionName: 'relay', args: [att.message, att.attestation] }));
    }
    const r = await settle(relayMode === 'cre' ? 'CRE relay -> NorenArcHook.onReport -> SHIELD' : 'NorenArcHook.relay -> SHIELD', 'arc-testnet', arcTx!);
    const hookEvents = decodeAll(r.logs, hookAbi, dep.NorenArcHook!), sinkEvents = decodeAll(r.logs, sinkAbi, dep.NorenShieldSink!), poolEvents = decodeAll(r.logs, poolAbi, d.pool);
    const shielded = sinkEvents.find(e => e.event === 'Shielded'), deposited = poolEvents.find(e => e.event === 'Deposited');
    if (!shielded || !deposited) throw new Error(`no Shielded/Deposited in ${txLink(arcTx!)}: ${jsonBigints([...hookEvents, ...sinkEvents])}`);
    if (BigInt(shielded.args.precommitment) !== precommitment) throw new Error('shielded under a different precommitment');
    state.done.arrived = { arcTx, viaCre: hookEvents.find(e => e.event === 'Bridged')?.args.viaCre, minted: shielded.args.amount.toString(), commitment: shielded.args.commitment.toString(), label: deposited.args.label.toString(), depositor: deposited.args.depositor, events: JSON.parse(jsonBigints([...hookEvents, ...sinkEvents, ...poolEvents])) };
    saveState(state);
    say(`arrived private: ${formatUnits(BigInt(shielded.args.amount), 6)} USDC in the pool, depositor ${deposited.args.depositor} (the sink); traveller's public Arc USDC: ${formatUnits(await arcUsdc(traveller.address), 6)}`);
  }

  // 5. Compliance screening on the source chain, then the ASP approves the label and posts a root.
  state.done.screening ??= {
    sourceChainUsdcIsBlacklisted: await srcClient.readContract({ address: src.usdc, abi: usdcAbi, functionName: 'isBlacklisted', args: [traveller.address] }),
    arcUsdcIsBlacklisted: await arc.readContract({ address: d.usdc, abi: usdcAbi, functionName: 'isBlacklisted', args: [traveller.address] }),
    depositorScreenedByAsp: state.done.arrived.depositor,
  };
  saveState(state);
  if (state.done.screening.sourceChainUsdcIsBlacklisted || state.done.screening.arcUsdcIsBlacklisted) throw new Error('traveller is on USDC\'s blocklist: the ASP must not approve this deposit');
    const base = `http://127.0.0.1:${PORTS.server}`;
    const post = async (path: string, value: unknown) => { const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: jsonBigints(value) }); const j = await r.json(); if (!r.ok) throw new Error(`${path}: ${j.error}`); return j; };
    const spendable = async () => (await customer.balance() as any[]).filter(x => !x.tag).reduce((s, x) => s + BigInt(x.amount), 0n);
    for (let i = 0; ; i++) {
      await postman.tick(true);
      const bal = await spendable();
      if (bal > 0n) { say(`ASP approved the arrival; spendable private balance ${formatUnits(bal, 6)} USDC`); state.done.aspApproved ??= { spendable: bal.toString() }; saveState(state); break; }
      if (i === 30) throw new Error('arrival not approved after 30 ASP ticks');
      await new Promise(r => setTimeout(r, 3000));
    }

    // 6. Pay a Noren invoice privately from the arrived balance.
    if (!state.done.paid) {
      const noren = createNoren({ server: base, token: merchantToken, merchant: operator.address });
      const payout = await arc.readContract({ address: d.checkout, abi: checkoutAbi, functionName: 'merchantPayout', args: [operator.address] }) as Address;
      if (/^0x0{40}$/.test(payout)) throw new Error('Setup required: the operator is not a registered merchant (run scripts/live/e2e-live.ts)');
      const created = await noren.invoices.create({ amount: INVOICE, expiresIn: 3600, description: 'Arrive private: paid from a CCTP SHIELD arrival' });
      const refund = await customer.refundInbox();
      const opening = customer.createReceipt();
      const bound = await post(`/invoices/${created.invoice.invoiceId}/bind`, { refundPrecommitment: refund.nextPrecommitment, receiptCommitment: opening.commitment });
      const invoice = { ...bound.invoice, amount: BigInt(bound.invoice.amount), expiry: BigInt(bound.invoice.expiry), refundPrecommitment: BigInt(bound.invoice.refundPrecommitment) } as Invoice;
      await customer.rememberReceipt(invoice, opening);
      const p0 = performance.now(); const proof = await customer.proveInvoicePayment(invoice); const secs = (performance.now() - p0) / 1000;
      say(`invoice ${invoice.invoiceId.slice(0, 10)}… bound; payment proof in ${secs.toFixed(2)} s`);
      const before = await arcUsdc(payout);
      const paid = await withArcLock(() => post(`/invoices/${invoice.invoiceId}/pay`, proof)); // the server signs with the shared operator key
      const r = await settle('pay 0.75 USDC invoice privately (NorenCheckout.pay)', 'arc-testnet', paid.paymentTx, `relayed by the merchant server; proof ${secs.toFixed(2)} s`);
      const gained = (await arcUsdc(payout)) - before;
      if (gained !== INVOICE) throw new Error(`payout gained ${formatUnits(gained, 6)}, expected 0.75`);
      const ev = decodeAll(r.logs, checkoutAbi, d.checkout).find(e => e.event === 'Paid');
      if (!ev) throw new Error('no Paid event');
      state.done.paid = { tx: paid.paymentTx, invoiceId: invoice.invoiceId, payout, payoutGained: gained.toString(), proveSeconds: Number(secs.toFixed(2)), travellerVisible: await appearsIn(arc, paid.paymentTx, traveller.address) };
      saveState(state);
    }

    // 7. Send privately to a friend through Noren's relayer.
    if (!state.done.sent) {
      const q = await (await fetch(`${base}/private/relayer`)).json();
      const p0 = performance.now();
      const s = await customer.proveRelayedSend({ recipient: friend, amount: P2P, feeRecipient: q.feeRecipient, relayFeeBps: BigInt(q.feeBps) });
      const secs = (performance.now() - p0) / 1000;
      say(`relayed-send proof in ${secs.toFixed(2)} s (fee ${q.feeBps} bps to relayer ${q.relayer})`);
      const before = await arcUsdc(friend);
      const sent = await withArcLock(() => post('/private/send', s)); // the relayer is the shared operator key
      const r = await settle('send 0.50 USDC privately to a friend (Entrypoint.relay)', 'arc-testnet', sent.tx, `relayed by the Noren server; fee ${q.feeBps} bps`);
      const ev = decodeAll(r.logs, relayAbi, d.entrypoint).find(e => e.event === 'WithdrawalRelayed');
      const gained = (await arcUsdc(friend)) - before;
      if (!ev || gained !== BigInt(sent.received)) throw new Error(`friend gained ${gained}, expected ${sent.received}`);
      state.done.sent = { tx: sent.tx, friend, amount: P2P.toString(), received: gained.toString(), fee: sent.fee, proveSeconds: Number(secs.toFixed(2)), travellerVisible: await appearsIn(arc, sent.tx, traveller.address) };
      saveState(state);
    }
    const left = await spendable();
    state.done.end = { privateBalanceLeft: left.toString(), travellerArcUsdc: (await arcUsdc(traveller.address)).toString(), operatorArc: (await arcUsdc(operator.address)).toString(), operatorSrc: (await srcUsdc(operator.address)).toString(), at: new Date().toISOString() };
    saveState(state);
    say(`private balance left: ${formatUnits(left, 6)} USDC; traveller public Arc USDC: ${formatUnits(BigInt(state.done.end.travellerArcUsdc), 6)}`);
    say(`traveller visible in the payment tx: ${jsonBigints(state.done.paid.travellerVisible)}; in the P2P send: ${jsonBigints(state.done.sent.travellerVisible)}`);
    writeFileSync(resolve('scripts/live/private-runs.json'), jsonBigints({ network: `PUBLIC TESTNETS: ${src.name} (${src.chainId}) -> Arc Testnet (5042002)`, traveller: traveller.address, friend, hook: dep.NorenArcHook, sink: dep.NorenShieldSink, relay: relayMode, steps: state.steps, ...state.done }, ) + '\n');
    say(`done: ${state.steps.length} transactions; record in scripts/live/private-runs.json`);
  } finally {
    await new Promise<void>(r => server.close(() => r()));
    await new Promise<void>(r => aspServer.close(() => r()));
  }
}
if (process.argv[1]?.endsWith('private-live.ts')) main().then(() => process.exit(0)).catch(e => { console.error(e?.shortMessage ?? e?.message ?? e); console.error(String(e?.stack ?? '').split('\n').slice(1, 6).join('\n')); process.exit(1); });
