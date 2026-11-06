// 1inch Aqua + SwapVM LIVE on the PUBLIC Arc Testnet (5042002). Every step sends real transactions.
//
//   bash scripts/live/aqua-build-official.sh                        # once: build 1inch Aqua v1.0.0 from the pinned commit
//   (cd packages/aqua/swapvm-ext && forge build)                     # once: the Noren SwapVM router artifact
//   (cd packages/xchain-aqua/contracts && forge build)
//   pnpm exec tsx scripts/live/aqua-live.ts deploy                   # Aqua, router, oracle feeds, settler, route, aquaOperator
//   pnpm exec tsx scripts/live/aqua-live.ts maker                    # the maker ships + registers its USDC -> EURC strategy
//   pnpm exec tsx scripts/live/aqua-live.ts swap 0.5                 # a direct on-Arc Aqua swap (customer: USDC -> EURC)
//   pnpm exec tsx scripts/live/aqua-live.ts xchain arbitrum-sepolia 2 # CCTP V2 burn with an AQUA_ORDER hook -> CRE relay ->
//                                                                    #   router -> CRE ROUTER_ORDER -> Aqua fill (EURC on Arc)
//   pnpm exec tsx scripts/live/aqua-live.ts status
//
// Keys: NOREN_DEPLOYER_KEY from the main checkout's gitignored .env.arc-deployer (owner, maker, source-chain burner) and
// the customer key from .keys-live-arc.json (taker / EURC recipient). Neither is ever printed. CRE gets the key only
// through a temporary 0600 env file that is deleted after the run, and its output is scrubbed before it is saved.
// Every batch of deployer transactions runs under the shared lock /private/tmp/noren-arc-deployer.lock; viem uses the
// pending nonce. State and every tx: packages/xchain-aqua/live/arc-testnet.json (resumable; finished steps never repeat).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  concat, createPublicClient, createWalletClient, decodeEventLog, defineChain, encodeAbiParameters, erc20Abi, formatUnits, getCreate2Address,
  http, keccak256, parseAbi, parseUnits, stringToHex, toHex, type Address, type Hex, type Log,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bridgeToArc, waitForAttestation } from "../../packages/cctp/sdk/bridge.ts";
import { CCTP_CHAINS, txUrl, type SourceChainKey } from "../../packages/cctp/sdk/chains.ts";
import { loadKey, walletFor, withArcLock } from "../../packages/cctp/scripts/lib.ts";
import { encodeAquaOrderAction } from "../../packages/xchain-aqua/sdk/index.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const CFG = JSON.parse(readFileSync(join(ROOT, "packages/xchain-aqua/live/config.json"), "utf8"));
const STATE_FILE = join(ROOT, "packages/xchain-aqua/live/arc-testnet.json");
const MAIN = "/Volumes/Extreme SSD/Projects/grokbot/projects/noren";
const EXPLORER = CFG.explorer as string;
const tx = (h: string) => `${EXPLORER}/tx/${h}`;
const addr = (a: string) => `${EXPLORER}/address/${a}`;
const say = (s: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);

