# Noren demo film (3:00)

A [HyperFrames](https://hyperframes.heygen.com) project. Every product shot is a cut of a live recording of the real
Noren UI (`record/record.mjs`, Playwright + the Chrome DevTools screencast at 1920×1080) against `pnpm dev:all`, plus the
public explorers (Arc testnet, Arbitrum Sepolia Blockscout, the CCIP explorer) for the live runs. Nothing is replayed, re-staged or text-edited: speed-ups are
labelled on screen (`▸▸ 2.2×`), the Noren Merchant secret key is covered by a visible "redacted" box, and every chain
shot says whether it is a local fork or Arc testnet (live).

| Path | What |
| --- | --- |
| `record/record.mjs` | the recorder: one take per flow (`landing`, `onboard`, `app`, `credit`, `shop`, `order`, `private`, `explorer`, `later`, `world`; v2 adds `privdefault`, `xchain`, `xexplorer`) |
| `record/retake-world.sh` | re-takes the World ID shot and re-renders (below) |
| `edit/edl.py` | the edit: which take, which seconds, how fast, captions, voice-over placement |
| `edit/build.py` | cuts the footage, writes `compositions/*.html` and `index.html`, places clicks/pops from the takes' own event logs |
| `edit/render.sh` | check + render `renders/noren-demo-v2.mp4` and the ≤20 MB `renders/noren-demo-v2-web.mp4` |
| `compositions/intro.html`, `compositions/tech.html` | the hand-made title, tech list and end card |
| `vo/*.txt` | the narration (Kokoro `af_heart`, `npx hyperframes tts`); `assets/vo/*.wav` |
| `assets/music/bed.wav` | the music bed (generated locally with MusicGen, see `SPEC.md`) |

Takes, browser state and renders are gitignored (`record/takes/`, `record/state/`, `renders/`).

## Re-take the World ID shot

World ID is production: a real verification needs a person to scan the IDKit request with World App. With
`pnpm dev:all` and `pnpm --filter @noren/web dev` running, one command opens the request, waits for the scan, records the
shot and, once verified, re-renders the film with it:

```sh
sh film/record/retake-world.sh        # WORLD_WAIT_MIN=30 by default
```

It writes the current World App link (decoded from the QR) to `film/record/state/world-link.txt` on every refresh, for a
phone that can't scan its own screen. Until a verification lands, section 05c shows the real request with
"verification pending" and the ladder from the recorded earn demo's fork transactions; a verified state is never drawn.

## Render

```sh
cd film && sh edit/render.sh          # NO_CUT=1 reuses the existing footage cuts
```

## v2 takes (private by default, cross-chain on public testnets)

With `pnpm dev:all` and the web app running: `node record/record.mjs privdefault` (a fresh store and customer; the
checkout opens on "Pay privately"; Noren Merchant shows "Customer: Private"), `node record/record.mjs xchain` (the app's
Bridge tab, then Noren Merchant's live "From other chains into Arc"), and `PAGES=<comma-separated explorer URLs>
node record/record.mjs xexplorer` for the live runs in docs/PRIVACY.md, docs/AQUA-LIVE.md and docs/CCIP.md
(sepolia.arbiscan.io shows a Cloudflare check to headless browsers, so the Arbitrum burn is shown on Blockscout).

## Injected test wallet (v3)

`record/wallet.mjs` gives the recorder a browser wallet without an extension: an EIP-1193 provider announced over
EIP-6963 as "Test wallet (injected)" (and `window.ethereum` when the page has none). The key lives in Node
(`record/state/wallet-key.json`, gitignored, 0600, generated once, never printed); the page calls one Playwright
binding, and `personal_sign`, `eth_signTypedData_v4` and `eth_sendTransaction` are signed with viem and broadcast to the
current chain's RPC (`WALLET=fork`: the `dev:all` forks; `WALLET=live`: Arc and Robinhood testnets). Reads are forwarded;
`wallet_switchEthereumChain` / `wallet_addEthereumChain` emit `chainChanged`. `node record/wallet.test.mjs` checks it
against a throwaway Anvil. Example: `WALLET=fork node record/record.mjs merchant3` (Noren Merchant: Browser wallet,
SIWE, store, link, API keys). Privy sign-in is never completed by the recorder.
