/**
 * Tsuke (ツケ, the shop tab) in the browser. Reads go straight to the two local forks:
 * - Robinhood Chain mainnet fork: real Stock Tokens, real Chainlink feeds, TsukeCredit.
 * - Arc testnet fork: NorenCreditLine, which the Chainlink CRE workflow keeps in step with TsukeCredit.
 * The customer's key is the same test key the private checkout uses (kept in this browser), so one address is the
 * borrower on both chains. Nothing here is simulated: if a contract isn't deployed, calls fail and the UI says so.
 */
import { createPublicClient, createWalletClient, defineChain, erc20Abi, http, parseAbi, parseAbiItem, type Address, type Hex } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { localFork } from "@noren/core";
import type { Config } from "./api";

export type CreditCfg = {
  creditLine: Address | null; robinhoodRpc: string | null;
  /** First block worth scanning on the Robinhood fork (the fork point), as a decimal string. */
  robinhoodFromBlock?: string; arcFromBlock?: string;
  tsuke?: Address; underwriterUrl?: string; gateway?: Address | null;
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
export const tsukeEvents = {
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
]);

export const gatewayAbi = parseAbi([
  "function quote(address merchant, bytes32 invoiceId, address asset) view returns (uint256 assetIn, uint256 priceUsd8, bool marketClosed)",
  "function pay(bytes32 invoiceId, address merchant, address asset, uint256 maxAssetIn) payable returns (uint256 assetIn)",
  "function spreadBps(address asset) view returns (uint16)",
]);
export const robinhoodFork = (url: string, id = 4663) => defineChain({ id, name: "Robinhood Chain (local fork)", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [url] } } });

/** The checkout's test key (see wallet.ts): same storage slot, so the borrower is the payer. */
function customerKey(): Hex {
  try { const s = JSON.parse(localStorage.getItem("noren.customer.v1") ?? "null"); if (s?.gasKey) return s.gasKey; } catch { /* below */ }
  const s = { gasKey: generatePrivateKey(), seed: generatePrivateKey() };
  try { localStorage.setItem("noren.customer.v1", JSON.stringify(s)); } catch { /* tab-only wallet */ }
  return s.gasKey;
}

export type Holding = { sym: string; name: string; token: Address; balance: bigint; price8: bigint; updatedAt: number; value8: bigint };
export type Line = { lineId: Hex; limit: bigint; expiry: number; collateral8: bigint; openedTx: Hex; openedBlock: bigint; closed: boolean; drawn: bigint; repaid: bigint; draws: { amount: bigint; invoiceId: Hex; merchant: Address; tx: Hex }[] };

export function makeTsuke(cfg: Config) {
  const credit = creditOf(cfg);
  const account = privateKeyToAccount(customerKey());
  const arcChain = localFork(cfg.rpcUrl);
  const arc = createPublicClient({ chain: arcChain, transport: http(cfg.rpcUrl) });
  const arcWallet = createWalletClient({ chain: arcChain, transport: http(cfg.rpcUrl), account });
  const rhChain = credit?.robinhoodRpc ? robinhoodFork(credit.robinhoodRpc, credit.robinhoodChainId ?? 4663) : null;
  const rh = rhChain ? createPublicClient({ chain: rhChain, transport: http(credit!.robinhoodRpc!) }) : null;
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
      if (!credit?.tsuke) throw new Error("Setup required: TsukeCredit isn't deployed on the Robinhood fork (packages/tsuke)");
      const opened = await c.getLogs({ address: credit.tsuke, event: tsukeEvents.opened, args: { borrower: account.address }, fromBlock: fromRh ?? "earliest", toBlock: "latest" });
      if (!opened.length) return [];
      const closed = await c.getLogs({ address: credit.tsuke, event: tsukeEvents.closed, fromBlock: fromRh ?? "earliest", toBlock: "latest" });
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
          draws: drawn.map((d) => ({ amount: d.args.amount!, invoiceId: d.args.invoiceId!, merchant: d.args.merchant!, tx: d.transactionHash! })),
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
    /** Arc: repays the line in USDC (approve, then repay). The CRE workflow carries the Repaid log back to TsukeCredit. */
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
    /** Robinhood: what `asset` it takes to pay a TsukeGateway invoice now (Chainlink price plus the vault's spread). */
    async stockQuote(gateway: Address, merchant: Address, invoiceId: Hex, asset: Address) {
      const c = need();
      const [assetIn, priceUsd8, marketClosed] = await c.readContract({ address: gateway, abi: gatewayAbi, functionName: "quote", args: [merchant, invoiceId, asset] });
      const spread = await c.readContract({ address: gateway, abi: gatewayAbi, functionName: "spreadBps", args: [asset] });
      return { assetIn, priceUsd8, marketClosed, spreadBps: Number(spread) };
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
      if (r.status !== "success") throw new Error(`TsukeGateway.pay reverted: ${hash}`);
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
    arcGas: () => arc.getBalance({ address: account.address }),
    arcUsdc: () => arc.readContract({ address: cfg.deployment.usdc, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
  };
}
export type Tsuke = ReturnType<typeof makeTsuke>;
export const usd8 = (v: bigint, dp = 2) => (Number(v) / 1e8).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
export const units = (v: bigint, decimals: number, dp = 4) => (Number(v) / 10 ** decimals).toLocaleString("en-US", { maximumFractionDigits: dp });