const arc = defineChain({ id: 5042002, name: "Arc Testnet", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [CFG.rpc] } } });
const pub = createPublicClient({ chain: arc, transport: http(CFG.rpc, { retryCount: 5 }) });
const deployerKey = loadKey();
const deployer = privateKeyToAccount(deployerKey);
if (deployer.address.toLowerCase() !== (CFG.owner as string).toLowerCase()) throw new Error(`NOREN_DEPLOYER_KEY is ${deployer.address}, config.owner is ${CFG.owner}`);
const wallet = createWalletClient({ chain: arc, account: deployer, transport: http(CFG.rpc) });
const customerKey = (): Hex => {
  const f = join(MAIN, ".keys-live-arc.json");
  if (!existsSync(f)) throw new Error(`Setup required: ${f} (customerKey, made by scripts/live/e2e-live.ts)`);
  const k = JSON.parse(readFileSync(f, "utf8")).customerKey as string | undefined;
  if (!k || !/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error(`Setup required: customerKey in ${f}`);
  return k as Hex;
};

type Rec = { label: string; hash: Hex; url: string; gasUsed: string; block: string; events?: unknown[] };
const state: any = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
state.network ??= "Arc Testnet (5042002), PUBLIC. Real transactions; every hash below exists on explorer.testnet.arc.io.";
state.contracts ??= {};
state.txs ??= [];
const save = () => writeFileSync(STATE_FILE, `${JSON.stringify(state, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`);

// ------------------------------------------------------------------ ABIs
const artifact = (p: string) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));
const A_AQUA = "packages/aqua/aqua-official/build/out/AquaRouter.sol/AquaRouter.json";
const A_ROUTER = "packages/aqua/swapvm-ext/out/NorenAquaSwapVMRouter.sol/NorenAquaSwapVMRouter.json";
const A_FEED = "packages/xchain-aqua/contracts/out/NorenRateOracleFeed.sol/NorenRateOracleFeed.json";
const A_SETTLER = "packages/xchain-aqua/contracts/out/NorenCrossChainSettler.sol/NorenCrossChainSettler.json";
const settlerAbi = () => artifact(A_SETTLER).abi;
const routerAbi = () => artifact(A_ROUTER).abi;
const aquaAbi = parseAbi([
  "function ship(address app, bytes strategy, address[] tokens, uint256[] amounts) returns (bytes32)",
  "function rawBalances(address maker, address app, bytes32 strategyHash, address token) view returns (uint248 balance, uint8 tokensCount)",
  "function owner() view returns (address)",
]);
const actionRouterAbi = parseAbi([
  "function setAquaOperator(address operator)",
  "function aquaOperator() view returns (address)",
  "function owner() view returns (address)",
  "function aquaOrders(bytes32 ref) view returns (address beneficiary, address token, uint256 amount, bytes32 rail, uint64 source, bool open, bytes params)",
  "event AquaOrderOpened(bytes32 indexed ref, address indexed beneficiary, address token, uint256 amount, bytes32 rail, uint64 source, bytes params)",
  "event AquaOrderClosed(bytes32 indexed ref, address indexed to, uint256 amount, bool filled)",
  "event ActionExecuted(bytes32 indexed rail, bytes32 indexed msgId, uint8 indexed kind, address beneficiary, bytes32 ref, address token, uint256 amount, bool ok)",
]);
const oracleAbi = parseAbi(["function rateE18(string currency) view returns (uint256)"]);

// ------------------------------------------------------------------ tx helpers
const decodeAll = (logs: Log[]) => {
  const abis = [settlerAbi(), routerAbi(), actionRouterAbi, erc20Abi, aquaAbi];
  return logs.flatMap((l) => {
    for (const abi of abis) {
      try {
        const d = decodeEventLog({ abi, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
        return [{ address: l.address, event: d.eventName, args: d.args }];
      } catch { /* next */ }
    }
    return [];
  });
};

async function send(label: string, hash: Hex): Promise<Rec & { contractAddress?: Address | null; logs: Log[] }> {
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (r.status !== "success") throw new Error(`${label} reverted: ${tx(hash)}`);
  const rec: Rec = { label, hash, url: tx(hash), gasUsed: r.gasUsed.toString(), block: r.blockNumber.toString(), events: decodeAll(r.logs) };
  state.txs.push(rec);
  save();
  say(`${label.padEnd(46)} ${tx(hash)}`);
  return { ...rec, contractAddress: r.contractAddress, logs: r.logs };
}

const write = async (label: string, address: Address, abi: any, functionName: string, args: unknown[], account = deployer) => {
  const w = account === deployer ? wallet : createWalletClient({ chain: arc, account, transport: http(CFG.rpc) });
  const { request } = await pub.simulateContract({ account, address, abi, functionName, args } as any);
  return send(label, await w.writeContract(request as any));
};

const CREATE2 = CFG.create2Deployer as Address;
async function create2(label: string, salt: Hex, initcode: Hex): Promise<{ address: Address; tx: Hex | null }> {
  const address = getCreate2Address({ from: CREATE2, salt, bytecodeHash: keccak256(initcode) });
  const existing = await pub.getCode({ address });
  if (existing && existing !== "0x") return { address, tx: null };
  const r = await send(label, await wallet.sendTransaction({ to: CREATE2, data: concat([salt, initcode]) }));
  const code = await pub.getCode({ address });
  if (!code || code === "0x") throw new Error(`${label}: no code at ${address} after ${tx(r.hash)}`);
  return { address, tx: r.hash };
}
async function deployNew(label: string, path: string, args: unknown[]): Promise<{ address: Address; tx: Hex }> {
  const a = artifact(path);
  const r = await send(label, await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args }));
  if (!r.contractAddress) throw new Error(`${label}: no contract address`);
  return { address: r.contractAddress, tx: r.hash };
}
const record = (key: string, name: string, v: { address: Address; tx: Hex | null }, note?: string) => {
  state.contracts[key] = { name, address: v.address, url: addr(v.address), deployTx: v.tx, deployUrl: v.tx ? tx(v.tx) : null, ...(note ? { note } : {}) };
  save();
};

