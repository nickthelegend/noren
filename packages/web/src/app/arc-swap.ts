import {
  createPublicClient, createWalletClient, defineChain, encodeAbiParameters, erc20Abi,
  http, parseAbi, zeroAddress, type Address, type Hex, type PublicClient,
} from "viem";
import type { LocalAccount } from "viem/accounts";

export const ARC_SWAP = {
  chainId: 5042002,
  rpc: "https://rpc.testnet.arc.io",
  usdc: "0x3600000000000000000000000000000000000000",
  eurc: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
  uniswap: {
    poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
    quoter: "0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94",
    universalRouter: "0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1",
    permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    fee: 500,
    tickSpacing: 10,
  },
  aqua: {
    router: "0x8717687866f988EEBe3bd1d8999DF820ffD9e295",
    aqua: "0x550CD499f1E2da71527f14d6469364461966895B",
    settler: "0xd9f90e397770faf66b228344af5fe285b349d016",
    oracle: "0xdb828bdcf33ef0a5a32861e4831ff3dd87be831c",
    maker: "0x4B2ACf80Bc6E07bbF5690f0710e25C528cb63F80",
    strategyHash: "0x1c97424c37aecc51258d16f4b0fb2e91f83b5bacb51bf5ed931aae2ecae995d2",
  },
} as const satisfies {
  chainId: 5042002; rpc: string; usdc: Address; eurc: Address;
  uniswap: { poolManager: Address; quoter: Address; universalRouter: Address; permit2: Address; fee: 500; tickSpacing: 10 };
  aqua: { router: Address; aqua: Address; settler: Address; oracle: Address; maker: Address; strategyHash: Hex };
};

export type ArcRoute =
  | { id: "uniswap" | "aqua"; out: bigint; detail: string; source?: "simulated" | "oracle" }
  | { id: "uniswap" | "aqua"; error: string };
export type ArcQuote = {
  at: number; amountIn: bigint; routes: ArcRoute[];
  best: (ArcRoute & { out: bigint }) | null;
  fairEurc: bigint | null;
};

const chain = defineChain({
  id: ARC_SWAP.chainId, name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [ARC_SWAP.rpc] } },
});
const client = createPublicClient({ chain, transport: http(ARC_SWAP.rpc) });
export function arcPublicClient(): PublicClient { return client; }

const poolKey = {
  currency0: ARC_SWAP.usdc, currency1: ARC_SWAP.eurc,
  fee: ARC_SWAP.uniswap.fee, tickSpacing: ARC_SWAP.uniswap.tickSpacing, hooks: zeroAddress,
} as const;
const quoterAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }",
  "function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)",
]);
const routerAbi = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);
const permit2Abi = parseAbi([
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
]);
const aquaAbi = parseAbi([
  "function rawBalances(address maker, address app, bytes32 strategyHash, address token) view returns (uint248 balance, uint8 tokensCount)",
]);
const settlerAbi = parseAbi([
  "function strategyOrder(bytes32 strategyHash) view returns ((address maker, uint256 traits, bytes data))",
  "function takerData(uint256 minAmountOut, address recipient) pure returns (bytes)",
]);
const swapVmAbi = parseAbi([
  "function swap((address maker, uint256 traits, bytes data) order, address tokenIn, address tokenOut, uint256 amount, bytes takerTraitsAndData) returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash)",
]);
const oracleAbi = parseAbi([
  "function rateE18(string currency) view returns (uint256)",
  "function latestRate(string currency) view returns ((uint128 fiatUsdAnswer, uint128 usdcUsdAnswer, uint80 fiatUsdRoundId, uint80 usdcUsdRoundId, uint64 fiatUsdUpdatedAt, uint8 fiatUsdDecimals, uint8 usdcUsdDecimals, uint8 fiatMinorDecimals, uint64 usdcUsdUpdatedAt, uint64 sourceBlock, uint64 recordedAt))",
]);

