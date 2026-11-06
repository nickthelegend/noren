/**
 * The customer's private wallet, in this browser. Test networks only. The active wallet (signer.ts: the Privy embedded
 * wallet, or the test key) pays gas for shielding, and its seed derives the Kohaku note secrets. Proofs are generated
 * here, on the device; no server ever sees the secrets.
 */
import { createPublicClient, createWalletClient, erc20Abi, http, keccak256, toBytes, concatHex, parseAbiItem, type Hex } from "viem";
import { activeAccount, activeKey, kohakuSeed, walletTransport } from "./signer";
import { createCustomer } from "@noren/core/customer";
import { localFork, type Invoice } from "@noren/core";
import type { Config } from "./api";

/**
 * Kohaku's sync cache, namespaced per deployment so a redeployed pool (or a fresh fork) never reads stale state, and per
 * wallet for Privy wallets (the test wallet keeps its original namespace, so existing balances stay readable).
 */
const storageFor = (cfg: Config, wallet: string) => {
  const ns = `noren.kohaku.${cfg.chainId}.${cfg.deployment.pool.toLowerCase()}.${cfg.deployment.deploymentBlock}.${wallet === "test" ? "" : wallet + "."}`;
  return {
    get: async (k: string) => { try { return localStorage.getItem(ns + k); } catch { return null; } },
    set: async (k: string, v: string) => { try { localStorage.setItem(ns + k, v); } catch { /* ignore */ } },
  };
};

export function makeWallet(cfg: Config) {
  const account = activeAccount(), walletKey = activeKey();
  const chain = localFork(cfg.rpcUrl);
  const pub = createPublicClient({ chain, transport: http(cfg.rpcUrl) });
  const wallet = createWalletClient({ chain, transport: walletTransport(cfg.rpcUrl), account });
  const customer = createCustomer({
    deployment: cfg.deployment as never, rpcUrl: cfg.rpcUrl, aspUrl: cfg.aspUrl, storage: storageFor(cfg, walletKey),
    // Same-origin prover artifacts (served from /zk by this app): the browser makes no third-party request.
    artifactBaseUrl: `${location.origin}/zk`,
    deriveAt: async (path) => {
      if (activeKey() !== walletKey) throw new Error("The active wallet changed; reopen this screen to use the new one");
      return keccak256(concatHex([await kohakuSeed(), keccak256(toBytes(path))]));
    },
  });
  return {
    address: account.address,
    customer,
    async shield(amount: bigint) {
      const hashes: Hex[] = [];
      // Kohaku returns only the deposit; the pool's Entrypoint pulls USDC, so approve it first when needed.
      const usdcAddr = cfg.deployment.usdc, spender = cfg.deployment.entrypoint;
      const allowance = await pub.readContract({ address: usdcAddr, abi: erc20Abi, functionName: "allowance", args: [account.address, spender] });
      if (allowance < amount) {
        const hash = await wallet.writeContract({ address: usdcAddr, abi: erc20Abi, functionName: "approve", args: [spender, amount], chain });
        if ((await pub.waitForTransactionReceipt({ hash })).status !== "success") throw new Error(`USDC approval reverted: ${hash}`);
        hashes.push(hash);
      }
      const txns = (await customer.shield(amount)) as { to: Hex; data: Hex; value?: bigint }[];
      for (const t of txns) {
        const hash = await wallet.sendTransaction({ to: t.to, data: t.data, value: BigInt(t.value ?? 0n), chain });
        const r = await pub.waitForTransactionReceipt({ hash });
        if (r.status !== "success") throw new Error(`Shield transaction reverted: ${hash}`);
        hashes.push(hash);
      }
      return hashes;
    },
    async balances() {
      const rows = (await customer.balance()) as unknown as Array<{ approved?: bigint; pending?: bigint; balance?: bigint; tag?: string }>;
      return summarise(rows);
    },
    async refundInbox() {
      const r = await customer.refundInbox();
      return { ...summarise(r.balances as never), nextPrecommitment: r.nextPrecommitment };
    },
    /** The precommitment of this account's next pool deposit (Kohaku), for a deposit someone else makes for it. */
    nextPrecommitment: () => customer.nextPrecommitment(),
    async prove(invoice: Invoice) {
      const t0 = performance.now();
      const result = await customer.proveInvoicePayment(invoice);
      return { ...result, seconds: (performance.now() - t0) / 1000 };
    },
    /** How many deposits the pool holds: the crowd a payment hides in. Read straight from the pool's Deposited logs. */
    async anonymitySet() {
      const logs = await pub.getLogs({ address: cfg.deployment.pool, event: parseAbiItem("event Deposited(address indexed depositor,uint256 commitment,uint256 label,uint256 value,uint256 precommitment)"), fromBlock: BigInt(cfg.deployment.deploymentBlock), toBlock: "latest" });
      return { deposits: logs.length, depositors: new Set(logs.map((l) => l.args.depositor?.toLowerCase())).size };
    },
    createReceipt: customer.createReceipt,
    rememberReceipt: (i: Invoice, o: { secret: Hex; commitment: Hex }) => customer.rememberReceipt(i, o),
  };
}

/** Kohaku's balance() rows are `{ amount, tag? }`: no tag = approved (spendable), tag "pending" = awaiting the ASP. */
function summarise(rows: unknown): { approved: bigint; pending: bigint } {
  let approved = 0n, pending = 0n;
  for (const r of (Array.isArray(rows) ? rows : []) as { amount: bigint | string; tag?: string }[]) {
    if (!r.tag) approved += BigInt(r.amount);
    else if (r.tag === "pending") pending += BigInt(r.amount);
  }
  return { approved, pending };
}
export type Wallet = ReturnType<typeof makeWallet>;
