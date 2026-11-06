/** Reads for NorenReputation (points, milestones, LTV tiers). Addresses come from /config; nothing is assumed. */
import { erc20Abi, maxUint256, parseAbi, parseAbiItem, type Address, type Hex } from "viem";
import type { Wallet } from "./NorenApp";

export type Milestone = { id: string; title: string; detail: string; done: boolean; boost?: string };

export const reputationAbi = parseAbi([
  "function breakdownOf(address account) view returns ((uint32 onTime, uint32 late, uint32 repaidLoans, uint32 liquidations, uint64 firstSeenAt, uint64 ageDays, bool verifiedHuman, uint256 points, uint256 milestones, uint8 tier, uint16 ltvBps, uint16 limitMultiplierBps))",
  "function creditLimitOf(address account) view returns (uint256 totalUsd6, uint256 securedUsdg, uint256 starterUsdc)",
  "function tierTable(uint8 t) pure returns ((uint16 ltvBps, uint16 limitMultiplierBps, uint16 minPoints, bool needsHuman, bool needsRepayment))",
]);

const M = [
  { bit: 0, id: "human", title: "Verified human", detail: "World ID, one account per person", boost: "+50 pts" },
  { bit: 3, id: "ontime3", title: "Three on-time installments", detail: "Pay in 3 on NorenCredit", boost: "+30 pts" },
  { bit: 4, id: "loan1", title: "First loan repaid", detail: "A NorenBorrow loan repaid in full", boost: "+25 pts" },
  { bit: 5, id: "loan3", title: "Three loans repaid", detail: "NorenBorrow", boost: "+75 pts" },
  { bit: 6, id: "clean", title: "Clean record", detail: "No late payments or liquidations" },
  { bit: 1, id: "age30", title: "Account 30 days old", detail: "Signed by the underwriter from Robinhood Chain history", boost: "+20 pts" },
  { bit: 2, id: "age180", title: "Account 180 days old", detail: "Signed by the underwriter", boost: "+20 pts" },
];

export async function readReputation(w: Wallet, reputation: Address): Promise<Milestone[]> {
  const { pub } = w.oc.robinhood();
  const b = await pub.readContract({ address: reputation, abi: reputationAbi, functionName: "breakdownOf", args: [w.oc.address] });
  return M.map((m) => ({ id: m.id, title: m.title, detail: m.id === "human" && b.verifiedHuman ? "Verified with World ID" : m.id === "ontime3" ? `${b.onTime} of 3 on time` : m.id === "loan1" || m.id === "loan3" ? `${b.repaidLoans} repaid` : m.detail, done: (b.milestones & (1n << BigInt(m.bit))) !== 0n, boost: m.boost }));
}

export async function readTier(w: Wallet, reputation: Address) {
  const { pub } = w.oc.robinhood();
  const [b, limit] = await Promise.all([
    pub.readContract({ address: reputation, abi: reputationAbi, functionName: "breakdownOf", args: [w.oc.address] }),
    pub.readContract({ address: reputation, abi: reputationAbi, functionName: "creditLimitOf", args: [w.oc.address] }),
  ]);
  return { points: b.points, tier: b.tier, ltvBps: b.ltvBps, multiplierBps: b.limitMultiplierBps, verifiedHuman: b.verifiedHuman, totalUsd6: limit[0], securedUsdg: limit[1], starterUsdc: limit[2] };
}

/* ------------------------------------------------------------------ NorenDepositVault (Earn) and NorenBorrow */

export const vaultAbi = parseAbi([
  "function asset() view returns (address)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function previewDeposit(uint256 assets) view returns (uint256)",
  "function previewRedeem(uint256 shares) view returns (uint256)",
  "function maxRedeem(address owner) view returns (uint256)",
  "function inKind(uint256 shares) view returns (uint256 assets, uint256 usdgAmount)",
  "function sharesValueUsd8(uint256 shares, bool risk) view returns (uint256)",
  "function stats() view returns ((uint256 assetBalance, uint256 usdgBalance, uint256 totalAssets, uint256 totalSupply, uint256 assetsPerShare, uint256 navUsd8, uint256 feesUsdg, uint256 fills, uint256 volumeUsdg, uint64 firstDepositAt, bytes32 strategyHash, bool priced))",
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "function depositETH(address receiver) payable returns (uint256 shares)",
  "function redeem(uint256 shares, address receiver, address owner) returns (uint256)",
  "function redeemETH(uint256 shares, address receiver, address owner) returns (uint256 assets)",
  "function redeemInKind(uint256 shares, address receiver, address owner) returns (uint256 assets, uint256 usdgOut)",
]);
const depositEv = parseAbiItem("event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)");
const withdrawEv = parseAbiItem("event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)");