const shortError = (error: unknown): string => {
  const e = error as { shortMessage?: string; message?: string };
  return (e?.shortMessage ?? e?.message ?? String(error)).split("\n")[0].slice(0, 180);
};
const staleMessage = "price stale (the CRE pricing workflow hasn't run in 25 h)";
const nowSeconds = () => Math.floor(Date.now() / 1000);
const quoted = (r: ArcRoute): r is ArcRoute & { out: bigint } => "out" in r;

async function oraclePrice(amountIn: bigint): Promise<{ fair: bigint; out: bigint; ask: bigint }> {
  const [rate, round, block] = await Promise.all([
    client.readContract({ address: ARC_SWAP.aqua.oracle, abi: oracleAbi, functionName: "rateE18", args: ["EUR"] }),
    client.readContract({ address: ARC_SWAP.aqua.oracle, abi: oracleAbi, functionName: "latestRate", args: ["EUR"] }),
    client.getBlock(),
  ]);
  if (rate === 0n || round.recordedAt === 0n) throw new Error("no EUR/USD oracle rate");
  const age = block.timestamp;
  if (round.usdcUsdUpdatedAt === 0n || round.usdcUsdUpdatedAt > age || age - round.usdcUsdUpdatedAt > 90_000n)
    throw new Error(staleMessage);
  const day = Number((age / 86_400n + 4n) % 7n);
  const closed = day === 6 || day === 0 || (day === 1 && age % 86_400n < 21_600n);
  const baseMaxAge = closed ? 259_200n : 90_000n;
  if (round.fiatUsdUpdatedAt === 0n || round.fiatUsdUpdatedAt > age || age - round.fiatUsdUpdatedAt > baseMaxAge)
    throw new Error(staleMessage);
  const ask = closed ? 130n : 30n; // Registered strategy: 30 bps ask, 100 bps closed-window extra.
  return { fair: amountIn * 10n ** 18n / rate, out: amountIn * 10n ** 18n * 10_000n / (rate * (10_000n + ask)), ask };
}

async function uniswapQuote(amountIn: bigint): Promise<ArcRoute> {
  try {
    if (amountIn <= 0n || amountIn > 2n ** 128n - 1n) throw new Error("amount must fit uint128 and be positive");
    const { result: [out] } = await client.simulateContract({
      address: ARC_SWAP.uniswap.quoter, abi: quoterAbi, functionName: "quoteExactInputSingle",
      args: [{ poolKey, zeroForOne: true, exactAmount: amountIn, hookData: "0x" }],
    });
    if (out === 0n) throw new Error("pool returned zero EURC");
    return { id: "uniswap", out, detail: `PoolKey USDC/EURC fee=500 tickSpacing=10 hooks=${zeroAddress}`, source: "simulated" };
  } catch (e) { return { id: "uniswap", error: `Uniswap v4: ${shortError(e)}` }; }
}