const balances = async (who: Address) => {
  const [usdc, eurc] = await Promise.all([CFG.usdc, CFG.eurc].map((t) => pub.readContract({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [who] })));
  return { usdc, eurc };
};
const fmt = (v: bigint) => formatUnits(v, 6);

// ------------------------------------------------------------------ steps
async function deploy() {
  const c = state.contracts;
  await withArcLock(async () => {
    if (!c.aqua) {
      const initcode = concat([artifact(A_AQUA).bytecode.object, encodeAbiParameters([{ type: "address" }], [deployer.address])]);
      const v = await create2("deploy 1inch Aqua v1.0.0 (unmodified, CREATE2)", keccak256(stringToHex(CFG.aquaSalt)), initcode);
      record("aqua", "1inch Aqua registry (AquaRouter v1.0.0, 81c26e4, unmodified)", v, "Rescuable owner = deployer (can only rescue tokens sent to the registry contract itself)");
    }
    if (!c.swapVmRouter) {
      const args = encodeAbiParameters(
        [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "string" }, { type: "string" }],
        [c.aqua.address, "0x0000000000000000000000000000000000000000", deployer.address, CFG.routerName, CFG.routerVersion],
      );
      const v = await create2("deploy NorenAquaSwapVMRouter (CREATE2)", keccak256(stringToHex(CFG.routerSalt)), concat([artifact(A_ROUTER).bytecode.object, args]));
      record("swapVmRouter", "NorenAquaSwapVMRouter: SwapVM v1.0.2 AquaOpcodes + NorenOraclePeg (opcode 34), modified redeploy", v);
    }
    if (!c.eurUsdFeed) record("eurUsdFeed", "NorenRateOracleFeed EUR/USD leg", await deployNew("deploy NorenRateOracleFeed (EUR/USD)", A_FEED, [CFG.rateOracle, "EUR", 0]));
    if (!c.usdcUsdFeed) record("usdcUsdFeed", "NorenRateOracleFeed USDC/USD leg", await deployNew("deploy NorenRateOracleFeed (USDC/USD)", A_FEED, [CFG.rateOracle, "EUR", 1]));
    if (!c.settler) {
      record("settler", "NorenCrossChainSettler (the Aqua order settler on Arc)",
        await deployNew("deploy NorenCrossChainSettler", A_SETTLER, [deployer.address, CFG.creForwarder, c.aqua.address, c.swapVmRouter.address]));
    }
    const S = c.settler.address as Address;
    const key = (await pub.readContract({ address: S, abi: settlerAbi(), functionName: "routeKey", args: [0n, CFG.usdc, CFG.eurc] })) as Hex;
    state.routeKey = key;
    const route = (await pub.readContract({ address: S, abi: settlerAbi(), functionName: "route", args: [key] })) as any;
    if (!route.enabled) {
      await write("settler.setRoute(USDC -> EURC, NorenRateOracle feeds)", S, settlerAbi(), "setRoute", [0n, CFG.usdc, {
        inToken: CFG.usdc, outToken: CFG.eurc, delivered: true, takerSellsBase: false,
        baseFeed: c.eurUsdFeed.address, relayed: false, quoteFeed: c.usdcUsdFeed.address,
        baseMaxAgeOpen: CFG.route.baseMaxAgeOpen, baseMaxAgeClosed: CFG.route.baseMaxAgeClosed, quoteMaxAge: CFG.route.quoteMaxAge,
        quoteMaxDepegBps: CFG.route.quoteMaxDepegBps, flags: CFG.route.flags, enabled: true,
      }]);
    }
    if (!(await pub.readContract({ address: S, abi: settlerAbi(), functionName: "transports", args: [CFG.actionRouter] }))) {
      await write("settler.setTransport(live NorenArcActionRouter)", S, settlerAbi(), "setTransport", [CFG.actionRouter, true]);
    }
    const op = await pub.readContract({ address: CFG.actionRouter, abi: actionRouterAbi, functionName: "aquaOperator" });
    if (op.toLowerCase() !== S.toLowerCase()) {
      await write("NorenArcActionRouter.setAquaOperator(settler)", CFG.actionRouter, actionRouterAbi, "setAquaOperator", [S]);
    }
  });
  await verify();
  writeCreConfig();
}