export const borrowAbi = parseAbi([
  "function lock(address v, uint256 shares)",
  "function unlock(address v, uint256 shares, address to)",
  "function borrow(uint256 amountUsdg, address to)",
  "function repay(address account, uint256 amountUsdg) returns (uint256 paid)",
  "function lockedShares(address account, address vault) view returns (uint256)",
  "function debtOf(address who) view returns (uint256)",
  "function borrowLimitUsdg(address who) view returns (uint256)",
  "function healthFactor(address who) view returns (uint256)",
  "function collateralValueUsd8(address who, bool risk) view returns (uint256)",
  "function liquidationPriceUsd8(address who, address v) view returns (uint256)",
  "function liquidationLtvBps() view returns (uint16)",
  "function borrowRateBps() view returns (uint16)",
  "function ltvOf(address who) view returns (uint16)",
  "function accountOf(address who) view returns ((uint256 scaledDebt, uint256 principal, uint256 peakPrincipal, uint64 openedAt, uint32 repaidLoans, uint32 liquidations))",
]);

export type VaultRow = { asset: Address; vault: Address; sym: string; shareSym: string; decimals: number; stats: Awaited<ReturnType<typeof readVaultStats>>; shares: bigint; assetsNow: bigint; netDeposited: bigint; realised: bigint; walletAsset: bigint; locked: bigint };

async function readVaultStats(pub: any, vault: Address) {
  return pub.readContract({ address: vault, abi: vaultAbi, functionName: "stats" }) as Promise<{ assetBalance: bigint; usdgBalance: bigint; totalAssets: bigint; totalSupply: bigint; assetsPerShare: bigint; navUsd8: bigint; feesUsdg: bigint; fills: bigint; volumeUsdg: bigint; firstDepositAt: bigint; strategyHash: Hex; priced: boolean }>;
}

/** Every deposit vault with this wallet's position. Gains come from the vault's own ERC-4626 Deposit/Withdraw logs:
 *  realised = assets withdrawn minus the average cost of the shares redeemed; open = shares now minus their cost. */
export async function readVaults(w: Wallet, list: { asset: Address; vault: Address }[], symOf: (a: Address) => string): Promise<VaultRow[]> {
  const { pub } = w.oc.robinhood();
  const me = w.oc.address;
  const from = w.oc.credit?.robinhoodFromBlock ? BigInt(w.oc.credit.robinhoodFromBlock) : undefined;
  const borrow = w.oc.credit?.borrow as Address | undefined;
  return Promise.all(list.map(async ({ asset, vault }) => {
    const [shareSym, decimals, stats, shares, deps, wds, walletAsset, locked] = await Promise.all([
      pub.readContract({ address: vault, abi: vaultAbi, functionName: "symbol" }),
      pub.readContract({ address: vault, abi: vaultAbi, functionName: "decimals" }),
      readVaultStats(pub, vault),
      pub.readContract({ address: vault, abi: vaultAbi, functionName: "balanceOf", args: [me] }),
      pub.getLogs({ address: vault, event: depositEv, args: { owner: me }, fromBlock: from ?? "earliest", toBlock: "latest" }),
      pub.getLogs({ address: vault, event: withdrawEv, args: { owner: me }, fromBlock: from ?? "earliest", toBlock: "latest" }),
      pub.readContract({ address: asset, abi: erc20Abi, functionName: "balanceOf", args: [me] }),
      borrow ? pub.readContract({ address: borrow, abi: borrowAbi, functionName: "lockedShares", args: [me, vault] }) : Promise.resolve(0n),
    ]);
    const held = shares + locked;
    const assetsNow = held > 0n ? await pub.readContract({ address: vault, abi: vaultAbi, functionName: "convertToAssets", args: [held] }).catch(() => 0n) : 0n;
    // Average-cost basis, in event order.
    const events = [...deps.map((l) => ({ k: 0, b: l.blockNumber!, i: l.logIndex!, a: l.args.assets!, s: l.args.shares! })), ...wds.map((l) => ({ k: 1, b: l.blockNumber!, i: l.logIndex!, a: l.args.assets!, s: l.args.shares! }))].sort((x, y) => (x.b === y.b ? x.i - y.i : x.b < y.b ? -1 : 1));
    let costShares = 0n, cost = 0n, realised = 0n;
    for (const e of events) {
      if (e.k === 0) { costShares += e.s; cost += e.a; }
      else if (costShares > 0n) { const basis = (cost * e.s) / costShares; realised += e.a - basis; cost -= basis; costShares -= e.s; }
    }
    return { asset, vault, sym: symOf(asset), shareSym, decimals: Number(decimals), stats, shares, assetsNow, netDeposited: cost, realised, walletAsset, locked };
  }));
}
export { maxUint256 };