async function aquaQuote(amountIn: bigint, taker: Address, price: { fair: bigint; out: bigint; ask: bigint }): Promise<ArcRoute> {
  try {
    const [allocation, walletBalance] = await Promise.all([
      client.readContract({ address: ARC_SWAP.aqua.aqua, abi: aquaAbi, functionName: "rawBalances", args: [ARC_SWAP.aqua.maker, ARC_SWAP.aqua.router, ARC_SWAP.aqua.strategyHash, ARC_SWAP.eurc] }),
      client.readContract({ address: ARC_SWAP.eurc, abi: erc20Abi, functionName: "balanceOf", args: [ARC_SWAP.aqua.maker] }),
    ]);
    if (price.out > allocation[0]) throw new Error(`insufficient Aqua allocation (${allocation[0]} EURC units available)`);
    if (price.out > walletBalance) throw new Error(`maker wallet has only ${walletBalance} EURC units`);
    const [balance, allowance] = await Promise.all([
      client.readContract({ address: ARC_SWAP.usdc, abi: erc20Abi, functionName: "balanceOf", args: [taker] }),
      client.readContract({ address: ARC_SWAP.usdc, abi: erc20Abi, functionName: "allowance", args: [taker, ARC_SWAP.aqua.router] }),
    ]);
    if (balance < amountIn || allowance < amountIn) {
      return { id: "aqua", out: price.out, detail: `Aqua maker oracle, ask=${price.ask} bps; taker needs USDC balance and router allowance to simulate`, source: "oracle" };
    }
    const [order, takerData] = await Promise.all([
      client.readContract({ address: ARC_SWAP.aqua.settler, abi: settlerAbi, functionName: "strategyOrder", args: [ARC_SWAP.aqua.strategyHash] }),
      client.readContract({ address: ARC_SWAP.aqua.settler, abi: settlerAbi, functionName: "takerData", args: [0n, taker] }),
    ]);
    const { result: [, out] } = await client.simulateContract({ account: taker, address: ARC_SWAP.aqua.router, abi: swapVmAbi, functionName: "swap", args: [order, ARC_SWAP.usdc, ARC_SWAP.eurc, amountIn, takerData] });
    if (out === 0n) throw new Error("router returned zero EURC");
    if (out > allocation[0] || out > walletBalance) throw new Error("maker cannot fund the simulated output");
    return { id: "aqua", out, detail: `Aqua maker SwapVM strategy ${ARC_SWAP.aqua.strategyHash}`, source: "simulated" };
  } catch (e) { return { id: "aqua", error: `Aqua maker: ${shortError(e)}` }; }
}

export async function quoteArcSwap(amountIn: bigint, taker: Address): Promise<ArcQuote> {
  const at = Date.now();
  const uni = uniswapQuote(amountIn);
  let price: Awaited<ReturnType<typeof oraclePrice>> | null = null;
  let aquaError: string | null = null;
  try {
    if (amountIn <= 0n || amountIn > 2n ** 128n - 1n) throw new Error("amount must fit uint128 and be positive");
    price = await oraclePrice(amountIn);
  } catch (e) { aquaError = `Aqua maker: ${shortError(e)}`; }
  const routes: ArcRoute[] = [await uni, price ? await aquaQuote(amountIn, taker, price) : { id: "aqua", error: aquaError! }];
  const available = routes.filter(quoted);
  const best = available.reduce<(ArcRoute & { out: bigint }) | null>((winner, route) =>
    !winner || route.out > winner.out ? route : winner, null);
  return { at, amountIn, routes, best, fairEurc: price?.fair ?? null };
}

const poolKeyParam = { type: "tuple", components: [
  { name: "currency0", type: "address" }, { name: "currency1", type: "address" },
  { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" },
] } as const;
function v4Input(amountIn: bigint, minOut: bigint): Hex {
  const swap = encodeAbiParameters([{
    type: "tuple", components: [
      { ...poolKeyParam, name: "poolKey" }, { name: "zeroForOne", type: "bool" },
      { name: "amountIn", type: "uint128" }, { name: "amountOutMinimum", type: "uint128" },
      { name: "minHopPriceX36", type: "uint256" },
      { name: "hookData", type: "bytes" },
    ],
  }], [{ poolKey, zeroForOne: true, amountIn, amountOutMinimum: minOut, minHopPriceX36: 0n, hookData: "0x" }]);
  const settle = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [ARC_SWAP.usdc, amountIn]);
  const take = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [ARC_SWAP.eurc, minOut]);
  return encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], ["0x060c0f", [swap, settle, take]]);
}