/** Re-checks the deployed Aqua runtime against Arc mainnet's official code (all but the metadata hash). */
async function verify() {
  const ours = (await pub.getCode({ address: state.contracts.aqua.address }))!.toLowerCase();
  const mainnet = createPublicClient({ transport: http(process.env.ARC_MAINNET_RPC ?? "https://arc-rpc.publicnode.com") });
  const official = (await mainnet.getCode({ address: "0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a" }))!.toLowerCase();
  const m = (h: string) => h.lastIndexOf("a264697066735822");
  const same = ours.length === official.length && m(ours) === m(official) && ours.slice(0, m(ours)) === official.slice(0, m(official));
  if (!same) throw new Error("deployed Aqua runtime differs from Arc mainnet's official code");
  const router = state.contracts.swapVmRouter.address as Address;
  const [aq, op, name] = await Promise.all([
    pub.readContract({ address: router, abi: routerAbi(), functionName: "AQUA" }),
    pub.readContract({ address: router, abi: routerAbi(), functionName: "NOREN_ORACLE_PEG_OPCODE" }),
    pub.readContract({ address: router, abi: routerAbi(), functionName: "eip712Domain" }),
  ]) as [Address, number, any];
  state.checks = {
    aquaRuntimeBytes: (ours.length - 2) / 2,
    aquaCodehash: keccak256(ours as Hex),
    officialArcMainnetCodehash: keccak256(official as Hex),
    aquaExecutableCodeIdenticalToArcMainnet: same,
    routerAqua: aq,
    routerPegOpcode: Number(op),
    routerEip712: { name: name[1], version: name[2] },
    actionRouterAquaOperator: await pub.readContract({ address: CFG.actionRouter, abi: actionRouterAbi, functionName: "aquaOperator" }),
    checkedAt: new Date().toISOString(),
  };
  save();
  say(`verified: Aqua runtime = Arc mainnet official code except metadata (${state.checks.aquaRuntimeBytes} B); router AQUA() = ${aq}, opcode ${op}`);
}

function writeCreConfig() {
  const f = join(ROOT, "packages/xchain-aqua/cre/xchain-aqua/config.arc-live.json");
  const cfg = {
    chains: [{ name: "arc", chainSelectorName: "arc-testnet", chainId: 5042002, escrow: "0x0000000000000000000000000000000000000000", settler: state.contracts.settler.address, actionRouter: CFG.actionRouter, gasLimit: "3000000" }],
    maxPriceAgeSec: 259200,
    confidence: "SAFE",
  };
  writeFileSync(f, `${JSON.stringify(cfg, null, 2)}\n`);
}

