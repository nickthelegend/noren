// Shared helpers for the live scripts. The key is read from a gitignored env file and never printed.
import { mkdirSync, readFileSync, rmdirSync, statSync } from "node:fs";
import { createWalletClient, defineChain, http, type Hex, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CCTP_CHAINS, type CctpChainKey } from "../sdk/chains";

export const ENV_FILE = process.env.ENV_FILE ?? "/Volumes/Extreme SSD/Projects/grokbot/projects/noren/.env.arc-deployer";

export const loadKey = (): Hex => {
  let text: string;
  try {
    text = readFileSync(ENV_FILE, "utf8");
  } catch {
    throw new Error(`Setup required: ${ENV_FILE} with NOREN_DEPLOYER_KEY`);
  }
  const line = text.split("\n").find((l) => l.trim().startsWith("NOREN_DEPLOYER_KEY="));
  const v = line?.split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "");
  if (!v || !/^0x[0-9a-fA-F]{64}$/.test(v)) throw new Error("Setup required: NOREN_DEPLOYER_KEY (0x + 64 hex) in the env file");
  return v as Hex;
};

export const walletFor = (key: CctpChainKey, pk: Hex): WalletClient => {
  const c = CCTP_CHAINS[key];
  const chain = defineChain({ id: c.chainId, name: c.name, nativeCurrency: { name: c.gas, symbol: c.gas, decimals: 18 }, rpcUrls: { default: { http: [c.rpcUrl] } } });
  return createWalletClient({ account: privateKeyToAccount(pk), chain, transport: http(c.rpcUrl) });
};

/** The Arc deployer is shared by several agents: every Arc tx batch runs under this lock (stale after 10 min). */
const LOCK = "/private/tmp/noren-arc-deployer.lock";
export const withArcLock = async <T>(fn: () => Promise<T>): Promise<T> => {
  for (;;) {
    try {
      mkdirSync(LOCK);
      break;
    } catch {
      try {
        if (Date.now() - statSync(LOCK).mtimeMs > 10 * 60_000) {
          rmdirSync(LOCK);
          continue;
        }
      } catch {
        continue;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  try {
    return await fn();
  } finally {
    try {
      rmdirSync(LOCK);
    } catch {
      /* already gone */
    }
  }
};

export const json = (v: unknown): string => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);
