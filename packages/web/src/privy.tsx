/**
 * Privy login for Noren Merchant and the Noren app (lazy-loaded; only mounted when VITE_PRIVY_APP_ID is set).
 * Users sign in with email or a wallet and get a Privy embedded wallet. The bridge below hands the session and the
 * embedded wallet's EIP-1193 provider to signer.ts, which the rest of the app signs through.
 * Appearance overrides keep the modal on Noren's name and logo whatever the Privy app is called in its dashboard.
 */
import { useEffect, useRef, type ReactNode } from "react";
import { PrivyProvider, useLogin, usePrivy, useWallets } from "@privy-io/react-auth";
import { defineChain, type Address } from "viem";
import { arcTestnet } from "@noren/core";
import { CCTP_CHAINS } from "@noren/cctp";
import { PRIVY_APP_ID, registerPrivyActions, setPrivy, type Eip1193, type PrivyActions } from "./signer";

const robinhoodTestnet = defineChain({ id: 46630, name: "Robinhood Chain Testnet", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["https://rpc.testnet.chain.robinhood.com"] } }, blockExplorers: { default: { name: "Explorer", url: "https://explorer.testnet.chain.robinhood.com" } }, testnet: true });
// The local Robinhood Chain fork (pnpm dev:all, port 8646) keeps mainnet's chain ID 4663. Arc's fork keeps 5042002.
const robinhoodFork = defineChain({ id: 4663, name: "Robinhood Chain · mainnet snapshot", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["http://127.0.0.1:8646"] } }, testnet: true });
const cctpSources = Object.values(CCTP_CHAINS).filter((c) => c.chainId !== arcTestnet.id && c.chainId !== robinhoodTestnet.id)
  .map((c) => defineChain({ id: c.chainId, name: c.name, nativeCurrency: { name: c.gas, symbol: c.gas, decimals: 18 }, rpcUrls: { default: { http: [c.rpcUrl] } }, blockExplorers: { default: { name: "Explorer", url: c.explorer } }, testnet: true }));

const embedded = (t: string) => t === "privy" || t === "privy-v2";

function Bridge() {
  const { ready, authenticated, user, getAccessToken, logout } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const pending = useRef<{ ok: (id: string) => void; fail: (e: Error) => void } | null>(null);
  const { login } = useLogin({
    onComplete: ({ user: u }) => { pending.current?.ok(u.id); pending.current = null; },
    onError: (e) => { pending.current?.fail(new Error(e === "exited_auth_flow" ? "Sign-in was closed before it finished" : `Privy sign-in failed: ${e}`)); pending.current = null; },
  });

  useEffect(() => {
    const a: PrivyActions = {
      login: () => new Promise<string>((ok, fail) => { if (authenticated && user) return ok(user.id); pending.current = { ok, fail }; login(); }),
      logout: () => logout(),
      getAccessToken: () => getAccessToken(),
      authenticated, userId: user?.id ?? null, primaryWallet: (user?.wallet?.address as Address | undefined) ?? null, email: user?.email?.address ?? null,
      wallets: wallets.map((w) => ({ address: w.address as Address, walletClientType: w.walletClientType, getEthereumProvider: () => w.getEthereumProvider() as Promise<Eip1193> })),
    };
    registerPrivyActions(a);
  }, [authenticated, user, wallets, login, logout, getAccessToken]);
  useEffect(() => () => registerPrivyActions(null), []);

  useEffect(() => {
    let on = true;
    if (!ready) { setPrivy("loading", null); return; }
    if (!authenticated || !user) { setPrivy("out", null); return; }
    const w = wallets.find((x) => embedded(x.walletClientType));
    if (!w) { setPrivy(walletsReady ? "creating" : "loading", null); return; }
    w.getEthereumProvider()
      .then((provider) => on && setPrivy("in", { address: w.address as Address, provider: provider as Eip1193, userId: user.id, login: user.email?.address ?? user.wallet?.address ?? "Privy" }))
      .catch((e) => on && setPrivy("error", null, `Couldn't open your Privy wallet: ${(e as Error).message ?? e}`));
    return () => { on = false; };
  }, [ready, authenticated, user, wallets, walletsReady]);
  return null;
}

export default function NorenPrivy({ children }: { children: ReactNode }) {
  if (!PRIVY_APP_ID) return <>{children}</>;
  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        appearance: {
          theme: "light", accentColor: "#1c2a5e", logo: `${location.origin}/art/mark.png`,
          landingHeader: "Sign in to Noren", loginMessage: "Email or wallet. You get a Noren wallet for test networks.",
          showWalletLoginFirst: false, walletChainType: "ethereum-only",
        },
        loginMethods: ["email", "wallet"],
        embeddedWallets: { ethereum: { createOnLogin: "all-users" }, showWalletUIs: true },
        defaultChain: arcTestnet,
        supportedChains: [arcTestnet, robinhoodTestnet, robinhoodFork, ...cctpSources],
      }}
    >
      <Bridge />
      {children}
    </PrivyProvider>
  );
}