async function maker() {
  const S = state.contracts.settler.address as Address;
  const terms = { bidSpreadBps: 0, askSpreadBps: CFG.terms.askSpreadBps, closedExtraBps: CFG.terms.closedExtraBps, minPriceUsd8: BigInt(CFG.terms.minPriceUsd8), maxPriceUsd8: BigInt(CFG.terms.maxPriceUsd8), salt: BigInt(CFG.terms.salt) };
  const [order, hash] = (await pub.readContract({ address: S, abi: settlerAbi(), functionName: "buildOrder", args: [deployer.address, state.routeKey, terms] })) as [any, Hex];
  state.maker = { address: deployer.address, strategyHash: hash, terms: { ...terms, minPriceUsd8: terms.minPriceUsd8.toString(), maxPriceUsd8: terms.maxPriceUsd8.toString(), salt: terms.salt.toString() }, eurcAllocation: CFG.eurcAllocation };
  save();
  const b = await balances(deployer.address);
  if (b.eurc < BigInt(CFG.eurcAllocation)) throw new Error(`Setup required: maker ${deployer.address} holds ${fmt(b.eurc)} EURC on Arc Testnet; needs ${fmt(BigInt(CFG.eurcAllocation))} (faucet.circle.com -> Arc Testnet -> EURC)`);
  await withArcLock(async () => {
    const allowance = await pub.readContract({ address: CFG.eurc, abi: erc20Abi, functionName: "allowance", args: [deployer.address, state.contracts.aqua.address] });
    if (allowance < BigInt(CFG.eurcAllocation)) await write("maker approves Aqua for EURC", CFG.eurc, erc20Abi, "approve", [state.contracts.aqua.address, BigInt(CFG.eurcAllocation) * 4n]);
    const [bal] = await pub.readContract({ address: state.contracts.aqua.address, abi: aquaAbi, functionName: "rawBalances", args: [deployer.address, state.contracts.swapVmRouter.address, hash, CFG.eurc] });
    if (bal === 0n) {
      const r = await write(`maker Aqua.ship(USDC -> EURC, ${fmt(BigInt(CFG.eurcAllocation))} EURC)`, state.contracts.aqua.address, aquaAbi, "ship",
        [state.contracts.swapVmRouter.address, encodeAbiParameters([{ type: "tuple", components: [{ name: "maker", type: "address" }, { name: "traits", type: "uint256" }, { name: "data", type: "bytes" }] }], [order]), [CFG.usdc, CFG.eurc], [0n, BigInt(CFG.eurcAllocation)]]);
      state.maker.shipTx = r.hash;
    }
    const s = (await pub.readContract({ address: S, abi: settlerAbi(), functionName: "strategy", args: [hash] })) as any;
    if (!s.active) state.maker.registerTx = (await write("maker settler.register(strategy)", S, settlerAbi(), "register", [state.routeKey, terms, "0x0000000000000000000000000000000000000000"])).hash;
  });
  save();
  say(`maker strategy ${hash}: ${fmt(BigInt(CFG.eurcAllocation))} EURC allocated from the maker wallet (${fmt(b.eurc)} EURC held)`);
}

const strategyOrder = async () => (await pub.readContract({ address: state.contracts.settler.address, abi: settlerAbi(), functionName: "strategyOrder", args: [state.maker.strategyHash] })) as any;

/** EURC out for usdcIn at the live oracle rate plus the maker's ask (closed-window extra on weekends). */
async function expectedEurc(usdcIn: bigint) {
  const rate = await pub.readContract({ address: CFG.rateOracle, abi: oracleAbi, functionName: "rateE18", args: ["EUR"] });
  const now = BigInt(Math.floor(Date.now() / 1000));
  const day = Number((now / 86400n + 4n) % 7n);
  const closed = day === 6 || day === 0 || (day === 1 && Number(now % 86400n) < 6 * 3600);
  const ask = BigInt(CFG.terms.askSpreadBps + (closed ? CFG.terms.closedExtraBps : 0));
  return { rate, ask, out: (usdcIn * 10n ** 18n * 10_000n) / (rate * (10_000n + ask)) };
}

