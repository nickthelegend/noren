/**
 * Pay with stocks and pay later, in the browser. Reads go straight to the two local forks:
 * - Robinhood Chain mainnet fork: real Stock Tokens, real Chainlink feeds, NorenCredit.
 * - Arc testnet fork: NorenCreditLine, which the Chainlink CRE workflow keeps in step with NorenCredit.
 * The customer's wallet is the active wallet (signer.ts: the Privy embedded wallet, or this browser's test key), the
 * same one the private checkout uses, so one address is the borrower on both chains. Nothing here is simulated: if a contract isn't deployed, calls fail and the UI says so.
 */
import { createPublicClient, createWalletClient, defineChain, erc20Abi, http, parseAbi, parseAbiItem, type Address, type Hex } from "viem";
import { activeAccount } from "./signer";
import { localFork } from "@noren/core";
import type { Config } from "./api";

export type CreditCfg = {
  creditLine: Address | null; robinhoodRpc: string | null;
  /** First block worth scanning on the Robinhood fork (the fork point), as a decimal string. */
  robinhoodFromBlock?: string; arcFromBlock?: string;
  creditContract?: Address; underwriterUrl?: string; aiUnderwriterUrl?: string; stockOracle?: Address; gateway?: Address | null;
  /** 4663, or 46630 when dev:all runs the mainnet fork under Robinhood testnet's id for the CRE simulator. */
  robinhoodChainId?: number; [k: string]: unknown;
};
export const creditOf = (cfg: Config | null): CreditCfg | null => ((cfg as unknown as { credit?: CreditCfg | null })?.credit ?? null);