export async function executeArcSwap(p: {
  route: "uniswap" | "aqua"; amountIn: bigint; minOut: bigint; account: LocalAccount; onStep?: (s: string) => void;
}): Promise<{ hash: Hex; received: bigint; approvals: Hex[] }> {
  if (p.amountIn <= 0n || p.amountIn > 2n ** 128n - 1n || p.minOut < 0n || p.minOut > 2n ** 128n - 1n)
    throw new Error("Swap amount and minimum must be nonnegative uint128 values; input must be positive");
  const wallet = createWalletClient({ chain, account: p.account, transport: http(ARC_SWAP.rpc) });
  const approvals: Hex[] = [];
  const before = await client.readContract({ address: ARC_SWAP.eurc, abi: erc20Abi, functionName: "balanceOf", args: [p.account.address] });
  if (p.route === "aqua") {
    try { await oraclePrice(p.amountIn); }
    catch (e) { throw new Error(`Aqua maker: ${shortError(e)}`); }
  }
  const send = async (label: string, request: Parameters<typeof wallet.writeContract>[0]) => {
    p.onStep?.(label);
    const hash = await wallet.writeContract(request);
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${label} reverted: ${hash}`);
    return hash;
  };
  const spender = p.route === "uniswap" ? ARC_SWAP.uniswap.permit2 : ARC_SWAP.aqua.router;
  const allowance = await client.readContract({ address: ARC_SWAP.usdc, abi: erc20Abi, functionName: "allowance", args: [p.account.address, spender] });
  if (allowance < p.amountIn) approvals.push(await send("Approving USDC", {
    address: ARC_SWAP.usdc, abi: erc20Abi, functionName: "approve", args: [spender, p.amountIn], chain, account: p.account,
  }));
  let hash: Hex;
  if (p.route === "uniswap") {
    const [amount, expiration] = await client.readContract({ address: ARC_SWAP.uniswap.permit2, abi: permit2Abi, functionName: "allowance", args: [p.account.address, ARC_SWAP.usdc, ARC_SWAP.uniswap.universalRouter] });
    if (amount < p.amountIn || expiration <= nowSeconds()) approvals.push(await send("Approving Permit2 router allowance", {
      address: ARC_SWAP.uniswap.permit2, abi: permit2Abi, functionName: "approve",
      args: [ARC_SWAP.usdc, ARC_SWAP.uniswap.universalRouter, p.amountIn, nowSeconds() + 30 * 86_400], chain, account: p.account,
    }));
    const args = ["0x10", [v4Input(p.amountIn, p.minOut)], BigInt(nowSeconds() + 600)] as const;
    try {
      await client.simulateContract({ account: p.account, address: ARC_SWAP.uniswap.universalRouter, abi: routerAbi, functionName: "execute", args });
      hash = await send("Swapping on Uniswap v4", { address: ARC_SWAP.uniswap.universalRouter, abi: routerAbi, functionName: "execute", args, chain, account: p.account });
    } catch (e) { throw new Error(`Uniswap v4: ${shortError(e)}`); }
  } else {
    try {
      const [order, takerData] = await Promise.all([
        client.readContract({ address: ARC_SWAP.aqua.settler, abi: settlerAbi, functionName: "strategyOrder", args: [ARC_SWAP.aqua.strategyHash] }),
        client.readContract({ address: ARC_SWAP.aqua.settler, abi: settlerAbi, functionName: "takerData", args: [p.minOut, p.account.address] }),
      ]);
      const args = [order, ARC_SWAP.usdc, ARC_SWAP.eurc, p.amountIn, takerData] as const;
      await client.simulateContract({ account: p.account, address: ARC_SWAP.aqua.router, abi: swapVmAbi, functionName: "swap", args });
      hash = await send("Swapping with Aqua maker", { address: ARC_SWAP.aqua.router, abi: swapVmAbi, functionName: "swap", args, chain, account: p.account });
    } catch (e) { throw new Error(`Aqua maker: ${shortError(e)}`); }
  }
  const after = await client.readContract({ address: ARC_SWAP.eurc, abi: erc20Abi, functionName: "balanceOf", args: [p.account.address] });
  return { hash, received: after - before, approvals };
}

export async function arcBalances(who: Address): Promise<{ usdc: bigint; eurc: bigint; gas: bigint }> {
  const [usdc, eurc, gas] = await Promise.all([
    client.readContract({ address: ARC_SWAP.usdc, abi: erc20Abi, functionName: "balanceOf", args: [who] }),
    client.readContract({ address: ARC_SWAP.eurc, abi: erc20Abi, functionName: "balanceOf", args: [who] }),
    client.getBalance({ address: who }),
  ]);
  return { usdc, eurc, gas };
}