async function swap(amount: string) {
  const usdcIn = parseUnits(amount, 6);
  const customer = privateKeyToAccount(customerKey());
  const label = `direct-${usdcIn}`;
  state.swaps ??= {};
  if (state.swaps[label]?.swapTx) return say(`swap ${label} already done: ${state.swaps[label].swapUrl}`);
  const before = { customer: await balances(customer.address), maker: await balances(deployer.address) };
  if (before.customer.usdc < usdcIn + 50_000n) throw new Error(`Setup required: customer ${customer.address} holds ${fmt(before.customer.usdc)} USDC; needs ${amount} + gas`);
  const q = await expectedEurc(usdcIn);
  const minOut = (q.out * 99n) / 100n;
  const S = state.contracts.settler.address as Address;
  const takerData = (await pub.readContract({ address: S, abi: settlerAbi(), functionName: "takerData", args: [minOut, customer.address] })) as Hex;
  const order = await strategyOrder();
  const router = state.contracts.swapVmRouter.address as Address;
  const cw = createWalletClient({ chain: arc, account: customer, transport: http(CFG.rpc) });
  const allowance = await pub.readContract({ address: CFG.usdc, abi: erc20Abi, functionName: "allowance", args: [customer.address, router] });
  const approve = allowance < usdcIn ? await write("customer approves the SwapVM router for USDC", CFG.usdc, erc20Abi, "approve", [router, usdcIn], customer) : null;
  const { request, result } = await pub.simulateContract({ account: customer, address: router, abi: routerAbi(), functionName: "swap", args: [order, CFG.usdc, CFG.eurc, usdcIn, takerData] });
  const r = await send(`customer SwapVM swap ${amount} USDC -> EURC (Aqua)`, await cw.writeContract(request as any));
  const after = { customer: await balances(customer.address), maker: await balances(deployer.address) };
  state.swaps[label] = {
    taker: customer.address, maker: deployer.address, usdcIn: usdcIn.toString(), eurcOut: (result as any)[1].toString(), quotedEurc: q.out.toString(), rateE18: q.rate.toString(), askBps: q.ask.toString(),
    approveTx: approve?.hash ?? null, swapTx: r.hash, swapUrl: r.url,
    deltas: { customerEurc: (after.customer.eurc - before.customer.eurc).toString(), makerEurc: (after.maker.eurc - before.maker.eurc).toString(), makerUsdc: (after.maker.usdc - before.maker.usdc).toString() },
  };
  save();
  say(`direct swap: customer ${fmt(usdcIn)} USDC -> ${fmt(after.customer.eurc - before.customer.eurc)} EURC (quote ${fmt(q.out)}); maker EURC ${fmt(after.maker.eurc - before.maker.eurc)}`);
}