export const STOCKS: { sym: string; name: string; token: Address; feed: Address }[] = [
  { sym: "NVDA", name: "NVIDIA", token: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", feed: "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15" },
  { sym: "TSLA", name: "Tesla", token: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d", feed: "0x4A1166a659A55625345e9515b32adECea5547C38" },
  { sym: "AAPL", name: "Apple", token: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", feed: "0x6B22A786bAa607d76728168703a39Ea9C99f2cD0" },
  { sym: "SPY", name: "SPDR S&P 500", token: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C", feed: "0x319724394D3A0e3669269846abE664Cd621f9f6A" },
  { sym: "MSFT", name: "Microsoft", token: "0xe93237C50D904957Cf27E7B1133b510C669c2e74", feed: "0x45C3C877C15E6BA2EBB19eA114Ea508d14C1Af2E" },
  { sym: "AMZN", name: "Amazon", token: "0x12f190a9F9d7D37a250758b26824B97CE941bF54", feed: "0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C" },
  { sym: "GOOGL", name: "Alphabet", token: "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3", feed: "0xF6f373a037c30F0e5010d854385cA89185AE638b" },
  { sym: "META", name: "Meta", token: "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35", feed: "0x7C38C00C30BEe9378381E7B6135d7283356D71b1" },
];
export const USDG: Address = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
export const USDG_FEED: Address = "0x61B7e5650328764B076A108EFF5fa7282a1B9aD2";

const feedAbi = parseAbi(["function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)"]);
export const creditEvents = {
  opened: parseAbiItem("event CreditLineOpened(address indexed borrower, bytes32 indexed lineId, uint256 limitUsdc6, uint64 expiry, uint256 collateralValueUsd8)"),
  closed: parseAbiItem("event CreditLineClosed(bytes32 indexed lineId)"),
};
export const creditLineAbi = parseAbi([
  "function payInvoice(bytes32 lineId, address merchant, uint256 amount, bytes32 invoiceId)",
  "function repay(bytes32 lineId, uint256 amount)",
  "event Drawn(bytes32 indexed lineId, uint256 amount, bytes32 invoiceId, address merchant)",
  "event Repaid(bytes32 indexed lineId, uint256 amount)",
  "function lines(bytes32 lineId) view returns ((address borrower, uint64 expiry, uint64 updatedAt, bool closed, uint256 limitUsdc6, uint256 drawnUsdc6, uint256 repaidUsdc6))",
  "function available(bytes32 lineId) view returns (uint256)",
  "function drawToPool(bytes32 lineId, uint256 amount, uint256 precommitment) returns (uint256)",
  "function privacyEntrypoint() view returns (address)",
  "event DrawnToPool(bytes32 indexed lineId, uint256 amount, uint256 precommitment, uint256 commitment)",
]);
const entrypointConfigAbi = parseAbi(["function assetConfig(address asset) view returns (address pool, uint256 minimumDepositAmount, uint256 vettingFeeBPS, uint256 maxRelayFeeBPS)"]);

export const gatewayAbi = parseAbi([
  "function quote(address merchant, bytes32 invoiceId, address asset) view returns (uint256 assetIn, uint256 priceUsd8, bool marketClosed)",
  "function pay(bytes32 invoiceId, address merchant, address asset, uint256 maxAssetIn) payable returns (uint256 assetIn)",
  "function spreadBps(address asset) view returns (uint16)",
  "function quoteRoute(address merchant, bytes32 invoiceId, address asset) view returns (uint256 assetIn, uint256 priceUsd8, bool marketClosed, bytes32 strategyHash)",
]);
export const robinhoodFork = (url: string, id = 4663) => defineChain({ id, name: "Robinhood Chain (local fork)", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [url] } } });

/** The active wallet as a viem account, for public testnets (CCTP source chains, Arc testnet) and the forks. */
export const customerAccount = () => activeAccount();

export type Holding = { sym: string; name: string; token: Address; balance: bigint; price8: bigint; updatedAt: number; value8: bigint };
export type Line = { lineId: Hex; limit: bigint; expiry: number; collateral8: bigint; openedTx: Hex; openedBlock: bigint; closed: boolean; drawn: bigint; repaid: bigint; draws: { amount: bigint; invoiceId: Hex; merchant: Address; tx: Hex; toPool: boolean }[] };

export function makeOnchain(cfg: Config) {
  const credit = creditOf(cfg);
  const account = activeAccount();
  const arcChain = localFork(cfg.rpcUrl);
  const arc = createPublicClient({ chain: arcChain, transport: http(cfg.rpcUrl) });
  const arcWallet = createWalletClient({ chain: arcChain, transport: http(cfg.rpcUrl), account });
  const rhChain = credit?.robinhoodRpc ? robinhoodFork(credit.robinhoodRpc, credit.robinhoodChainId ?? 4663) : null;
  // A fresh fork fetches each contract from Robinhood mainnet on first touch, so allow slow first reads.
  const rh = rhChain ? createPublicClient({ chain: rhChain, transport: http(credit!.robinhoodRpc!, { timeout: 45_000, retryCount: 2 }) }) : null;
  const need = () => { if (!rh || !credit?.robinhoodRpc) throw new Error("Setup required: the Robinhood fork isn't running. Start everything with pnpm dev:all"); return rh; };

  return {
    address: account.address,
    credit,
    /** Stock Tokens and USDG this address holds on the Robinhood fork, valued at the live Chainlink price (8 decimals). */
    async holdings(): Promise<{ stocks: Holding[]; usdg: bigint; eth: bigint }> {
      const c = need();
      const [eth, usdg, rows] = await Promise.all([
        c.getBalance({ address: account.address }),
        c.readContract({ address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
        Promise.all(STOCKS.map(async (s) => {
          const [balance, round] = await Promise.all([
            c.readContract({ address: s.token, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
            c.readContract({ address: s.feed, abi: feedAbi, functionName: "latestRoundData" }),
          ]);
          const price8 = round[1] > 0n ? round[1] : 0n;
          return { ...s, balance, price8, updatedAt: Number(round[3]), value8: (balance * price8) / 10n ** 18n };
        })),
      ]);
      return { stocks: rows, usdg, eth };
    },
    /** Credit lines opened for this borrower on Robinhood (CreditLineOpened), with Arc-side draws and repayments. */
    async lines(): Promise<Line[]> {
      const c = need();
      const fromRh = credit?.robinhoodFromBlock ? BigInt(credit.robinhoodFromBlock) : undefined;
      if (!credit?.creditContract) throw new Error("Setup required: NorenCredit isn't deployed on the Robinhood fork (packages/robinhood)");
      const opened = await c.getLogs({ address: credit.creditContract, event: creditEvents.opened, args: { borrower: account.address }, fromBlock: fromRh ?? "earliest", toBlock: "latest" });
      if (!opened.length) return [];
      const closed = await c.getLogs({ address: credit.creditContract, event: creditEvents.closed, fromBlock: fromRh ?? "earliest", toBlock: "latest" });
      const closedIds = new Set(closed.map((l) => l.args.lineId!.toLowerCase()));
      const fromArc = credit.arcFromBlock ? BigInt(credit.arcFromBlock) : BigInt(cfg.deployment.deploymentBlock);
      const creditLine = credit.creditLine;
      return Promise.all(opened.map(async (l) => {
        const lineId = l.args.lineId!;
        const [drawn, repaid] = !creditLine ? [[], []] : await Promise.all([
          arc.getLogs({ address: creditLine, event: creditLineAbi[2], args: { lineId }, fromBlock: fromArc, toBlock: "latest" }),
          arc.getLogs({ address: creditLine, event: creditLineAbi[3], args: { lineId }, fromBlock: fromArc, toBlock: "latest" }),
        ]);
        return {
          lineId, limit: l.args.limitUsdc6!, expiry: Number(l.args.expiry!), collateral8: l.args.collateralValueUsd8!, openedTx: l.transactionHash!, openedBlock: l.blockNumber!,
          closed: closedIds.has(lineId.toLowerCase()),
          drawn: drawn.reduce((a, d) => a + d.args.amount!, 0n), repaid: repaid.reduce((a, r) => a + r.args.amount!, 0n),
          // drawToPool logs Drawn with merchant = the Kohaku Entrypoint: a draw into this borrower's private balance.
          draws: drawn.map((d) => ({ amount: d.args.amount!, invoiceId: d.args.invoiceId!, merchant: d.args.merchant!, tx: d.transactionHash!, toPool: d.args.merchant!.toLowerCase() === cfg.deployment.entrypoint.toLowerCase() })),
        };
      }));
    },
    /** Arc: pays a Noren invoice from the credit pool. The merchant server sees the Drawn log and settles the invoice. */
    async payInvoice(lineId: Hex, merchant: Address, amount: bigint, invoiceId: Hex) {
      const creditLine = credit?.creditLine;
      if (!creditLine) throw new Error("Setup required: NorenCreditLine isn't deployed on the Arc fork (packages/arc-credit)");
      await arc.simulateContract({ account, address: creditLine, abi: creditLineAbi, functionName: "payInvoice", args: [lineId, merchant, amount, invoiceId] });
      const hash = await arcWallet.writeContract({ address: creditLine, abi: creditLineAbi, functionName: "payInvoice", args: [lineId, merchant, amount, invoiceId], chain: arcChain });
      const r = await arc.waitForTransactionReceipt({ hash });
      if (r.status !== "success") throw new Error(`payInvoice reverted: ${hash}`);
      return { hash, gasUsed: r.gasUsed };
    },
    /** Pay later, privately: is drawToPool on, and the pool's minimum deposit (a draw can't be smaller). */
    async poolDraw() {
      const creditLine = credit?.creditLine;
      if (!creditLine) throw new Error("Setup required: NorenCreditLine isn't deployed on the Arc fork (packages/arc-credit)");
      const [entrypoint, cfgRow] = await Promise.all([
        arc.readContract({ address: creditLine, abi: creditLineAbi, functionName: "privacyEntrypoint" }).catch(() => null),
        arc.readContract({ address: cfg.deployment.entrypoint, abi: entrypointConfigAbi, functionName: "assetConfig", args: [cfg.deployment.usdc] }),
      ]);
      const on = !!entrypoint && entrypoint.toLowerCase() === cfg.deployment.entrypoint.toLowerCase();
      return { on, minimum: cfgRow[1] };
    },
    /** Arc: draws on the line straight into the Kohaku pool under this wallet's precommitment (NorenCreditLine.drawToPool). */
    async drawToPool(lineId: Hex, amount: bigint, precommitment: bigint) {
      const creditLine = credit?.creditLine;
      if (!creditLine) throw new Error("Setup required: NorenCreditLine isn't deployed on the Arc fork (packages/arc-credit)");
      await arc.simulateContract({ account, address: creditLine, abi: creditLineAbi, functionName: "drawToPool", args: [lineId, amount, precommitment] });
      const hash = await arcWallet.writeContract({ address: creditLine, abi: creditLineAbi, functionName: "drawToPool", args: [lineId, amount, precommitment], chain: arcChain });
      const r = await arc.waitForTransactionReceipt({ hash });
      if (r.status !== "success") throw new Error(`drawToPool reverted: ${hash}`);
      return { hash, gasUsed: r.gasUsed };
    },
    /** Arc: repays the line in USDC (approve, then repay). The CRE workflow carries the Repaid log back to NorenCredit. */
    async repay(lineId: Hex, amount: bigint) {
      const creditLine = credit?.creditLine;
      if (!creditLine) throw new Error("Setup required: NorenCreditLine isn't deployed on the Arc fork (packages/arc-credit)");
      const usdc = cfg.deployment.usdc;
      const allowance = await arc.readContract({ address: usdc, abi: erc20Abi, functionName: "allowance", args: [account.address, creditLine] });
      if (allowance < amount) {
        const a = await arcWallet.writeContract({ address: usdc, abi: erc20Abi, functionName: "approve", args: [creditLine, amount], chain: arcChain });
        if ((await arc.waitForTransactionReceipt({ hash: a })).status !== "success") throw new Error(`USDC approval reverted: ${a}`);
      }
      await arc.simulateContract({ account, address: creditLine, abi: creditLineAbi, functionName: "repay", args: [lineId, amount] });
      const hash = await arcWallet.writeContract({ address: creditLine, abi: creditLineAbi, functionName: "repay", args: [lineId, amount], chain: arcChain });
      if ((await arc.waitForTransactionReceipt({ hash })).status !== "success") throw new Error(`repay reverted: ${hash}`);
      return hash;
    },
    /** Robinhood: what `asset` it takes to pay a NorenGateway invoice now (Chainlink price plus the vault's spread). */
    async stockQuote(gateway: Address, merchant: Address, invoiceId: Hex, asset: Address) {
      const c = need();
      const spread = Number(await c.readContract({ address: gateway, abi: gatewayAbi, functionName: "spreadBps", args: [asset] }));
      // quoteRoute (1inch Aqua makers first, the vault as fallback) when the gateway has it; plain quote otherwise.
      try {
        const [assetIn, priceUsd8, marketClosed, strategyHash] = await c.readContract({ address: gateway, abi: gatewayAbi, functionName: "quoteRoute", args: [merchant, invoiceId, asset] });
        const viaMaker = BigInt(strategyHash) !== 0n;
        return { assetIn, priceUsd8, marketClosed, spreadBps: spread, route: (viaMaker ? "aqua-maker" : "vault") as "aqua-maker" | "vault", strategyHash: viaMaker ? strategyHash : null };
      } catch {
        const [assetIn, priceUsd8, marketClosed] = await c.readContract({ address: gateway, abi: gatewayAbi, functionName: "quote", args: [merchant, invoiceId, asset] });
        return { assetIn, priceUsd8, marketClosed, spreadBps: spread, route: "vault" as const, strategyHash: null };
      }
    },
    /** Robinhood: approve the Stock Token to the gateway, then pay. maxAssetIn allows 1% price movement. */
    async payWithStock(gateway: Address, merchant: Address, invoiceId: Hex, asset: Address, quoted: bigint) {
      const c = need(); const chain = rhChain!;
      const w = createWalletClient({ chain, transport: http(credit!.robinhoodRpc!), account });
      const max = quoted + quoted / 100n;
      const allowance = await c.readContract({ address: asset, abi: erc20Abi, functionName: "allowance", args: [account.address, gateway] });
      if (allowance < max) {
        const a = await w.writeContract({ address: asset, abi: erc20Abi, functionName: "approve", args: [gateway, max], chain });
        if ((await c.waitForTransactionReceipt({ hash: a })).status !== "success") throw new Error(`Approval reverted: ${a}`);
      }
      await c.simulateContract({ account, address: gateway, abi: gatewayAbi, functionName: "pay", args: [invoiceId, merchant, asset, max] });
      const hash = await w.writeContract({ address: gateway, abi: gatewayAbi, functionName: "pay", args: [invoiceId, merchant, asset, max], chain });
      const r = await c.waitForTransactionReceipt({ hash });
      if (r.status !== "success") throw new Error(`NorenGateway.pay reverted: ${hash}`);
      return hash;
    },
    /** Arc: the line as NorenCreditLine sees it (written by the CRE bridge). live = the bridge has delivered it. */
    async arcLine(lineId: Hex) {
      const creditLine = credit?.creditLine;
      if (!creditLine) throw new Error("Setup required: NorenCreditLine isn't deployed on the Arc fork (packages/arc-credit)");
      const [l, available] = await Promise.all([
        arc.readContract({ address: creditLine, abi: creditLineAbi, functionName: "lines", args: [lineId] }),
        arc.readContract({ address: creditLine, abi: creditLineAbi, functionName: "available", args: [lineId] }),
      ]);
      const live = l.borrower !== "0x0000000000000000000000000000000000000000";
      return { live, closed: l.closed, limit: l.limitUsdc6, expiry: Number(l.expiry), drawn: l.drawnUsdc6, repaid: l.repaidUsdc6, updatedAt: Number(l.updatedAt), available };
    },
    /** Raw access to the Robinhood fork for the credit-line calls (credit-actions.ts). */
    robinhood() {
      const c = need();
      return { pub: c, wallet: createWalletClient({ chain: rhChain!, transport: http(credit!.robinhoodRpc!, { timeout: 45_000 }), account }), chain: rhChain!, account };
    },
    /** The Arc fork's public client (reads only). */
    arcPublic: () => arc,
    arcGas: () => arc.getBalance({ address: account.address }),
    arcUsdc: () => arc.readContract({ address: cfg.deployment.usdc, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
  };
}
export type Onchain = ReturnType<typeof makeOnchain>;
export const usd8 = (v: bigint, dp = 2) => (Number(v) / 1e8).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
export const units = (v: bigint, decimals: number, dp = 4) => (Number(v) / 10 ** decimals).toLocaleString("en-US", { maximumFractionDigits: dp });