/** Runs `cre workflow simulate --broadcast`; the key reaches the CLI only through a temporary 0600 env file. */
function cre(projectDir: string, workflow: string, target: string, args: string[], logName: string): string {
  const dir = mkdtempSync(join(tmpdir(), "noren-aqua-cre-"));
  const envFile = join(dir, "cre.env");
  try {
    writeFileSync(envFile, `CRE_ETH_PRIVATE_KEY=${deployerKey.slice(2)}\n`, { mode: 0o600 });
    const run = spawnSync("cre", ["workflow", "simulate", workflow, "--target", target, "--non-interactive", "-e", envFile, ...args],
      { cwd: join(ROOT, projectDir), encoding: "utf8", maxBuffer: 1 << 24, timeout: 300_000 });
    const k = deployerKey.slice(2);
    const out = `${run.stdout ?? ""}${run.stderr ?? ""}`.split(k).join("[redacted]").split(k.toLowerCase()).join("[redacted]");
    writeFileSync(join(ROOT, "packages/xchain-aqua/live", `${logName}.log`), out);
    for (const line of out.split("\n")) if (/\[USER LOG\]/.test(line)) say(`  cre | ${line.replace(/.*\[USER LOG\]\s*/, "").trim()}`);
    if (run.status !== 0) throw new Error(`cre workflow simulate ${workflow} exited ${run.status}; see packages/xchain-aqua/live/${logName}.log`);
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function xchain(from: SourceChainKey, amount: string, label = `${from}-${Date.now()}`) {
  const src = CCTP_CHAINS[from];
  if (!src || from === ("arc-testnet" as SourceChainKey)) throw new Error("usage: xchain <sourceChain> <usdc> [label]");
  const customer = privateKeyToAccount(customerKey());
  state.xchain ??= {};
  const run: any = (state.xchain[label] ??= { from, network: `PUBLIC: ${src.name} (${src.chainId}, CCTP domain ${src.domain}) -> Arc Testnet (5042002, domain 26)` });
  const S = state.contracts.settler.address as Address;
  const ref = keccak256(stringToHex(`noren-aqua-live:${label}`));
  run.ref = ref;

  if (!run.burnTx) {
    const usdcIn = parseUnits(amount, 6);
    const q = await expectedEurc(usdcIn);
    const minOut = (q.out * 98n) / 100n; // after Circle's fast fee (~1.3 bps) and rounding, 2% headroom
    const params = encodeAquaOrderAction({
      srcChainId: src.chainId, tokenOut: CFG.eurc, minAmountOut: minOut, recipient: customer.address, maker: deployer.address,
      strategyHash: state.maker.strategyHash, fillDeadline: BigInt(Math.floor(Date.now() / 1000) + 2 * 3600), nonce: BigInt(ref),
    });
    run.order = { tokenOut: CFG.eurc, minAmountOut: minOut.toString(), recipient: customer.address, maker: deployer.address, strategyHash: state.maker.strategyHash, quotedEurcForFullAmount: q.out.toString(), rateE18: q.rate.toString(), askBps: q.ask.toString() };
    const srcWallet = walletFor(from, deployerKey);
    const burn = await withArcLock(() => bridgeToArc({
      fromChain: from, amount, recipient: customer.address, walletClient: srcWallet, waitForMint: false,
      action: { kind: "aqua-order", order: params, beneficiary: customer.address, ref },
      onStatus: (s) => say(`cctp ${s.step}${"url" in s && s.url ? ` ${s.url}` : ""}`),
    }));
    Object.assign(run, { amount: burn.amount.toString(), maxFee: burn.maxFee.toString(), approveTx: burn.approveTxHash, burnTx: burn.burnTxHash, burnUrl: burn.burnUrl, hookData: burn.hookData });
    save();
  }
  say(`source burn ${run.burnUrl}`);

  if (!run.attestation) {
    const att = await waitForAttestation(src, run.burnTx, Date.now() + 30 * 60_000, 4000, (s) => say(`iris ${s.step}`));
    run.attestation = { irisUrl: `https://iris-api-sandbox.circle.com/v2/messages/${src.domain}?transactionHash=${run.burnTx}`, message: att.message, attestation: att.attestation, attestedAt: new Date().toISOString() };
    save();
  }
  say("Circle attestation complete");

  if (!run.arcMintTx) {
    const srcPub = createPublicClient({ transport: http(src.rpcUrl) });
    const receipt = await srcPub.getTransactionReceipt({ hash: run.burnTx });
    const MESSAGE_SENT = keccak256(toHex("MessageSent(bytes)"));
    const idx = receipt.logs.findIndex((l) => l.address.toLowerCase() === src.messageTransmitter.toLowerCase() && l.topics[0] === MESSAGE_SENT);
    if (idx < 0) throw new Error("no MessageSent in the burn receipt");
    const relayCfg = JSON.parse(readFileSync(join(ROOT, "packages/cctp/cre/cctp-relay/config.staging.json"), "utf8"));
    const trig = relayCfg.sources.findIndex((s: { key: string }) => s.key === from);
    if (trig < 0) throw new Error(`${from} is not a source of the CCTP CRE relay`);
    const out = await withArcLock(async () => cre("packages/cctp/cre", "cctp-relay", "staging-settings",
      ["--trigger-index", String(trig), "--evm-tx-hash", run.burnTx, "--evm-event-index", String(idx), "--broadcast"], `cre-cctp-relay-${label}`));
    const arcTx = (out.match(/through NorenArcHook: tx (0x[0-9a-f]{64})/) ?? [])[1] as Hex | undefined;
    if (!arcTx) throw new Error("the CCTP CRE relay did not write on Arc (see the log)");
    const r = await send(`CRE relay: Circle mint + NorenArcHook -> router (AQUA_ORDER) [${from}]`, arcTx);
    const opened = (r.events as any[]).find((e) => e.event === "AquaOrderOpened");
    if (!opened) throw new Error(`no AquaOrderOpened in ${tx(arcTx)}`);
    const logIndex = r.logs.findIndex((l) => l.topics[0] === keccak256(toHex("AquaOrderOpened(bytes32,address,address,uint256,bytes32,uint64,bytes)")));
    Object.assign(run, { arcMintTx: arcTx, arcMintUrl: tx(arcTx), minted: opened.args.amount.toString(), aquaOrderOpenedLogIndex: logIndex });
    save();
  }
  say(`Arc mint + hook + AquaOrderOpened ${run.arcMintUrl}`);

  if (!run.fillTx) {
    const before = { customer: await balances(customer.address), maker: await balances(deployer.address) };
    const out = await withArcLock(async () => cre("packages/xchain-aqua/cre", "xchain-aqua", "arc-live-settings",
      ["--trigger-index", "0", "--evm-tx-hash", run.arcMintTx, "--evm-event-index", String(run.aquaOrderOpenedLogIndex), "--broadcast"], `cre-xchain-aqua-${label}`));
    const fillTx = (out.match(/Delivered to arc 0x[0-9a-fA-F]{40}: tx (0x[0-9a-f]{64})/) ?? [])[1] as Hex | undefined;
    if (!fillTx) throw new Error("the xchain-aqua CRE workflow did not write the ROUTER_ORDER report (see the log)");
    const r = await send(`CRE ROUTER_ORDER -> settler: Aqua fill USDC -> EURC [${from}]`, fillTx);
    const filled = (r.events as any[]).find((e) => e.event === "OrderFilled");
    const rejected = (r.events as any[]).find((e) => e.event === "FillRejected");
    if (!filled) throw new Error(`fill rejected in ${tx(fillTx)}: ${rejected ? JSON.stringify(rejected.args) : "no OrderFilled"}`);
    const after = { customer: await balances(customer.address), maker: await balances(deployer.address) };
    Object.assign(run, {
      fillTx, fillUrl: tx(fillTx), orderId: filled.args.orderId, usdcIn: filled.args.amountIn.toString(), eurcOut: filled.args.amountOut.toString(),
      deltas: { customerEurc: (after.customer.eurc - before.customer.eurc).toString(), makerEurc: (after.maker.eurc - before.maker.eurc).toString() },
    });
    save();
  }
  say(`Aqua fill ${run.fillUrl}: ${fmt(BigInt(run.usdcIn))} USDC (from ${from}) -> ${fmt(BigInt(run.eurcOut))} EURC to ${customer.address}`);
}

async function status() {
  const customer = privateKeyToAccount(customerKey());
  const b = { deployer: await balances(deployer.address), customer: await balances(customer.address) };
  console.log(JSON.stringify({ contracts: Object.fromEntries(Object.entries(state.contracts).map(([k, v]: any) => [k, v.address])), strategy: state.maker?.strategyHash,
    deployer: { usdc: fmt(b.deployer.usdc), eurc: fmt(b.deployer.eurc) }, customer: { address: customer.address, usdc: fmt(b.customer.usdc), eurc: fmt(b.customer.eurc) } }, null, 2));
}

const [cmd, ...rest] = process.argv.slice(2);
const steps: Record<string, () => Promise<unknown>> = {
  deploy, verify, maker, status,
  swap: () => swap(rest[0] ?? "0.5"),
  xchain: () => xchain(rest[0] as SourceChainKey, rest[1] ?? "1", rest[2]),
  "cre-config": async () => writeCreConfig(),
};
if (!steps[cmd]) throw new Error(`usage: aqua-live.ts ${Object.keys(steps).join("|")}`);
await steps[cmd]();
